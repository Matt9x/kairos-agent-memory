import { buildMemoryIndex, searchMemory, filterEligibleClaimIds } from '../memory/memoryCore.mjs';

const percentile95 = (values) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : 0;

/** Recall averages answerable cases only. P@5 uses a fixed denominator, including no-answer cases. */
export function measureRanking(rows, rebuildMs) {
  let recall = 0, answerable = 0, precision = 0, leakCount = 0, highHarmCount = 0;
  for (const row of rows) {
    const ids = [...new Set(row.returnedIds)];
    const relevant = new Set(row.relevantIds);
    const eligible = new Set(row.eligibleIds);
    const harmful = new Set(row.highHarmIds);
    if (relevant.size) { answerable++; recall += ids.slice(0, 10).filter((id) => relevant.has(id)).length / relevant.size; }
    precision += ids.slice(0, 5).filter((id) => relevant.has(id)).length / 5;
    leakCount += ids.filter((id) => !eligible.has(id)).length;
    highHarmCount += ids.filter((id) => harmful.has(id) && !relevant.has(id)).length;
  }
  return { recallAt10: answerable ? recall / answerable : 0, precisionAt5: rows.length ? precision / rows.length : 0, leakCount, highHarmCount, p95Ms: percentile95(rows.map((r) => r.latencyMs)), rebuildMs };
}

export function decideRetrievalMode(lexical, dense, profile) {
  const reasons = [];
  const valid = (m) => m && ['recallAt10', 'precisionAt5', 'leakCount', 'highHarmCount', 'p95Ms', 'rebuildMs'].every((k) => Number.isFinite(m[k]) && m[k] >= 0) && m.recallAt10 <= 1 && m.precisionAt5 <= 1;
  if (!valid(lexical) || !valid(dense)) reasons.push('invalid-metrics');
  else {
    if (dense.recallAt10 - lexical.recallAt10 < 0.1 - 1e-12) reasons.push('recall-gain-below-10pp');
    if (lexical.precisionAt5 - dense.precisionAt5 > 0.02 + 1e-12) reasons.push('precision-loss-above-2pp');
    if (dense.leakCount !== 0) reasons.push('eligibility-leaks');
    if (dense.highHarmCount !== 0) reasons.push('high-harm-false-positive');
    if (dense.p95Ms > 300) reasons.push('latency-budget');
    if (dense.rebuildMs > 30000) reasons.push('rebuild-budget');
  }
  if (profile?.platform !== 'android' || profile.androidVersion !== 12 || profile.ramGB !== 6 || profile.measured !== true || profile.fakeVectors !== false) reasons.push('target-android-evidence-missing');
  return { mode: reasons.length ? 'lexical+manual' : 'dense-candidate', reasons };
}

const now = '2026-09-09T00:00:00.000Z';
const fixtureDefinitions = [
  ['two-character', '散步', '晚饭后散步', ['two-character']],
  ['mixed-scripts', 'Zoom', '周末 Zoom 会议', ['mixed-scripts']],
  ['typo', '咔啡', '她想喝咖啡', ['typo']],
  ['emoji', '🙂', '今天🙂', ['emoji']],
  ['alias', '阿林', '小林喜欢阅读', ['alias']],
  ['exact-quote', '别催我', '她说“别催我”', ['exact-quote']],
  ['synonym', '休息片刻', '她想歇一会儿', ['synonym']],
  ['negation', '不联系', '今晚不联系', ['negation']],
  ['temporal-update', '现在喝茶', '现在喝茶', ['temporal-update']],
  ['conflict', '旅行', '她说想去旅行', ['conflict', 'conflict-other']],
  ['no-answer', '火星', '无此证据', []],
  ['source-edit', '编辑证据', '编辑证据', []],
  ['source-delete', '删除证据', '删除证据', []],
  ['deletion-states', '删除状态', '删除状态', []],
  ['cross-relationship', '跨关系暗号', '跨关系暗号', []],
  ['crash-rebuild', '重建后', '重建后', ['crash-rebuild']],
];
const vectorFor = (dimension) => { const v = new Float32Array(fixtureDefinitions.length); if (dimension >= 0) v[dimension] = 1; return v; };
function fixture(size) {
  const sources = [], claims = [], vectors = new Map();
  const add = (id, statement, dimension, patch = {}) => {
    const sourceId = `s-${id}`;
    sources.push({ id: sourceId, content: statement, relationshipId: patch.relationshipId ?? 'a', sourceVersion: 'v1', sourceDigest: `d-${id}`, visibility: 'active' });
    claims.push({ id, relationshipId: 'a', statement, status: 'confirmed', visibility: 'active', sourceVersion: 'v1', sourceDigest: `c-${id}`, sources: [{ sourceId, sourceVersion: 'v1', sourceDigest: `d-${id}` }], createdAt: now, updatedAt: now, validFrom: now, ...patch });
    vectors.set(id, vectorFor(dimension));
  };
  fixtureDefinitions.forEach(([id, , statement], dimension) => add(id, statement, dimension));
  add('negation-opposite', '今晚联系', 7);
  add('conflict-other', '她也说不想去旅行', 9);
  add('old-preference', '现在喝茶', 8, { status: 'superseded' });
  for (const status of ['candidate', 'needs_review', 'superseded', 'archived', 'trashed', 'purged']) add(`state-${status}`, '删除状态', 13, { status });
  add('foreign-canary', '跨关系暗号', 14, { relationshipId: 'b' });
  for (let i = claims.length; i < size; i++) add(`filler-${i}`, `日记记录编号${i}`, -1);
  const original = { relationships: [{ id: 'a', state: 'active' }, { id: 'b', state: 'active' }], sources, claims };
  const current = {
    ...original,
    sources: sources.filter((s) => s.id !== 's-source-delete').map((s) => s.id === 's-source-edit' ? { ...s, sourceVersion: 'v2' } : s),
    claims: claims.map((c) => ['deletion-states', 'cross-relationship', 'no-answer'].includes(c.id) ? { ...c, visibility: 'deleting' } : c),
  };
  const eligibleIds = claims.filter((c) => !['source-edit', 'source-delete', 'deletion-states', 'cross-relationship', 'no-answer', 'old-preference', 'foreign-canary'].includes(c.id) && !c.id.startsWith('state-')).map((c) => c.id);
  return { original, current, vectors, eligibleIds };
}

