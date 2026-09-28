# Candidate versioning model: shared open commits

This prototype explores a **candidate versioning model**, inspired by Jujutsu's
working-copy commit and adapted to a shared Automerge document. It is an experiment
in collaborative history, not a settled versioning specification.

Everyone editing a branch shares its open commit. Each input still creates an
immutable Automerge change; the application groups those changes into logical
commits. **Create checkpoint** freezes the snapshot received by this replica and
starts the next shared open commit. No changes are rewritten or squashed.

## User experience

The default commit view shows each branch's open commit and closed checkpoints.
A card summarizes contributions, for example “32 edits from John · 24 edits from
Alice”. Expand **Net changes and individual edits** to inspect the net diff and
the underlying contributions. Multiple-parent commits also offer a diff against
each parent. Parent buttons navigate the checkpoint graph, including across branches.
The **Show activity timeline** toggle retains the original detailed history view.

A title is optional when creating a checkpoint. It describes the commit being
closed. An empty, untitled successor normally reuses its existing parent rather
than adding a redundant checkpoint. A title permits an intentional empty checkpoint.
A pending merge, concurrent checkpoints, or a recorded review decision can still
require a new checkpoint even without new text edits.

Clicking a closed card pins its exact snapshot and makes the textarea read-only.
Incoming activity cannot alter that snapshot. **Return to live** or Escape returns
to the current open commit. Checkpoint notifications do not move another user's
focus or switch their branch.

Edit counts measure changes with text operations, not characters, effort, or final
ownership. Typing and deleting can count as two edits with an empty net diff.
Initialization and branch/checkpoint bookkeeping are excluded. New edits carry a
tab-local session user ID; names can change without splitting that ID's count. These
are unauthenticated labels, not verified accounts. Separate editing sessions have different
IDs, and historical edits without IDs are grouped by Automerge actor.

## Closing and concurrency

A checkpoint promises: **this is exactly the state captured here**. It does not
promise that every collaborator's outstanding edits have arrived. Connection to
the relay is not acknowledgement by all collaborators.

Suppose John closes C while Alice is disconnected. Alice's later-arriving changes
remain outside C and enter the current open successor. Their original authors,
operations, and editing contexts survive. The UI notes edits originating in an
earlier editing context. This is a causal distinction, not wall-clock ordering.
An IME composition begun before a checkpoint can likewise finish afterward without
being inserted retroactively into the checkpoint.

If John and Alice independently close the same open commit, both closed snapshots
survive. After synchronizing, replicas derive the same open successor from the
sorted set of terminal checkpoint IDs:

```text
          John's checkpoint
         /                 \
previous                    shared open commit
         \                 /
          Alice's checkpoint
```

No replica arbitrarily overwrites a shared `currentCommitId`. Closing the shared
successor records both parents. Shared edits can appear in both concurrent closed
snapshots; they are counted once in their successor's combined ancestry. The UI
therefore must not sum all cards to obtain a unique document-wide edit count.

There is one agreed open commit after replicas receive the same state, not global
instantaneous agreement during a network partition. Strictly linear checkpoint
creation would require a coordinator and different offline semantics.

## Branches and merges

- **Checkpoint and branch…** captures the source's open state (or reuses an empty
  successor's parent), then creates a separate open successor on the new branch.
  Only the initiating user switches branches.
- **Branch from checkpoint** clones that exact historical state. It does not close
  or otherwise change the source's current open commit. Arbitrary activity snapshots
  remain inspectable, but the new branch action requires a closed checkpoint.
- Joining an existing branch joins its current open commit.
- **Merge into current branch** checkpoints the received source and target states,
  merges the pinned source history into the target, and records both parent links
  for the target's open commit. Review the result and checkpoint when ready. Later
  source edits are excluded until another merge. If all source text changes and review decisions are
  already present, merging is a no-op.

The branch documents remain independent. Source collaborators stay on their source
branch, including when another user checkpoints it to merge. The branch selector
and existing discovery subscriptions keep related documents available.

