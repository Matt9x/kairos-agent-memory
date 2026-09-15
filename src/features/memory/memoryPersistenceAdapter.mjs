import { applyMemoryCommand, buildMemoryIndex, filterEligibleClaimIds, pendingClaims, searchEvidence, searchMemory, selectEvidence } from './memoryCore.mjs';
import { assertIsoUtcTimestamp } from '../../data/localDataCore.mjs';
import { canonicalTables } from '../../data/lifecycleCore.mjs';

export class MemoryPersistenceError extends Error {
  constructor(code) { super(code); this.name = 'MemoryPersistenceError'; this.code = code; }
}

const text = (value) => typeof value === 'string' && value.trim().length > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const unavailable = () => { throw new MemoryPersistenceError('PERSISTENCE_UNAVAILABLE'); };
const invalid = () => { throw new MemoryPersistenceError('CANONICAL_PROJECTION_INVALID'); };
const liveReceipt = (receipt) => receipt.status === 'deleting' || receipt.status === 'trashed';

function validateReceipts(raw, relationshipId) {
  const rows = { relationships: [raw.relationship], evidence_items: raw.evidenceItems, memory_claims: raw.memoryClaims };
  const ids = new Set();
  const activeTargets = new Set();
  for (const receipt of raw.receipts) {
    if (!object(receipt) || !text(receipt.id) || receipt.relationshipId !== relationshipId || !Array.isArray(receipt.targets) || !receipt.targets.length || receipt.targets.some((target) => !object(target) || !text(target.table) || !text(target.id)) || !['deleting', 'trashed', 'restored', 'purged'].includes(receipt.status)) invalid();
    if (ids.has(receipt.id)) invalid();
    ids.add(receipt.id);
    const targets = new Set();
    for (const target of receipt.targets) {
      if (!canonicalTables.includes(target.table) || target.table === 'profiles' || (target.table === 'relationships' && target.id !== relationshipId)) invalid();
      const key = JSON.stringify([target.table, target.id]);
      if (targets.has(key) || (liveReceipt(receipt) && activeTargets.has(key))) invalid();
      targets.add(key);
      if (liveReceipt(receipt)) activeTargets.add(key);
      // This port contains only these three tables. The storage layer owns validation of
      // any other canonical targets; never request a full maintenance snapshot.
      if (own(rows, target.table)) {
        const retained = rows[target.table].some((row) => row?.id === target.id);
        if ((receipt.status === 'purged' && retained) || (liveReceipt(receipt) && !retained)) invalid();
      }
    }
  }
}

const receiptHides = (receipts, table, id) => receipts.some((receipt) => liveReceipt(receipt) && receipt.targets.some((target) => target.table === table && target.id === id));

function sourceFrom(row, relationshipId) {
  if (!object(row) || row.relationship_id !== relationshipId || !text(row.id) || !text(row.content) || !text(row.source_version) || !own(row, 'source_digest')) invalid();
  return {
    id: row.id, relationshipId, content: row.content, sourceVersion: row.source_version, sourceDigest: row.source_digest,
    visibility: 'active', validFrom: row.valid_from ?? null, validUntil: row.valid_until ?? null, invalidatedAt: row.invalidated_at ?? null,
  };
}

