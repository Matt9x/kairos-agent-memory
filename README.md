# Kairos

Evidence-Grounded Long-Term Memory for LLM Agents

Experimental memory protocols: confirmation, provenance, invalidation,
conservative retrieval, and persistence contracts. Runs offline with Node.js;
no model, service, credentials, or third-party packages are required.

## Overview

A long-running agent cannot safely treat every past observation as permanently
valid memory. A statement may be uncertain when first recorded, contradicted
later, or backed by a source that has changed or disappeared. Retrieval must
consider those conditions as well as whether a phrase matches a query.

Kairos is a small research prototype for these rules. It maintains explicit claim
states, checks source versions and digests, and returns only eligible memory
records. A relationship-reflection scenario supplies the application testbed;
the public artifact is the memory core, not a relationship-advice product or a
complete autonomous agent. All public examples and tests use synthetic or
generated data.

## Research Question

**How should a long-running LLM agent maintain and retrieve memory when
observations may become outdated, conflicting, or invalid?**

- **RQ1:** How should an agent distinguish confirmed memory from uncertain or
  invalidated observations?
- **RQ2:** How can provenance information affect whether a memory remains
  eligible for retrieval?
- **RQ3:** How should retrieval behave when a false recall may be more harmful
  than a missed recall?
- **RQ4:** How can persistent state support long-horizon agent behavior without
  treating all historical information as equally valid?

These questions motivate the implementation; the tests do not establish a new
state-of-the-art method or answer them for real-world agents.

## Why This Matters

Stale observations, conflicting memories, invalid sources and false recall can
produce misleading context. Persistent state also preserves mistakes unless its
validity is reconsidered. Kairos makes confirmation, source eligibility and
invalidation explicit so that these behaviors can be inspected and tested.

## Current Scope

- Pure functions for claim confirmation, editing, supersession and archival.
- Provenance-aware memory eligibility within one explicit context scope.
- Literal lexical retrieval, explicit manual evidence selection and index rebuild.
- A storage-port adapter that validates scoped projections, command receipts and
  observed post-write state, including idempotent retry checks.
- An offline JSON checkpoint example and synthetic regression tests.
- A retained synthetic ranking experiment with handcrafted vectors, used to test
  evaluation and selection rules; it is not a deployed dense retriever.

The `relationshipId` identifier remains from the original testbed and defines a
scope boundary. This snapshot has no UI, provider integration, database service
or application runtime.

## Architecture

```text
Caller-supplied observation + version/digest
  -> candidate claim referencing that source
  -> explicit confirmation / edit / reconciliation
  -> claim state and current source eligibility
  -> lexical retrieval or manual evidence selection
  -> provenance-bearing records for downstream context

Caller-owned storage port <-> memory persistence adapter
JSON checkpoint demo      <-> pure memory snapshot
```

The caller supplies observations and confirmations. LLM extraction and consuming
these records in an agent context are not implemented here. The two persistence
lines represent separate examples/contracts, not a shared production database.

## Memory Lifecycle

| State | Meaning in this snapshot |
| --- | --- |
| `candidate` | Recorded claim awaiting confirmation; excluded from memory retrieval. |
| `confirmed` | Potentially retrievable, subject to current scope, source and validity checks. |
| `needs_review` | Edited or reconciled claim requiring review; excluded from retrieval. |
| `superseded` | Replaced claim; excluded from retrieval. |
| `archived` | Inactive claim; excluded from retrieval. |
| `trashed` / `purged` | Deletion states; excluded from retrieval, not proof of physical erasure. |

`applyMemoryCommand` enforces allowed transitions. Editing a confirmed claim moves
it to review; an explicit refreshed edit and confirmation can make it eligible
again. `archiveUnconfirmed` archives candidates/review items aged at least 90 days
when called. There is no background expiry scheduler.

## Provenance and Invalidation

Memory claims reference sources by ID, version and digest. The pure core checks
those references against the current sources at query time, even when an index
already exists. Removed, changed, expired or hidden sources can therefore make
a previously confirmed claim ineligible. `reconcileMemorySources` explicitly
moves affected claims to review.

Digests and version updates must be maintained by the caller. This is not a
tamper-proof history system. The persistence adapter projects lineage from the
storage port's current source rows: a real storage integration must preserve
confirmation provenance and perform invalidation on source changes. Automatic
historical-version invalidation across arbitrary storage writers is not proven.

## Conservative Retrieval

Memory retrieval requires both eligibility and literal matching of every query
chunk. It does not infer synonyms, aliases or corrected spelling. Manual
selection is a separate explicit operation that also checks source eligibility.

The synthetic dense-selection gate rejects candidates with eligibility leaks or
high-harm false positives, even when recall improves. This captures a hypothesis
that missed recall can be preferable to misleading recall in sensitive contexts;
it does not establish that lexical matching is universally safer. In particular,
literal substring matching is not semantic negation understanding, and unresolved
contradictory confirmed claims can both be returned.

