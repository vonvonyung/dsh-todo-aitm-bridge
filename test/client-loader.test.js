// Regression: the DSH loader accepts a client half only if its factory returns
// a function or an object with an apply() method. Returning {} fails boot with
// "invalid plugin, expect function or object with an \"apply\" method".
// This test runs the REAL built bundle against a fake window and checks that shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeWindow() {
  const listeners = new Map();
  const loads = [];
  const win = {
    loads,
    fetch: async () => {
      throw new Error('no network in tests');
    },
    confirm: () => false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    __dshTodoTaskActions: undefined,
    __ModuleLoader__: {
      load(spec) {
        loads.push(spec);
      },
    },
  };
  return win;
}

function loadBundle(win) {
  const code = fs.readFileSync(path.join(root, 'dist/client.js'), 'utf8');
  const sandbox = { window: win, console: { warn() {}, log() {} }, Promise, setTimeout, clearTimeout, URL, JSON, Object, Array };
  vm.runInNewContext(code, sandbox, { filename: 'dist/client.js' });
  return win.loads;
}

test('the client factory returns a loader-valid plugin: an object with an apply() function', () => {
  const win = fakeWindow();
  const loads = loadBundle(win);
  assert.equal(loads.length, 1, 'bundle must register exactly one client half');
  assert.equal(loads[0].id, 'dsh-todo-aitm-bridge');

  const plugin = loads[0].factory(() => {
    throw new Error('no requires expected');
  });
  const valid =
    typeof plugin === 'function' || (plugin && typeof plugin === 'object' && typeof plugin.apply === 'function');
  assert.ok(valid, `factory returned ${JSON.stringify(plugin)}; loader needs a function or an object with apply()`);
  assert.equal(plugin.name, 'dsh-todo-aitm-bridge');
  assert.deepEqual([...plugin.inject], []); // spread: the bundle runs in another realm
});

test('apply() installs the menu rows and returns a dispose that removes them', () => {
  const win = fakeWindow();
  const registered = [];
  win.__dshTodoTaskActions = {
    apiVersion: 1,
    register(action) {
      registered.push(action.id);
      return () => {};
    },
    subscribe: () => () => {},
    forTask: () => [],
  };
  const loads = loadBundle(win);
  const plugin = loads[0].factory(() => ({}));
  const dispose = plugin.apply({});
  assert.deepEqual(registered.sort(), ['aitm-idea', 'aitm-start']);
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
});

test('apply() without the todo API present does not throw (it waits for the ready event)', () => {
  const win = fakeWindow();
  const loads = loadBundle(win);
  const plugin = loads[0].factory(() => ({}));
  assert.doesNotThrow(() => plugin.apply({}));
});