function claimFrom(row, relationshipId, sources) {
  if (!object(row) || row.relationship_id !== relationshipId || !text(row.id) || !text(row.statement) || !text(row.status) || !text(row.source_version) || !own(row, 'source_digest') || !text(row.created_at) || !text(row.updated_at)) invalid();
  let lineage;
  try { lineage = JSON.parse(row.lineage_json); } catch { invalid(); }
  if (!Array.isArray(lineage) || !lineage.length || lineage.some((id) => !text(id)) || new Set(lineage).size !== lineage.length) invalid();
  const refs = lineage.map((id) => sources.get(id)).map((source) => {
    if (!source) invalid();
    return { sourceId: source.id, sourceVersion: source.sourceVersion, sourceDigest: source.sourceDigest };
  });
  return {
    id: row.id, relationshipId, statement: row.statement, status: row.status, sourceVersion: row.source_version, sourceDigest: row.source_digest,
    sources: refs, visibility: 'active', validFrom: row.valid_from ?? null, validUntil: row.valid_until ?? null, invalidatedAt: row.invalidated_at ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function project(raw, relationshipId, now) {
  assertIsoUtcTimestamp(now);
  if (!object(raw) || !object(raw.relationship) || raw.relationship.id !== relationshipId || !Array.isArray(raw.evidenceItems) || !Array.isArray(raw.memoryClaims) || !Array.isArray(raw.receipts)) invalid();
  if (raw.evidenceItems.some((row) => row?.relationship_id !== relationshipId) || raw.memoryClaims.some((row) => row?.relationship_id !== relationshipId)) invalid();
  validateReceipts(raw, relationshipId);
  if (raw.relationship.state !== 'active' || receiptHides(raw.receipts, 'relationships', relationshipId)) throw new MemoryPersistenceError('SCOPE_HIDDEN');
  const sources = raw.evidenceItems.filter((row) => !receiptHides(raw.receipts, 'evidence_items', row.id)).map((row) => sourceFrom(row, relationshipId));
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const claims = raw.memoryClaims.filter((row) => !receiptHides(raw.receipts, 'memory_claims', row.id)).map((row) => claimFrom(row, relationshipId, sourceMap));
  return { relationships: [{ id: relationshipId, state: 'active' }], sources, claims };
}

function commandCopy(command) {
  const bad = () => { throw new MemoryPersistenceError('COMMAND_INVALID'); };
  if (!object(command) || !['confirm', 'edit', 'archive', 'supersede', 'delete'].includes(command.kind) || !text(command.commandId) || !text(command.relationshipId) || !text(command.claimId)) bad();
  try { assertIsoUtcTimestamp(command.now); } catch { bad(); }
  const copy = { commandId: command.commandId, relationshipId: command.relationshipId, claimId: command.claimId, kind: command.kind, now: command.now };
  if (command.kind === 'delete') {
    if (!text(command.receiptId)) bad();
    copy.receiptId = command.receiptId;
  }
  if (command.kind === 'supersede') {
    if (!text(command.replacementClaimId)) bad();
    copy.replacementClaimId = command.replacementClaimId;
  }
  if (command.kind === 'edit') {
    if (!text(command.statement) || !text(command.sourceVersion) || (command.sourceDigest != null && !text(command.sourceDigest))) bad();
    copy.statement = command.statement;
    copy.sourceVersion = command.sourceVersion;
    if (own(command, 'sourceDigest')) copy.sourceDigest = command.sourceDigest ?? null;
    if (own(command, 'sources')) {
      if (!Array.isArray(command.sources) || !command.sources.length) bad();
      copy.sources = command.sources.map((ref) => {
        if (!object(ref) || !text(ref.sourceId) || !text(ref.sourceVersion) || !own(ref, 'sourceDigest') || (ref.sourceDigest !== null && !text(ref.sourceDigest))) bad();
        return { sourceId: ref.sourceId, sourceVersion: ref.sourceVersion, sourceDigest: ref.sourceDigest };
      });
    }
  }
  if (Object.keys(command).some((key) => !own(copy, key))) bad();
  return copy;
}

function verifiedReceipt(result, command) {
  const bad = () => { throw new MemoryPersistenceError('COMMAND_RECEIPT_INVALID'); };
  if (!object(result) || result.status !== (command.kind === 'delete' ? 'trashed' : 'persisted')) bad();
  let returned;
  try { returned = commandCopy(result.command); } catch { bad(); }
  if (JSON.stringify(returned) !== JSON.stringify(command)) bad();
  return { command: commandCopy(command), status: result.status };
}

const comparableClaim = (claim) => JSON.stringify([
  claim.id, claim.relationshipId, claim.statement, claim.status, claim.sourceVersion, claim.sourceDigest,
  claim.sources, claim.visibility, claim.validFrom ?? null, claim.validUntil ?? null, claim.invalidatedAt ?? null,
  claim.createdAt, claim.updatedAt,
]);

function verifyApplied({ raw, snapshot }, command, desiredClaim) {
  const bad = () => { throw new MemoryPersistenceError('COMMAND_NOT_APPLIED'); };
  const current = snapshot.claims.find((claim) => claim.id === command.claimId);
  if (command.kind === 'delete') {
    const receipt = raw.receipts.find((item) => item.id === command.receiptId);
    if (current || receipt?.status !== 'trashed' || !receipt.targets.some((target) => target.table === 'memory_claims' && target.id === command.claimId)) bad();
    return;
  }
  if (!current || current.status !== { confirm: 'confirmed', edit: 'needs_review', archive: 'archived', supersede: 'superseded' }[command.kind] || current.updatedAt !== command.now) bad();
  if (desiredClaim && comparableClaim(current) !== comparableClaim(desiredClaim)) bad();
  if (command.kind === 'edit' && (current.statement !== command.statement.trim() || current.sourceVersion !== command.sourceVersion || current.sourceDigest !== (command.sourceDigest ?? null) || (command.sources && JSON.stringify(current.sources) !== JSON.stringify(command.sources)))) bad();
  const eligibleId = command.kind === 'confirm' ? command.claimId : command.kind === 'supersede' ? command.replacementClaimId : null;
  if (eligibleId && !filterEligibleClaimIds(snapshot, { ...command, ids: [eligibleId] }).includes(eligibleId)) bad();
}

/**
 * Memory feature boundary. The caller-supplied storage port owns persistence and
 * lifecycle receipts; callers receive only a relationship-scoped feature projection.
 */
export function createMemoryPersistenceAdapter(nativePort) {
  const indexes = new Map();
  const load = async ({ relationshipId, now }) => {
    if (!nativePort || typeof nativePort.readMemoryScope !== 'function') unavailable();
    if (!text(relationshipId)) throw new MemoryPersistenceError('SCOPE_REQUIRED');
    const raw = await nativePort.readMemoryScope({ relationshipId });
    return { raw, snapshot: project(raw, relationshipId, now) };
  };
  const read = async (scope) => (await load(scope)).snapshot;
  const rebuild = async (scope) => {
    const snapshot = await read(scope);
    indexes.set(scope.relationshipId, buildMemoryIndex(snapshot));
    return undefined;
  };
  const commandPort = (kind) => {
    if (!nativePort || typeof nativePort.lookupMemoryCommand !== 'function' || (kind === 'delete' ? typeof nativePort.trash !== 'function' : typeof nativePort.persistMemoryCommand !== 'function')) unavailable();
  };
  return Object.freeze({
    readScopedMemory: read,
    rebuildLexicalIndex: rebuild,
    async searchMemory(request) {
      const snapshot = await read(request);
      const index = indexes.get(request.relationshipId) ?? buildMemoryIndex(snapshot);
      if (!indexes.has(request.relationshipId)) indexes.set(request.relationshipId, index);
      return searchMemory(index, snapshot, request);
    },
    async searchEvidence(request) { return searchEvidence(await read(request), request); },
    async selectEvidence(request) { return selectEvidence(await read(request), request); },
    async pendingClaims(request) { return pendingClaims(await read(request), request); },
    async execute(input) {
      let command = input;
      if (!text(command?.commandId)) throw new MemoryPersistenceError('COMMAND_ID_REQUIRED');
      commandPort(command.kind);
      if (command.kind === 'delete' && !text(command.receiptId)) throw new MemoryPersistenceError('RECEIPT_ID_REQUIRED');
      command = commandCopy(command);
      const existing = await nativePort.lookupMemoryCommand({ commandId: command.commandId, relationshipId: command.relationshipId });
      if (existing !== undefined) {
        const receipt = verifiedReceipt(existing, command);
        const post = await load(command);
        verifyApplied(post, command);
        indexes.set(command.relationshipId, buildMemoryIndex(post.snapshot));
        return receipt;
      }
      const snapshot = await read(command);
      const desired = applyMemoryCommand(snapshot, command);
      const desiredClaim = desired.claims.find((claim) => claim.id === command.claimId && claim.relationshipId === command.relationshipId);
      indexes.delete(command.relationshipId);
      const result = command.kind === 'delete'
        ? await nativePort.trash({ commandId: command.commandId, receiptId: command.receiptId, relationshipId: command.relationshipId, artifactId: command.claimId, command })
        : await nativePort.persistMemoryCommand({ commandId: command.commandId, relationshipId: command.relationshipId, command, desiredClaim });
      const receipt = verifiedReceipt(result, command);
      const post = await load(command);
      verifyApplied(post, command, desiredClaim);
      indexes.set(command.relationshipId, buildMemoryIndex(post.snapshot));
      return receipt;
    },
  });
}
