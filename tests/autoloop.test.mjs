import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { Autoloop } from '../src/autoloop.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'boss-autoloop-test-'));
  const filename = path.join(directory, 'events.sqlite');
  const opened = [];
  t.after(() => {
    for (const db of opened) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { filename, open: () => { const db = new Autoloop(filename); opened.push(db); return db; } };
}

function rules() {
  return {
    timezone: 'Asia/Shanghai', askFirst: [],
    sources: { project: { name: '项目事件' } },
    agents: { reviewer: { name: '审查员', worker: 'local', use: 'boss', access: 'read' } },
    channels: {},
    rules: [{ name: 'review', when: { source: 'project', types: ['review.requested'] },
      to: 'reviewer', cwd: process.cwd(), group: 'project-review', tell: 'needed',
      prompt: '检查任务范围内的可核查证据。', resume: true }],
  };
}

const event = (id) => ({ id, type: 'review.requested', subject: 'stage-1', summary: 'Review requested' });
const runs = (db) => Object.values(db.snapshot().tables.runs);

test('vendored modules match the pinned Git blobs and SHA-256 manifest', () => {
  const root = new URL('../vendor/agent-autoloop/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('upstream.json', root), 'utf8'));
  assert.equal(manifest.commit, 'd3a44cac4460f4e0417c3d407baa853de7aa25ff');
  assert.equal(manifest.license, 'MIT');
  for (const file of manifest.files) {
    const bytes = readFileSync(new URL(file.path, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), file.gitBlobSha1, file.path);
    assert.ok(file.path === 'LICENSE' || /^(kernel|protocol)\//.test(file.path));
  }
});

test('event deduplication preserves one routed event and one queued execution', (t) => {
  const db = fixture(t).open();
  const input = rules();
  const before = structuredClone(input);
  db.configure(input);
  assert.deepEqual(input, before, 'configuration must not mutate the caller');
  const first = db.ingest('project', event('duplicate'));
  const seq = db.snapshot().seq;
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.routed, ['review']);
  assert.equal(db.ingest('project', event('duplicate')).duplicate, true);
  assert.equal(db.snapshot().seq, seq);
  assert.equal(runs(db).length, 1);
  assert.equal(Object.keys(db.snapshot().tables.events).length, 1);
  const explanation = db.why('project', first.event);
  assert.equal(explanation.runs[0].state, 'queued');
  assert.equal(db.why('another-source', first.event), null);
});

test('queued work and issued run tokens survive closing and reopening the database', (t) => {
  const f = fixture(t);
  let db = f.open();
  db.configure(rules());
  db.ingest('project', event('restart'));
  db.close();
  db = f.open();
  const job = db.claim('local', 'before-second-restart');
  assert.equal(job.context.events[0].id, 'restart');
  db.close();
  db = f.open();
  db.finish(job.run, job.token, { outcome: 'done', summary: 'Reviewed', session: 'persistent-thread' });
  assert.equal(runs(db)[0].state, 'done');
  db.ingest('project', event('resume'));
  assert.equal(db.claim('local', 'resume-thread').session, 'persistent-thread');
});

test('separate connections cannot claim concurrent work in the same group', (t) => {
  const f = fixture(t);
  const first = f.open();
  first.configure(rules());
  first.ingest('project', event('first'));
  const job = first.claim('local', 'claim-one');
  first.ingest('project', event('second'));
  const second = f.open();
  assert.equal(second.claim('local', 'claim-two'), null);
  second.finish(job.run, job.token, { outcome: 'done', summary: 'Checked' });
  const next = first.claim('local', 'claim-three');
  assert.notEqual(next.run, job.run);
  assert.equal(next.context.events[0].id, 'second');
});

test('simultaneous worker threads serialize claims through SQLite', async (t) => {
  const f = fixture(t);
  const db = f.open();
  db.configure(rules());
  db.ingest('project', event('race'));
  const shared = new SharedArrayBuffer(8);
  const gate = new Int32Array(shared);
  const workers = [];
  const ready = [];
  const results = [];
  for (let index = 0; index < 2; index++) {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { Autoloop } = await import(workerData.moduleUrl);
        const db = new Autoloop(workerData.filename);
        const gate = new Int32Array(workerData.shared);
        parentPort.postMessage({ ready: true });
        Atomics.wait(gate, 1, 0);
        try { parentPort.postMessage({ result: db.claim('local', 'racer-' + workerData.index) }); }
        finally { db.close(); }
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { filename: f.filename, shared, index, moduleUrl: new URL('../src/autoloop.mjs', import.meta.url).href } });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => {
      worker.on('message', (message) => { if (message.ready) resolve(); });
      worker.on('error', reject);
    }));
    results.push(new Promise((resolve, reject) => {
      worker.on('message', (message) => { if (Object.hasOwn(message, 'result')) resolve(message.result); });
      worker.on('error', reject);
    }));
  }
  try {
    await Promise.all(ready);
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    const jobs = await Promise.all(results);
    assert.equal(jobs.filter(Boolean).length, 1);
    assert.equal(runs(db).filter((run) => run.state === 'claimed').length, 1);
  } finally {
    for (const worker of workers) await worker.terminate();
  }
});

