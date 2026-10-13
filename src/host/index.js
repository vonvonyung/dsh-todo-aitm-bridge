/**
 * dsh-todo-aitm-bridge -- host half (runs inside the DSH process).
 *
 * Dependencies are resolved lazily and are all OPTIONAL:
 *   - `aitmBridge` (provided by ai-tasks-mgr's dsh-plugin): the frozen Bridge v1 facade.
 *     Looked up on every request, so a late or missing provider degrades to a disabled
 *     menu row instead of failing to load this plugin.
 *   - `connection` (DSH session admission): missing means every route fails closed.
 *   - `webServer`: needed to serve the browser half at all. In a real DSH host the
 *     webserver starts after cmdlineArgs is ready, so `apply()` can run BEFORE the
 *     service exists. In that case we wait for it with `ctx.inject(['webServer'], fn)`
 *     instead of giving up.
 */

import { BRIDGE_VERSION, PLUGIN_ID, ROUTE_PREFIX } from '../contract.js';
import { createBridgeHttpHandler } from './http.js';

export const name = PLUGIN_ID;
// Nothing is required up front: a missing webServer waits, a missing aitmBridge degrades.
export const inject = [];

export { createBridgeHttpHandler } from './http.js';

const BRIDGE_ROUTE_PREFIX = ROUTE_PREFIX;

function safeGet(ctx, key) {
  try {
    return typeof ctx?.get === 'function' ? (ctx.get(key) ?? null) : null;
  } catch {
    return null;
  }
}

export function apply(ctx, options = {}) {
  const logger = options.logger ?? console;
  const prefix = options.prefix || BRIDGE_ROUTE_PREFIX;
  const get = (key) => safeGet(ctx, key);

  const mount = (scopeCtx, webServer) => {
    if (!webServer || typeof webServer.register !== 'function') return;
    const handler = createBridgeHttpHandler({
      getAitm: () => get('aitmBridge'),
      getConnection: () => get('connection'),
      logger: (m) => logger?.warn?.(`[${PLUGIN_ID}] ${m}`),
      timeoutMs: options.timeoutMs,
    });
    const register = () => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: prefix,
        handler: async (req, res) => handler(req, res),
      });
      return typeof dispose === 'function' ? dispose : () => {};
    };
    if (typeof scopeCtx?.effect === 'function') {
      scopeCtx.effect(register, `${PLUGIN_ID}.http`);
    } else {
      register();
    }
  };

  // Case 1: the webServer already exists (unit tests, or a host that started it first).
  const webServer = get('webServer');
  if (webServer) {
    mount(ctx, webServer);
    return;
  }

  // Case 2: real DSH. The webServer service arrives later; wait for it and mount then.
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const ws = safeGet(webCtx, 'webServer') ?? get('webServer');
      if (ws) mount(webCtx, ws);
    });
    return;
  }

  // Case 3: no webServer and no way to wait for one. Say so and stay degraded.
  logger?.warn?.(
    '[%s] webServer unavailable; browser half cannot reach the bridge (v%s)',
    PLUGIN_ID,
    BRIDGE_VERSION,
  );
}
