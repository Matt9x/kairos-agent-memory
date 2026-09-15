import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyMemoryCommand, buildMemoryIndex, reconcileMemorySources, searchMemory,
} from '../src/features/memory/memoryCore.mjs';

// Entirely synthetic: no messages are imported or sent to a provider.
const now = '2026-09-15T00:00:00.000Z';
const relationshipId = 'synthetic-context';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const request = { relationshipId, now, query: 'tea' };
const command = (kind, extra = {}) => ({ kind, relationshipId, claimId: 'claim-1', now, ...extra });
const search = (state, index = buildMemoryIndex(state)) => searchMemory(index, state, request);

export function runDemo() {
  const content = 'The synthetic participant prefers tea for the afternoon break.';
  let state = {
    relationships: [{ id: relationshipId, state: 'active' }],
    sources: [{ id: 'source-1', relationshipId, content, sourceVersion: 'v1', sourceDigest: digest(content), visibility: 'active' }],
    claims: [{
      id: 'claim-1', relationshipId, statement: 'Tea is the preferred afternoon drink.',
      status: 'candidate', visibility: 'active', sourceVersion: 'v1', sourceDigest: digest('tea-claim-v1'),
      sources: [{ sourceId: 'source-1', sourceVersion: 'v1', sourceDigest: digest(content) }],
      createdAt: now, updatedAt: now, validFrom: now,
    }],
  };
  const lines = [];
  assert.equal(search(state).length, 0);
  lines.push('candidate: 0 retrieval hits');
  state = applyMemoryCommand(state, command('confirm'));
  assert.equal(search(state).length, 1);
  lines.push('confirmed: 1 retrieval hit');

  // Example-only JSON checkpoint. This is not an encrypted, transactional,
  // concurrent or crash-safe production storage implementation.
  const directory = mkdtempSync(join(tmpdir(), 'kairos-memory-demo-'));
  const checkpoint = join(directory, 'checkpoint.json');
  let written = false;
  try {
    writeFileSync(checkpoint, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' });
    written = true;
    state = JSON.parse(readFileSync(checkpoint, 'utf8'));
    assert.equal(search(state).length, 1);
    lines.push('reloaded checkpoint: 1 retrieval hit');

    const oldIndex = buildMemoryIndex(state);
    const revised = 'The synthetic participant now prefers water for the afternoon break.';
    state.sources[0] = { ...state.sources[0], content: revised, sourceVersion: 'v2', sourceDigest: digest(revised) };
    assert.equal(search(state, oldIndex).length, 0);
    lines.push('changed source, old index: 0 retrieval hits');

    state = reconcileMemorySources(state, request);
    assert.equal(state.claims[0].status, 'needs_review');
    assert.equal(state.claims[0].invalidatedAt, now);
    writeFileSync(checkpoint, JSON.stringify(state), 'utf8');
    state = JSON.parse(readFileSync(checkpoint, 'utf8'));
    assert.equal(state.claims[0].status, 'needs_review');
    assert.equal(search(state).length, 0);
    lines.push('reloaded invalidation: needs_review, 0 retrieval hits');

    state = applyMemoryCommand(state, command('edit', {
      statement: 'Water is the preferred afternoon drink.', sourceVersion: 'v2', sourceDigest: digest('water-claim-v2'),
      sources: [{ sourceId: 'source-1', sourceVersion: 'v2', sourceDigest: digest(revised) }],
    }));
    state = applyMemoryCommand(state, command('confirm'));
    assert.equal(search(state).length, 0);
    assert.equal(searchMemory(buildMemoryIndex(state), state, { ...request, query: 'water' }).length, 1);
    lines.push('refreshed and confirmed: tea=0, water=1');
  } finally {
    if (written) unlinkSync(checkpoint);
    rmdirSync(directory);
  }
  return lines;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(runDemo().join('\n'));
