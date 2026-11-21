#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
export const marketplaceName = 'boss-local';

// Only product code, bundled skills and attributed upstream files belong in a release.
// Never copy the workspace wholesale: it contains live chats, approvals and SQLite secrets.
const required = ['src', 'skills', 'vendor', 'plugin.json', '.codex-plugin/plugin.json', 'mcp.json', '.mcp.json', 'INSTALL.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE'];
for (const name of ['cli.mjs','channel.mjs','checkpoint.mjs','sdk.mjs','card.mjs','manager.mjs','wake.mjs','package.json','package-lock.json','README.md','example.env']) {
  required.push('integrations/feishu/'+name);
}
const optional = ['LICENSE.md', 'LICENSE.txt', 'NOTICE', 'NOTICE.md'];
const excludedDirectories = new Set(['.boss', '.dev', '.git', 'dist', 'node_modules', '__pycache__', '.venv', 'venv']);
const extensions = new Set(['.mjs', '.ts', '.md', '.json', '.yaml', '.yml', '.py', '.txt']);
// credentials.ts is upstream application code, not a credential file.
const sensitive = /^(?:\.env(?:\..*)?|auth\.json|credentials(?:\.(?:json|ya?ml|toml|ini|conf|env|txt))?|secrets?(?:\.(?:json|ya?ml|toml|ini|conf|env|txt))?|id_(?:rsa|ed25519)(?:\..*)?)$|\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$|\.(?:pem|key|p12|pfx|pyc)$/i;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const posix = path => path.split(sep).join('/');

function ownDirectory(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing linked output directory: ${path}`);
  mkdirSync(path, { recursive: true });
  if (realpathSync(path) !== path) throw new Error(`Output directory resolves elsewhere: ${path}`);
}

function sourceFiles(path, result = []) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Release inputs cannot be symbolic links: ${path}`);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (!excludedDirectories.has(name) && !sensitive.test(name)) sourceFiles(join(path, name), result);
    }
  } else if (stat.isFile()) {
    const name = path.split(sep).at(-1);
    if (sensitive.test(name)) return result;
    if (!extensions.has(extname(name)) && relative(projectRoot,path)!==join('integrations','feishu','example.env') && !/^(?:LICENSE|NOTICE)$/i.test(name)) {
      throw new Error(`Review and explicitly allow this new release file type: ${path}`);
    }
    result.push(path);
  } else throw new Error(`Unsupported release input: ${path}`);
  return result;
}

function validateManifests() {
  const portable = json(join(projectRoot, 'plugin.json'));
  const compatibility = json(join(projectRoot, '.codex-plugin/plugin.json'));
  if (portable.name !== 'boss-project' || portable.name !== compatibility.name || portable.version !== compatibility.version) {
    throw new Error('Portable and compatibility plugin identities must match');
  }
  const modern = json(join(projectRoot, 'mcp.json')).mcpServers[portable.name];
  const legacy = json(join(projectRoot, '.mcp.json')).mcpServers[portable.name];
  if (modern.type !== 'stdio' || modern.command !== 'node' || modern.command !== legacy.command ||
      JSON.stringify(modern.args) !== JSON.stringify(legacy.args) ||
      JSON.stringify(modern.args) !== JSON.stringify(['${PLUGIN_ROOT}/src/mcp.mjs'])) {
    throw new Error('Portable and compatibility MCP entry points must match the local server');
  }
  return portable;
}

export function buildPackage() {
  const manifest = validateManifests();
  // Check every source before replacing the previous package.
  const files = [...required, ...optional.filter(path => existsSync(join(projectRoot, path)))]
    .flatMap(path => sourceFiles(join(projectRoot, path)))
    .sort((a, b) => posix(relative(projectRoot, a)).localeCompare(posix(relative(projectRoot, b)), 'en'));
  const dist = join(projectRoot, 'dist');
  ownDirectory(dist);
  const packageRoot = join(dist, 'boss-project');
  if (existsSync(packageRoot)) {
    // This exact child is the only recursive deletion target. Refuse links/junctions.
    if (lstatSync(packageRoot).isSymbolicLink() || realpathSync(packageRoot) !== packageRoot || dirname(packageRoot) !== realpathSync(dist)) {
      throw new Error(`Unsafe package replacement target: ${packageRoot}`);
    }
    rmSync(packageRoot, { recursive: true });
  }
  ownDirectory(packageRoot);
  const checksums = [];
  for (const file of files) {
    const name = relative(projectRoot, file);
    const target = join(packageRoot, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
    checksums.push(`${createHash('sha256').update(readFileSync(target)).digest('hex')}  ${posix(name)}`);
  }
  writeFileSync(join(packageRoot, 'SHA256SUMS'), checksums.join('\n') + '\n');
  ownDirectory(join(dist, '.agents'));
  ownDirectory(join(dist, '.agents', 'plugins'));
  const catalog = {
    name: marketplaceName,
    interface: { displayName: 'BOSS 本地验收' },
    plugins: [{ name: manifest.name, source: { source: 'local', path: './boss-project' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  };
  writeFileSync(join(dist, '.agents', 'plugins', 'marketplace.json'), JSON.stringify(catalog, null, 2) + '\n');
  return { dist, packageRoot, name: manifest.name, version: manifest.version, fileCount: files.length,
    checksum: createHash('sha256').update(checksums.join('\n') + '\n').digest('hex') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(buildPackage(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
