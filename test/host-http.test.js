import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createBridgeHttpHandler, checkOrigin, admitSession } from '../src/host/http.js';
import { previewDigest, previewView } from '../src/host/aitm.js';

const CAPS = ['idea.create', 'idea.start-preview', 'idea.start'];
const okConnection = { admit: () => ({ user: 'u1' }) };

/** Facade shaped like ai-tasks-mgr's frozen aitmBridge (Bridge v1). */
function fakeAitm(overrides = {}) {
  const calls = [];
  const base = {
    protocol: 1,
    service: 'ai-tasks-mgr',
    capabilities: CAPS,
    async discovery() {
      calls.push(['discovery']);
      return {
        protocol: 1,
        ok: true,
        service: 'ai-tasks-mgr',
        version: '0.3.48',
        apiRev: 1,
        base: '/aitm-plugin/bridge/v1',
        capabilities: CAPS,
      };
    },
    async createIdea(payload, opts) {
      calls.push(['createIdea', payload, opts]);
      return { protocol: 1, ok: true, ideaId: 'i_1', created: true };
    },
    async previewStart(id, payload) {
      calls.push(['previewStart', id, payload]);
      return {
        protocol: 1,
        ok: true,
        ideaId: id,
        preview: {
          target: { project: 'proj', engine: 'eng', model: 'm1' },
          instruction: '实现想法：写周报',
          sideEffects: ['创建 worktree'],
          secretRepoPath: '/home/someone/private',
        },
      };
    },
    async startWork(id, payload, opts) {
      calls.push(['startWork', id, payload, opts]);
      return { protocol: 1, ok: true, started: true, taskId: 'w_1', deduplicated: false };
    },
  };
  return { facade: Object.freeze({ ...base, ...overrides }), calls };
}

function makeReq({ method = 'GET', path, headers = {}, body }) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.url = path;
  req.headers = {
    host: 'dsh.local:3000',
    origin: 'http://dsh.local:3000',
    'sec-fetch-site': 'same-origin',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  };
  return req;
}

function makeRes() {
  const res = { status: 0, headers: {}, text: '' };
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.end = (chunk) => {
    res.text = chunk ?? '';
    res.body = JSON.parse(res.text || 'null');
  };
  return res;
}

async function run({ aitm = null, connection = okConnection, timeoutMs, logs = [], ...req }) {
  const handler = createBridgeHttpHandler({
    getAitm: () => aitm,
    getConnection: () => connection,
    logger: (m) => logs.push(m),
    timeoutMs,
  });
  const res = makeRes();
  const handled = await handler(makeReq(req), res);
  assert.equal(handled, true);
  return res;
}

const API = '/dsh-todo-aitm-bridge/api';
const sourceRef = { plugin: 'dsh-todo', taskId: 't1' };

// ---------------------------------------------------------------- service missing / degraded

