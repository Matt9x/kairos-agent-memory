# Kairos Public Specification

## 1. Purpose

Kairos is a research prototype for **provenance-aware long-term memory eligibility** in long-running agents.

Its central question is not whether an agent can store more information. It is:

> **When should a previously stored claim still be eligible for retrieval?**

Kairos treats stored memory as non-authoritative. A claim may remain present in storage while becoming ineligible because its supporting source changed, disappeared, expired, became hidden, or no longer matches the historical source reference recorded for that claim.

This document specifies the public V1.1 artifact. It describes implemented invariants and boundaries; it is not a specification for the private Kairos product.

## 2. Core Principle

A stored claim MUST NOT become retrievable merely because it exists in memory or in an index.

Retrieval eligibility MUST be recomputed from:

1. the claim's explicit state;
2. its persisted historical source references;
3. the current state of those sources;
4. scope and validity constraints.

A derived search index is therefore **non-authoritative**. It may accelerate candidate discovery, but it MUST NOT override live eligibility checks.

## 3. Terms

### 3.1 Source

A source is a current observation record within one explicit context scope.

The public representation includes at least:

- `sourceId`
- `sourceVersion`
- `sourceDigest`
- scope identity
- content
- validity / visibility state

`sourceDigest` is an opaque digest token supplied by the caller. The public protocol accepts a non-empty string or `null`; it does not require a particular hashing algorithm.

### 3.2 Historical source reference

A historical source reference records the source identity that a claim depended on at the time that reference was persisted:

```text
{
  sourceId,
  sourceVersion,
  sourceDigest
}
```

Historical refs are facts about the past. They MUST NOT be reconstructed from the current source row.

### 3.3 Claim

A claim is a memory statement with an explicit lifecycle state and one or more persisted historical source references.

The public lifecycle uses:

- `candidate`
- `confirmed`
- `needs_review`
- `superseded`
- `archived`
- deletion states such as `trashed` / `purged`

### 3.4 Current source state

Current source state is the source record available at query or reconciliation time.

It is compared against historical refs. It is not allowed to rewrite them implicitly.

## 4. Persistence Invariant

For every persisted claim, the storage projection MUST preserve the complete historical source refs required for later comparison.

In the public adapter this is represented through `source_refs_json`.

A conforming persisted ref MUST contain:

- non-empty `sourceId`;
- non-empty `sourceVersion`;
- present `sourceDigest` whose value is a non-empty string or `null`.

The ref collection MUST be non-empty.

Duplicate `sourceId` values within one claim MUST be rejected.

Missing or malformed historical refs MUST fail closed. A loader MUST NOT repair missing provenance by looking up the current source and guessing what the old version or digest must have been.

## 5. Source-Drift Invariant

Let a confirmed claim persist a historical reference:

```text
e1 @ v1 / d1
```

If the current source later becomes:

```text
e1 @ v2 / d2
```

then the claim's historical ref remains:

```text
e1 @ v1 / d1
```

and the current source is compared independently.

The mismatch MUST make the stale confirmed claim ineligible for retrieval.

Formally, for each historical ref `r` and current source `s`:

```text
validSource(r, s) :=
  same scope
  AND source exists and is active
  AND s.id == r.sourceId
  AND s.version == r.sourceVersion
  AND s.digest == r.sourceDigest
```

A claim is source-valid only if every required historical ref is valid against the corresponding current source.

## 6. Claim Eligibility

A claim is retrieval-eligible only when all applicable conditions hold.

At minimum, the public implementation requires:

```text
eligible(claim) :=
  correct active scope
  AND claim is active
  AND claim lifecycle state is retrievable
  AND claim validity interval permits retrieval
  AND claim has non-empty historical source refs
  AND every historical ref matches a current valid source
```

`confirmed` is potentially retrievable; it is not sufficient by itself.

`candidate`, `needs_review`, `superseded`, `archived`, `trashed` and `purged` are not normal retrieval states in the public protocol.

## 7. Lifecycle Semantics

### 7.1 Confirmation

A claim may transition to `confirmed` only when its referenced sources are currently valid under the protocol.

Confirmation is explicit. Kairos does **not** infer semantic truth from source text.

### 7.2 Edit

Editing a claim does not preserve confirmed status automatically. A confirmed claim that is edited moves into review-oriented state and must be explicitly refreshed / reconfirmed before becoming eligible again.

### 7.3 Reconciliation

