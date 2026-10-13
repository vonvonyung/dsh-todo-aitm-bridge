import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as plugin from '../src/host/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A Cordis-like ctx: services live in a map and can be provided late. */
function fakeCtx(services = {}) {
  const map = new Map(Object.entries(services));
  const registrations = [];
  return {
    map,
    registrations,
    get(name) {
      return map.get(name);
    },
    effect(fn) {
      registrations.push(fn());
    },
  };
}

function fakeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
}

function reqFor(pathname, method = 'GET') {
  const req = Readable.from([]);
  req.method = method;
  req.url = pathname;
  req.headers = { host: 'dsh.local:3000', 'sec-fetch-site': 'same-origin' };
  return req;
}

function resFor() {
  const res = { status: 0, text: '' };
  res.writeHead = (s) => (res.status = s);
  res.end = (c) => (res.text = c ?? '');
  return res;
}

test('manifest: exports the Cordis plugin name, no hard inject, and an apply()', () => {
  assert.equal(plugin.name, 'dsh-todo-aitm-bridge');
  assert.deepEqual(plugin.inject, []);
  assert.equal(typeof plugin.apply, 'function');
});

test('apply without webServer degrades: no throw, no route, and a clear warning', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    assert.doesNotThrow(() => plugin.apply(fakeCtx({})));
  } finally {
    console.warn = original;
  }
  assert.ok(warnings.some((w) => /webServer unavailable/.test(w)));
});

test('apply with webServer registers exactly one prefix route under /dsh-todo-aitm-bridge', () => {
  const ws = fakeWebServer();
  plugin.apply(fakeCtx({ webServer: ws }));
  assert.equal(ws.routes.length, 1);
  assert.equal(ws.routes[0].kind, 'prefix');
  assert.equal(ws.routes[0].path, '/dsh-todo-aitm-bridge');
  assert.equal(typeof ws.routes[0].handler, 'function');
});

test('registration goes through ctx.effect when it exists', () => {
  const ws = fakeWebServer();
  const ctx = fakeCtx({ webServer: ws });
  plugin.apply(ctx);
  assert.equal(ctx.registrations.length, 1);
});

test('the route degrades when aitmBridge is absent: health says unavailable, the rest say 503', async () => {
  const ws = fakeWebServer();
  const conn = { admit: () => ({ user: 'u' }) };
  plugin.apply(fakeCtx({ webServer: ws, connection: conn }));
  const handler = ws.routes[0].handler;

  const res = resFor();
  await handler(reqFor('/dsh-todo-aitm-bridge/api/health'), res);
  assert.equal(res.status, 200);
  assert.match(res.text, /"state":"unavailable"/);

  const create = resFor();
  const post = reqFor('/dsh-todo-aitm-bridge/api/ideas', 'POST');
  post.headers['content-type'] = 'application/json';
  // Body is empty here, so validation will answer first; the point is no crash and no leak.
  await handler(post, create);
  assert.ok([400, 503].includes(create.status));
});

test('aitmBridge provided AFTER apply() is picked up on the next request (late load)', async () => {
  const ws = fakeWebServer();
  const ctx = fakeCtx({ webServer: ws, connection: { admit: () => ({ user: 'u' }) } });
  plugin.apply(ctx);
  const handler = ws.routes[0].handler;

  const before = resFor();
  await handler(reqFor('/dsh-todo-aitm-bridge/api/health'), before);
  assert.match(before.text, /"state":"unavailable"/);

  ctx.map.set('aitmBridge', {
    protocol: 1,
    service: 'ai-tasks-mgr',
    capabilities: ['idea.create', 'idea.start-preview', 'idea.start'],
    async discovery() {
      return { protocol: 1, ok: true, service: 'ai-tasks-mgr', capabilities: ['idea.create', 'idea.start-preview', 'idea.start'] };
    },
    async createIdea() {},
    async previewStart() {},
    async startWork() {},
  });

  const after = resFor();
  await handler(reqFor('/dsh-todo-aitm-bridge/api/health'), after);
  assert.match(after.text, /"state":"ready"/);
});

test('a throwing ctx.get is treated as a missing service, not a crash', async () => {
  const ws = fakeWebServer();
  const ctx = {
    get(name) {
      if (name === 'webServer') return ws;
      throw new Error(`service ${name} exploded`);
    },
  };
  plugin.apply(ctx);
  const res = resFor();
  await ws.routes[0].handler(reqFor('/dsh-todo-aitm-bridge/api/health'), res);
  assert.equal(res.status, 401);
});

