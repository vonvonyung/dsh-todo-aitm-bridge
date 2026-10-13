// Browser entry, bundled to dist/client.js.
import { installBridge } from './index.js';

const start = () =>
  installBridge(window, {
    log: (msg) => console.warn('[dsh-todo-aitm-bridge]', msg),
  });

if (window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-todo-aitm-bridge',
    factory: () => {
      start();
      return {};
    },
  });
} else {
  start();
}
