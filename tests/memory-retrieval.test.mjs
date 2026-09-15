import test from 'node:test';
import assert from 'node:assert/strict';

const core = await import('../src/features/memory/memoryCore.mjs').catch(() => ({}));
const bench = await import('../src/features/retrieval/benchmark.mjs').catch(() => ({}));
const now = '2026-09-09T00:00:00.000Z';
const createdAt = '2026-06-11T00:00:00.000Z';
const source = (id = 's1', patch = {}) => ({ id, relationshipId: 'a', content: '周末一起散步', sourceVersion: 'v1', sourceDigest: 'digest-1', visibility: 'active', ...patch });
const claim = (id = 'c1', patch = {}) => ({ id, relationshipId: 'a', statement: '周末一起散步', status: 'confirmed', sourceVersion: 'v1', sourceDigest: 'claim-digest', sources: [{ sourceId: 's1', sourceVersion: 'v1', sourceDigest: 'digest-1' }], visibility: 'active', createdAt, updatedAt: createdAt, validFrom: createdAt, ...patch });
const snapshot = (claims = [claim()], sources = [source()]) => ({ relationships: [{ id: 'a', state: 'active' }, { id: 'b', state: 'active' }], claims, sources });
const search = (s, query = '散步', index = core.buildMemoryIndex(s)) => core.searchMemory(index, s, { relationshipId: 'a', query, now });

test('only active confirmed claims enter retrieval; pending states remain reviewable', () => {
  assert.equal(typeof core.searchMemory, 'function');
  const s = snapshot(['candidate', 'confirmed', 'needs_review', 'superseded', 'archived', 'trashed', 'purged'].map((status) => claim(status, { status })));
  assert.deepEqual(search(s).map((r) => r.claimId), ['confirmed']);
  assert.deepEqual(core.pendingClaims(s, { relationshipId: 'a', now }).map((r) => r.id), ['candidate', 'needs_review']);
  for (const patch of [{ invalidatedAt: now }, { validFrom: '2099-01-01T00:00:00.000Z' }, { validUntil: now }, { visibility: 'deleting' }, { visibility: 'trashed' }]) assert.deepEqual(search(snapshot([claim('blocked', patch)])), []);
});

test('typed user commands confirm, edit pending review, supersede and delete without mutating input', () => {
  assert.equal(typeof core.applyMemoryCommand, 'function');
  const s = snapshot([claim('c1', { status: 'candidate' }), claim('c2')]);
  const command = (kind, extra = {}) => ({ kind, relationshipId: 'a', claimId: 'c1', now, ...extra });
  const confirmed = core.applyMemoryCommand(s, command('confirm'));
  assert.equal(confirmed.claims[0].status, 'confirmed');
  assert.equal(s.claims[0].status, 'candidate');
  const edited = core.applyMemoryCommand(confirmed, command('edit', { statement: '周末不散步', sourceVersion: 'v2', sourceDigest: 'new-digest' }));
  assert.equal(edited.claims[0].status, 'needs_review');
  assert.equal(edited.claims[0].statement, '周末不散步');
  assert.deepEqual(search(edited).map((r) => r.claimId), ['c2']);
  const superseded = core.applyMemoryCommand(confirmed, command('supersede', { replacementClaimId: 'c2' }));
  assert.equal(superseded.claims[0].status, 'superseded');
  assert.equal(superseded.claims[0].supersededBy, 'c2');
  const trashed = core.applyMemoryCommand(confirmed, command('delete'));
  assert.equal(trashed.claims[0].status, 'trashed');
  assert.throws(() => core.applyMemoryCommand(trashed, command('confirm')), /Illegal/);
  assert.throws(() => core.applyMemoryCommand(s, command('confirm', { relationshipId: 'b' })), /scope/);
  assert.throws(() => core.applyMemoryCommand(confirmed, command('edit', { statement: ' ', sourceVersion: 'v2' })), /Invalid/);
});

test('unconfirmed hypotheses archive at exactly 90 days without changing confirmed or another relationship', () => {
  assert.equal(typeof core.archiveUnconfirmed, 'function');
  const s = snapshot([claim('old', { status: 'candidate' }), claim('review', { status: 'needs_review' }), claim('recent', { status: 'candidate', createdAt: '2026-06-11T00:00:00.001Z' }), claim('confirmed'), claim('other', { status: 'candidate', relationshipId: 'b' })]);
  const result = core.archiveUnconfirmed(s, { relationshipId: 'a', now });
  assert.deepEqual(result.claims.map((c) => c.status), ['archived', 'archived', 'candidate', 'confirmed', 'candidate']);
  assert.deepEqual(result.claims[0].transitions.map((t) => t.to), ['needs_review', 'archived']);
  assert.equal(s.claims[0].status, 'candidate');
});