Branch identity has a document-URL-scoped key, separate from text and checkpoint
records. Merging another document's metadata cannot change the target's displayed
name or origin. Legacy `branch` fields are still readable; a target's identity is
preserved before importing history. Metadata shares the Automerge document, but
belongs to distinct namespaces. This is not a separate control-document service.

## Conflict and review behavior

Two categories have different meanings:

1. **Conflict:** Automerge reports concurrent assignments to the `text` property.
   The review panel exposes the alternative values, including the value currently
   displayed by Automerge.
2. **Needs review:** concurrent collaborative text operations overlap according to
   the prototype's detector. Automerge has already merged these operations; the
   badge asks a person to review their meaning.

The overlap detector batches consecutive typing by the same actor in the same
editing context and touching text range. Moving to a different passage, observing
another actor's content, crossing an editing-context boundary, or recording a
resolution starts a new run. Grouping uses causal history rather than a timeout,
so offline typing is batched too.

It compares the completed runs against their common causal base. Unchanged
characters separate replacement spans, preserving unrelated edits elsewhere in
the document. Intersecting replacements, insertions inside replacements, and
concurrent insertions at the same position are candidates for review. Touching
candidates are combined into a passage review, including contributions from more
than two editors. Choices show each actor's latest participating version, with
identical results offered only once. Typing “dog” versus “fox” therefore requires
one decision, not approval of every intermediate character.

Separate passages remain separately reviewable, even when a single Automerge
change touches both. The review panel reports the number of underlying edits in
the batch. Resolving a passage acknowledges the observed change pairs within
that passage only; the record stores compact sets of hashes and cursor bounds.
Earlier single-pair resolution records are still recognized. Late typing introduces
new pairs and can require another review. Detection applies both to ordinary
synchronization and explicit branch merges.

The panel displays the common base, the current affected passage, each version,
and an editable result. Surrounding text provides context, with the affected passage
highlighted; only that passage is replaced. Choose a version or write a combined result, then **Apply
resolution**. Resolving text splices only the affected passage, using Automerge
cursors to locate it. It records a new attributed change and a uniquely keyed
resolution record. Original alternatives remain available in history.

A panel is tied to the heads visible when it opened. Any intervening document
change disables applying it until reopened, preventing a stale panel from silently
overwriting newer work. Two offline users can still resolve independently: if
those resolution edits overlap and differ, their merge raises a new review issue.

Open/closed and conflicted/resolved are separate dimensions. A checkpoint can
contain unresolved issues; freezing a snapshot does not approve its content.
Historical badges describe the captured state and remain visible after a later
resolution. Return to live to resolve; historical checkpoints are never rewritten.

## Representation

`versioning.js` defines the application-level checkpoint graph. A closed record is
stored under a unique `commit:<uuid>` key and includes:

- owner branch URL and logical parent IDs;
- `snapshotHeads`, the exact captured Automerge frontier;
- `baseHeads`, the combined parent frontier;
- the open editing context, title, creator, timestamp, and newly consumed merge IDs.

New checkpoint, merge, and resolution records are JSON encoded in Automerge
`ImmutableString` scalars. Their hashes and IDs do not need character-level editing
semantics. Readers continue to accept the original nested records, so existing
documents do not need migration. Checkpoints record only newly consumed merge IDs;
previously consumed IDs remain in their earlier checkpoints.

Checkpoint metadata is written after capturing `snapshotHeads`; the snapshot does
not include its own metadata write. Branch creation explicitly carries its fork
checkpoint record so that the parent remains navigable.

Commit membership is the set of text changes reachable from the captured heads,
minus those reachable from the combined parent heads. Automerge dependencies decide
membership; timestamps only label activity. A merge inherits its parents' edits;
its own edit count describes further edits or resolutions. Per-parent diffs expose
the contributions imported by the merge.

