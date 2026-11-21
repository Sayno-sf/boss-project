import { resolve } from 'node:path';
import { CodexBridge } from '../src/codex-bridge.mjs';

// No inference and no thread creation. stdio must be requested explicitly.
const transport = process.argv.includes('--stdio') ? 'stdio' : 'proxy';
const cwd = resolve(process.argv.find(arg => arg.startsWith('--cwd='))?.slice(6) ?? process.cwd());
const bridge = new CodexBridge({ transport, cwd, timeoutMs: 15_000 });
try {
  await bridge.connect();
  const result = await bridge.request('thread/list', { cwd, limit: 1 });
  console.log(JSON.stringify({
    ok: true, transport, cwd, handshake: true, scopedThreadList: true,
    threadsReturned: result.data?.length ?? 0, inferenceStarted: false, threadsCreated: 0,
    desktopVisibilityVerified: false,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, transport, error: error.message, inferenceStarted: false, threadsCreated: 0 }, null, 2));
  process.exitCode = 1;
} finally {
  await bridge.close();
}