test('lost claim responses return the same run with the latest token', (t) => {
  const db = fixture(t).open();
  db.configure(rules());
  db.ingest('project', event('claim-retry'));
  const first = db.claim('local', 'stable-request');
  const retry = db.claim('local', 'stable-request');
  assert.equal(retry.run, first.run);
  assert.notEqual(retry.token, first.token);
  assert.throws(() => db.finish(first.run, first.token, { outcome: 'done', summary: 'Stale' }));
  db.finish(retry.run, retry.token, { outcome: 'done', summary: 'Latest' });
});

test('duplicate result submission is idempotent; conflicting results roll back', (t) => {
  const db = fixture(t).open();
  db.configure(rules());
  db.ingest('project', event('result-retry'));
  const job = db.claim('local', 'result-claim');
  const result = { outcome: 'done', summary: 'Checked', usage: { input: 10, output: 3 } };
  db.finish(job.run, job.token, result);
  const before = db.snapshot();
  assert.equal(db.finish(job.run, job.token, result).duplicate, true);
  assert.deepEqual(db.snapshot(), before);
  assert.throws(() => db.finish(job.run, job.token, { ...result, summary: 'Changed' }));
  assert.deepEqual(db.snapshot(), before);
  assert.throws(() => db.apply('unknown-command', []));
  assert.deepEqual(db.snapshot(), before);
});

test('an open ask card does not freeze project routing and an answer resumes its thread', (t) => {
  const db = fixture(t).open();
  db.configure(rules());
  db.ingest('project', event('needs-answer'));
  const job = db.claim('local', 'asking');
  db.finish(job.run, job.token, { outcome: 'done', summary: 'Waiting for a choice', session: 'review-thread',
    ask: [{ title: '选择检查范围', text: '这是任务问题，不是阶段审批。', options: ['当前范围', '扩大范围'], about: '只继续待检查内容', key: 'scope' }] });
  const card = Object.values(db.snapshot().tables.cards).find((item) => item.kind === 'ask');
  assert.equal(card.state, 'open');
  assert.deepEqual(db.snapshot().tables.pauses, {});
  db.ingest('project', event('independent-event'));
  const next = db.claim('local', 'still-claimable');
  assert.ok(next, 'open cards are not stage execution gates');
  db.finish(next.run, next.token, { outcome: 'done', summary: 'Other event checked', session: 'review-thread' });
  assert.equal(db.answer(card.id, { choice: 0, by: 'boss', text: '保持范围' }).changed, true);
  const resumed = db.claim('local', 'after-answer');
  assert.equal(resumed.session, 'review-thread');
  assert.equal(resumed.context.answers[0].card, card.id);
  assert.equal(resumed.context.answers[0].text, '保持范围');
});

test('invalid rules and event inputs leave existing state untouched', (t) => {
  const db = fixture(t).open();
  db.configure(rules());
  const before = db.snapshot();
  assert.throws(() => db.configure({ sources: {}, agents: {}, rules: [{ name: 'bad' }] }));
  assert.throws(() => db.ingest('project', { id: 'bad', type: 'INVALID' }));
  assert.deepEqual(db.snapshot(), before);
  db.close();
  db.close();
  assert.throws(() => db.snapshot(), /closed/);
});
