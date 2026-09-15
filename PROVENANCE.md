# Source provenance and extraction boundary

Public snapshot derived from:

- Source project: Kairos
- Source repository identifier: `project-001-kairos`
- Source branch: `codex/kairos-mobile-v0`
- Source commit: `bbdc2637914781929099be69403893f86264325c`
- Snapshot created at: 2026-09-15T13:46:45+08:00 (discovery baseline)
- Source state: clean at extraction
- History: new public snapshot; no original Git directory or history included
- Authorization: the project owner confirmed authority to publish the selected code and tests, including AI-assisted development, and approved MIT licensing on 2026-09-15.

Source paths below are repository-relative. Public paths omit the original `mobile/` prefix.

## Selected source files

| Public file | SHA-256 of original source bytes | Extraction change |
| --- | --- | --- |
| `src/features/memory/memoryCore.mjs` | `cf75dc93d337d802d91e72216b13eaf95a3de9a5d869b1e12b26ce5c05002a86` | LF normalization only; otherwise unchanged |
| `src/features/memory/memoryPersistenceAdapter.mjs` | `7a33218c9e4ef00407927e7de9738a13ed10f03be87081a8988bd9146fbfe120` | Internal task-number comments replaced by public storage-boundary descriptions; executable code unchanged. |
| `src/features/retrieval/benchmark.mjs` | `60de04639914f0b4137da51a77734fd15f204e67006f10485cbce90438bed26d` | LF normalization only; otherwise unchanged |
| `src/data/localDataCore.mjs` | `2922381b71398700f2785ce8ae25b114476681bd8f4d7d6c9eca74673123fff9` | Exact extraction of claimTransitions, transition, transitionClaim, isClaimRetrievable and assertIsoUtcTimestamp; unrelated schema, encryption, provider and application helpers excluded. |
| `src/data/lifecycleCore.mjs` | `7cf8ac0ca2ee3e18af9aa34ca06487acee5fa900a6fba089004ca2e8fcafedb8` | Only canonicalTables retained, with a scope comment; lifecycle services and other helpers excluded. |
| `tests/memory-retrieval.test.mjs` | `7ab269459defde733833f80031b01f0e819dae584d4c66e8552fe1f0ba1be618` | Benchmark log label renamed; all 13 tests and assertions retained. |
| `tests/memory-persistence-adapter.test.mjs` | `c23c780890cba390385b5ec2946175ed8343ab36f5e3e9283e48b6e0d4375288` | LF normalization only; otherwise unchanged |

The hashes identify source bytes before extraction, not the modified snapshot files.
The two shared modules retain only transitive requirements. In particular, the
table vocabulary does not mean that the excluded application tables or a database
implementation are delivered here.

## Dependency map

```text
tests/memory-retrieval.test.mjs
  -> memoryCore.mjs -> localDataCore.mjs
  -> benchmark.mjs -> memoryCore.mjs

tests/memory-persistence-adapter.test.mjs
  -> memoryPersistenceAdapter.mjs
       -> memoryCore.mjs
       -> localDataCore.mjs
       -> lifecycleCore.mjs (canonicalTables only)

examples/offline-memory.mjs
  -> memoryCore.mjs
  -> Node standard library (assert, crypto, fs, os, path, url)
tests/offline-demo.test.mjs -> examples/offline-memory.mjs
```

There are no third-party runtime or development packages. No Expo, UI, provider,
database, vector service or original repository file is required at runtime.
The unchanged `relationshipId` field is a testbed scope identifier.

## Public data classification

| Location | Classification | Evidence / decision |
| --- | --- | --- |
| `tests/memory-retrieval.test.mjs` | SAFE_SYNTHETIC | Literal, inline sources and claims; fixed artificial IDs/dates; explicit mutations construct invalid and cross-scope cases. No imported conversation files. |
| `tests/memory-persistence-adapter.test.mjs` | SAFE_SYNTHETIC | Inline fixture constructs two scopes, three claims and in-memory receipts; test functions deliberately corrupt copies. No external records. |
| `src/features/retrieval/benchmark.mjs` | SAFE_SYNTHETIC / SAFE_GENERATED | Sixteen handwritten cases, generated filler records, and handcrafted one-hot vectors; no embeddings or corpus download. |
| `examples/offline-memory.mjs` | SAFE_SYNTHETIC | Newly authored artificial tea-to-water observation; digests computed from those literals; fixed date. Temporary checkpoint is deleted after each run. |
| `tests/offline-demo.test.mjs` | SAFE_SYNTHETIC | Expected output for the new example; no imported user data. |
| `package.json`, `package-lock.json` | SAFE_GENERATED | Snapshot-specific package metadata and dependency-free npm lockfile. |
| Documentation | SAFE_GENERATED | Newly authored from inspected code, current verification and non-sensitive source identity. |
| All other original fixtures, samples, datasets and reports | UNKNOWN_ORIGIN for this extraction | Not part of the reviewed allowlist; excluded without assuming their names prove safety. |

The names/aliases and short Chinese phrases in fixtures are fictional test
literals, not records of actual participants. All public examples and tests use
synthetic or generated data.

## New snapshot files

The package metadata, ignore/line-ending rules, MIT license, this provenance note,
README, offline example and its one regression test were authored for this
snapshot. The example adds only a temporary JSON save/reload demonstration around
existing memory functions; it is not a replacement persistence implementation.

## Excluded scope

- Legacy Web/backend code and their dependencies or CI.
- Mobile UI, Android/iOS projects and application wiring.
- Database migrations, encryption/key handling, provider configuration and sessions.
- Lifecycle service implementation outside the receipt table vocabulary.
- Original build outputs, dashboards, operational records and historical reports.
- Original datasets and conversations outside the inline synthetic cases above.
- Training, downloaded vectors, real-provider evaluation and embodied experiments.

## Ownership and attribution

The selected source belongs to the Kairos project according to the owner's
publication authorization. The inspected allowlist contains no vendor files,
generated bundles, third-party source headers or external package dependencies.
This is a scoped provenance review, not an independent legal determination.
MIT applies to the public snapshot; the source project's unpublished history is
not relicensed or distributed by this extraction.
