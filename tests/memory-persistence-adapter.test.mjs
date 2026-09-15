import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryPersistenceAdapter } from '../src/features/memory/memoryPersistenceAdapter.mjs';

const now = '2026-09-12T00:00:00.000Z';
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function fixture() {
  const state = {
    relationships: [
      { id: 'r1', state: 'active' },
      { id: 'r2', state: 'active' },
    ],
    evidenceItems: [
      { id: 'e1', relationship_id: 'r1', content: '晚饭后散步', source_version: 'v1', source_digest: 'digest-e1', valid_from: now, valid_until: null, invalidated_at: null },
      { id: 'e2', relationship_id: 'r2', content: 'foreign canary', source_version: 'v1', source_digest: 'digest-e2', valid_from: now, valid_until: null, invalidated_at: null },
    ],
    memoryClaims: [
      { id: 'candidate', relationship_id: 'r1', statement: '她喜欢散步', status: 'candidate', source_version: 'v1', source_digest: 'digest-candidate', lineage_json: '["e1"]', valid_from: now, valid_until: null, invalidated_at: null, created_at: now, updated_at: now },
      { id: 'confirmed', relationship_id: 'r1', statement: '她喜欢散步', status: 'confirmed', source_version: 'v1', source_digest: 'digest-confirmed', lineage_json: '["e1"]', valid_from: now, valid_until: null, invalidated_at: null, created_at: now, updated_at: now },
      { id: 'foreign', relationship_id: 'r2', statement: 'foreign canary', status: 'confirmed', source_version: 'v1', source_digest: 'digest-foreign', lineage_json: '["e2"]', valid_from: now, valid_until: null, invalidated_at: null, created_at: now, updated_at: now },
    ],
    receipts: [],
  };
  const commands = new Map();
  let writes = 0;
  const port = {
    async readMemoryScope({ relationshipId }) {
      return clone({
        relationship: state.relationships.find((row) => row.id === relationshipId) ?? null,
        evidenceItems: state.evidenceItems.filter((row) => row.relationship_id === relationshipId),
        memoryClaims: state.memoryClaims.filter((row) => row.relationship_id === relationshipId),
        receipts: state.receipts.filter((row) => row.relationshipId === relationshipId),
      });
    },
    async lookupMemoryCommand({ commandId }) { return clone(commands.get(commandId)); },
    async persistMemoryCommand({ commandId, relationshipId, command, desiredClaim }) {
      if (commands.has(commandId)) return clone(commands.get(commandId));
      writes++;
      const row = state.memoryClaims.find((item) => item.id === command.claimId && item.relationship_id === relationshipId);
      Object.assign(row, {
        statement: desiredClaim.statement,
        status: desiredClaim.status,
        source_version: desiredClaim.sourceVersion,
        source_digest: desiredClaim.sourceDigest,
        lineage_json: JSON.stringify(desiredClaim.sources.map((source) => source.sourceId)),
        valid_from: desiredClaim.validFrom ?? null,
        valid_until: desiredClaim.validUntil ?? null,
        invalidated_at: desiredClaim.invalidatedAt ?? null,
        updated_at: desiredClaim.updatedAt,
      });
      const receipt = { command: clone(command), status: 'persisted' };
      commands.set(commandId, receipt);
      return clone(receipt);
    },
    async trash({ commandId, receiptId, relationshipId, artifactId, command }) {
      if (commands.has(commandId)) return clone(commands.get(commandId));
      writes++;
      state.receipts.push({ id: receiptId, relationshipId, artifactId, status: 'trashed', targets: [{ table: 'memory_claims', id: artifactId }] });
      const receipt = { command: clone(command), status: 'trashed' };
      commands.set(commandId, receipt);
      return clone(receipt);
    },
  };
  return { state, port, writes: () => writes };
}

const request = (overrides = {}) => ({ relationshipId: 'r1', claimId: 'candidate', kind: 'confirm', now, commandId: 'cmd-1', ...overrides });

test('projects only current scoped canonical evidence and claims with explicit provenance', async () => {
  const f = fixture();
  const adapter = createMemoryPersistenceAdapter(f.port);
  const snapshot = await adapter.readScopedMemory({ relationshipId: 'r1', now });
  assert.deepEqual(snapshot.relationships, [{ id: 'r1', state: 'active' }]);
  assert.deepEqual(snapshot.sources.map((source) => [source.id, source.sourceVersion, source.sourceDigest]), [['e1', 'v1', 'digest-e1']]);
  assert.deepEqual(snapshot.claims.map((claim) => [claim.id, claim.sources[0].sourceId]), [['candidate', 'e1'], ['confirmed', 'e1']]);
  assert.equal('database' in adapter, false);
  assert.equal('store' in adapter, false);
  assert.equal('readMemoryScope' in adapter, false);
});

