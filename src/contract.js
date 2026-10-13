// Shared constants and pure helpers for the todo -> AI 任务台 bridge.
// No DOM, no network: safe to import from both the browser half and tests.

export const PROTOCOL_VERSION = 1;
export const TODO_TASK_ACTIONS_API_VERSION = 1;
export const TODO_READY_EVENT = 'dsh-todo-task-actions-ready';
export const SOURCE_PLUGIN = 'dsh-todo';
export const MAX_TITLE_LENGTH = 200;
export const MAX_TOAST_LENGTH = 180;

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/** Stable link from an AI 任务台 object back to the source todo. */
export function sourceRefForTask(task) {
  const raw = task && task.id;
  const id = typeof raw === 'number' || typeof raw === 'string' ? String(raw).trim() : '';
  if (!id) throw new BridgeError('invalid-task', '待办缺少有效 ID');
  return { plugin: SOURCE_PLUGIN, taskId: id };
}

/**
 * Field mapping for idea.create (v1). Only the fields listed here are sent;
 * the todo snapshot is never forwarded wholesale.
 */
export function mapTaskToIdea(task) {
  const sourceRef = sourceRefForTask(task);
  const title = typeof task.title === 'string' ? task.title.trim() : '';
  if (!title) throw new BridgeError('invalid-task', '待办标题为空');
  if (title.length > MAX_TITLE_LENGTH) {
    throw new BridgeError('invalid-task', `待办标题超过 ${MAX_TITLE_LENGTH} 个字符`);
  }
  return {
    protocol: PROTOCOL_VERSION,
    sourceRef,
    title,
    note: typeof task.note === 'string' ? task.note : '',
    due: typeof task.due === 'string' && task.due ? task.due : null,
    tags: Array.isArray(task.tags)
      ? task.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
      : [],
  };
}

export function ideaIdempotencyKey(sourceRef) {
  return `${sourceRef.plugin}:${sourceRef.taskId}:idea`;
}

export function startIdempotencyKey(sourceRef, ideaId) {
  return `${sourceRef.plugin}:${sourceRef.taskId}:start:${ideaId}`;
}

export function clampText(text, max = MAX_TOAST_LENGTH) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// ---- Host-side constants (Bridge v1 of this plugin's own routes + AI 任务台 Bridge v1) ----
export const PLUGIN_ID = 'dsh-todo-aitm-bridge';
export const BRIDGE_VERSION = '0.2.1';
export const ROUTE_PREFIX = '/dsh-todo-aitm-bridge';
export const API_BASE = `${ROUTE_PREFIX}/api`;
export const AITM_SERVICE_ID = 'ai-tasks-mgr';
export const REQUIRED_AITM_CAPABILITIES = Object.freeze(['idea.create', 'idea.start-preview', 'idea.start']);
export const MAX_BODY_BYTES = 64 * 1024;
export const AITM_CALL_TIMEOUT_MS = 15000;
