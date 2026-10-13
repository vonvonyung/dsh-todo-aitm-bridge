import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, clampText, mapTaskToIdea, sourceRefForTask, MAX_TOAST_LENGTH } from '../src/contract.js';

test('sourceRefForTask uses stringified id and rejects missing ids', () => {
  assert.deepEqual(sourceRefForTask({ id: 42 }), { plugin: 'dsh-todo', taskId: '42' });
  assert.deepEqual(sourceRefForTask({ id: ' t-1 ' }), { plugin: 'dsh-todo', taskId: 't-1' });
  for (const bad of [undefined, null, {}, { id: '' }, { id: '   ' }, { id: {} }]) {
    assert.throws(() => sourceRefForTask(bad), (e) => e instanceof BridgeError && e.code === 'invalid-task');
  }
});

test('mapTaskToIdea forwards only the mapped fields and trims them', () => {
  const idea = mapTaskToIdea({
    id: 'a',
    title: '  写周报  ',
    note: '本周',
    due: '2026-10-20',
    tags: [' work ', '', 3, 'x'],
    internalHandle: { secret: true },
    list: 'inbox',
  });
  assert.deepEqual(idea, {
    protocol: 1,
    sourceRef: { plugin: 'dsh-todo', taskId: 'a' },
    title: '写周报',
    note: '本周',
    due: '2026-10-20',
    tags: ['work', 'x'],
  });
});

test('mapTaskToIdea rejects empty and overlong titles', () => {
  assert.throws(() => mapTaskToIdea({ id: 'a', title: '   ' }), /标题为空/);
  assert.throws(() => mapTaskToIdea({ id: 'a', title: 'x'.repeat(201) }), /超过 200/);
  assert.equal(mapTaskToIdea({ id: 'a', title: 'x'.repeat(200) }).title.length, 200);
});

test('clampText keeps toasts within the todo limit', () => {
  assert.equal(clampText('短'), '短');
  const long = clampText('字'.repeat(500));
  assert.equal(long.length, MAX_TOAST_LENGTH);
  assert.ok(long.endsWith('…'));
});
