# Performance and storage of the candidate versioning model

The shared-open-commit model is unchanged. This implementation makes repeated
analysis incremental, caches immutable results, and moves review work off the
browser's main thread. It retains the underlying Automerge edits and exact
checkpoint snapshots.

## Reproduce the measurements

```sh
npm test
npm run benchmark
npm run build
```

`benchmarks/versioning.mjs` constructs the same small synthetic workloads used in
the initial assessment. Cold numbers are medians of three runs with application
analysis caches and the change index cleared. Cached numbers reuse exact heads
through new document objects. The incremental case adds one edit to an already
indexed document. Timings use Node on the local development machine, exclude
browser rendering and worker transport, and are observations rather than budgets
or performance guarantees. Repeated text compresses unusually well in these fixtures.

Representative measurements on 2026-09-28, rounded:

| Workload | Previous implementation | Optimized cold analysis | Optimized cached analysis |
| --- | ---: | ---: | ---: |
| Commit summaries, 1,000 edits | 209 ms | 17 ms | — |
| Passage review, 1,000 edits in two offline typing runs | 429 ms | 194 ms | under 0.01 ms |
| All closed reviews, 200 edits and 10 checkpoints | 920 ms | 23 ms | 0.4 ms |

After 1,000 indexed edits, one additional edit took about 0.2 ms to update commit
summaries and about 14 ms for review analysis. The review computation runs in the
worker in the browser. It is not a claim that complete input latency is 0.2 ms:
Automerge editing, rendering, transport, and scheduling have separate costs.

The 200-edit/10-checkpoint document serialized to about 1.8 KB, versus about 3.0 KB
before immutable metadata records. These repetitive fixtures do not establish
an average number of bytes per real-world edit.

## What changed

- **One index per analysis realm.** Related branches reuse change nodes by hash.
  New updates use `getChangesMetaSince`; immutable operations are classified once
  instead of diffing every old state merely to determine whether text changed.
- **Compact causality.** A clock records the latest observed sequence per actor
  lineage. Ancestor tests are lookups, and common frontiers use intersected clocks.
  Index space is roughly O(N × A), with N changes and A actor lineages, rather than
  storing O(N²) ancestor-hash references for a long linear history. Many actors can
  still make these clocks large.
- **Incremental summaries and typing runs.** An open commit adds only new
  contributions to its cached counts. A typing run links to previous segments;
  it does not retain a copied edit array for every typed character. Historical
  arrays are materialized only when needed. Closed summaries cache exact heads.
- **Range-based candidates.** A sweep of cursor-anchored ranges compares touching
  runs from different actors. Causal checks discard sequential pairs. Entirely
  separate passages do not enter expensive pairwise diff analysis. The regression
  suite compares this path with exhaustive comparisons on multiple histories.
- **Worker and backpressure.** Only one review job is in flight; waiting live jobs
  for the same branch coalesce to the latest heads. Only new binary changes are
  sent after the initial transfer. Each result belongs to its requested snapshot.
  Resolution applies only if the document still has those exact heads.
- **Immutable snapshot caches.** Cache keys depend on heads, not JavaScript object
  identity. Closed reviews persist in the separate `textarea-history-analysis`
  IndexedDB database, with a version prefix and a 256-entry LRU limit. In-memory
  review and summary caches also have entry limits. These are entry limits, not
  strict byte limits; unusually large individual review results can be large.
  Persistence is optional: failures fall back to computation.
- **Bounded commit rendering.** Each branch shows its open commit and at most 20
  closed cards, with Newer/Older navigation. Only historical badges near the viewport
  request analysis. Expanded diffs remain lazy. The diagnostic activity timeline
  is still a full-history view.
- **Smaller immutable metadata.** New commit, merge, and resolution records are
  scalar JSON (`ImmutableString`), rather than nested collaborative text objects
  for every identifier. Legacy nested records remain readable. Each checkpoint
  records only newly consumed merge IDs.

## Shared branch storage investigation

The existing Repo adapter persists each document independently. Cloning preserves
change identities, but does not create a shared on-disk history store across
branch document IDs.

In the source-plus-four-branches fixture, there were **1,014 references to 210
unique changes**. The five compressed documents occupied about **5.3 KB** in total.
Storing each unique binary change separately would require about **42 KB** before
keys, indexes, or manifests. Thus naive per-change deduplication would make this
fixture larger: it loses the compression obtained by packing a whole document.
These figures describe serialized data, not actual IndexedDB allocation.

The production storage adapter is intentionally unchanged. A useful shared store
would need compressed packs shared by related branches, manifests identifying
each document's heads, crash-safe writes, multi-tab-safe garbage collection, and
backward-compatible loading of existing document snapshots. Those are persistence
semantics and migration work, not a safe side effect of caching derived analysis.
A future storage experiment should compare packed deduplication against Repo's
existing compressed snapshots using realistic histories and many branches.

## Remaining costs

Cold analysis still reads retained history and reconstructs historical text for
uncached typing runs. A fresh 1,000-edit review can still take around 200 ms of
worker time. All-passage overlap remains a worst case for candidate comparisons.
Root metadata catalogs and checkpoint ordering also grow with checkpoint count.

The browser and worker hold separate document state, and all discovered branch
handles remain subscribed. The shared index grows with retained changes; memory
is not bounded independently of document history. Initial worker loading includes
another bundled Automerge runtime. Long-lived projects will eventually need a
history-retention policy or an archive design if retaining every edit is unwanted.

Neither logical commit grouping, passage batching, nor these caches prune edit
history. Historical snapshots, offline merges, and original authorship are preserved.