test('source edits, digest changes, deletion and expired sources invalidate stale index and confirmation', () => {
  assert.equal(typeof core.buildMemoryIndex, 'function');
  const original = snapshot();
  const index = core.buildMemoryIndex(original);
  for (const sources of [[], [source('s1', { sourceVersion: 'v2' })], [source('s1', { sourceDigest: 'changed' })], [source('s1', { visibility: 'trashed' })], [source('s1', { validUntil: now })], [source('s1', { relationshipId: 'b' })]]) {
    const changed = snapshot([claim()], sources);
    assert.deepEqual(search(changed, '散步', index), []);
    assert.throws(() => core.applyMemoryCommand({ ...changed, claims: [claim('c1', { status: 'candidate' })] }, { kind: 'confirm', relationshipId: 'a', claimId: 'c1', now }), /source/);
  }
});

test('manual evidence selection is explicit, atomic, scoped and rechecks the selected version', () => {
  assert.equal(typeof core.selectEvidence, 'function');
  const s = snapshot();
  const req = { relationshipId: 'a', now, selection: [{ sourceId: 's1', sourceVersion: 'v1', sourceDigest: 'digest-1' }] };
  const selected = core.selectEvidence(s, req);
  assert.equal(selected[0].content, '周末一起散步');
  assert.equal(selected[0].relationshipId, 'a');
  assert.equal(selected[0].method, 'manual');
  assert.deepEqual(core.selectEvidence(s, { ...req, selection: [] }), []);
  assert.throws(() => core.selectEvidence(s, { ...req, relationshipId: 'b' }), /source/);
  assert.throws(() => core.selectEvidence(s, { ...req, selection: [...req.selection, { sourceId: 'missing', sourceVersion: 'v1', sourceDigest: null }] }), /source/);
  s.relationships[0].state = 'archived';
  assert.throws(() => core.selectEvidence(s, req), /scope/);
});

test('Chinese lexical matching preserves two-character, scripts, emoji and quotes without synonym inference', () => {
  assert.equal(typeof core.searchMemory, 'function');
  const texts = ['散步', '周末 Zoom 会议', '今天🙂', '她说“别催我”', '小林喜欢咖啡', '周末不散步'];
  for (const [query, expected] of [['散步', ['c0', 'c5']], ['Zoom', ['c1']], ['🙂', ['c2']], ['别催我', ['c3']], ['阿林', []], ['散布', []], ['漫步', []], ['火星', []], ['', []]]) {
    const s = snapshot(texts.map((statement, i) => claim(`c${i}`, { statement })), [source('s1', { content: '原始证据' })]);
    assert.deepEqual(search(s, query).map((r) => r.claimId).sort(), expected);
  }
  const result = search(snapshot())[0];
  assert.deepEqual(result.sources, [{ sourceId: 's1', sourceVersion: 'v1', sourceDigest: 'digest-1' }]);
  assert.equal(result.sourceVersion, 'v1');
  assert.equal(result.relationshipId, 'a');
  assert.ok(result.eligibilityReasons.includes('confirmed'));
  assert.equal(result.method, 'lexical');
});

test('crashed/discarded indexes rebuild from canonical state without resurrecting deleted claims', () => {
  assert.equal(typeof core.buildMemoryIndex, 'function');
  const original = snapshot();
  const old = core.buildMemoryIndex(original);
  const changed = snapshot([claim('c1', { status: 'trashed' }), claim('new')]);
  assert.deepEqual(search(changed, '散步', old), []);
  const rebuilt = core.buildMemoryIndex(changed);
  assert.deepEqual(search(changed, '散步', rebuilt).map((r) => r.claimId), ['new']);
});

test('source reconciliation moves stale confirmed claims to pending and explicit refreshed edit permits reconfirmation', () => {
  assert.equal(typeof core.reconcileMemorySources, 'function');
  const s = snapshot([claim()], [source('s1', { sourceVersion: 'v2', sourceDigest: 'd2' })]);
  const reconciled = core.reconcileMemorySources(s, { relationshipId: 'a', now });
  assert.equal(reconciled.claims[0].status, 'needs_review');
  assert.equal(reconciled.claims[0].invalidatedAt, now);
  const edited = core.applyMemoryCommand(reconciled, { kind: 'edit', relationshipId: 'a', claimId: 'c1', now, statement: '更正的记忆', sourceVersion: 'v2', sources: [{ sourceId: 's1', sourceVersion: 'v2', sourceDigest: 'd2' }] });
  assert.equal(edited.claims[0].invalidatedAt, null);
  assert.deepEqual(edited.claims[0].sources, [{ sourceId: 's1', sourceVersion: 'v2', sourceDigest: 'd2' }]);
  const confirmed = core.applyMemoryCommand(edited, { kind: 'confirm', relationshipId: 'a', claimId: 'c1', now });
  assert.equal(search(confirmed, '更正')[0].claimId, 'c1');
});