test('the route refuses requests when the DSH session service is missing (fail closed)', async () => {
  const ws = fakeWebServer();
  plugin.apply(fakeCtx({ webServer: ws }));
  const res = resFor();
  await ws.routes[0].handler(reqFor('/dsh-todo-aitm-bridge/api/health'), res);
  assert.equal(res.status, 401);
  assert.match(res.text, /unauthorized/);
});

test('client manifest: package.json declares the DSH bundle, web client and export entries', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.main, './src/host/index.js');
  assert.equal(pkg.exports['./client'], './dist/client.js');
  assert.ok(pkg.files.includes('dist/client.js'));
  assert.ok(pkg.files.includes('cordis.patch.yml'));
});

test('cordis.patch.yml names this package so the loader can resolve it', () => {
  const text = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(text, /id: dsh-todo-aitm-bridge/);
  assert.match(text, /name: 'dsh-todo-aitm-bridge'/);
});

test('built browser half is a classic script that uses the DSH module loader', () => {
  const js = fs.readFileSync(path.join(root, 'dist/client.js'), 'utf8');
  assert.match(js, /__ModuleLoader__/);
  assert.match(js, /dsh-todo-aitm-bridge/);
  assert.doesNotMatch(js, /^\s*import\s/m, 'browser bundle must not contain ESM imports');
  assert.match(js, /\/dsh-todo-aitm-bridge\/api/);
  assert.doesNotMatch(js, /aitm-plugin\/bridge/, 'browser must never address the AITM facade or its base');
});

// ---------------------------------------------------------------- deferred webServer (real DSH)

/** A ctx like DSH's: webServer is absent at apply() time, and inject() defers the callback. */
function deferredCtx() {
  const services = {};
  const injections = [];
  const ctx = {
    services,
    injections,
    get(name) {
      return services[name];
    },
    inject(deps, fn) {
      injections.push({ deps, fn });
    },
  };
  return ctx;
}

test('webServer not ready at apply(): uses ctx.inject and mounts the route once the service arrives', async () => {
  const ctx = deferredCtx();
  plugin.apply(ctx);

  assert.equal(ctx.injections.length, 1, 'must wait via ctx.inject instead of giving up');
  assert.deepEqual([...ctx.injections[0].deps], ['webServer']);

  // Nothing is mounted before the service exists.
  const ws = fakeWebServer();
  // Real DSH: the webserver starts later and the injected callback runs with a scope ctx.
  ctx.services.webServer = ws;
  ctx.services.connection = { admit: () => ({ user: 'u' }) };
  ctx.injections[0].fn({
    get: (n) => ctx.services[n],
    webServer: ws,
    effect(fn) {
      fn();
    },
  });

  assert.equal(ws.routes.length, 1);
  assert.equal(ws.routes[0].kind, 'prefix');
  assert.equal(ws.routes[0].path, '/dsh-todo-aitm-bridge');

  // The mounted route really serves the API (health with no aitmBridge -> unavailable).
  const res = resFor();
  await ws.routes[0].handler(reqFor('/dsh-todo-aitm-bridge/api/health'), res);
  assert.equal(res.status, 200);
  assert.match(res.text, /"state":"unavailable"/);
});

test('the injected callback without a webServer mounts nothing and does not throw', () => {
  const ctx = deferredCtx();
  plugin.apply(ctx);
  assert.doesNotThrow(() => ctx.injections[0].fn({ get: () => undefined }));
});

test('deferred mount uses the scope ctx effect with a description and keeps the dispose', () => {
  const ctx = deferredCtx();
  plugin.apply(ctx);
  const ws = fakeWebServer();
  const effects = [];
  ctx.injections[0].fn({
    get: () => ws,
    webServer: ws,
    effect(fn, description) {
      effects.push(description);
      return fn();
    },
  });
  assert.deepEqual(effects, ['dsh-todo-aitm-bridge.http']);
  assert.equal(ws.routes.length, 1);
});

test('when webServer is already present, apply() mounts directly and never calls ctx.inject', () => {
  const ctx = deferredCtx();
  ctx.services.webServer = fakeWebServer();
  plugin.apply(ctx);
  assert.equal(ctx.injections.length, 0);
  assert.equal(ctx.services.webServer.routes.length, 1);
});

test('with neither webServer nor inject, apply() warns once and stays degraded', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    plugin.apply({ get: () => undefined });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /webServer unavailable/);
});