function denseRank(vectors, queryVector) {
  const scores = [];
  for (const [id, vector] of vectors) {
    let score = 0;
    for (let i = 0; i < queryVector.length; i++) score += vector[i] * queryVector[i];
    if (score > 0) scores.push({ id, score });
  }
  return scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en')).map((s) => s.id);
}

/** Disposable synthetic experiment only: handcrafted vectors deliberately encode fixture associations. */
export function runDisposableBenchmark({ scales = [1000, 10000, 50000], iterations = 3 } = {}) {
  if (!Array.isArray(scales) || !scales.length || scales.some((s) => ![1000, 10000, 50000].includes(s)) || !Number.isInteger(iterations) || iterations < 1 || iterations > 100) throw new Error('Invalid benchmark budget');
  const measuredScales = [];
  const cases = fixtureDefinitions.map(([tag, query, , relevantIds]) => ({ tag, query, relevantIds, lexical: [], 'device-dense': [], union: [] }));
  for (const size of scales) {
    const { original, current, vectors, eligibleIds } = fixture(size);
    let start = performance.now();
    let index = buildMemoryIndex(original);
    const staleIndex = index;
    index = null; // Simulated loss of the complete derived generation; canonical input survives.
    index = buildMemoryIndex(current);
    const lexicalRebuild = performance.now() - start;
    start = performance.now();
    const rebuiltVectors = new Map([...vectors].map(([id, vector]) => [id, Float32Array.from(vector)]));
    const denseRebuild = performance.now() - start;
    const modes = { lexical: [], 'device-dense': [], union: [] };
    for (let repeat = 0; repeat < iterations; repeat++) {
      fixtureDefinitions.forEach(([tag, query, , relevantIds], dimension) => {
        const request = { relationshipId: 'a', now, query };
        for (const mode of Object.keys(modes)) {
          start = performance.now();
          const selectedIndex = ['source-edit', 'source-delete'].includes(tag) ? staleIndex : index;
          const lexical = mode !== 'device-dense' ? searchMemory(selectedIndex, current, request).map((r) => r.claimId) : [];
          const dense = mode !== 'lexical' ? filterEligibleClaimIds(current, { ...request, ids: denseRank(rebuiltVectors, vectorFor(dimension)) }).slice(0, 10) : [];
          const returnedIds = (mode === 'lexical' ? lexical : mode === 'device-dense' ? dense : [...new Set([...lexical, ...dense])]).slice(0, 10);
          modes[mode].push({ relevantIds, eligibleIds, highHarmIds: tag === 'negation' ? ['negation-opposite'] : [], returnedIds, latencyMs: performance.now() - start });
          if (repeat === 0) cases[dimension][mode] = returnedIds;
        }
      });
    }
    measuredScales.push({ size, lexical: measureRanking(modes.lexical, lexicalRebuild), 'device-dense': measureRanking(modes['device-dense'], denseRebuild), union: measureRanking(modes.union, lexicalRebuild + denseRebuild) });
  }
  const largest = measuredScales.reduce((a, b) => a.size > b.size ? a : b);
  const profile = { platform: 'desktop', androidVersion: null, ramGB: null, measured: true, fakeVectors: true };
  return { fakeVectors: true, profile, iterations, caseTags: fixtureDefinitions.map(([tag]) => tag), cases, scales: measuredScales, decision: decideRetrievalMode(largest.lexical, largest.union, profile), denseDecision: decideRetrievalMode(largest.lexical, largest['device-dense'], profile), limitation: 'Synthetic desktop fixture and handcrafted vectors; no semantic-memory, device-model, Android latency, durable crash or native rebuild evidence.' };
}
