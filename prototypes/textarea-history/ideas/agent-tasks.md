# Agent tasks

## Small first proof

Prove the smallest durable human/agent loop using Automerge records in the shared document.

### Step 1 — Durable task

The browser writes a task record:

```js
agent-task:<id> = {
  id,
  type,
  status,
  prompt,
  createdAt,
}
```

Minimum fields:

- `id` — unique task id
- `type` — initially `"echo"`
- `status` — initially `"open"`
- `prompt` — user instruction
- `createdAt` — timestamp

Ignore initially: selections, branch URLs, base heads, claiming, cancellation, failures, model metadata.

### Step 2 — Agent result

The agent runner watches for open tasks and writes a result:

```js
agent-result:<id> = {
  id,
  taskId,
  text,
  createdAt,
}
```

Minimum fields:

- `id` — unique result id
- `taskId` — task being answered
- `text` — agent response
- `createdAt` — timestamp

The agent also updates the task:

```js
agent-task:<id>.status = "done"
```

### Step 3 — UI loop

Add a small Assistant UI with:

- prompt input
- `Ask assistant` button
- task/result list

The first task type can be `"echo"`, where the runner replies with something like:

```js
text: `Received: ${prompt}`
```

This proves:

```text
human request → Automerge task → agent sees it → agent writes result → UI updates
```

## Bigger idea

The fuller design is to make AI agents first-class collaborators in the shared Automerge document. Agents can run as separate daemon processes connected to the same sync server. Instead of adding a custom backend API, the document itself carries durable task, result, proposal, and review records.

Ephemeral messages remain useful for transient agent presence/status, such as “idle”, “thinking”, or “working”. Durable `agent-task:*` and `agent-result:*` records are used for auditable work.

## Future features/tasks

Possible next increments after the initial loop:

1. **Task lifecycle**
   - Add `claimed`, `failed`, and `canceled` statuses.
   - Let the runner claim tasks before processing.
   - Let users cancel pending/running tasks.

2. **Selection-aware tasks**
   - Store `baseHeads`, `startCursor`, and `endCursor`.
   - Let the agent answer questions about the exact selected text snapshot.

3. **Proposal records**
   - Agent writes proposed replacements instead of editing directly.
   - UI shows before/after diff with `Apply` and `Dismiss`.

4. **Apply proposal**
   - Human applies a proposal into the current open commit.
   - Record who applied it and when.

5. **Undo applied proposal**
   - Record enough metadata to create a compensating edit.
   - Offer `Undo AI change` when safe.

6. **Branch-based agent work**
   - Agent creates an alternative branch, edits it, and checkpoints it.
   - Humans review and merge using the existing history/merge UI.

7. **Merge conflict suggestions**
   - Agent suggests resolutions for recorded merge conflicts.
   - Human chooses whether to apply or edit the suggestion.

8. **LLM-backed runner**
   - Replace canned responses with actual model calls.
   - Keep the same task/result/proposal protocol.

9. **Harness integrations**
   - Run Pi/Codex/Claude-style harnesses from the agent runner.
   - Or expose Automerge collaboration tools through MCP/custom tools.
