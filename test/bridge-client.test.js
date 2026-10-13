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

test('createIdea posts to the bridge route and sends no client-side idempotency header', async () => {
  const { fetchImpl, calls } = fakeFetch(() => reply(200, { protocol: 1, ok: true, ideaId: 'i1', created: true }));
  const client = createBridgeClient({ fetchImpl });
  const r = await client.createIdea({ sourceRef, title: 'x', note: '', due: null, tags: [] });
  assert.deepEqual(r, { ideaId: 'i1', created: true });
  assert.equal(calls[0].url, '/dsh-todo-aitm-bridge/api/ideas');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['idempotency-key'], undefined);
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(client.state, 'ready');
});

test('createIdea reports an existing idea as created:false', async () => {
  const { fetchImpl } = fakeFetch(() => reply(200, { protocol: 1, ok: true, ideaId: 'i1', created: false }));
  const r = await createBridgeClient({ fetchImpl }).createIdea({ sourceRef, title: 'x' });
  assert.equal(r.created, false);
});

test('protocol mismatch marks the bridge incompatible and fails closed', async () => {
  const { fetchImpl } = fakeFetch(() => reply(200, { protocol: 2, ok: true, ideaId: 'i1' }));
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
    reply(409, { protocol: 1, ok: false, error: { code: 'conflict', message: '已有任务在运行' } }),
  );
  await assert.rejects(
    createBridgeClient({ fetchImpl }).startWork('i1', { sourceRef, confirmedPreviewDigest: 'x' }),
    (e) => e instanceof BridgeError && e.code === 'conflict' && e.message === '已有任务在运行',
  );
});

test('a 409 business error keeps the bridge usable (it is reachable)', async () => {
  const { fetchImpl } = fakeFetch(() =>
    reply(409, { protocol: 1, ok: false, error: { code: 'preview-changed', message: '变了' } }),
  );
  const client = createBridgeClient({ fetchImpl });
  await assert.rejects(client.startWork('i1', { sourceRef, confirmedPreviewDigest: 'x' }));
  assert.equal(client.state, 'ready');
  assert.equal(client.isUsable(), true);
});

test('an aitm-unavailable envelope disables the menu, and aitm-incompatible marks it incompatible', async () => {
  const unavailable = createBridgeClient({
    fetchImpl: fakeFetch(() =>
      reply(503, { protocol: 1, ok: false, error: { code: 'aitm-unavailable', message: 'AI 任务台当前不可用' } }),
    ).fetchImpl,
  });
  await assert.rejects(unavailable.createIdea({ sourceRef, title: 'x' }));
  assert.equal(unavailable.isUsable(), false);

  const incompatible = createBridgeClient({
    fetchImpl: fakeFetch(() =>
      reply(503, { protocol: 1, ok: false, error: { code: 'aitm-incompatible', message: 'x' } }),
    ).fetchImpl,
  });
  await assert.rejects(incompatible.createIdea({ sourceRef, title: 'x' }));
  assert.equal(incompatible.state, 'incompatible');
});

test('an auth failure (401/403) marks the menu unavailable without pretending it is ready', async () => {
  const client = createBridgeClient({
    fetchImpl: fakeFetch(() => reply(401, { protocol: 1, ok: false, error: { code: 'unauthorized', message: 'x' } }))
      .fetchImpl,
  });
  await assert.rejects(client.health(), (e) => e.code === 'unauthorized');
  assert.equal(client.isUsable(), false);
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

test('health() reflects the host-reported AI 任务台 state', async () => {
  for (const [aitmState, expected] of [
    ['ready', 'ready'],
    ['unavailable', 'unavailable'],
    ['incompatible', 'incompatible'],
  ]) {
    const client = createBridgeClient({
      fetchImpl: fakeFetch(() => reply(200, { protocol: 1, ok: true, aitm: { state: aitmState } })).fetchImpl,
    });
    const r = await client.health();
    assert.equal(r.state, expected);
    assert.equal(client.state, expected);
  }
});

test('subscribe is notified on state changes only', async () => {
  let n = 0;
  const client = createBridgeClient({
    fetchImpl: fakeFetch(() => reply(200, { protocol: 1, ok: true, aitm: { state: 'unavailable' } })).fetchImpl,
  });
  client.subscribe(() => n++);
  await client.health(); // unknown -> ready -> unavailable: two changes
  assert.equal(n, 2);
  await client.health(); // unavailable -> ready -> unavailable: still changes twice
  assert.ok(n >= 3);
});

test('previewStart validates shape and returns the confirmation digest', async () => {
  const good = { preview: { target: { project: 'p', engine: 'e', model: 'm' }, instruction: 'do', sideEffects: [] } };
  const ok = createBridgeClient({
    fetchImpl: fakeFetch(() => reply(200, { protocol: 1, ok: true, ...good, previewDigest: 'abc' })).fetchImpl,
  });
  const p = await ok.previewStart('i1');
  assert.equal(p.target.project, 'p');
  assert.equal(p.digest, 'abc');

  const bad = createBridgeClient({
    fetchImpl: fakeFetch(() => reply(200, { protocol: 1, ok: true, preview: { instruction: 'no target' }, previewDigest: 'x' }))
      .fetchImpl,
  });
  await assert.rejects(bad.previewStart('i1'), (e) => e.code === 'bad-response');
});

test('startWork sends the sourceRef and the confirmed digest in the body, with no client header', async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    reply(200, { protocol: 1, ok: true, started: true, taskId: 'w1', deduplicated: false }),
  );
  const r = await createBridgeClient({ fetchImpl }).startWork('i/1', { sourceRef, confirmedPreviewDigest: 'd'.repeat(64) });
  assert.deepEqual(r, { started: true, taskId: 'w1', deduplicated: false });
  assert.equal(calls[0].url, '/dsh-todo-aitm-bridge/api/ideas/i%2F1/start');
  assert.equal(calls[0].init.headers['idempotency-key'], undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), { sourceRef, confirmedPreviewDigest: 'd'.repeat(64) });
});
