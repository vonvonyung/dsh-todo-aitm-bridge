// Browser-side client for the bridge's OWN same-origin routes.
// It never talks to AI 任务台 directly. The host half does that, and it derives
// idempotency keys itself, so this client sends none.

import { BridgeError, PROTOCOL_VERSION } from './contract.js';

export const DEFAULT_BASE = '/dsh-todo-aitm-bridge/api';

/** Map a server error envelope to the menu state it implies. */
function stateForError(status, code) {
  if (code === 'aitm-incompatible') return 'incompatible';
  if (status === 401 || status === 403 || code === 'aitm-unavailable') return 'unavailable';
  // 4xx business errors (conflict, invalid input, preview changed...) mean the bridge itself is reachable.
  if (status >= 400 && status < 500) return 'ready';
  return 'unavailable';
}

export function createBridgeClient({ fetchImpl, base = DEFAULT_BASE, timeoutMs = 10000 } = {}) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  let state = 'unknown'; // unknown | ready | unavailable | incompatible
  let reason = null;
  const listeners = new Set();

  function setState(next, why = null) {
    const changed = next !== state;
    state = next;
    reason = why;
    if (changed) {
      for (const l of [...listeners]) {
        try {
          l(state);
        } catch {
          // a listener must not break the client
        }
      }
    }
  }

  async function request(method, path, { body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init = {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
          setState('unavailable', 'timeout');
          throw new BridgeError('timeout', '连接 AI 任务台超时，请稍后重试');
        }
        setState('unavailable', 'network');
        throw new BridgeError('network', 'AI 任务台当前不可用');
      }

      let data;
      try {
        data = await res.json();
      } catch {
        if (controller.signal.aborted) {
          setState('unavailable', 'timeout');
          throw new BridgeError('timeout', '连接 AI 任务台超时，请稍后重试');
        }
        setState('unavailable', 'bad-response');
        throw new BridgeError('bad-response', '桥接服务返回了无法识别的响应');
      }

      if (!data || typeof data !== 'object' || data.protocol !== PROTOCOL_VERSION) {
        setState('incompatible', 'protocol');
        throw new BridgeError('incompatible', '桥接协议版本不兼容，请更新插件');
      }

      if (!res.ok) {
        const code = (data.error && data.error.code) || `http-${res.status}`;
        const message = (data.error && data.error.message) || '请求失败';
        setState(stateForError(res.status, code), code);
        throw new BridgeError(code, message);
      }
      setState('ready');
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
    /** Menu gating: only states known to be broken disable the row. */
    isUsable() {
      return state !== 'unavailable' && state !== 'incompatible';
    },
    /** Notified whenever the state changes, so the menu can re-render. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Reads the host's view of AI 任务台. Always resolves for a reachable host. */
    async health() {
      const data = await request('GET', '/health');
      const s = data.aitm && data.aitm.state;
      if (s === 'ready') setState('ready');
      else if (s === 'incompatible') setState('incompatible', 'aitm-incompatible');
      else setState('unavailable', 'aitm-unavailable');
      return { state };
    },
    async createIdea(idea) {
      const data = await request('POST', '/ideas', {
        body: {
          sourceRef: idea.sourceRef,
          title: idea.title,
          note: idea.note,
          due: idea.due,
          tags: idea.tags,
        },
      });
      if (typeof data.ideaId !== 'string' || !data.ideaId) {
        throw new BridgeError('bad-response', '桥接服务未返回想法 ID');
      }
      return { ideaId: data.ideaId, created: data.created === true };
    },
    /** Resolved configuration with a digest the user's confirmation is bound to. */
    async previewStart(ideaId) {
      const data = await request('POST', `/ideas/${encodeURIComponent(ideaId)}/start-preview`, {
        body: {},
      });
      const p = data.preview;
      if (!p || typeof p !== 'object' || !p.target || typeof p.instruction !== 'string') {
        throw new BridgeError('bad-response', '启动预览内容不完整');
      }
      if (typeof data.previewDigest !== 'string' || !data.previewDigest) {
        throw new BridgeError('bad-response', '启动预览缺少确认摘要');
      }
      return { ...p, digest: data.previewDigest };
    },
    async startWork(ideaId, { sourceRef, confirmedPreviewDigest }) {
      const data = await request('POST', `/ideas/${encodeURIComponent(ideaId)}/start`, {
        body: { sourceRef, confirmedPreviewDigest },
      });
      return {
        started: data.started === true,
        taskId: typeof data.taskId === 'string' ? data.taskId : null,
        deduplicated: data.deduplicated === true,
      };
    },
  };
}
