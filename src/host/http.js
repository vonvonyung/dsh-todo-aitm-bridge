// Host half: same-origin routes under /dsh-todo-aitm-bridge/api/* for the browser half.
// Only four fixed routes exist. No generic action forwarding, no L3, no bridge token.

import {
  API_BASE,
  BRIDGE_VERSION,
  MAX_BODY_BYTES,
  PLUGIN_ID,
  PROTOCOL_VERSION,
  SOURCE_PLUGIN,
  ideaIdempotencyKey,
  startIdempotencyKey,
} from '../contract.js';
import {
  RouteError,
  call,
  previewDigest,
  previewView,
  requireCompatibleDiscovery,
  requireFacade,
  toRouteError,
} from './aitm.js';

const IDEA_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

const ROUTES = [
  { method: 'GET', re: /^\/health$/, name: 'health' },
  { method: 'POST', re: /^\/ideas$/, name: 'createIdea' },
  { method: 'POST', re: /^\/ideas\/([^/]+)\/start-preview$/, name: 'previewStart' },
  { method: 'POST', re: /^\/ideas\/([^/]+)\/start$/, name: 'startWork' },
];

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function header(req, name) {
  const v = req?.headers?.[name];
  return typeof v === 'string' ? v.trim() : '';
}

/** Reject cross-site requests and Origin/Host mismatches. */
export function checkOrigin(req) {
  if (header(req, 'sec-fetch-site').toLowerCase() === 'cross-site') {
    return { ok: false, code: 'forbidden-origin', message: '拒绝跨站请求' };
  }
  const origin = header(req, 'origin');
  if (origin) {
    if (origin === 'null') return { ok: false, code: 'forbidden-origin', message: '拒绝匿名源请求' };
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return { ok: false, code: 'forbidden-origin', message: '非法的 Origin 请求头' };
    }
    const host = header(req, 'host').toLowerCase();
    if (!host || originHost !== host) {
      return { ok: false, code: 'forbidden-origin', message: '拒绝跨源请求' };
    }
  }
  return { ok: true };
}

/** Fail closed: no DSH session service, or a rejected admission, means no access. */
export function admitSession(req, connection) {
  const unauthorized = {
    ok: false,
    status: 401,
    code: 'unauthorized',
    message: '未通过 DSH 会话认证',
  };
  if (!connection || typeof connection.admit !== 'function') return unauthorized;
  let admission;
  try {
    admission = connection.admit(req);
  } catch {
    return unauthorized;
  }
  if (admission && !('rejection' in admission)) return { ok: true };
  if (admission?.rejection === 403) {
    return { ok: false, status: 403, code: 'forbidden', message: '请求被 DSH 安全边界拒绝' };
  }
  return unauthorized;
}

function parseSourceRef(raw) {
  if (!isObj(raw)) throw new RouteError(400, 'invalid-source-ref', '缺少有效的 sourceRef');
  // The plugin is pinned: the browser cannot claim to be another source.
  const taskId =
    typeof raw.taskId === 'string'
      ? raw.taskId.trim()
      : typeof raw.taskId === 'number' && Number.isFinite(raw.taskId)
        ? String(raw.taskId)
        : '';
  if (!taskId || taskId.length > 128) {
    throw new RouteError(400, 'invalid-source-ref', 'sourceRef.taskId 必须为 1–128 个字符');
  }
  return { plugin: SOURCE_PLUGIN, taskId };
}

function parseIdeaId(raw) {
  if (typeof raw !== 'string' || !IDEA_ID_RE.test(raw)) {
    throw new RouteError(400, 'invalid-idea', '想法 ID 格式不正确');
  }
  return raw;
}

function parseCreateBody(body) {
  const sourceRef = parseSourceRef(body.sourceRef);

  const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new RouteError(400, 'invalid-task', '想法标题不能为空');
  if (title.length > 200) throw new RouteError(400, 'invalid-task', '想法标题不能超过 200 个字符');

  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    throw new RouteError(400, 'invalid-task', 'note 必须为字符串');
  }
  const note = typeof body.note === 'string' ? body.note.slice(0, 20_000) : '';

  if (body.due !== undefined && body.due !== null && typeof body.due !== 'string') {
    throw new RouteError(400, 'invalid-task', 'due 必须为字符串或 null');
  }
  const due = typeof body.due === 'string' && body.due.trim() ? body.due.trim().slice(0, 64) : null;

  if (body.tags !== undefined && body.tags !== null) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== 'string')) {
      throw new RouteError(400, 'invalid-task', 'tags 必须为字符串数组');
    }
  }
  const tags = Array.isArray(body.tags)
    ? body.tags.map((t) => t.trim().slice(0, 32)).filter(Boolean).slice(0, 12)
    : [];

  return { sourceRef, title, note, due, tags };
}

/** Facade readiness: present, shaped correctly, and discovery says compatible. */
async function readyAitm(getAitm, timeoutMs) {
  const aitm = requireFacade(getAitm());
  requireCompatibleDiscovery(await call(() => aitm.discovery(), timeoutMs));
  return aitm;
}

function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v; // stays invalid, so parseIdeaId rejects it
  }
}