## Quick Start

Use **Node.js 22 or later** and npm. This snapshot was verified on Node.js
**24.18.0**, npm **12.0.2**, Windows; other runtime/platform combinations have not
been tested. From the root of this downloaded or cloned repository:

```sh
npm ci --ignore-scripts --offline --no-audit --no-fund
npm run demo
npm test
```

There are no dependencies to download. You can also run the demo directly with
`node examples/offline-memory.mjs`. Do not add personal data to the example.

## Offline Example

A synthetic observation initially says that tea is preferred. The example
confirms the claim, saves and reads a JSON checkpoint, changes the source to
water, rejects the old claim, saves/reads the invalidation, then explicitly
refreshes and confirms the new claim.

```text
candidate: 0 retrieval hits
confirmed: 1 retrieval hit
reloaded checkpoint: 1 retrieval hit
changed source, old index: 0 retrieval hits
reloaded invalidation: needs_review, 0 retrieval hits
refreshed and confirmed: tea=0, water=1
```

Assertions check these outcomes. The example creates an operating-system
temporary directory and removes its checkpoint on exit. The JSON round trip is
real filesystem I/O; it is not encrypted, transactional, concurrency-safe or a
crash-recovery demonstration. The tests for the storage adapter use in-memory
ports and must not be interpreted as database or Android validation.

## Tests

Verified in this standalone snapshot on **2026-09-15**:

| Command | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| `npm run test:memory` | 13 | 0 | 0 |
| `npm run test:persistence` | 55 | 0 | 0 |
| `node --test tests/offline-demo.test.mjs` | 1 | 0 | 0 |
| `npm test` | 69 | 0 | 0 |

The original 68 targeted tests remain; one new test checks the repeated offline
example. Coverage includes scope isolation, state transitions, source changes,
stale indexes, invalid receipts and writers that report success without applying
the requested change. No tests are silently skipped to accommodate extraction.

The retained experiment has 16 handcrafted case definitions and generated
1,000/10,000/50,000-record fixtures. Its printed `device-dense` label describes
simulated rankings with handcrafted vectors, not a device run or real embeddings.
Timing checks are desktop smoke bounds, not performance guarantees or paper
results. No TypeScript compiler or lint configuration is included in this
JavaScript-only snapshot; syntax is checked with Node.

## Project Structure

```text
src/data/                      required state rules and receipt table vocabulary
src/features/memory/           memory core and storage-port adapter
src/features/retrieval/        retained synthetic ranking experiment
tests/                         two original suites and one demo regression
examples/offline-memory.mjs     asserted synthetic checkpoint walkthrough
PROVENANCE.md                  source identity, extraction and data classification
```

## Current Limitations

- Research prototype; no production-readiness claim or real-user-data validation.
- No real-provider evaluation, deployed LLM integration or long-duration agent run.
- No Android real-device persistence verification or native storage integration.
- No full lifecycle verification: physical erasure, backup recovery, concurrent
  updates, process-death recovery and scheduled expiry are not established.
- The storage-port contract depends on correct caller-owned provenance,
  invalidation, transactions and receipt persistence.
- Literal retrieval has no semantic negation handling, synonym understanding,
  automatic contradiction resolution or learned relevance ranking.
- Synthetic benchmarks and handcrafted vectors cannot establish real retrieval
  quality, target-device latency or generalization.
- No multimodal, robot, VLM, VLA or embodied-agent validation.
- Node.js 22+ is the intended runtime range; only the recorded environment was tested.

## Future Research

Not implemented or evaluated in this snapshot: adaptive retrieval, relevance
reversal, deferred relevance, automatic memory conflict resolution, multimodal
memory, and memory retrieval in changing physical environments.

## Toward Embodied Agents

Kairos currently studies memory protocols for a software-agent setting using
synthetic inputs. A future direction is to examine related problems in embodied
agents, where observations are multimodal, environments change over time, and
stale memory may affect physical decisions.

One possible question is: when should an embodied agent reconsider previously
dormant memory after new observations change what is relevant? This is a research
direction, not evidence of robot experiments or implemented VLM/VLA support.

## Provenance

Public snapshot derived from **Kairos**, branch `codex/kairos-mobile-v0`,
commit `bbdc2637914781929099be69403893f86264325c`, snapshot date **2026-09-15**.
See [PROVENANCE.md](PROVENANCE.md) for source-file hashes, dependency mapping,
exact extraction changes, data classification and excluded scope. Original Git
history and non-public operational material are not included.

## License

[MIT](LICENSE), with publication and licensing authorized by the project owner.
No third-party package source, vendor bundle or downloaded dataset is included.
