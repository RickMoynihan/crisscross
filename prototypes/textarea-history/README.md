# Automerge textarea + shared commit history

```sh
npm ci
npm start
```

Open http://localhost:8000 and copy the full URL into another tab or browser.
Enter a name at the top left. The native textarea shows collaborators' coloured
carets. Everyone on a branch shares an **open commit**, with contributions summarized
as “32 edits from John · 24 edits from Alice”. **Create checkpoint** freezes the
received state and starts the next shared open commit. Expand a card for net changes
and individual edits, or enable **Show activity timeline** for the original view.

This is a **candidate versioning model**, inspired by Jujutsu and adapted for
Automerge. [Read the model, concurrency rules, implementation, and limitations](docs/candidate-versioning-model.md).

## Checkpoints, branches, and review

Give a checkpoint an optional title, then choose **Create checkpoint**. Closed
commits are immutable snapshots; clicking one makes the textarea read-only.
Late offline edits enter the next open commit. Simultaneous checkpoints both
survive, and their shared open successor has both as parents.

Use **Checkpoint and branch…** from live editing, or **Branch from checkpoint**
from a closed card. Only the initiating user switches branches. Select another
branch and choose **Merge into current branch** to merge fixed source/target
checkpoints into the target's open commit. Review and checkpoint the result.

Overlapping concurrent text edits are batched into passage reviews, with completed
versions from each editor instead of individual character approvals. They show
**Needs review**. Actual competing property
values show **Conflict**. **Review** displays the base, alternatives, current passage,
and an editable result. Applying a choice records a new edit; it never rewrites a
closed snapshot. The text detector is a conservative overlap heuristic, not a
semantic conflict detector. A stale review panel must be reopened before applying.
Review runs in a background worker; “Checking…” means the result is pending.
Closed review results are cached across reloads. History uses pages of 20 closed
commits per branch and analyzes historical badges near the visible viewport.

## Activity history

The timeline is one linear presentation of the existing Automerge changes.
Dependencies always precede their dependents. Concurrent ready changes are ordered
consistently by timestamp, actor ID, sequence, and hash. This is an activity order,
not an exact chronology: clocks can differ, and late changes can be inserted into
earlier activity. No changes are rewritten and no synthetic joins are created.

Enable **Show activity timeline** to inspect individual Automerge changes. Each
entry captures the cumulative state through that point as a set of heads. Its
tooltip compares that state with the preceding entry, so concurrent contributions
accumulate instead of disappearing when stepping through different authors' edits.
Named tracks identify branches; labels and colours identify authors.

Click an entry (or press Enter/Space while focused) to enter **History View**.
The textarea becomes read-only. Its captured state stays fixed even if incoming
changes reorder or regroup the timeline. An entry is highlighted only when its
current cumulative state matches the captured snapshot. Remote carets are hidden.
Press **Escape**, **Return to live**, or the sticky live-document button to
return to the full live state. Viewing history never changes the shared document.

To demonstrate concurrency, open the same document twice, pause sync in one tab,
edit in both, then resume. Both contributions appear on the same activity timeline.

## Branching from history

Select a closed commit, optionally enter a branch name, and choose **Branch from checkpoint**.
The tab switches to a new live document with its own URL. Use **Copy link** to
invite collaborators onto that branch, with cursors and independent activity
history. A banner identifies the branch and links to its source. Branches can
also be branched. The selector and timeline discover related branches automatically
for everyone sharing the document. Each branch has its own live track; edits and
new history entries update even while you are viewing another branch or a pinned
snapshot. Branch tracks split directly at their historical source entry. A branch-name
badge at the junction opens the exact saved starting state, even if later concurrent
changes alter the source timeline.

The branch preserves the entire snapshot on screen, including concurrent work
represented by multiple heads, and excludes edits outside that snapshot. Original
change hashes and authors are retained. Creation adds metadata recording the branch
name, source URL, fork heads, and parent checkpoint. Head branching first closes
the received source state. Source and branch edits stay independent. Reloading preserves the branch and its origin. If sync is paused,
resume it to make the branch available to other browsers.

## Storage and syncing

This prototype has no custom application server or backend API. It is served as a
static site; all application-specific logic runs in the browser, including editing,
commit/checkpoint metadata, branch operations, merge handling, conflict review, and
history rendering. Review analysis runs in a browser Web Worker so it does not block
the UI; it is not server-side processing.

Sync uses only `wss://sync.automerge.org`; the Automerge sync relay transports
document changes and ephemeral presence messages, but does not run app-specific
merge, review, checkpoint, or branch logic. Pause disconnects this tab from the
relay, including presence. There is no BroadcastChannel bypass. Documents persist in
IndexedDB. Names are tab-local session preferences and unauthenticated labels.
Each ordinary input event makes a change when text changes; IME composition is
applied as one change against the state where composition began. Author names are
recorded in change messages, so renaming affects future edits only.

Presence uses Automerge cursors and ephemeral messages, refreshed every three
seconds and expired after twelve seconds. It does not enter document history.
Connection status describes the relay connection, not acknowledgement by every
peer. Anyone with a document URL can read and edit it. All edits remain stored. The commit view uses incremental summaries, cached
snapshots, and bounded pages; the optional activity timeline still examines the
full history. [Performance measurements and storage tradeoffs](docs/performance.md).

`npm run build` produces `public/app.js` and `public/review-worker.js`; deploy both
and serve `public/` as a static site. `npm run benchmark` measures cold, cached, and
incremental analysis plus branch-storage duplication.
`npm test` checks the candidate commit model, conflicts and resolutions, deterministic
ordering, grouping, cumulative history states, text diffs, branching from historical snapshots, and branch discovery and live
updates between independent users through the Automerge sync protocol.