function safeGet(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

export function createBridgeHttpHandler({
  getAitm,
  getConnection,
  logger = () => {},
  timeoutMs = undefined,
}) {
  const handlers = {
    async health() {
      let state = 'unavailable';
      try {
        await readyAitm(() => safeGet(getAitm), timeoutMs);
        state = 'ready';
      } catch (err) {
        const e = err instanceof RouteError ? err : toRouteError(err);
        if (e.code === 'aitm-incompatible') state = 'incompatible';
      }
      return { protocol: PROTOCOL_VERSION, ok: true, service: PLUGIN_ID, version: BRIDGE_VERSION, aitm: { state } };
    },

    async createIdea(body) {
      const input = parseCreateBody(body);
      const aitm = await readyAitm(() => safeGet(getAitm), timeoutMs);
      const r = await call(
        () =>
          aitm.createIdea(
            { protocol: PROTOCOL_VERSION, ...input },
            { idempotencyKey: ideaIdempotencyKey(input.sourceRef) },
          ),
        timeoutMs,
      );
      if (!r || typeof r.ideaId !== 'string' || !r.ideaId) {
        throw new RouteError(503, 'aitm-incompatible', 'AI 任务台未返回想法 ID');
      }
      return { protocol: PROTOCOL_VERSION, ok: true, ideaId: r.ideaId, created: r.created === true };
    },

    async previewStart(_body, [rawId]) {
      const ideaId = parseIdeaId(rawId);
      const aitm = await readyAitm(() => safeGet(getAitm), timeoutMs);
      const r = await call(() => aitm.previewStart(ideaId, {}), timeoutMs);
      const view = previewView(r?.preview);
      return {
        protocol: PROTOCOL_VERSION,
        ok: true,
        ideaId,
        preview: view,
        previewDigest: previewDigest(view),
      };
    },

    async startWork(body, [rawId]) {
      const ideaId = parseIdeaId(rawId);
      const sourceRef = parseSourceRef(body.sourceRef);
      // Explicit confirmation must bind to the exact preview the user saw.
      if (typeof body.confirmedPreviewDigest !== 'string' || !DIGEST_RE.test(body.confirmedPreviewDigest)) {
        throw new RouteError(400, 'confirmation-required', '启动前必须先确认启动配置');
      }
      const aitm = await readyAitm(() => safeGet(getAitm), timeoutMs);

      const current = await call(() => aitm.previewStart(ideaId, {}), timeoutMs);
      if (previewDigest(previewView(current?.preview)) !== body.confirmedPreviewDigest) {
        throw new RouteError(409, 'preview-changed', '启动配置已变化，请重新确认后再开始');
      }

      const r = await call(
        () =>
          aitm.startWork(
            ideaId,
            { sourceRef },
            { idempotencyKey: startIdempotencyKey(sourceRef, ideaId) },
          ),
        timeoutMs,
      );
      return {
        protocol: PROTOCOL_VERSION,
        ok: true,
        ideaId,
        started: r?.started === true,
        taskId: typeof r?.taskId === 'string' ? r.taskId : null,
        deduplicated: r?.deduplicated === true,
      };
    },
  };

  function matchRoute(method, sub) {
    let pathMatched = false;
    for (const r of ROUTES) {
      const m = r.re.exec(sub);
      if (!m) continue;
      pathMatched = true;
      if (r.method === method) return { name: r.name, args: m.slice(1).map(safeDecode) };
    }
    if (pathMatched) throw new RouteError(405, 'method-not-allowed', '该接口不支持此请求方法');
    throw new RouteError(404, 'not-found', '未开放该桥接端点');
  }

  function readJsonBody(req, max = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
      const declared = Number(header(req, 'content-length') || 0);
      if (declared > max) return reject(new RouteError(413, 'bad-request', '请求体过大'));
      const ct = header(req, 'content-type').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') {
        return reject(new RouteError(415, 'bad-request', '需要 application/json 请求体'));
      }
      const chunks = [];
      let size = 0;
      let failed = false;
      req.on('data', (c) => {
        if (failed) return;
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
        size += buf.length;
        if (size > max) {
          failed = true;
          reject(new RouteError(413, 'bad-request', '请求体过大'));
          return;
        }
        chunks.push(buf);
      });
      req.on('end', () => {
        if (failed) return;
        if (chunks.length === 0) return resolve({});
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return reject(new RouteError(400, 'bad-request', '请求体不是合法 JSON'));
        }
        if (!isObj(parsed)) return reject(new RouteError(400, 'bad-request', '请求体必须为 JSON 对象'));
        resolve(parsed);
      });
      req.on('error', () => reject(new RouteError(400, 'bad-request', '读取请求体失败')));
    });
  }

  function send(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  }

  function sendError(res, e) {
    send(res, e.status, {
      protocol: PROTOCOL_VERSION,
      ok: false,
      error: { code: e.code, message: e.message },
    });
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    if (pathname !== API_BASE && !pathname.startsWith(`${API_BASE}/`)) {
      sendError(res, new RouteError(404, 'not-found', '未开放该路径'));
      return true;
    }
    const sub = pathname.slice(API_BASE.length) || '/';

    const origin = checkOrigin(req);
    if (!origin.ok) {
      sendError(res, new RouteError(403, origin.code, origin.message));
      return true;
    }

    const admission = admitSession(req, safeGet(getConnection));
    if (!admission.ok) {
      sendError(res, new RouteError(admission.status, admission.code, admission.message));
      return true;
    }

    try {
      const route = matchRoute(req.method, sub);
      const body = route.name === 'health' ? {} : await readJsonBody(req);
      const data = await handlers[route.name](body, route.args);
      send(res, 200, data);
    } catch (err) {
      const e = err instanceof RouteError ? err : toRouteError(err);
      if (e.status >= 500) logger(`bridge ${sub} unavailable: ${e.code}`);
      sendError(res, e);
    }
    return true;
  };
}
