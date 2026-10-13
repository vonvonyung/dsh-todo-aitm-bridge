// Browser entry, bundled to dist/client.js.
//
// The DSH module loader accepts a client half only when its factory returns a
// function or an object with an apply() method (the same shape the other DSH
// client halves use). Returning {} fails boot with
// "invalid plugin, expect function or object with an \"apply\" method".
import { installBridge } from './index.js';

const plugin = {
  name: 'dsh-todo-aitm-bridge',
  // No Cordis services are needed: the todo menu is reached through window.__dshTodoTaskActions.
  inject: [],
  // Returns the dispose function from installBridge, so teardown can remove the menu rows.
  apply() {
    return installBridge(window, {
      log: (msg) => console.warn('[dsh-todo-aitm-bridge]', msg),
    });
  },
};

if (window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-todo-aitm-bridge',
    factory: () => plugin,
  });
} else {
  plugin.apply();
}
