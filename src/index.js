// Browser entry: wires the bridge client into the todo task menu.

import { createBridgeClient } from './bridge-client.js';
import { createIdeaAction, defaultConfirm, installTodoMenu, startWorkAction } from './todo-menu.js';

export { createBridgeClient } from './bridge-client.js';
export { installTodoMenu, resolveTodoApi, createIdeaAction, startWorkAction } from './todo-menu.js';
export { startWorkFlow, toastFor, formatPreview } from './start-flow.js';
export { PROTOCOL_VERSION, TODO_TASK_ACTIONS_API_VERSION, TODO_READY_EVENT } from './contract.js';

export function installBridge(scope = globalThis, { bridge, log } = {}) {
  const client = bridge ?? createBridgeClient({ fetchImpl: (...args) => scope.fetch(...args) });
  const confirm = defaultConfirm(scope);
  return installTodoMenu(
    scope,
    [createIdeaAction({ bridge: client }), startWorkAction({ bridge: client, confirm })],
    { log },
  );
}
