#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPackage, marketplaceName, projectRoot } from './package.mjs';
import { codexExecutable } from '../src/codex-bridge.mjs';

function ownDirectory(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing linked test directory: ${path}`);
  mkdirSync(path, { recursive: true });
  assert.equal(realpathSync(path), path, 'Isolated test directory must stay in the workspace');
}

function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`Expected JSON from ${args.join(' ')}: ${result.stdout}`); }
}

function matchingObjects(value, name, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (!Array.isArray(value) && value.name === name) result.push(value);
  for (const nested of Object.values(value)) matchingObjects(nested, name, result);
  return result;
}

try {
  const release = buildPackage();
  const again = buildPackage();
  assert.equal(release.checksum, again.checksum, 'Unchanged source must produce the same package');
  ownDirectory(join(projectRoot, '.dev'));
  const hostBase = join(projectRoot, '.dev', 'plugin-host');
  ownDirectory(hostBase);
  const isolatedHome = mkdtempSync(join(hostBase, 'check-'));
  const workingDirectory = join(isolatedHome, 'workspace');
  mkdirSync(workingDirectory);
  // Plugin catalog commands only. This environment is never used for a model turn.
  // Strip inherited host/auth overrides so no personal configuration or API key is needed.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^CODEX_/i.test(key) && !/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/i.test(key)));
  env.CODEX_HOME = isolatedHome;
  const options = { cwd: workingDirectory, env };
  const command = codexExecutable();
  const added = run(command, ['plugin', 'marketplace', 'add', release.dist, '--json'], options);
  const markets = run(command, ['plugin', 'marketplace', 'list', '--json'], options);
  assert.ok(matchingObjects(markets, marketplaceName).length, 'Codex must discover the packaged marketplace');
  const available = run(command, ['plugin', 'list', '--marketplace', marketplaceName, '--available', '--json'], options);
  assert.ok(matchingObjects(available, release.name).length, 'Codex must discover the packaged plugin');
  const installed = run(command, ['plugin', 'add', `${release.name}@${marketplaceName}`, '--json'], options);
  const listed = run(command, ['plugin', 'list', '--marketplace', marketplaceName, '--json'], options);
  assert.ok(matchingObjects(listed, release.name).length, 'Installed plugin must appear in Codex');
  const cacheParent = join(isolatedHome, 'plugins', 'cache', marketplaceName, release.name);
  assert.ok(existsSync(cacheParent), 'Installed files must be inside isolated CODEX_HOME');
  const installs = readdirSync(cacheParent).map(name => join(cacheParent, name)).filter(path => existsSync(join(path, 'SHA256SUMS')));
  assert.equal(installs.length, 1, 'Fresh isolated host must have exactly one installed release');
  const installedRoot = installs[0];
  assert.equal(readFileSync(join(installedRoot, 'SHA256SUMS'), 'utf8'), readFileSync(join(release.packageRoot, 'SHA256SUMS'), 'utf8'));
  for (const line of readFileSync(join(installedRoot, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [expected, path] = line.split('  ');
    assert.equal(createHash('sha256').update(readFileSync(join(installedRoot, path))).digest('hex'), expected, `Installed bytes: ${path}`);
  }
  // Loading the installed server catches omitted runtime dependencies that catalog installation cannot.
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'boss-package-check', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'boss_init', arguments: { root: workingDirectory, name: '隔离安装验收' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boss_status', arguments: { root: workingDirectory } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boss_report_view', arguments: { root: workingDirectory } } },
  ];
  const invoke=(id,name,input={})=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:{root:workingDirectory,...input}}});
  requests.push(invoke(6,'boss_bind',{id:'worker',title:'验收员工',threadId:'fixture-worker',kind:'worker'}),
    invoke(7,'boss_stage',{id:'sample',title:'验收',goal:'可追踪',acceptance:['查到派工'],policy:{firstProof:'查到任务',workLimit:1}}),
    invoke(8,'boss_agreement',{id:'a1',text:'先查入口',sourceRef:'fixture-owner'}),
    invoke(9,'boss_assign',{id:'sample-work',role:'worker',text:'测试进度查询',scope:{read:['guide'],write:[]}}),
    invoke(10,'boss_team_board'),invoke(11,'boss_task_trace',{id:'sample-work'}));
  const mcp = spawnSync(process.execPath, [join(installedRoot, 'src', 'mcp.mjs')], {
    ...options, input: requests.map(request => JSON.stringify(request)).join('\n') + '\n', encoding: 'utf8',
    windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(mcp.status, 0, `Installed MCP server must run: ${mcp.error?.message ?? mcp.stderr}`);
  const responses = mcp.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(responses.length, requests.length);
  assert.equal(responses[0].result?.serverInfo?.name, 'boss');
  assert.equal(responses[0].result?.serverInfo?.version, release.version);
  const names = responses[1].result.tools.map(tool => tool.name);
  assert.ok(!names.includes('boss_decide'));
  assert.ok(names.includes('boss_close_dispatch'));
  assert.ok(!responses[2].result.isError, 'Installed MCP init must succeed');
  assert.equal(JSON.parse(responses[3].result.content[0].text).name, '隔离安装验收');
  assert.ok(!responses[4].result.isError, 'Installed MCP report view must succeed');
  assert.match(responses[4].result.content[0].text, /隔离安装验收.*阶段报告/);
  for (const response of responses.slice(5)) assert.ok(!response.error && !response.result?.isError,JSON.stringify(response));
  const board=JSON.parse(responses[9].result.content[0].text),trace=JSON.parse(responses[10].result.content[0].text);
  assert.equal(board.stage.used,1);assert.equal(board.decisions[0].id,'a1');
  assert.equal(trace.threadId,'fixture-worker');assert.ok(trace.event);
  assert.ok(names.includes('boss_review_pass') && !names.includes('boss_raise_limit'));
  const result = { ok: true, modelCalls: 0, installedMcp: 'initialize, catalog, init, status, report, role, stage, agreement, assignment, board and trace passed', isolatedHome, installedRoot, release, added, installed, listed };
  writeFileSync(join(isolatedHome, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