test('health: missing aitmBridge reports unavailable (200) and never touches the facade', async () => {
  const res = await run({ path: `${API}/health`, method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(res.body.aitm.state, 'unavailable');
  assert.equal(res.body.protocol, 1);
});

test('createIdea: missing aitmBridge is 503 aitm-unavailable, with the generic message', async () => {
  const res = await run({ path: `${API}/ideas`, method: 'POST', body: { sourceRef, title: 'x' } });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'aitm-unavailable');
  assert.equal(res.body.error.message, 'AI 任务台当前不可用');
});

test('start routes: missing aitmBridge is 503, not a crash', async () => {
  const preview = await run({ path: `${API}/ideas/i_1/start-preview`, method: 'POST', body: {} });
  assert.equal(preview.status, 503);
  const start = await run({
    path: `${API}/ideas/i_1/start`,
    method: 'POST',
    body: { sourceRef, confirmedPreviewDigest: 'a'.repeat(64) },
  });
  assert.equal(start.status, 503);
  assert.equal(start.body.error.code, 'aitm-unavailable');
});

test('a facade that is missing a documented method is treated as incompatible', async () => {
  const { facade } = fakeAitm();
  const broken = { ...facade, startWork: undefined };
  const res = await run({ aitm: broken, path: `${API}/health`, method: 'GET' });
  assert.equal(res.body.aitm.state, 'incompatible');
  const create = await run({ aitm: broken, path: `${API}/ideas`, method: 'POST', body: { sourceRef, title: 'x' } });
  assert.equal(create.status, 503);
  assert.equal(create.body.error.code, 'aitm-incompatible');
});

// ---------------------------------------------------------------- version / capability checks

test('health: a discovery with the wrong protocol or missing capability reports incompatible', async () => {
  const wrongProtocol = fakeAitm({
    async discovery() {
      return { protocol: 2, ok: true, service: 'ai-tasks-mgr', capabilities: CAPS };
    },
  });
  const r1 = await run({ aitm: wrongProtocol.facade, path: `${API}/health`, method: 'GET' });
  assert.equal(r1.body.aitm.state, 'incompatible');

  const missingCap = fakeAitm({
    async discovery() {
      return { protocol: 1, ok: true, service: 'ai-tasks-mgr', capabilities: ['idea.create'] };
    },
  });
  const r2 = await run({ aitm: missingCap.facade, path: `${API}/health`, method: 'GET' });
  assert.equal(r2.body.aitm.state, 'incompatible');
});

test('a different service id at the same facade is refused, not used', async () => {
  const other = fakeAitm({
    async discovery() {
      return { protocol: 1, ok: true, service: 'some-other-plugin', capabilities: CAPS };
    },
  });
  const res = await run({ aitm: other.facade, path: `${API}/ideas`, method: 'POST', body: { sourceRef, title: 'x' } });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'aitm-incompatible');
  assert.ok(!other.calls.some((c) => c[0] === 'createIdea'));
});

