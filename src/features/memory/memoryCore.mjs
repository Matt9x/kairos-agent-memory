import { assertIsoUtcTimestamp, isClaimRetrievable, transitionClaim } from '../../data/localDataCore.mjs';

const text = (value) => typeof value === 'string' && value.trim().length > 0;
const normalize = (value) => value.normalize('NFKC').toLocaleLowerCase('en-US').trim();
const validTimestamp = (value) => { try { assertIsoUtcTimestamp(value); return true; } catch { return false; } };
const active = (item, now) => item && item.visibility === 'active' && !item.invalidatedAt && (item.validFrom == null || (validTimestamp(item.validFrom) && item.validFrom <= now)) && (item.validUntil == null || (validTimestamp(item.validUntil) && item.validUntil > now));
function scope(snapshot, relationshipId, now) {
  assertIsoUtcTimestamp(now);
  if (!text(relationshipId) || !snapshot.relationships.some((r) => r.id === relationshipId && r.state === 'active')) throw new Error('Invalid relationship scope');
}
const sourceMap = (snapshot) => new Map(snapshot.sources.map((s) => [s.id, s]));
function validSource(ref, sources, relationshipId, now) {
  const source = sources.get(ref?.sourceId);
  return text(ref?.sourceVersion) && source?.relationshipId === relationshipId && active(source, now) && source.sourceVersion === ref.sourceVersion && (source.sourceDigest ?? null) === (ref.sourceDigest ?? null);
}
function validSources(claim, sources, now) {
  return Array.isArray(claim.sources) && claim.sources.length > 0 && claim.sources.every((ref) => validSource(ref, sources, claim.relationshipId, now));
}
const refCopy = (r) => ({ sourceId: r.sourceId, sourceVersion: r.sourceVersion, sourceDigest: r.sourceDigest ?? null });
const eligible = (c, sources, relationshipId, now) => text(c.sourceVersion) && text(c.statement) && c.relationshipId === relationshipId && active(c, now) && isClaimRetrievable(c, now) && validSources(c, sources, now);
function move(claim, next, now) {
  const status = transitionClaim(claim.status, next);
  return { ...claim, status, updatedAt: now, transitions: [...(claim.transitions ?? []), { from: claim.status, to: status, at: now }] };
}

/** Pure command result. Persist the complete result atomically through the canonical writer. */
export function applyMemoryCommand(snapshot, command) {
  const { relationshipId, claimId, now, kind } = command;
  scope(snapshot, relationshipId, now);
  const claim = snapshot.claims.find((c) => c.id === claimId && c.relationshipId === relationshipId);
  if (!claim || claim.visibility !== 'active') throw new Error('Invalid claim scope');
  const sources = sourceMap(snapshot);
  let updated;
  if (kind === 'confirm') {
    if (!text(claim.sourceVersion) || !validSources(claim, sources, now) || claim.invalidatedAt || !active(claim, now)) throw new Error('Invalid source or validity; refresh evidence before confirmation');
    updated = move(claim, 'confirmed', now);
  } else if (kind === 'edit') {
    if (!text(command.statement) || !text(command.sourceVersion) || command.sourceVersion === claim.sourceVersion || !['candidate', 'confirmed', 'needs_review'].includes(claim.status)) throw new Error('Invalid claim edit');
    updated = claim.status === 'needs_review' ? { ...claim } : move(claim, 'needs_review', now);
    updated = { ...updated, statement: command.statement.trim(), sourceVersion: command.sourceVersion, sourceDigest: command.sourceDigest ?? null, updatedAt: now };
    if (command.sources !== undefined) {
      if (!validSources({ ...updated, sources: command.sources }, sources, now)) throw new Error('Invalid refreshed source');
      updated = { ...updated, sources: command.sources.map(refCopy), invalidatedAt: null };
    }
  } else if (kind === 'supersede') {
    const replacement = snapshot.claims.find((c) => c.id === command.replacementClaimId && c.id !== claimId);
    if (!replacement || !eligible(replacement, sources, relationshipId, now)) throw new Error('Invalid replacement scope or source');
    updated = { ...move(claim, 'superseded', now), supersededBy: replacement.id };
  } else if (kind === 'delete' || kind === 'archive') {
    updated = move(claim, kind === 'delete' ? 'trashed' : 'archived', now);
  } else throw new Error('Invalid memory command');
  return { ...snapshot, claims: snapshot.claims.map((c) => c === claim ? updated : c) };
}

export function archiveUnconfirmed(snapshot, { relationshipId, now }) {
  scope(snapshot, relationshipId, now);
  const cutoff = Date.parse(now) - 90 * 86400000;
  return { ...snapshot, claims: snapshot.claims.map((c) => {
    if (c.relationshipId !== relationshipId || c.visibility !== 'active' || !['candidate', 'needs_review'].includes(c.status)) return c;
    assertIsoUtcTimestamp(c.createdAt);
    if (Date.parse(c.createdAt) > cutoff) return c;
    return move(c.status === 'candidate' ? move(c, 'needs_review', now) : c, 'archived', now);
  }) };
}