test('rejects a canonical scope that leaks another relationship', async () => {
  const f = fixture();
  const original = f.port.readMemoryScope;
  f.port.readMemoryScope = async (scope) => {
    const result = await original(scope);
    result.evidenceItems.push(clone(f.state.evidenceItems[1]));
    return result;
  };
  await assert.rejects(createMemoryPersistenceAdapter(f.port).readScopedMemory({ relationshipId: 'r1', now }), { code: 'CANONICAL_PROJECTION_INVALID' });
});

test('fails closed when canonical evidence omits a provenance field', async () => {
  const f = fixture();
  delete f.state.evidenceItems[0].source_digest;
  await assert.rejects(createMemoryPersistenceAdapter(f.port).readScopedMemory({ relationshipId: 'r1', now }), { code: 'CANONICAL_PROJECTION_INVALID' });
});

test('fails closed on malformed scoped lifecycle receipts instead of treating them as visible', async () => {
  const f = fixture();
  f.state.receipts.push({ id: 'bad', relationshipId: 'r1', status: 'trashed', targets: [] });
  await assert.rejects(createMemoryPersistenceAdapter(f.port).readScopedMemory({ relationshipId: 'r1', now }), { code: 'CANONICAL_PROJECTION_INVALID' });
});

test('persists a validated confirm once and returns the native idempotency receipt on retry', async () => {
  const f = fixture();
  const adapter = createMemoryPersistenceAdapter(f.port);
  assert.deepEqual(await adapter.execute(request()), { command: request(), status: 'persisted' });
  assert.equal(f.state.memoryClaims.find((row) => row.id === 'candidate').status, 'confirmed');
  assert.deepEqual(await adapter.execute(request()), { command: request(), status: 'persisted' });
  assert.equal(f.writes(), 1);
});

test('persists typed edit, archive and supersede commands only after core transition validation', async () => {
  const f = fixture();
  const adapter = createMemoryPersistenceAdapter(f.port);
  Object.assign(f.state.evidenceItems[0], { source_version: 'v2', source_digest: 'digest-e1-v2' });
  await adapter.execute(request({ kind: 'edit', commandId: 'cmd-edit', statement: '她现在喜欢散步', sourceVersion: 'v2', sourceDigest: 'digest-candidate-v2', sources: [{ sourceId: 'e1', sourceVersion: 'v2', sourceDigest: 'digest-e1-v2' }] }));
  assert.equal(f.state.memoryClaims.find((row) => row.id === 'candidate').status, 'needs_review');
  await adapter.execute(request({ kind: 'archive', commandId: 'cmd-archive' }));
  assert.equal(f.state.memoryClaims.find((row) => row.id === 'candidate').status, 'archived');

  const second = fixture();
  const secondAdapter = createMemoryPersistenceAdapter(second.port);
  await secondAdapter.execute(request({ commandId: 'cmd-confirm-replacement' }));
  await secondAdapter.execute(request({ claimId: 'confirmed', kind: 'supersede', replacementClaimId: 'candidate', commandId: 'cmd-supersede' }));
  assert.equal(second.state.memoryClaims.find((row) => row.id === 'confirmed').status, 'superseded');
});

test('routes delete through a receipt and keeps that claim out of scoped reads', async () => {
  const f = fixture();
  const adapter = createMemoryPersistenceAdapter(f.port);
  const result = await adapter.execute(request({ claimId: 'confirmed', kind: 'delete', commandId: 'cmd-delete', receiptId: 'receipt-delete' }));
  assert.equal(result.status, 'trashed');
  const snapshot = await adapter.readScopedMemory({ relationshipId: 'r1', now });
  assert.deepEqual(snapshot.claims.map((claim) => claim.id), ['candidate']);
  assert.deepEqual(await adapter.searchMemory({ relationshipId: 'r1', now, query: '散步' }), []);
});

test('rejects a delete without a lifecycle receipt before native mutation', async () => {
  const f = fixture();
  await assert.rejects(createMemoryPersistenceAdapter(f.port).execute(request({ claimId: 'confirmed', kind: 'delete', commandId: 'cmd-no-receipt' })), { code: 'RECEIPT_ID_REQUIRED' });
  assert.equal(f.writes(), 0);
});