When a source no longer satisfies a persisted historical ref, `reconcileMemorySources` may move an affected active claim into `needs_review` and record invalidation.

Reconciliation does not rewrite history to make old provenance agree with new source state.

### 7.4 Supersession and archival

Superseded and archived claims remain part of state history but are excluded from normal retrieval.

## 8. Retrieval Semantics

### 8.1 Candidate matching

The public snapshot uses literal lexical matching for normal retrieval. It does not claim semantic retrieval quality.

### 8.2 Eligibility after matching

A lexical or other derived candidate set is insufficient to authorize retrieval.

Every returned memory claim MUST pass live eligibility checks against the current snapshot.

### 8.3 Non-authoritative indexes

An index is disposable derived state.

A stale index MUST NOT make stale memory retrievable if the current source state has changed.

The implementation therefore rechecks current source content and eligibility before returning matches.

## 9. Scope Isolation

All public memory operations occur within one explicit context scope (`relationshipId` in the extracted testbed vocabulary).

Rows from another scope MUST NOT be silently projected into the active scope.

Duplicate source IDs or claim IDs in a canonical projection MUST fail closed rather than being silently overwritten by map construction.

## 10. Persistence Adapter Contract

The public persistence adapter assumes a caller-owned storage port.

The adapter:

- validates the scoped projection;
- reconstructs claims from persisted historical refs;
- validates command receipts;
- verifies observed post-write state;
- maintains disposable in-memory indexes;
- rejects malformed canonical state.

The adapter does not provide a production database.

The caller remains responsible for:

- durable storage;
- transactions;
- correct source version / digest maintenance;
- receipt persistence;
- concurrency control;
- backup / crash recovery;
- physical deletion semantics.

## 11. Fail-Closed Conditions

The public protocol rejects, rather than repairs or guesses through, conditions including:

- missing historical refs;
- malformed historical refs;
- duplicate historical refs for one source ID;
- duplicate source IDs;
- duplicate claim IDs;
- malformed digest values;
- cross-scope projection leaks;
- invalid lifecycle receipts;
- a writer reporting success without applying the requested state transition.

The design preference is explicit failure over silent state reinterpretation.

## 12. Non-Goals

The V1.1 public artifact does **not** claim to implement:

- semantic entailment between source text and a confirmed claim;
- semantic negation understanding;
- automatic contradiction resolution;
- learned relevance ranking;
- production persistence;
- trusted / signed attestations;
- real-provider integration;
- long-duration autonomous-agent evaluation;
- multimodal or embodied memory;
- robot, VLM or VLA validation.

A confirmed claim means the caller explicitly confirmed it under the protocol; it does not mean Kairos proved that the claim is semantically true.

## 13. Reference Conformance Scenarios

### Scenario A — confirmed and unchanged

```text
historical ref: e1@v1/d1
current source: e1@v1/d1
claim state: confirmed
```

Expected: source-valid and potentially retrievable.

### Scenario B — source drift

```text
historical ref: e1@v1/d1
current source: e1@v2/d2
claim state: confirmed
```

Expected: not retrieval-eligible. Reconciliation moves the claim toward review / invalidation rather than rebinding provenance.

### Scenario C — malformed persistence

```text
source_refs_json missing or malformed
```

Expected: canonical projection fails closed.

### Scenario D — stale index

```text
index built when source = v1
afterward source becomes v2
```

Expected: index membership does not authorize return. Live eligibility rejects the stale claim.

### Scenario E — edited claim

```text
confirmed claim -> edited statement / source reference
```

Expected: explicit review / reconfirmation is required before retrieval eligibility returns.

## 14. Research Interpretation

Kairos should be interpreted as a **protocol prototype**, not as a complete memory framework.

Its main implemented proposition is:

> **Historical provenance and current source state are separate facts, and retrieval eligibility depends on comparing them at query time.**

The current artifact demonstrates this proposition with deterministic offline tests and synthetic data. It does not establish novelty relative to every existing memory system, nor does it establish real-world retrieval quality.

## 15. Current Evidence

The V1.1 release gate records:

- 77 passing offline tests;
- source-drift regressions;
- historical-provenance reload regressions;
- duplicate-ID and malformed-ref fail-closed tests;
- an offline demo showing stale-memory rejection and explicit refresh / reconfirmation.

These results support conformance of this public prototype to the invariants above; they are not a benchmark of general agent-memory performance.
