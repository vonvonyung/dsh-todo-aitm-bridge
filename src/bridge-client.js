// Browser-side client for the bridge's OWN same-origin routes.
// It never talks to AI 任务台 directly; the bridge's host half does that.
// Routes below are the bridge's own contract (v1) and must match the server half.

import {
  BridgeError,
  PROTOCOL_VERSION,
  ideaIdempotencyKey,
  startIdempotencyKey,
} from './contract.js';

export const DEFAULT_BASE = '/dsh-todo-aitm-bridge/api';

export function createBridgeClient({ fetchImpl, base = DEFAULT_BASE, timeoutMs = 10000 } = {}) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  let state = 'unknown'; // unknown | ready | unavailable | incompatible
  let reason = null;

  function setState(next, why = null) {
    state = next;
    reason = why;
  }

  async function request(method, path, { body, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init = {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        credentials: 'same-origin',
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);

      let res;
      try {
        res = await doFetch(base + path, init);
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw new BridgeError('timeout', '连接 AI 任务台超时，请稍后重试');
        }
        setState('unavailable', 'network');
        throw new BridgeError('network', 'AI 任务台当前不可用');
      }

      let data;
      try {
        data = await res.json();
      } catch (err) {
        if (controller.signal.aborted) {
          throw new BridgeError('timeout', '连接 AI 任务台超时，请稍后重试');
        }
        setState('unavailable', 'bad-response');
        throw new BridgeError('bad-response', '桥接服务返回了无法识别的响应');
      }

      if (!data || typeof data !== 'object' || data.protocol !== PROTOCOL_VERSION) {
        setState('incompatible', 'protocol');
        throw new BridgeError('incompatible', '桥接协议版本不兼容，请更新插件');
      }
      setState('ready');
      if (!res.ok) {
        const code = (data.error && data.error.code) || `http-${res.status}`;
        const message = (data.error && data.error.message) || '请求失败';
        throw new BridgeError(code, message);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get state() {
      return state;
    },
    get reason() {
      return reason;
    },
    /** Menu gating: only states that are known to be broken disable the row. */
    isUsable() {
      return state !== 'unavailable' && state !== 'incompatible';
    },
    async health() {
      return request('GET', '/health');
    },
    /** Idempotent by sourceRef on the server; a retry returns the existing idea. */
    async createIdea(idea) {
      const data = await request('POST', '/ideas', {
        body: idea,
        headers: { 'idempotency-key': ideaIdempotencyKey(idea.sourceRef) },
      });
      if (typeof data.ideaId !== 'string' || !data.ideaId) {
        throw new BridgeError('bad-response', '桥接服务未返回想法 ID');
      }
      return { ideaId: data.ideaId, created: data.created === true };
    },
    /** Resolved project/engine configuration that a start would use. Read-only. */
    async previewStart(ideaId) {
      const data = await request('POST', `/ideas/${encodeURIComponent(ideaId)}/start-preview`, {
        body: {},
      });
      const p = data.preview;
      if (!p || typeof p !== 'object' || !p.target || typeof p.instruction !== 'string') {
        throw new BridgeError('bad-response', '启动预览内容不完整');
      }
      return p;
    },
    async startWork(ideaId, { sourceRef }) {
      const data = await request('POST', `/ideas/${encodeURIComponent(ideaId)}/start`, {
        body: {},
        headers: { 'idempotency-key': startIdempotencyKey(sourceRef, ideaId) },
      });
      return { started: data.started === true, taskId: typeof data.taskId === 'string' ? data.taskId : null };
    },
  };
}