test('external source writer explicitly rebuilds the disposable lexical index after a source edit', async () => {
  const f = fixture();
  const adapter = createMemoryPersistenceAdapter(f.port);
  assert.deepEqual((await adapter.searchMemory({ relationshipId: 'r1', now, query: '散步' })).map((row) => row.claimId), ['confirmed']);
  Object.assign(f.state.evidenceItems[0], { content: '晚饭后喝茶', source_version: 'v2', source_digest: 'digest-e1-v2' });
  Object.assign(f.state.memoryClaims[1], { statement: '她喜欢喝茶', source_version: 'v2', source_digest: 'digest-confirmed-v2' });
  await adapter.rebuildLexicalIndex({ relationshipId: 'r1', now });
  assert.deepEqual(await adapter.searchMemory({ relationshipId: 'r1', now, query: '散步' }), []);
  assert.deepEqual((await adapter.searchMemory({ relationshipId: 'r1', now, query: '喝茶' })).map((row) => row.claimId), ['confirmed']);
});

for (const [table, id] of [['evidence_items', 'e1'], ['memory_claims', 'confirmed'], ['relationships', 'r1']]) {
  test(`rejects purged receipt with retained ${table} target before projecting active data`, async () => {
    const f = fixture();
    f.state.receipts.push({ id: 'purged', relationshipId: 'r1', status: 'purged', targets: [{ table, id }] });
    const adapter = createMemoryPersistenceAdapter(f.port);
    await assert.rejects(adapter.readScopedMemory({ relationshipId: 'r1', now }), { code: 'CANONICAL_PROJECTION_INVALID' });
    await assert.rejects(adapter.searchMemory({ relationshipId: 'r1', now, query: '散步' }), { code: 'CANONICAL_PROJECTION_INVALID' });
  });
}

for (const targets of [
  [{ table: 'unknown', id: 'e1' }],
  [{ table: 'relationships', id: 'r2' }],
  [{ table: 'evidence_items', id: 'e1' }, { table: 'evidence_items', id: 'e1' }],
]) {
  test(`rejects semantically invalid receipt targets ${JSON.stringify(targets)}`, async () => {
    const f = fixture();
    f.state.receipts.push({ id: 'invalid-targets', relationshipId: 'r1', status: 'restored', targets });
    await assert.rejects(createMemoryPersistenceAdapter(f.port).readScopedMemory({ relationshipId: 'r1', now }), { code: 'CANONICAL_PROJECTION_INVALID' });
  });
}

test('validates every receipt even after an earlier receipt hides the relationship', async () => {
  const f = fixture();
  f.state.receipts.push(
    { id: 'hidden', relationshipId: 'r1', status: 'trashed', targets: [{ table: 'relationships', id: 'r1' }] },
    { id: 'invalid', relationshipId: 'r1', status: 'success', targets: [{ table: 'memory_claims', id: 'confirmed' }] },
  );
  await assert.rejects(createMemoryPersistenceAdapter(f.port).readScopedMemory({ relationshipId: 'r1', now }), { code: 'CANONICAL_PROJECTION_INVALID' });
});

test('allows historical purged targets only when physically absent', async () => {
  const f = fixture();
  f.state.receipts.push({ id: 'purged', relationshipId: 'r1', status: 'purged', targets: [{ table: 'memory_claims', id: 'old-removed' }] });
  assert.equal((await createMemoryPersistenceAdapter(f.port).searchMemory({ relationshipId: 'r1', now, query: '散步' })).length, 1);
});

for (const stage of ['lookupMemoryCommand', 'persistMemoryCommand', 'trash']) {
  for (const mutation of ['malformed', 'relationship', 'claim', 'commandId', 'kind', 'now', 'status', 'payload']) {
    test(`${stage} rejects ${mutation} success receipt`, async () => {
      const f = fixture();
      const command = request(stage === 'trash' ? { kind: 'delete', receiptId: 'delete-1' } : { kind: 'edit', statement: '喝茶', sourceVersion: 'v2' });
      const wrong = clone(command);
      if (mutation === 'relationship') wrong.relationshipId = 'r2';
      if (mutation === 'claim') wrong.claimId = 'foreign';
      if (mutation === 'commandId') wrong.commandId = 'unrelated';
      if (mutation === 'kind') wrong.kind = 'archive';
      if (mutation === 'now') wrong.now = '2026-09-11T00:00:00.000Z';
      if (mutation === 'payload') stage === 'trash' ? wrong.receiptId = 'other' : wrong.statement = 'other';
      f.port[stage] = async () => mutation === 'malformed' ? {} : { command: wrong, status: mutation === 'status' ? 'deleting' : stage === 'trash' ? 'trashed' : 'persisted' };
      await assert.rejects(createMemoryPersistenceAdapter(f.port).execute(command), { code: 'COMMAND_RECEIPT_INVALID' });
      assert.equal(f.writes(), 0);
    });
  }
}

