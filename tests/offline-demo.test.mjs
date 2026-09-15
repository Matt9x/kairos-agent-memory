import test from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../examples/offline-memory.mjs';

test('offline synthetic checkpoint demo is repeatable and checks every lifecycle step', () => {
  const expected = [
    'candidate: 0 retrieval hits',
    'confirmed: 1 retrieval hit',
    'reloaded checkpoint: 1 retrieval hit',
    'changed source, old index: 0 retrieval hits',
    'reloaded invalidation: needs_review, 0 retrieval hits',
    'refreshed and confirmed: tea=0, water=1',
  ];
  assert.deepEqual(runDemo(), expected);
  assert.deepEqual(runDemo(), expected);
});
