// Integration with the todo app's task-action extension point (apiVersion 1).
// The bridge only registers rows; it never renders the todo menu itself and
// never touches window.__dshTodoTaskActions when the version is not 1.

import {
  TODO_READY_EVENT,
  TODO_TASK_ACTIONS_API_VERSION,
  mapTaskToIdea,
} from './contract.js';
import { startWorkFlow, toastFor, formatPreview } from './start-flow.js';

export function resolveTodoApi(scope) {
  const api = scope && scope.__dshTodoTaskActions;
  if (!api) return { ok: false, reason: 'absent' };
  if (api.apiVersion !== TODO_TASK_ACTIONS_API_VERSION) {
    return { ok: false, reason: 'version-mismatch', found: api.apiVersion };
  }
  if (
    typeof api.register !== 'function' ||
    typeof api.subscribe !== 'function' ||
    typeof api.forTask !== 'function'
  ) {
    return { ok: false, reason: 'incomplete' };
  }
  return { ok: true, api };
}

/** Phase 1: create a linked idea. The original todo is left untouched. */
export function createIdeaAction({ bridge }) {
  return {
    id: 'aitm-idea',
    label: '在 AI 任务台创建想法',
    order: 200,
    visible: () => true,
    enabled: () => bridge.isUsable(),
    disabledReason: () => 'AI 任务台当前不可用',
    run: async (task) => {
      const { created } = await bridge.createIdea(mapTaskToIdea(task));
      return created ? '已在 AI 任务台创建想法，原待办保持不变' : '该待办已有关联想法，未重复创建';
    },
  };
}

/** Phase 2: create if needed, then start work after explicit confirmation. */
export function startWorkAction({ bridge, confirm }) {
  return {
    id: 'aitm-start',
    label: '在 AI 任务台开始工作',
    order: 210,
    visible: () => true,
    enabled: () => bridge.isUsable(),
    disabledReason: () => 'AI 任务台当前不可用',
    run: async (task) => {
      const result = await startWorkFlow({ client: bridge, task, confirm });
      return toastFor(result);
    },
  };
}

/** Default confirm: native dialog, fail closed when no dialog is available. */
export function defaultConfirm(scope) {
  return (preview) => {
    if (!scope || typeof scope.confirm !== 'function') return false;
    return scope.confirm(formatPreview(preview)) === true;
  };
}

/**
 * Register actions now, or when the todo app announces readiness.
 * Returns a dispose function that removes the listener and our registrations.
 */
export function installTodoMenu(scope, actions, { log = () => {} } = {}) {
  const disposers = [];
  let installed = false;

  const tryInstall = () => {
    if (installed) return;
    const r = resolveTodoApi(scope);
    if (!r.ok) {
      if (r.reason !== 'absent') log(`todo task actions unavailable: ${r.reason}`);
      return;
    }
    installed = true;
    for (const action of actions) {
      try {
        disposers.push(r.api.register(action));
      } catch (err) {
        log(`failed to register action ${action.id}: ${err && err.message}`);
      }
    }
  };

  const hasListeners = scope && typeof scope.addEventListener === 'function';
  if (hasListeners) scope.addEventListener(TODO_READY_EVENT, tryInstall);
  tryInstall();

  return () => {
    if (hasListeners) scope.removeEventListener(TODO_READY_EVENT, tryInstall);
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // a stale disposer must not break teardown
      }
    }
    installed = false;
  };
}
