/**
 * dsh-todo-aitm-bridge -- host half (runs inside the DSH process).
 *
 * Dependencies are resolved lazily and are all OPTIONAL:
 *   - `aitmBridge` (provided by ai-tasks-mgr's dsh-plugin): the frozen Bridge v1 facade.
 *     Looked up on every request, so a late or missing provider degrades to a disabled
 *     menu row instead of failing to load this plugin.
 *   - `connection` (DSH session admission): missing means every route fails closed.
 *   - `webServer`: needed to serve the browser half at all.
 */

import { BRIDGE_VERSION, PLUGIN_ID, ROUTE_PREFIX } from '../contract.js';
import { createBridgeHttpHandler } from './http.js';

export const name = PLUGIN_ID;
export const inject = [];

export { createBridgeHttpHandler } from './http.js';

export function apply(ctx) {
  const logger = (msg) => console.warn(`[${PLUGIN_ID}] ${msg}`);
  const get = (svc) => {
    try {
      return ctx?.get?.(svc) ?? null;
    } catch {
      return null;
    }
  };

  const webServer = get('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    logger(`webServer unavailable; browser half cannot reach the bridge (v${BRIDGE_VERSION})`);
    return;
  }

  const handler = createBridgeHttpHandler({
    getAitm: () => get('aitmBridge'),
    getConnection: () => get('connection'),
    logger,
  });

  const register = () =>
    webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => handler(req, res),
    });

  if (typeof ctx.effect === 'function') ctx.effect(register);
  else register();
}