export function pendingClaims(snapshot, { relationshipId, now }) {
  scope(snapshot, relationshipId, now);
  return snapshot.claims.filter((c) => c.relationshipId === relationshipId && c.visibility === 'active' && ['candidate', 'needs_review'].includes(c.status)).map((c) => ({ ...c, sources: c.sources.map(refCopy) }));
}

export function reconcileMemorySources(snapshot, { relationshipId, now }) {
  scope(snapshot, relationshipId, now);
  const sources = sourceMap(snapshot);
  return { ...snapshot, claims: snapshot.claims.map((c) => {
    if (c.relationshipId !== relationshipId || c.visibility !== 'active' || !['candidate', 'confirmed', 'needs_review'].includes(c.status) || validSources(c, sources, now)) return c;
    return { ...(c.status === 'needs_review' ? c : move(c, 'needs_review', now)), invalidatedAt: c.invalidatedAt ?? now };
  }) };
}

export function selectEvidence(snapshot, { relationshipId, now, selection }) {
  scope(snapshot, relationshipId, now);
  const sources = sourceMap(snapshot);
  if (!Array.isArray(selection) || selection.some((ref) => !validSource(ref, sources, relationshipId, now))) throw new Error('Invalid selected source');
  return [...new Map(selection.map((ref) => [ref.sourceId, ref])).values()].map((ref) => ({ ...refCopy(ref), relationshipId, content: sources.get(ref.sourceId).content, method: 'manual', eligibilityReasons: ['active-relationship', 'active-source', 'source-version-matches', 'user-selected'] }));
}

export function searchEvidence(snapshot, { relationshipId, now, query, limit = 10 }) {
  scope(snapshot, relationshipId, now);
  if (typeof query !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid search request');
  const chunks = normalize(query).split(/\s+/u).filter(Boolean);
  if (!chunks.length) return [];
  return snapshot.sources.filter((s) => s.relationshipId === relationshipId && active(s, now) && text(s.sourceVersion) && typeof s.content === 'string' && chunks.every((chunk) => normalize(s.content).includes(chunk))).slice(0, limit).map((s) => ({ sourceId: s.id, sourceVersion: s.sourceVersion, sourceDigest: s.sourceDigest ?? null, relationshipId, content: s.content, kind: 'evidence', method: 'lexical', eligibilityReasons: ['active-relationship', 'active-source', 'literal-match'] }));
}

/** Disposable derived index. Never persist as canonical memory or authorize from cached eligibility. */
export function buildMemoryIndex(snapshot) {
  const sources = sourceMap(snapshot);
  return new Map(snapshot.claims.map((c) => [c.id, {
    statement: c.statement, sourceVersion: c.sourceVersion, sourceDigest: c.sourceDigest ?? null,
    text: normalize([c.statement, ...(c.sources ?? []).map((r) => sources.get(r.sourceId)?.content ?? '')].join('\n')),
  }]));
}

/** All query chunks must occur literally; no synonyms, typo correction, inferred aliases or answers. */
export function searchMemory(index, snapshot, { relationshipId, now, query, limit = 10 }) {
  scope(snapshot, relationshipId, now);
  if (typeof query !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid search request');
  const chunks = normalize(query).split(/\s+/u).filter(Boolean);
  if (!chunks.length) return [];
  const sources = sourceMap(snapshot);
  const matches = [];
  // ponytail: linear scan up to the measured 50k fixture; add postings only after target-device profiling.
  for (const claim of snapshot.claims) {
    const cached = index.get(claim.id);
    if (!cached || cached.statement !== claim.statement || cached.sourceVersion !== claim.sourceVersion || cached.sourceDigest !== (claim.sourceDigest ?? null) || !chunks.every((chunk) => cached.text.includes(chunk))) continue;
    if (!eligible(claim, sources, relationshipId, now)) continue;
    // Re-read source text too: even a malformed writer that kept a version cannot return stale text.
    const currentText = normalize([claim.statement, ...claim.sources.map((ref) => sources.get(ref.sourceId).content)].join('\n'));
    if (!chunks.every((chunk) => currentText.includes(chunk))) continue;
    matches.push({ claimId: claim.id, statement: claim.statement, relationshipId, sourceVersion: claim.sourceVersion, sourceDigest: claim.sourceDigest ?? null, sources: claim.sources.map(refCopy), method: 'lexical', eligibilityReasons: ['active-relationship', 'confirmed', 'active-validity', 'source-version-matches', 'literal-match'] });
  }
  return matches.sort((a, b) => a.claimId.localeCompare(b.claimId, 'en')).slice(0, limit);
}

/** Dense experiments must apply exactly the same live eligibility gate. No shipping dense backend. */
export function filterEligibleClaimIds(snapshot, { relationshipId, now, ids }) {
  scope(snapshot, relationshipId, now);
  const wanted = new Set(ids);
  const sources = sourceMap(snapshot);
  const allowed = new Set(snapshot.claims.filter((c) => wanted.has(c.id) && eligible(c, sources, relationshipId, now)).map((c) => c.id));
  return [...new Set(ids)].filter((id) => allowed.has(id));
}