for (const kind of ['confirm', 'edit', 'archive', 'supersede']) {
  test(`rejects ${kind} success without the requested canonical transition`, async () => {
    const f = fixture();
    const command = request({ kind, ...(kind === 'edit' ? { statement: '喝茶', sourceVersion: 'v2' } : {}), ...(kind === 'archive' || kind === 'supersede' ? { claimId: 'confirmed' } : {}), ...(kind === 'supersede' ? { replacementClaimId: 'candidate' } : {}) });
    if (kind === 'supersede') f.state.memoryClaims[0].status = 'confirmed';
    f.port.persistMemoryCommand = async ({ command }) => ({ command, status: 'persisted' });
    await assert.rejects(createMemoryPersistenceAdapter(f.port).execute(command), { code: 'COMMAND_NOT_APPLIED' });
  });
}

test('rejects a writer that changes status but omits the requested edited text/provenance', async () => {
  const f = fixture();
  const persist = f.port.persistMemoryCommand;
  f.port.persistMemoryCommand = async (input) => {
    const result = await persist(input);
    f.state.memoryClaims[0].statement = 'old text';
    return result;
  };
  await assert.rejects(createMemoryPersistenceAdapter(f.port).execute(request({ kind: 'edit', statement: '喝茶', sourceVersion: 'v2' })), { code: 'COMMAND_NOT_APPLIED' });
});

for (const lifecycle of ['absent', 'wrong-id', 'wrong-target', 'deleting', 'restored']) {
  test(`rejects delete success with ${lifecycle} canonical lifecycle receipt`, async () => {
    const f = fixture();
    const command = request({ kind: 'delete', receiptId: 'delete-1' });
    f.port.trash = async () => {
      if (lifecycle !== 'absent') f.state.receipts.push({
        id: lifecycle === 'wrong-id' ? 'other' : command.receiptId, relationshipId: 'r1',
        status: ['deleting', 'restored'].includes(lifecycle) ? lifecycle : 'trashed',
        targets: [{ table: 'memory_claims', id: lifecycle === 'wrong-target' ? 'confirmed' : 'candidate' }],
      });
      return { command, status: 'trashed' };
    };
    await assert.rejects(createMemoryPersistenceAdapter(f.port).execute(command), { code: 'COMMAND_NOT_APPLIED' });
  });
}

test('retry fails closed when a stored receipt has no matching current claim transition', async () => {
  const f = fixture();
  f.port.lookupMemoryCommand = async () => ({ command: request(), status: 'persisted' });
  await assert.rejects(createMemoryPersistenceAdapter(f.port).execute(request()), { code: 'COMMAND_NOT_APPLIED' });
  assert.equal(f.writes(), 0);
});

test('delete retry verifies receipt and stays idempotent', async () => {
  const f = fixture();
  const adapter = createMemoryPersistenceAdapter(f.port);
  const command = request({ kind: 'delete', receiptId: 'delete-1' });
  assert.deepEqual(await adapter.execute(command), { command, status: 'trashed' });
  assert.deepEqual(await adapter.execute(command), { command, status: 'trashed' });
  assert.equal(f.writes(), 1);
});

test('external source deletion and explicit rebuild remove indexed claims', async () => {
  const f = fixture();
  const adapter = createMemoryPersistenceAdapter(f.port);
  await adapter.searchMemory({ relationshipId: 'r1', now, query: '散步' });
  f.state.receipts.push({ id: 'source-delete', relationshipId: 'r1', status: 'trashed', targets: [
    { table: 'evidence_items', id: 'e1' }, { table: 'memory_claims', id: 'candidate' }, { table: 'memory_claims', id: 'confirmed' },
  ] });
  await adapter.rebuildLexicalIndex({ relationshipId: 'r1', now });
  assert.deepEqual(await adapter.searchMemory({ relationshipId: 'r1', now, query: '散步' }), []);
});

test('fails closed before reads or writes when the native canonical port is unavailable', async () => {
  const adapter = createMemoryPersistenceAdapter();
  await assert.rejects(adapter.readScopedMemory({ relationshipId: 'r1', now }), { code: 'PERSISTENCE_UNAVAILABLE' });
  await assert.rejects(adapter.execute(request()), { code: 'PERSISTENCE_UNAVAILABLE' });
});
