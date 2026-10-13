import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TODO_READY_EVENT } from '../src/contract.js';
import {
  createIdeaAction,
  defaultConfirm,
  installTodoMenu,
  resolveTodoApi,
  startWorkAction,
} from '../src/todo-menu.js';
import { installBridge } from '../src/index.js';

/** Minimal stand-in for window with the v1 task-action registry. */
function fakeScope({ version = 1, omitMethods = [] } = {}) {
  const listeners = new Map();
  const scope = {
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ type });
    },
    registered: [],
    disposed: [],
  };
  const api = {
    apiVersion: version,
    register(action) {
      scope.registered.push(action);
      const record = { action };
      return () => scope.disposed.push(record.action.id);
    },
    subscribe: () => () => {},
    forTask: () => [],
  };
  for (const m of omitMethods) delete api[m];
  scope.__dshTodoTaskActions = api;
  return scope;
}

const usableBridge = (overrides = {}) => ({
  isUsable: () => true,
  createIdea: async () => ({ ideaId: 'i1', created: true }),
  previewStart: async () => ({ target: {}, instruction: 'x' }),
  startWork: async () => ({ started: true, taskId: 'w' }),
  ...overrides,
});

test('resolveTodoApi distinguishes absent, mismatched, incomplete, and ok', () => {
  assert.equal(resolveTodoApi({}).reason, 'absent');
  assert.deepEqual(resolveTodoApi({ __dshTodoTaskActions: { apiVersion: 2 } }), {
    ok: false,
    reason: 'version-mismatch',
    found: 2,
  });
  assert.equal(resolveTodoApi(fakeScope({ omitMethods: ['subscribe'] })).reason, 'incomplete');
  assert.equal(resolveTodoApi(fakeScope()).ok, true);
});

test('installs immediately when the todo API is already present', () => {
  const scope = fakeScope();
  installTodoMenu(scope, [createIdeaAction({ bridge: usableBridge() })]);
  assert.deepEqual(scope.registered.map((a) => a.id), ['aitm-idea']);
});

test('late load: waits for the ready event, then registers', () => {
  const scope = fakeScope();
  delete scope.__dshTodoTaskActions;
  installTodoMenu(scope, [createIdeaAction({ bridge: usableBridge() })]);
  assert.equal(scope.registered.length, 0);
  const late = fakeScope();
  scope.__dshTodoTaskActions = late.__dshTodoTaskActions;
  scope.registered = late.registered;
  scope.dispatch(TODO_READY_EVENT);
  assert.equal(scope.registered.length, 1);
});

test('ready event repeated after install does not register twice', () => {
  const scope = fakeScope();
  installTodoMenu(scope, [createIdeaAction({ bridge: usableBridge() })]);
  scope.dispatch(TODO_READY_EVENT);
  scope.dispatch(TODO_READY_EVENT);
  assert.equal(scope.registered.length, 1);
});

test('version mismatch: does not overwrite or register anything, and logs', () => {
  const scope = fakeScope({ version: 2 });
  const original = scope.__dshTodoTaskActions;
  const logs = [];
  installTodoMenu(scope, [createIdeaAction({ bridge: usableBridge() })], { log: (m) => logs.push(m) });
  assert.equal(scope.__dshTodoTaskActions, original);
  assert.equal(scope.registered.length, 0);
  assert.match(logs[0], /version-mismatch/);
});

test('a throwing register is logged and does not break the other actions', () => {
  const scope = fakeScope();
  const logs = [];
  scope.__dshTodoTaskActions.register = (action) => {
    if (action.id === 'aitm-idea') throw new Error('bad action');
    scope.registered.push(action);
    return () => {};
  };
  installTodoMenu(scope, [createIdeaAction({ bridge: usableBridge() }), startWorkAction({ bridge: usableBridge(), confirm: () => true })], {
    log: (m) => logs.push(m),
  });
  assert.deepEqual(scope.registered.map((a) => a.id), ['aitm-start']);
  assert.match(logs[0], /aitm-idea/);
});

