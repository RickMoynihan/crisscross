# Automerge textarea + activity history

```sh
npm ci
npm start
```

Open http://localhost:8000 and copy the full URL into another tab or browser.
Enter a name at the top left. The native textarea shows collaborators' coloured
carets; the compact activity timeline alongside it groups consecutive edits.
Hover or keyboard-focus an entry for net text edits, timestamps, author/actor ID,
and sequence. Runs show start/end timestamps and a sequence range. Quoted text
makes spaces, newlines, and tabs visible.

## Activity history

The timeline is one linear presentation of the existing Automerge changes.
Dependencies always precede their dependents. Concurrent ready changes are ordered
consistently by timestamp, actor ID, sequence, and hash. This is an activity order,
not an exact chronology: clocks can differ, and late changes can be inserted into
earlier activity. No changes are rewritten and no synthetic joins are created.

Adjacent changes from the same actor and author form a run when no more than two
seconds separates edits. Each entry captures the cumulative state through that
point, represented internally by a set of Automerge heads. Its tooltip compares
that state with the preceding entry, so concurrent contributions accumulate
instead of disappearing when stepping through different authors' edits. Toggle
**Individual changes** to see each change separately. User labels and colours
identify activity without separate tracks or multiple-head indicators.

Click an entry (or press Enter/Space while focused) to enter **History View**.
The textarea becomes read-only. Its captured state stays fixed even if incoming
changes reorder or regroup the timeline. An entry is highlighted only when its
current cumulative state matches the captured snapshot. Remote carets are hidden.
Press **Escape**, **Return to live**, or the sticky **Current document** button to
return to the full live state. Viewing history never changes the shared document.

To demonstrate concurrency, open the same document twice, pause sync in one tab,
edit in both, then resume. Both contributions appear on the same activity timeline.

## Branching from history

In History View, optionally enter a branch name and choose **Branch from here**.
The tab switches to a new live document with its own URL. Use **Copy link** to
invite collaborators onto that branch, with cursors and independent activity
history. A banner identifies the branch and links to its source. Branches can
also be branched. The selector and timeline discover related branches automatically
for everyone sharing the document. Each branch has its own live track; edits and
new history entries update even while you are viewing another branch or a pinned
snapshot. Fork markers retain the exact state from which each branch was created.

The branch preserves the entire snapshot on screen, including concurrent work
represented by multiple heads, and excludes edits outside that snapshot. Original
change hashes and authors are retained. Creation adds one metadata-only change
recording the branch name, source URL, and fork heads. Source and branch edits
stay independent. Reloading preserves the branch and its origin. If sync is paused,
resume it to make the branch available to other browsers.

## Storage and syncing

Sync uses only `wss://sync.automerge.org`; pause disconnects this tab from the relay,
including presence. There is no BroadcastChannel bypass. Documents persist in
IndexedDB. Names are tab-local session preferences and unauthenticated labels.
Each ordinary input event makes a change when text changes; IME composition is
applied as one change against the state where composition began. Author names are
recorded in change messages, so renaming affects future edits only.

Presence uses Automerge cursors and ephemeral messages, refreshed every three
seconds and expired after twelve seconds. It does not enter document history.
Connection status describes the relay connection, not acknowledgement by every
peer. Anyone with a document URL can read and edit it. The complete history is
rendered, so long editing sessions will eventually slow the history view.

`npm run build` produces `public/app.js`; serve `public/` as a static site.
`npm test` checks deterministic ordering, grouping, cumulative history states,
text diffs, branching from historical snapshots, and branch discovery and live
updates between independent users through the Automerge sync protocol.