test('raw evidence search returns current scoped provenance even without a confirmed claim', () => {
  assert.equal(typeof core.searchEvidence, 'function');
  const s = snapshot([], [source(), source('s2', { relationshipId: 'b' }), source('s3', { visibility: 'deleting' })]);
  const results = core.searchEvidence(s, { relationshipId: 'a', now, query: '散步' });
  assert.deepEqual(results.map((r) => r.sourceId), ['s1']);
  assert.equal(results[0].sourceDigest, 'digest-1');
  assert.equal(results[0].method, 'lexical');
  assert.equal(results[0].kind, 'evidence');
});

test('malformed validity and missing claim provenance cannot become eligible or be confirmed', () => {
  const s = snapshot([claim('bad', { validUntil: 'not-a-date' }), claim('provenance', { sourceVersion: '' })]);
  assert.deepEqual(search(s), []);
  assert.throws(() => core.selectEvidence(snapshot([], [source('s1', { validUntil: 'zzz' })]), { relationshipId: 'a', now, selection: [{ sourceId: 's1', sourceVersion: 'v1', sourceDigest: 'digest-1' }] }), /source/);
});

test('benchmark metrics penalize empty results, duplicates, leakage and high-harm false positives', () => {
  assert.equal(typeof bench.measureRanking, 'function');
  const result = bench.measureRanking([{ relevantIds: ['a', 'b'], eligibleIds: ['a', 'b', 'c'], highHarmIds: ['leak'], returnedIds: ['a', 'a', 'c', 'leak'], latencyMs: 12 }, { relevantIds: [], eligibleIds: [], highHarmIds: [], returnedIds: [], latencyMs: 40 }], 80);
  assert.equal(result.recallAt10, 0.5);
  assert.equal(result.precisionAt5, 0.1);
  assert.equal(result.leakCount, 1);
  assert.equal(result.highHarmCount, 1);
  assert.equal(result.p95Ms, 40);
  assert.equal(result.rebuildMs, 80);
});

test('dense gate enforces every threshold and requires real target-device evidence', () => {
  assert.equal(typeof bench.decideRetrievalMode, 'function');
  const lexical = { recallAt10: 0.6, precisionAt5: 0.6, leakCount: 0, highHarmCount: 0, p95Ms: 100, rebuildMs: 1000 };
  const dense = { ...lexical, recallAt10: 0.7, precisionAt5: 0.58, p95Ms: 300, rebuildMs: 30000 };
  const target = { platform: 'android', androidVersion: 12, ramGB: 6, measured: true, fakeVectors: false };
  assert.equal(bench.decideRetrievalMode(lexical, dense, target).mode, 'dense-candidate');
  for (const patch of [{ recallAt10: 0.699 }, { precisionAt5: 0.579 }, { leakCount: 1 }, { highHarmCount: 1 }, { p95Ms: 301 }, { rebuildMs: 30001 }, { recallAt10: NaN }]) assert.equal(bench.decideRetrievalMode(lexical, { ...dense, ...patch }, target).mode, 'lexical+manual');
  for (const patch of [{ measured: false }, { fakeVectors: true }, { platform: 'desktop' }, { ramGB: 16 }]) assert.equal(bench.decideRetrievalMode(lexical, dense, { ...target, ...patch }).mode, 'lexical+manual');
});

test('offline benchmark covers all required cases and reports lexical/device-dense/union at each scale', () => {
  assert.equal(typeof bench.runDisposableBenchmark, 'function');
  const report = bench.runDisposableBenchmark({ scales: [1000, 10000, 50000], iterations: 3 });
  for (const tag of ['two-character', 'mixed-scripts', 'typo', 'emoji', 'alias', 'exact-quote', 'synonym', 'negation', 'temporal-update', 'conflict', 'no-answer', 'source-edit', 'source-delete', 'deletion-states', 'cross-relationship', 'crash-rebuild']) assert.ok(report.caseTags.includes(tag), tag);
  assert.equal(report.fakeVectors, true);
  assert.ok(Array.isArray(report.cases), 'benchmark exposes per-case ranking evidence');
  const conflict = report.cases.find((c) => c.tag === 'conflict');
  assert.deepEqual(conflict.relevantIds, ['conflict', 'conflict-other']);
  assert.deepEqual(conflict.lexical.sort(), ['conflict', 'conflict-other']);
  assert.equal(report.decision.mode, 'lexical+manual');
  assert.deepEqual(report.scales.map((r) => r.size), [1000, 10000, 50000]);
  for (const row of report.scales) for (const mode of ['lexical', 'device-dense', 'union']) {
    const m = row[mode];
    for (const k of ['recallAt10', 'precisionAt5', 'leakCount', 'highHarmCount', 'p95Ms', 'rebuildMs']) assert.ok(Number.isFinite(m[k]), `${mode}.${k}`);
    assert.equal(m.leakCount, 0);
    assert.ok(m.p95Ms < 300, `desktop synthetic search budget: ${row.size} ${mode}`);
    assert.ok(m.rebuildMs < 30000, `desktop synthetic rebuild budget: ${row.size} ${mode}`);
  }
  console.log('SYNTHETIC_BENCHMARK', JSON.stringify(report));
});
