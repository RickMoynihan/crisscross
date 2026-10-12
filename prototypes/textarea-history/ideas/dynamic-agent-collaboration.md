# Dynamic agent collaboration

## Goal

Explore an agent that behaves like a live collaborator in an Automerge document, rather than a task processor.

Instead of:

```text
user creates task → agent responds
```

prove:

```text
user writes → agent notices document/history context → agent participates nearby
```

The first goal is not maximum intelligence. It is to make the agent feel present, restrained, and useful beside the human.

## Product principle

The agent should behave like a thoughtful collaborator sitting next to you:

- watches quietly
- signals when it has context
- contributes briefly
- writes nearby rather than over the user's hand
- accepts being edited/deleted
- avoids flooding the document with slop

## Smallest useful model

### Ephemeral agent presence

Use ephemeral Automerge messages for transient state:

```js
{
  type: "agent-presence",
  agentId: "agent-runner",
  name: "Assistant",
  status: "watching" | "thinking" | "writing",
  cursor,
  summary,
}
```

Purpose:

- show the agent is present
- show where it is looking
- show when it is thinking or writing
- avoid persisting transient chatter in document history

### Agent text contributions

When the agent writes, use normal Automerge text edits with change metadata:

```js
{
  author: "Assistant",
  userId: "agent:runner",
  kind: "agent-riff",
  mode: "riff",
  openCommitId,
}
```

This lets the existing commit/versioning model summarize agent edits naturally, e.g. `3 edits from Assistant`.

Avoid adding durable task/proposal schemas at first unless the UI needs them.

## Incremental proofs

### Step 1 — Agent cursor presence

Prove the agent can appear as a live collaborator.

Behavior:

- agent connects to the document
- broadcasts an ephemeral cursor
- cursor moves occasionally to the paragraph it is watching
- UI renders it like a human cursor, but with bot/agent styling

No document edits yet.

This proves:

- dynamic agent presence
- ephemeral cursor protocol
- user can see the agent “in the room”

### Step 2 — Agent watches recent editing and sends tiny status

Agent runner listens to document changes.

When the document changes, it broadcasts lightweight status such as:

```text
Assistant is watching your latest paragraph.
Assistant is thinking about nearby suggestions…
```

Constraints:

- debounce heavily
- wait a few seconds after typing stops
- only react to meaningful changes
- do not update more than every 20–30 seconds

This proves the agent can be inspired by live document changes without being noisy.

### Step 3 — Agent writes adjacent riff text

First real dynamic contribution.

Example user text:

```text
We need a better branch workflow for AI-assisted editing.
```

Agent appends nearby:

```text
Assistant riff:
- show agent branches as lightweight alternatives
- keep human approval before merging
- make conflicts explainable rather than hidden
```

Initial rules:

- write below/after the active paragraph
- use a clear prefix
- keep it short, e.g. max 3 bullets
- do not alter the user's paragraph
- rate-limit strongly

This proves the agent can collaborate in-document with small contributions that enter the open commit and history naturally.

### Deferred — Agent-owned riff block

Discard this for now. It may be useful later, but it adds ownership and update semantics before we have proven the simpler adjacent riff interaction.

The deferred idea was to avoid endless appending by giving the agent a bounded scratch area:

```text
[Assistant notes]
- ...
- ...
[/Assistant notes]
```

Potential future rules:

- one block near the relevant paragraph
- max 3 bullets
- replace/update previous bullets rather than adding forever
- if the user edits the block, the agent backs off

For now, prefer simpler adjacent riff text with strong rate limits.

### Step 4 — Human can accept/promote a riff

Initially, the agent's contribution is plain text. The user can edit, delete, or incorporate it manually.

Later possible affordances:

```text
[Turn into paragraph]
[Keep as note]
[Dismiss]
```

Do not add these until the basic dynamic feel works.

## Suggested first prototype behavior

Use a deterministic/canned policy before adding an LLM.

Trigger:

- on document change
- debounce for around 4 seconds
- find the last non-empty paragraph
- if it is different from the last handled paragraph
- broadcast `thinking`
- insert a short assistant riff below it

Example canned riff:

```text
Assistant riff:
- clarify the user-facing outcome
- note the tradeoff or constraint
- add one concrete example
```

Rate limits:

- no more than one riff every 30 seconds
- ignore paragraphs shorter than about 40 characters
- do not riff inside an existing assistant block
- do not riff if the latest edit was from the agent

## Minimal process-local state

Track mostly in the agent runner memory:

```js
{
  lastHeadsSeen,
  lastRiffedText,
  lastRiffAt,
  lastCursorPosition,
}
```

No durable `agent-task:*` records are needed for the first dynamic proof.

## UI changes worth proving

1. Render agent cursor distinctly.
   - bot icon/name
   - agent role in ephemeral cursor message
   - possibly dashed or differently colored caret

2. Assistant tab shows live status.
   - watching
   - thinking
   - writing

3. Later: highlight or summarize agent-written text.
   - not needed initially because history already records author metadata

## What to avoid initially

Avoid these until the basic interaction feels right:

- full document rewrites
- agent editing the user's active paragraph
- long explanations
- explicit task queues
- complex proposal records
- LLM calls on every keystroke
- multiple autonomous agents
- merge/checkpoint automation

## Recommended order

1. Agent ephemeral cursor
2. Watching/thinking/writing status
3. Canned adjacent riff insertion
4. Human can accept/promote or manually edit/delete a riff
5. LLM-generated riff once the interaction model feels right

Deferred: agent-owned bounded riff blocks.