The open commit is derived, not persistently overwritten. Its identity includes the
branch URL and sorted parent IDs. Concurrent checkpoint records are unioned by
Automerge. Unique `merge:<uuid>` records add source/target parents; the next checkpoint
records the merge IDs it consumes. Target history import and its merge record are
applied in one local update. `resolution:<uuid>` records acknowledge individual
review issues. Branch bookkeeping is never counted as a user edit.

Existing documents need no destructive migration. Their uncheckpointed activity
appears in the first open commit. Existing forks retain their exact saved heads.

## Analysis and rendering

A shared in-memory index reads appended change metadata and classifies each change's
text operations once. Actor-sequence clocks replace per-edit ancestor sets. Actor
lineages are namespaced by their first change, keeping unrelated documents safe
even when they reuse actor IDs. Open contribution counts and typing runs update
incrementally. Closed summaries are cached by their immutable snapshot heads.

Passage analysis runs in a module worker. The browser sends incremental Automerge
changes and coalesces pending live requests; old results are cached for their own
heads, never applied to a newer snapshot. A range sweep limits comparisons to
runs touching the same passage. A reserved inline indicator beside the Text heading
shows pending analysis without shifting the editor. Existing findings stay visible
while the same view refreshes, with review actions disabled until fresh results
arrive. The UI shows an error rather than implying that a failed analysis found no issues.
Applying a resolution still checks its exact heads synchronously.

The commit view renders 20 closed checkpoints per branch per page, plus the open
commit. Historical review badges are requested near the visible viewport. Closed
review results are cached in a separate, versioned IndexedDB database, capped at
256 entries. The cache also persists a live result when its heads become a closed
checkpoint. Disk-cache failures fall back to analysis; deleting this cache cannot
lose document history. Full source document history remains in the original store.

See [Performance and storage](performance.md) for reproducible measurements,
remaining costs, and the shared-branch-storage investigation.

## Limits and questions to evaluate

- Text overlap detection is conservative. Passage boundaries follow overlapping
  text operations, not sentence meaning; touching conflicts can form a larger
  passage. It is not a semantic detector: contradictory edits in different passages
  will not be found. It also cannot recognize every equivalent resolution.
- The prototype reviews the document's `text` field, not arbitrary nested fields
  or structured application data. Internal metadata conflicts are not presented
  as content conflicts.
- Cold loads still index retained history and reconstruct uncached typing runs.
  Many actors or many overlapping runs remain expensive. Worker analysis prevents
  this work from blocking typing, but does not eliminate its CPU or memory cost.
  The optional diagnostic activity timeline still computes the full raw history.
- A commit's displayed closed status is an application invariant, not an access
  control boundary. Anyone with the document URL can edit the underlying data.
- Branch creation spans documents. Existing branch registration is idempotent and
  discovery retries unavailable branches; local persistence is flushed before the
  UI finishes the action. There is no distributed multi-document transaction or
  guarantee against a crash before registration. A durable operation journal would
  be needed for stronger crash recovery.
- Titles become fixed with the checkpoint. Shared draft titles, checkpoint rename,
  squash/rebase, revert, and author authentication are not included in this experiment.

## Verification

`test/analysis.test.js` checks incremental indexing, immutable snapshot reuse,
actor isolation, range-index equivalence, worker coalescing, stale results,
persistence, and cache failures. `test/conflict-batches.test.js` covers completed typing alternatives, three-author
passages, independent passage approvals, preservation of unrelated edits, and late
arrivals after a batch decision. `test/versioning.test.js` exercises contribution counts, frozen membership, offline
arrival, concurrent checkpoints, head and historical branches, pinned merge inputs,
identity preservation, repeated merges, text review, stale panels, and concurrent
resolutions. The existing tests retain coverage of activity snapshots, branch
discovery, and real Automerge Repo synchronization between independent replicas.

References: [Jujutsu working-copy commits](https://docs.jj-vcs.dev/latest/working-copy/)
and [Automerge conflicts](https://automerge.org/docs/reference/documents/conflicts/).
