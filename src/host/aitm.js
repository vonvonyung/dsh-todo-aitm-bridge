// Adapter over the frozen `aitmBridge` facade provided by ai-tasks-mgr (Bridge v1).
// Everything here is pure: no DOM, no Cordis, no network of its own.

import crypto from 'node:crypto';
import {
  AITM_CALL_TIMEOUT_MS,
  AITM_SERVICE_ID,
  PROTOCOL_VERSION,
  REQUIRED_AITM_CAPABILITIES,
} from '../contract.js';

export const AITM_UNAVAILABLE_MESSAGE = 'AI 任务台当前不可用';
const FACADE_METHODS = ['discovery', 'createIdea', 'previewStart', 'startWork'];

// Error codes the AI 任务台 Bridge v1 emits for user-correctable situations.
// Anything else (including internal errors and unknown codes) collapses to "unavailable".
const PASSTHROUGH_CODES = new Set([
  'bad-request',
  'invalid-idea',
  'invalid-task',
  'invalid-source-ref',
  'missing-idempotency-key',
  'idempotency-conflict',
  'not-found',
  'no-repo',
  'blocked',
  'conflict',
  'engine-not-ready',
]);

export class RouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
    this.code = code;
  }
}

/** The facade must be an object with the four documented methods and protocol 1. */
export function requireFacade(aitm) {
  if (!aitm || typeof aitm !== 'object') {
    throw new RouteError(503, 'aitm-unavailable', AITM_UNAVAILABLE_MESSAGE);
  }
  if (aitm.protocol !== PROTOCOL_VERSION) {
    throw new RouteError(503, 'aitm-incompatible', 'AI 任务台桥接协议版本不兼容');
  }
  for (const m of FACADE_METHODS) {
    if (typeof aitm[m] !== 'function') {
      throw new RouteError(503, 'aitm-incompatible', 'AI 任务台桥接接口不完整');
    }
  }
  return aitm;
}

/** Discovery must name the right service and advertise every capability we call. */
export function requireCompatibleDiscovery(d) {
  const caps = d && Array.isArray(d.capabilities) ? d.capabilities : [];
  const ok =
    d &&
    d.protocol === PROTOCOL_VERSION &&
    d.service === AITM_SERVICE_ID &&
    REQUIRED_AITM_CAPABILITIES.every((c) => caps.includes(c));
  if (!ok) throw new RouteError(503, 'aitm-incompatible', 'AI 任务台桥接版本或能力不兼容');
  return d;
}

export function withTimeout(factory, ms = AITM_CALL_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new RouteError(503, 'aitm-unavailable', 'AI 任务台响应超时')),
      ms,
    );
  });
  return Promise.race([Promise.resolve().then(factory), timeout]).finally(() => clearTimeout(timer));
}

export function toRouteError(err) {
  if (err instanceof RouteError) return err;
  const code = typeof err?.code === 'string' ? err.code : '';
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (code === 'incompatible') {
    return new RouteError(503, 'aitm-incompatible', 'AI 任务台桥接协议版本不兼容');
  }
  if (status >= 400 && status < 500 && PASSTHROUGH_CODES.has(code)) {
    return new RouteError(status, code, String(err.message || '请求失败').slice(0, 200));
  }
  return new RouteError(503, 'aitm-unavailable', AITM_UNAVAILABLE_MESSAGE);
}

/** Run one facade call with a timeout; every failure is mapped to a RouteError. */
export async function call(factory, ms) {
  try {
    return await withTimeout(factory, ms);
  } catch (err) {
    throw toRouteError(err);
  }
}

const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/** Browser-safe, whitelisted view of a start preview. Drops everything else. */
export function previewView(preview) {
  if (!preview || typeof preview !== 'object' || !preview.target || typeof preview.instruction !== 'string') {
    throw new RouteError(503, 'aitm-incompatible', 'AI 任务台返回的启动预览不完整');
  }
  const t = preview.target;
  return {
    target: { project: str(t.project), engine: str(t.engine), model: str(t.model) },
    instruction: preview.instruction,
    sideEffects: Array.isArray(preview.sideEffects)
      ? preview.sideEffects.filter((s) => typeof s === 'string')
      : [],
  };
}

/** Stable digest of the exact preview the user confirmed. */
export function previewDigest(view) {
  return crypto.createHash('sha256').update(JSON.stringify(view)).digest('hex');
}