test('facade protocol mismatch (not 1) fails closed before any call', async () => {
  const { facade, calls } = fakeAitm({ protocol: 2 });
  const res = await run({ aitm: facade, path: `${API}/ideas`, method: 'POST', body: { sourceRef, title: 'x' } });
  assert.equal(res.body.error.code, 'aitm-incompatible');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- health / happy path

test('health: ready when discovery is compatible, with no internal fields leaked', async () => {
  const { facade } = fakeAitm();
  const res = await run({ aitm: facade, path: `${API}/health`, method: 'GET' });
  assert.equal(res.body.aitm.state, 'ready');
  const text = res.text;
  assert.ok(!text.includes('/aitm-plugin'), 'must not expose the facade base');
  assert.ok(!/token/i.test(text), 'must not expose any token');
  assert.ok(!text.includes('0.3.48'), 'must not expose the AITM version');
});

test('createIdea: pins the source plugin, derives the idempotency key, and returns only whitelisted fields', async () => {
  const { facade, calls } = fakeAitm();
  const res = await run({
    aitm: facade,
    path: `${API}/ideas`,
    method: 'POST',
    headers: { 'idempotency-key': 'attacker-controlled' },
    body: { sourceRef: { plugin: 'evil-plugin', taskId: 't1' }, title: '  写周报 ', note: '本周', due: '2026-10-20', tags: ['work', ' work ', 'x'] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { protocol: 1, ok: true, ideaId: 'i_1', created: true });
  const [, payload, opts] = calls.find((c) => c[0] === 'createIdea');
  assert.equal(payload.sourceRef.plugin, 'dsh-todo');
  assert.equal(payload.title, '写周报');
  assert.deepEqual(payload.tags, ['work', 'work', 'x']);
  assert.equal(opts.idempotencyKey, 'dsh-todo:t1:idea');
});

test('createIdea: an existing link is returned as created:false', async () => {
  const { facade } = fakeAitm({
    async createIdea() {
      return { protocol: 1, ok: true, ideaId: 'i_9', created: false };
    },
  });
  const res = await run({ aitm: facade, path: `${API}/ideas`, method: 'POST', body: { sourceRef, title: 'x' } });
  assert.equal(res.body.created, false);
});

// ---------------------------------------------------------------- input validation

test('createIdea: invalid inputs are rejected before the facade is touched', async () => {
  const cases = [
    [{ sourceRef, title: '   ' }, 'invalid-task'],
    [{ sourceRef, title: 'x'.repeat(201) }, 'invalid-task'],
    [{ title: 'x' }, 'invalid-source-ref'],
    [{ sourceRef: { taskId: '' }, title: 'x' }, 'invalid-source-ref'],
    [{ sourceRef: { taskId: 'x'.repeat(129) }, title: 'x' }, 'invalid-source-ref'],
    [{ sourceRef, title: 'x', note: 42 }, 'invalid-task'],
    [{ sourceRef, title: 'x', due: 42 }, 'invalid-task'],
    [{ sourceRef, title: 'x', tags: 'work' }, 'invalid-task'],
    [{ sourceRef, title: 'x', tags: [1] }, 'invalid-task'],
  ];
  for (const [body, code] of cases) {
    const { facade, calls } = fakeAitm();
    const res = await run({ aitm: facade, path: `${API}/ideas`, method: 'POST', body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, code, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
});

test('ideaId in the path must match the safe id format', async () => {
  const { facade, calls } = fakeAitm();
  const res = await run({ aitm: facade, path: `${API}/ideas/..%2Fetc/start-preview`, method: 'POST', body: {} });
  assert.equal(res.status, 400);
  const bang = await run({ aitm: facade, path: `${API}/ideas/bad!id/start-preview`, method: 'POST', body: {} });
  assert.equal(bang.body.error.code, 'invalid-idea');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid-idea');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- session and origin

test('auth: no DSH session service fails closed with 401', async () => {
  const { facade, calls } = fakeAitm();
  const res = await run({ aitm: facade, connection: null, path: `${API}/health`, method: 'GET' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthorized');
  assert.equal(calls.length, 0);
});

test('auth: an admission rejection is reported as 403 forbidden or 401 unauthorized', async () => {
  const { facade, calls } = fakeAitm();
  const forbidden = await run({
    aitm: facade,
    connection: { admit: () => ({ rejection: 403 }) },
    path: `${API}/ideas`,
    method: 'POST',
    body: { sourceRef, title: 'x' },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'forbidden');

  const unauthorized = await run({
    aitm: facade,
    connection: { admit: () => ({ rejection: 401 }) },
    path: `${API}/ideas`,
    method: 'POST',
    body: { sourceRef, title: 'x' },
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(calls.length, 0);
});

test('auth: an admit() that throws is treated as unauthenticated', async () => {
  const { facade, calls } = fakeAitm();
  const res = await run({
    aitm: facade,
    connection: {
      admit() {
        throw new Error('session store down');
      },
    },
    path: `${API}/health`,
    method: 'GET',
  });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('origin: cross-site, null, and mismatched Origin requests are refused', async () => {
  const { facade, calls } = fakeAitm();
  const cross = await run({
    aitm: facade,
    path: `${API}/ideas`,
    method: 'POST',
    body: { sourceRef, title: 'x' },
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error.code, 'forbidden-origin');

  const nullOrigin = await run({
    aitm: facade,
    path: `${API}/ideas`,
    method: 'POST',
    body: { sourceRef, title: 'x' },
    headers: { origin: 'null' },
  });
  assert.equal(nullOrigin.status, 403);

  const mismatch = await run({
    aitm: facade,
    path: `${API}/ideas`,
    method: 'POST',
    body: { sourceRef, title: 'x' },
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(mismatch.status, 403);
  assert.equal(calls.length, 0);
});

test('checkOrigin and admitSession unit behaviour', () => {
  assert.equal(checkOrigin({ headers: { host: 'a', origin: 'http://a' } }).ok, true);
  assert.equal(checkOrigin({ headers: {} }).ok, true);
  assert.equal(checkOrigin({ headers: { host: 'a', origin: 'http://b' } }).ok, false);
  assert.equal(admitSession({}, null).ok, false);
  assert.equal(admitSession({}, { admit: () => ({}) }).ok, true);
});

// ---------------------------------------------------------------- routing and bodies

test('routing: wrong method is 405, unknown endpoints are 404, and no generic forwarding exists', async () => {
  const { facade } = fakeAitm();
  assert.equal((await run({ aitm: facade, path: `${API}/ideas`, method: 'GET' })).status, 405);
  assert.equal((await run({ aitm: facade, path: `${API}/health`, method: 'POST', body: {} })).status, 405);
  const unknown = await run({ aitm: facade, path: `${API}/action/anything`, method: 'POST', body: {} });
  assert.equal(unknown.status, 404);
  const outside = await run({ aitm: facade, path: '/dsh-todo-aitm-bridge/other', method: 'GET' });
  assert.equal(outside.status, 404);
});

test('bodies: wrong content-type, invalid JSON, non-object JSON, and oversized bodies are rejected', async () => {
  const { facade, calls } = fakeAitm();
  const text = await run({
    aitm: facade,
    path: `${API}/ideas`,
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(text.status, 415);

  const bad = await run({ aitm: facade, path: `${API}/ideas`, method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);

  const array = await run({ aitm: facade, path: `${API}/ideas`, method: 'POST', body: '[1,2]' });
  assert.equal(array.status, 400);

  const big = await run({
    aitm: facade,
    path: `${API}/ideas`,
    method: 'POST',
    body: { sourceRef, title: 'x', note: 'n'.repeat(70 * 1024) },
    headers: { 'content-length': String(70 * 1024) },
  });
  assert.equal(big.status, 413);
  assert.equal(calls.length, 0);
});

test('a hung facade call times out as aitm-unavailable instead of hanging the request', async () => {
  const { facade } = fakeAitm({
    startWork: () => new Promise(() => {}),
  });
  const preview = previewView(
    (await fakeAitm().facade.previewStart('i_1', {})).preview,
  );
  const digest = previewDigest(preview);
  const res = await run({
    aitm: facade,
    timeoutMs: 20,
    path: `${API}/ideas/i_1/start`,
    method: 'POST',
    body: { sourceRef, confirmedPreviewDigest: digest },
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'aitm-unavailable');
});

// ---------------------------------------------------------------- error mapping

test('facade errors: user-correctable codes pass through, everything else collapses to unavailable', async () => {
  const cases = [
    [{ status: 409, code: 'idempotency-conflict', message: '已占用' }, 409, 'idempotency-conflict'],
    [{ status: 409, code: 'engine-not-ready', message: '引擎不可用' }, 409, 'engine-not-ready'],
    [{ status: 500, code: 'internal-error', message: 'boom /secret/path' }, 503, 'aitm-unavailable'],
    [{ status: 401, code: 'unauthorized', message: 'token' }, 503, 'aitm-unavailable'],
    [new Error('ECONNREFUSED 127.0.0.1:49182'), 503, 'aitm-unavailable'],
    [{ code: 'incompatible', message: 'x' }, 503, 'aitm-incompatible'],
  ];
  for (const [thrown, status, code] of cases) {
    const { facade } = fakeAitm({
      async createIdea() {
        throw thrown;
      },
    });
    const logs = [];
    const res = await run({ aitm: facade, logs, path: `${API}/ideas`, method: 'POST', body: { sourceRef, title: 'x' } });
    assert.equal(res.status, status, code);
    assert.equal(res.body.error.code, code);
    assert.ok(!res.text.includes('/secret/path') && !res.text.includes('127.0.0.1'), 'internal details must not leak');
  }
});

// ---------------------------------------------------------------- start preview and confirmation

test('previewStart: returns a whitelisted view plus the digest of exactly that view', async () => {
  const { facade } = fakeAitm();
  const res = await run({ aitm: facade, path: `${API}/ideas/i_1/start-preview`, method: 'POST', body: {} });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.preview, {
    target: { project: 'proj', engine: 'eng', model: 'm1' },
    instruction: '实现想法：写周报',
    sideEffects: ['创建 worktree'],
  });
  assert.equal(res.body.previewDigest, previewDigest(res.body.preview));
  assert.ok(!res.text.includes('secretRepoPath') && !res.text.includes('/home/someone'));
});

test('previewStart: a browser-supplied instruction is not forwarded to the facade', async () => {
  const { facade, calls } = fakeAitm();
  await run({
    aitm: facade,
    path: `${API}/ideas/i_1/start-preview`,
    method: 'POST',
    body: { instruction: 'rm -rf /' },
  });
  const call = calls.find((c) => c[0] === 'previewStart');
  assert.deepEqual(call[2], {});
});

test('startWork: without a confirmed digest it is refused and the facade is never asked to start', async () => {
  const { facade, calls } = fakeAitm();
  const res = await run({ aitm: facade, path: `${API}/ideas/i_1/start`, method: 'POST', body: { sourceRef } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'confirmation-required');
  assert.equal(calls.length, 0);

  const malformed = await run({
    aitm: facade,
    path: `${API}/ideas/i_1/start`,
    method: 'POST',
    body: { sourceRef, confirmedPreviewDigest: 'not-hex' },
  });
  assert.equal(malformed.body.error.code, 'confirmation-required');
  assert.equal(calls.length, 0);
});

test('startWork: if the configuration changed after confirmation, it refuses to start', async () => {
  const { facade, calls } = fakeAitm();
  const oldDigest = previewDigest(
    previewView({ target: { project: 'old', engine: 'eng', model: 'm1' }, instruction: 'x', sideEffects: [] }),
  );
  const res = await run({
    aitm: facade,
    path: `${API}/ideas/i_1/start`,
    method: 'POST',
    body: { sourceRef, confirmedPreviewDigest: oldDigest },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'preview-changed');
  assert.ok(!calls.some((c) => c[0] === 'startWork'));
});

test('startWork: with the matching digest, starts with the derived idempotency key and no browser instruction', async () => {
  const { facade, calls } = fakeAitm();
  const digest = (await run({ aitm: facade, path: `${API}/ideas/i_1/start-preview`, method: 'POST', body: {} })).body
    .previewDigest;
  const res = await run({
    aitm: facade,
    path: `${API}/ideas/i_1/start`,
    method: 'POST',
    headers: { 'idempotency-key': 'attacker' },
    body: { sourceRef, confirmedPreviewDigest: digest, instruction: 'rm -rf /' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { protocol: 1, ok: true, ideaId: 'i_1', started: true, taskId: 'w_1', deduplicated: false });
  const call = calls.find((c) => c[0] === 'startWork');
  assert.equal(call[1], 'i_1');
  assert.deepEqual(call[2], { sourceRef: { plugin: 'dsh-todo', taskId: 't1' } });
  assert.equal(call[3].idempotencyKey, 'dsh-todo:t1:start:i_1');
});

test('startWork: a deduplicated replay is surfaced to the browser', async () => {
  const { facade } = fakeAitm({
    async startWork() {
      return { protocol: 1, ok: true, started: true, taskId: 'w_1', deduplicated: true };
    },
  });
  const digest = previewDigest(previewView((await fakeAitm().facade.previewStart('i_1', {})).preview));
  const res = await run({
    aitm: facade,
    path: `${API}/ideas/i_1/start`,
    method: 'POST',
    body: { sourceRef, confirmedPreviewDigest: digest },
  });
  assert.equal(res.body.deduplicated, true);
});

test('the digest is a real sha256 over the canonical view', () => {
  const view = previewView({ target: { project: 'p', engine: 'e', model: 'm' }, instruction: 'i', sideEffects: ['s'] });
  const expected = crypto.createHash('sha256').update(JSON.stringify(view)).digest('hex');
  assert.equal(previewDigest(view), expected);
  assert.equal(expected.length, 64);
});
