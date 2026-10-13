import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeClient } from '../src/bridge-client.js';
import { BridgeError } from '../src/contract.js';

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

const sourceRef = { plugin: 'dsh-todo', taskId: 't1' };

test('createIdea posts to the bridge route with an idempotency key', async () => {
  const { fetchImpl, calls } = fakeFetch(() => reply(200, { protocol: 1, ideaId: 'i1', created: true }));
  const client = createBridgeClient({ fetchImpl });
  const r = await client.createIdea({ protocol: 1, sourceRef, title: 'x' });
  assert.deepEqual(r, { ideaId: 'i1', created: true });
  assert.equal(calls[0].url, '/dsh-todo-aitm-bridge/api/ideas');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['idempotency-key'], 'dsh-todo:t1:idea');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(client.state, 'ready');
});

test('createIdea reports an existing idea as created:false', async () => {
  const { fetchImpl } = fakeFetch(() => reply(200, { protocol: 1, ideaId: 'i1', created: false }));
  const r = await createBridgeClient({ fetchImpl }).createIdea({ sourceRef, title: 'x' });
  assert.equal(r.created, false);
});

test('protocol mismatch marks the bridge incompatible and fails closed', async () => {
  const { fetchImpl } = fakeFetch(() => reply(200, { protocol: 2, ideaId: 'i1' }));
  const client = createBridgeClient({ fetchImpl });
  await assert.rejects(client.createIdea({ sourceRef, title: 'x' }), (e) => e.code === 'incompatible');
  assert.equal(client.state, 'incompatible');
  assert.equal(client.isUsable(), false);
});

test('non-JSON responses are a bad-response and make the bridge unavailable', async () => {
  const { fetchImpl } = fakeFetch(() => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('x'); } }));
  const client = createBridgeClient({ fetchImpl });
  await assert.rejects(client.health(), (e) => e.code === 'bad-response');
  assert.equal(client.isUsable(), false);
});

test('server error envelopes surface their code and message', async () => {
  const { fetchImpl } = fakeFetch(() =>
    reply(409, { protocol: 1, error: { code: 'conflict', message: '已有任务在运行' } }),
  );
  await assert.rejects(
    createBridgeClient({ fetchImpl }).startWork('i1', { sourceRef }),
    (e) => e instanceof BridgeError && e.code === 'conflict' && e.message === '已有任务在运行',
  );
});

test('network failure is reported as unavailable with a generic message', async () => {
  const { fetchImpl } = fakeFetch(() => {
    throw new TypeError('fetch failed');
  });
  const client = createBridgeClient({ fetchImpl });
  await assert.rejects(client.health(), (e) => e.code === 'network' && e.message === 'AI 任务台当前不可用');
  assert.equal(client.state, 'unavailable');
  assert.equal(client.isUsable(), false);
});

test('a hung request times out instead of waiting forever', async () => {
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const client = createBridgeClient({ fetchImpl, timeoutMs: 20 });
  await assert.rejects(client.health(), (e) => e.code === 'timeout');
});

test('previewStart validates the resolved configuration shape', async () => {
  const good = { preview: { target: { project: 'p', engine: 'e', model: 'm' }, instruction: 'do' } };
  const ok = createBridgeClient({ fetchImpl: fakeFetch(() => reply(200, { protocol: 1, ...good })).fetchImpl });
  assert.deepEqual((await ok.previewStart('i1')).target.project, 'p');

  const bad = createBridgeClient({
    fetchImpl: fakeFetch(() => reply(200, { protocol: 1, preview: { instruction: 'no target' } })).fetchImpl,
  });
  await assert.rejects(bad.previewStart('i1'), (e) => e.code === 'bad-response');
});

test('startWork sends a start-specific idempotency key and parses started', async () => {
  const { fetchImpl, calls } = fakeFetch(() => reply(200, { protocol: 1, started: true, taskId: 'w1' }));
  const r = await createBridgeClient({ fetchImpl }).startWork('i/1', { sourceRef });
  assert.deepEqual(r, { started: true, taskId: 'w1' });
  assert.equal(calls[0].url, '/dsh-todo-aitm-bridge/api/ideas/i%2F1/start');
  assert.equal(calls[0].init.headers['idempotency-key'], 'dsh-todo:t1:start:i/1');
});
