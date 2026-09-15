import test from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../examples/offline-memory.mjs';

test('offline synthetic checkpoint demo is repeatable and checks every lifecycle step', () => {
  const expected = [
    'candidate: 0 retrieval hits',
    'confirmed: 1 retrieval hit',
    'reloaded checkpoint: 1 retrieval hit',
    'historical ref retained: source-1@v1',
    'source changed: source-1@v2',
    'stale confirmed claim: 0 retrieval hits',
    'reconciled: needs_review, 0 retrieval hits',
    'refreshed and confirmed: tea=0, water=1',
  ];
  assert.deepEqual(runDemo(), expected);
  assert.deepEqual(runDemo(), expected);
});