test('dispose removes our registrations and the ready listener', () => {
  const scope = fakeScope();
  const dispose = installTodoMenu(scope, [createIdeaAction({ bridge: usableBridge() })]);
  dispose();
  assert.deepEqual(scope.disposed, ['aitm-idea']);
  assert.equal(scope.listeners.get(TODO_READY_EVENT).size, 0);
});

test('createIdea row: disabled when the bridge is unusable, otherwise enabled', () => {
  const action = createIdeaAction({ bridge: usableBridge({ isUsable: () => false }) });
  assert.equal(action.enabled({ id: 't' }), false);
  assert.equal(action.disabledReason({ id: 't' }), 'AI 任务台当前不可用');
  assert.equal(createIdeaAction({ bridge: usableBridge() }).enabled({ id: 't' }), true);
});

test('createIdea row: returns a success toast and never mutates the todo', async () => {
  const seen = [];
  const action = createIdeaAction({
    bridge: usableBridge({
      createIdea: async (idea) => {
        seen.push(idea);
        return { ideaId: 'i1', created: true };
      },
    }),
  });
  const toast = await action.run({ id: 't1', title: '写周报' }, {});
  assert.match(toast, /原待办保持不变/);
  assert.equal(seen[0].sourceRef.taskId, 't1');
});

test('createIdea row: an existing link reports no duplicate', async () => {
  const action = createIdeaAction({
    bridge: usableBridge({ createIdea: async () => ({ ideaId: 'i1', created: false }) }),
  });
  assert.match(await action.run({ id: 't1', title: 'x' }, {}), /未重复创建/);
});

test('startWork row: cancel via the dialog yields a toast and no start call', async () => {
  let started = false;
  const action = startWorkAction({
    bridge: usableBridge({
      startWork: async () => {
        started = true;
        return { started: true };
      },
    }),
    confirm: () => false,
  });
  const toast = await action.run({ id: 't1', title: 'x' }, {});
  assert.match(toast, /已取消/);
  assert.equal(started, false);
});

test('defaultConfirm fails closed when no native dialog exists', () => {
  assert.equal(defaultConfirm({})({ target: {}, instruction: 'x' }), false);
  assert.equal(defaultConfirm({ confirm: () => 1 })({ target: {}, instruction: 'x' }), false);
  assert.equal(defaultConfirm({ confirm: () => true })({ target: {}, instruction: 'x' }), true);
});

test('installBridge wires both rows into the todo registry', () => {
  const scope = fakeScope();
  scope.confirm = () => true;
  const dispose = installBridge(scope, { bridge: usableBridge() });
  assert.deepEqual(scope.registered.map((a) => a.id), ['aitm-idea', 'aitm-start']);
  dispose();
});

test('refresh re-registers our rows so an AI 任务台 outage shows a disabled row without reopening the menu', async () => {
  const { createBridgeClient } = await import('../src/bridge-client.js');
  const scope = fakeScope();
  scope.confirm = () => true;
  let online = true;
  const fetchImpl = async () => {
    if (online) return { ok: true, status: 200, json: async () => ({ protocol: 1, ok: true, aitm: { state: 'ready' } }) };
    return { ok: false, status: 503, json: async () => ({ protocol: 1, ok: false, error: { code: 'aitm-unavailable', message: 'AI 任务台当前不可用' } }) };
  };
  const client = createBridgeClient({ fetchImpl });
  const dispose = installBridge(scope, { bridge: client });
  await client.health();
  assert.equal(client.isUsable(), true);

  online = false;
  await client.health().catch(() => {});
  assert.equal(client.isUsable(), false);
  // Re-registered rows: the latest record reflects the new state.
  const latest = scope.registered.filter((a) => a.id === 'aitm-idea').at(-1);
  assert.equal(latest.enabled({ id: 't' }), false);
  assert.equal(latest.disabledReason({ id: 't' }), 'AI 任务台当前不可用');
  dispose();
});

test('installBridge tolerates a bridge without subscribe/health (test doubles)', () => {
  const scope = fakeScope();
  const dispose = installBridge(scope, { bridge: usableBridge() });
  assert.equal(scope.registered.length, 2);
  dispose();
});
