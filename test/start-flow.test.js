import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError } from '../src/contract.js';
import { startWorkFlow, toastFor, formatPreview } from '../src/start-flow.js';

const task = (id = 't1') => ({ id, title: '写周报', note: '', tags: [] });
const preview = {
  target: { project: 'proj-a', engine: 'eng-b', model: 'm-c' },
  instruction: '整理本周待办',
  sideEffects: ['创建 worktree'],
};

/** Scripted bridge: each method records calls and can be told to fail. */
function fakeBridge({ createFails, previewFails, startResult = { started: true, taskId: 'w1' }, startFails } = {}) {
  const log = [];
  return {
    log,
    async createIdea(idea) {
      log.push(['create', idea.sourceRef.taskId]);
      if (createFails) throw new BridgeError('network', 'AI 任务台当前不可用');
      return { ideaId: 'i1', created: true };
    },
    async previewStart(ideaId) {
      log.push(['preview', ideaId]);
      if (previewFails) throw new BridgeError('timeout', '连接 AI 任务台超时，请稍后重试');
      return preview;
    },
    async startWork(ideaId, { sourceRef }) {
      log.push(['start', ideaId, sourceRef.taskId]);
      if (startFails) throw new BridgeError('http-500', '内部错误');
      return startResult;
    },
  };
}

test('happy path: create -> preview -> explicit confirm -> start, in order', async () => {
  const client = fakeBridge();
  const shown = [];
  const r = await startWorkFlow({
    client,
    task: task('happy'),
    confirm: async (p) => {
      shown.push(p);
      return true;
    },
  });
  assert.deepEqual(r, { state: 'started', ideaId: 'i1', created: true, taskId: 'w1' });
  assert.deepEqual(
    client.log.map((x) => x[0]),
    ['create', 'preview', 'start'],
  );
  assert.deepEqual(shown, [preview]);
});

test('cancel: confirm returning false never calls start', async () => {
  const client = fakeBridge();
  const r = await startWorkFlow({ client, task: task('cancel-false'), confirm: () => false });
  assert.equal(r.state, 'cancelled');
  assert.equal(r.created, true);
  assert.ok(!client.log.some((x) => x[0] === 'start'));
});

test('cancel: confirm returning a truthy non-true value does not start', async () => {
  const client = fakeBridge();
  const r = await startWorkFlow({ client, task: task('cancel-truthy'), confirm: () => 'yes' });
  assert.equal(r.state, 'cancelled');
  assert.ok(!client.log.some((x) => x[0] === 'start'));
});

test('cancel: a throwing confirm is treated as cancel and does not start', async () => {
  const client = fakeBridge();
  const r = await startWorkFlow({
    client,
    task: task('cancel-throw'),
    confirm: () => {
      throw new Error('dialog unavailable');
    },
  });
  assert.equal(r.state, 'cancelled');
  assert.ok(!client.log.some((x) => x[0] === 'start'));
});

test('failure: create failing stops before preview, confirm, or start', async () => {
  const client = fakeBridge({ createFails: true });
  let asked = false;
  const r = await startWorkFlow({
    client,
    task: task('create-fail'),
    confirm: () => {
      asked = true;
      return true;
    },
  });
  assert.equal(r.state, 'failed');
  assert.equal(r.stage, 'create');
  assert.equal(asked, false);
  assert.deepEqual(client.log, [['create', 'create-fail']]);
});

test('partial: preview failure after idea creation does not start and keeps the idea', async () => {
  const client = fakeBridge({ previewFails: true });
  const r = await startWorkFlow({ client, task: task('preview-fail'), confirm: () => true });
  assert.equal(r.state, 'partial');
  assert.equal(r.stage, 'preview');
  assert.equal(r.ideaId, 'i1');
  assert.ok(!client.log.some((x) => x[0] === 'start'));
});

test('partial: start failing after idea creation reports the idea and can be retried', async () => {
  const client = fakeBridge({ startFails: true });
  const r = await startWorkFlow({ client, task: task('start-fail'), confirm: () => true });
  assert.equal(r.state, 'partial');
  assert.equal(r.stage, 'start');
  assert.equal(r.ideaId, 'i1');
  assert.equal(r.created, true);
});

test('partial: start responding started:false is not reported as success', async () => {
  const client = fakeBridge({ startResult: { started: false, taskId: null } });
  const r = await startWorkFlow({ client, task: task('start-false'), confirm: () => true });
  assert.equal(r.state, 'partial');
  assert.equal(r.stage, 'start');
});

test('double click: a second start for the same todo while in flight is rejected', async () => {
  let release;
  const gate = new Promise((res) => (release = res));
  const client = fakeBridge();
  client.createIdea = async () => {
    await gate;
    return { ideaId: 'i1', created: true };
  };
  const first = startWorkFlow({ client, task: task('dbl'), confirm: () => true });
  const second = await startWorkFlow({ client, task: task('dbl'), confirm: () => true });
  assert.equal(second.state, 'busy');
  release();
  assert.equal((await first).state, 'started');
  // After completion the todo can be started again.
  const again = await startWorkFlow({ client: fakeBridge(), task: task('dbl'), confirm: () => true });
  assert.equal(again.state, 'started');
});

test('invalid task is a validation failure, not an exception', async () => {
  const r = await startWorkFlow({ client: fakeBridge(), task: { title: 'no id' }, confirm: () => true });
  assert.equal(r.state, 'failed');
  assert.equal(r.stage, 'validate');
});

test('toastFor covers every outcome within the length limit', () => {
  const cases = [
    { state: 'started' },
    { state: 'cancelled', created: true },
    { state: 'cancelled', created: false },
    { state: 'busy' },
    { state: 'partial', stage: 'start', ideaId: 'i1', error: 'x'.repeat(400) },
    { state: 'failed', stage: 'create', error: 'AI 任务台当前不可用' },
  ];
  for (const c of cases) {
    const t = toastFor(c);
    assert.equal(typeof t, 'string');
    assert.ok(t.length <= 180, `toast too long: ${t.length}`);
  }
  assert.match(toastFor({ state: 'cancelled', created: true }), /想法已创建/);
});

test('formatPreview shows the resolved project, engine, model and instruction', () => {
  const text = formatPreview(preview);
  for (const s of ['proj-a', 'eng-b', 'm-c', '整理本周待办', '创建 worktree']) {
    assert.ok(text.includes(s), `missing ${s}`);
  }
});
