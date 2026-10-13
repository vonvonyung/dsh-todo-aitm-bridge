(() => {
  // src/contract.js
  var PROTOCOL_VERSION = 1;
  var TODO_TASK_ACTIONS_API_VERSION = 1;
  var TODO_READY_EVENT = "dsh-todo-task-actions-ready";
  var SOURCE_PLUGIN = "dsh-todo";
  var MAX_TITLE_LENGTH = 200;
  var MAX_TOAST_LENGTH = 180;
  var BridgeError = class extends Error {
    constructor(code, message) {
      super(message);
      this.name = "BridgeError";
      this.code = code;
    }
  };
  function sourceRefForTask(task) {
    const raw = task && task.id;
    const id = typeof raw === "number" || typeof raw === "string" ? String(raw).trim() : "";
    if (!id) throw new BridgeError("invalid-task", "\u5F85\u529E\u7F3A\u5C11\u6709\u6548 ID");
    return { plugin: SOURCE_PLUGIN, taskId: id };
  }
  function mapTaskToIdea(task) {
    const sourceRef = sourceRefForTask(task);
    const title = typeof task.title === "string" ? task.title.trim() : "";
    if (!title) throw new BridgeError("invalid-task", "\u5F85\u529E\u6807\u9898\u4E3A\u7A7A");
    if (title.length > MAX_TITLE_LENGTH) {
      throw new BridgeError("invalid-task", `\u5F85\u529E\u6807\u9898\u8D85\u8FC7 ${MAX_TITLE_LENGTH} \u4E2A\u5B57\u7B26`);
    }
    return {
      protocol: PROTOCOL_VERSION,
      sourceRef,
      title,
      note: typeof task.note === "string" ? task.note : "",
      due: typeof task.due === "string" && task.due ? task.due : null,
      tags: Array.isArray(task.tags) ? task.tags.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : []
    };
  }
  function clampText(text, max = MAX_TOAST_LENGTH) {
    const s = String(text);
    return s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
  }
  var ROUTE_PREFIX = "/dsh-todo-aitm-bridge";
  var API_BASE = `${ROUTE_PREFIX}/api`;
  var REQUIRED_AITM_CAPABILITIES = Object.freeze(["idea.create", "idea.start-preview", "idea.start"]);
  var MAX_BODY_BYTES = 64 * 1024;

  // src/bridge-client.js
  var DEFAULT_BASE = "/dsh-todo-aitm-bridge/api";
  function stateForError(status, code) {
    if (code === "aitm-incompatible") return "incompatible";
    if (status === 401 || status === 403 || code === "aitm-unavailable") return "unavailable";
    if (status >= 400 && status < 500) return "ready";
    return "unavailable";
  }
  function createBridgeClient({ fetchImpl, base = DEFAULT_BASE, timeoutMs = 1e4 } = {}) {
    const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    let state = "unknown";
    let reason = null;
    const listeners = /* @__PURE__ */ new Set();
    function setState(next, why = null) {
      const changed = next !== state;
      state = next;
      reason = why;
      if (changed) {
        for (const l of [...listeners]) {
          try {
            l(state);
          } catch {
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
            accept: "application/json",
            ...body === void 0 ? {} : { "content-type": "application/json" }
          },
          credentials: "same-origin",
          signal: controller.signal
        };
        if (body !== void 0) init.body = JSON.stringify(body);
        let res;
        try {
          res = await doFetch(base + path, init);
        } catch (err) {
          if (err && err.name === "AbortError") {
            setState("unavailable", "timeout");
            throw new BridgeError("timeout", "\u8FDE\u63A5 AI \u4EFB\u52A1\u53F0\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
          }
          setState("unavailable", "network");
          throw new BridgeError("network", "AI \u4EFB\u52A1\u53F0\u5F53\u524D\u4E0D\u53EF\u7528");
        }
        let data;
        try {
          data = await res.json();
        } catch {
          if (controller.signal.aborted) {
            setState("unavailable", "timeout");
            throw new BridgeError("timeout", "\u8FDE\u63A5 AI \u4EFB\u52A1\u53F0\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
          }
          setState("unavailable", "bad-response");
          throw new BridgeError("bad-response", "\u6865\u63A5\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u54CD\u5E94");
        }
        if (!data || typeof data !== "object" || data.protocol !== PROTOCOL_VERSION) {
          setState("incompatible", "protocol");
          throw new BridgeError("incompatible", "\u6865\u63A5\u534F\u8BAE\u7248\u672C\u4E0D\u517C\u5BB9\uFF0C\u8BF7\u66F4\u65B0\u63D2\u4EF6");
        }
        if (!res.ok) {
          const code = data.error && data.error.code || `http-${res.status}`;
          const message = data.error && data.error.message || "\u8BF7\u6C42\u5931\u8D25";
          setState(stateForError(res.status, code), code);
          throw new BridgeError(code, message);
        }
        setState("ready");
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
        return state !== "unavailable" && state !== "incompatible";
      },
      /** Notified whenever the state changes, so the menu can re-render. */
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      /** Reads the host's view of AI 任务台. Always resolves for a reachable host. */
      async health() {
        const data = await request("GET", "/health");
        const s = data.aitm && data.aitm.state;
        if (s === "ready") setState("ready");
        else if (s === "incompatible") setState("incompatible", "aitm-incompatible");
        else setState("unavailable", "aitm-unavailable");
        return { state };
      },
      async createIdea(idea) {
        const data = await request("POST", "/ideas", {
          body: {
            sourceRef: idea.sourceRef,
            title: idea.title,
            note: idea.note,
            due: idea.due,
            tags: idea.tags
          }
        });
        if (typeof data.ideaId !== "string" || !data.ideaId) {
          throw new BridgeError("bad-response", "\u6865\u63A5\u670D\u52A1\u672A\u8FD4\u56DE\u60F3\u6CD5 ID");
        }
        return { ideaId: data.ideaId, created: data.created === true };
      },
      /** Resolved configuration with a digest the user's confirmation is bound to. */
      async previewStart(ideaId) {
        const data = await request("POST", `/ideas/${encodeURIComponent(ideaId)}/start-preview`, {
          body: {}
        });
        const p = data.preview;
        if (!p || typeof p !== "object" || !p.target || typeof p.instruction !== "string") {
          throw new BridgeError("bad-response", "\u542F\u52A8\u9884\u89C8\u5185\u5BB9\u4E0D\u5B8C\u6574");
        }
        if (typeof data.previewDigest !== "string" || !data.previewDigest) {
          throw new BridgeError("bad-response", "\u542F\u52A8\u9884\u89C8\u7F3A\u5C11\u786E\u8BA4\u6458\u8981");
        }
        return { ...p, digest: data.previewDigest };
      },
      async startWork(ideaId, { sourceRef, confirmedPreviewDigest }) {
        const data = await request("POST", `/ideas/${encodeURIComponent(ideaId)}/start`, {
          body: { sourceRef, confirmedPreviewDigest }
        });
        return {
          started: data.started === true,
          taskId: typeof data.taskId === "string" ? data.taskId : null,
          deduplicated: data.deduplicated === true
        };
      }
    };
  }

  // src/start-flow.js
  var inFlight = /* @__PURE__ */ new Map();
  function formatPreview(preview) {
    const t = preview.target || {};
    const lines = [
      "\u5C06\u5728 AI \u4EFB\u52A1\u53F0\u5F00\u59CB\u5DE5\u4F5C\uFF0C\u4F7F\u7528\u4EE5\u4E0B\u73B0\u6709\u914D\u7F6E\uFF1A",
      `\u9879\u76EE\uFF1A${t.project ?? "(\u672A\u77E5)"}`,
      `\u5F15\u64CE\uFF1A${t.engine ?? "(\u672A\u77E5)"}`,
      `\u6A21\u578B\uFF1A${t.model ?? "(\u672A\u77E5)"}`,
      "",
      `\u6307\u4EE4\uFF1A${preview.instruction}`
    ];
    if (Array.isArray(preview.sideEffects) && preview.sideEffects.length) {
      lines.push("", "\u526F\u4F5C\u7528\uFF1A", ...preview.sideEffects.map((s) => `- ${s}`));
    }
    return lines.join("\n");
  }
  function startWorkFlow({ client, task, confirm }) {
    let sourceRef;
    try {
      sourceRef = sourceRefForTask(task);
    } catch (err) {
      return Promise.resolve({ state: "failed", stage: "validate", error: err.message });
    }
    const key = `${sourceRef.plugin}:${sourceRef.taskId}`;
    if (inFlight.has(key)) return Promise.resolve({ state: "busy" });
    const p = run(client, task, sourceRef, confirm).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }
  async function run(client, task, sourceRef, confirm) {
    let idea;
    try {
      idea = await client.createIdea(mapTaskToIdea(task));
    } catch (err) {
      return { state: "failed", stage: "create", error: messageOf(err) };
    }
    const base = { ideaId: idea.ideaId, created: idea.created };
    let preview;
    try {
      preview = await client.previewStart(idea.ideaId);
    } catch (err) {
      return { ...base, state: "partial", stage: "preview", error: messageOf(err) };
    }
    let approved = false;
    try {
      approved = await confirm(preview) === true;
    } catch {
      approved = false;
    }
    if (!approved) return { ...base, state: "cancelled" };
    try {
      const r = await client.startWork(idea.ideaId, {
        sourceRef,
        confirmedPreviewDigest: preview.digest
      });
      if (!r.started) {
        return { ...base, state: "partial", stage: "start", error: "AI \u4EFB\u52A1\u53F0\u672A\u786E\u8BA4\u542F\u52A8" };
      }
      return { ...base, state: "started", taskId: r.taskId };
    } catch (err) {
      return { ...base, state: "partial", stage: "start", error: messageOf(err) };
    }
  }
  function messageOf(err) {
    return err instanceof BridgeError ? err.message : "\u672A\u77E5\u9519\u8BEF";
  }
  function toastFor(result) {
    switch (result.state) {
      case "started":
        return clampText("\u5DF2\u5728 AI \u4EFB\u52A1\u53F0\u5F00\u59CB\u5DE5\u4F5C\uFF0C\u539F\u5F85\u529E\u4FDD\u6301\u4E0D\u53D8");
      case "cancelled":
        return clampText(result.created ? "\u5DF2\u53D6\u6D88\u542F\u52A8\uFF1B\u60F3\u6CD5\u5DF2\u521B\u5EFA\uFF0C\u672A\u5F00\u59CB\u5DE5\u4F5C" : "\u5DF2\u53D6\u6D88\uFF0C\u672A\u5F00\u59CB\u5DE5\u4F5C");
      case "busy":
        return clampText("\u8BE5\u5F85\u529E\u6B63\u5728\u5904\u7406\u4E2D\uFF0C\u8BF7\u7A0D\u5019");
      case "partial": {
        const where = { preview: "\u65E0\u6CD5\u83B7\u53D6\u542F\u52A8\u914D\u7F6E", start: "\u542F\u52A8\u5DE5\u4F5C\u5931\u8D25" }[result.stage] ?? "\u540E\u7EED\u6B65\u9AA4\u5931\u8D25";
        return clampText(`\u60F3\u6CD5\u5DF2\u521B\u5EFA\uFF0C\u4F46${where}\uFF1A${result.error ?? ""}\u3002\u53EF\u7A0D\u540E\u91CD\u8BD5`);
      }
      default:
        return clampText(`\u65E0\u6CD5\u5728 AI \u4EFB\u52A1\u53F0\u521B\u5EFA\u60F3\u6CD5\uFF1A${result.error ?? ""}`);
    }
  }

  // src/todo-menu.js
  function resolveTodoApi(scope) {
    const api = scope && scope.__dshTodoTaskActions;
    if (!api) return { ok: false, reason: "absent" };
    if (api.apiVersion !== TODO_TASK_ACTIONS_API_VERSION) {
      return { ok: false, reason: "version-mismatch", found: api.apiVersion };
    }
    if (typeof api.register !== "function" || typeof api.subscribe !== "function" || typeof api.forTask !== "function") {
      return { ok: false, reason: "incomplete" };
    }
    return { ok: true, api };
  }
  function createIdeaAction({ bridge }) {
    return {
      id: "aitm-idea",
      label: "\u5728 AI \u4EFB\u52A1\u53F0\u521B\u5EFA\u60F3\u6CD5",
      order: 200,
      visible: () => true,
      enabled: () => bridge.isUsable(),
      disabledReason: () => "AI \u4EFB\u52A1\u53F0\u5F53\u524D\u4E0D\u53EF\u7528",
      run: async (task) => {
        const { created } = await bridge.createIdea(mapTaskToIdea(task));
        return created ? "\u5DF2\u5728 AI \u4EFB\u52A1\u53F0\u521B\u5EFA\u60F3\u6CD5\uFF0C\u539F\u5F85\u529E\u4FDD\u6301\u4E0D\u53D8" : "\u8BE5\u5F85\u529E\u5DF2\u6709\u5173\u8054\u60F3\u6CD5\uFF0C\u672A\u91CD\u590D\u521B\u5EFA";
      }
    };
  }
  function startWorkAction({ bridge, confirm }) {
    return {
      id: "aitm-start",
      label: "\u5728 AI \u4EFB\u52A1\u53F0\u5F00\u59CB\u5DE5\u4F5C",
      order: 210,
      visible: () => true,
      enabled: () => bridge.isUsable(),
      disabledReason: () => "AI \u4EFB\u52A1\u53F0\u5F53\u524D\u4E0D\u53EF\u7528",
      run: async (task) => {
        const result = await startWorkFlow({ client: bridge, task, confirm });
        return toastFor(result);
      }
    };
  }
  function defaultConfirm(scope) {
    return (preview) => {
      if (!scope || typeof scope.confirm !== "function") return false;
      return scope.confirm(formatPreview(preview)) === true;
    };
  }
  function installTodoMenu(scope, actions, { log = () => {
  } } = {}) {
    const disposers = [];
    let installed = false;
    const tryInstall = () => {
      if (installed) return;
      const r = resolveTodoApi(scope);
      if (!r.ok) {
        if (r.reason !== "absent") log(`todo task actions unavailable: ${r.reason}`);
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
    const hasListeners = scope && typeof scope.addEventListener === "function";
    if (hasListeners) scope.addEventListener(TODO_READY_EVENT, tryInstall);
    tryInstall();
    const dispose = () => {
      if (hasListeners) scope.removeEventListener(TODO_READY_EVENT, tryInstall);
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch {
        }
      }
      installed = false;
    };
    dispose.refresh = () => {
      if (!installed) return;
      const r = resolveTodoApi(scope);
      if (!r.ok) return;
      for (const action of actions) {
        try {
          disposers.push(r.api.register(action));
        } catch (err) {
          log(`failed to refresh action ${action.id}: ${err && err.message}`);
        }
      }
    };
    return dispose;
  }

  // src/index.js
  function installBridge(scope = globalThis, { bridge, log } = {}) {
    const client = bridge ?? createBridgeClient({ fetchImpl: (...args) => scope.fetch(...args) });
    const confirm = defaultConfirm(scope);
    const dispose = installTodoMenu(
      scope,
      [createIdeaAction({ bridge: client }), startWorkAction({ bridge: client, confirm })],
      { log }
    );
    const unsubscribe = typeof client.subscribe === "function" ? client.subscribe(() => dispose.refresh()) : () => {
    };
    if (typeof client.health === "function") client.health().catch(() => {
    });
    return () => {
      unsubscribe();
      dispose();
    };
  }

  // src/client-entry.js
  var plugin = {
    name: "dsh-todo-aitm-bridge",
    // No Cordis services are needed: the todo menu is reached through window.__dshTodoTaskActions.
    inject: [],
    // Returns the dispose function from installBridge, so teardown can remove the menu rows.
    apply() {
      return installBridge(window, {
        log: (msg) => console.warn("[dsh-todo-aitm-bridge]", msg)
      });
    }
  };
  if (window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === "function") {
    window.__ModuleLoader__.load({
      id: "dsh-todo-aitm-bridge",
      factory: () => plugin
    });
  } else {
    plugin.apply();
  }
})();
