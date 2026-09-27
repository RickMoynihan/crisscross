# Automerge Markdown

A minimal collaborative markdown editor that demonstrates the [Automerge](https://automerge.org) CRDT.

- Enter a username to start. Each user's text is shown in a colour derived from their username.
- Authorship is stored in the CRDT itself using Automerge **marks** (`author: <username>`) over each insert, so it merges correctly under concurrent edits.
- When a remote edit arrives, your caret stays in place using Automerge **cursors**.
- After logging in you see a shared, editable **list of documents** (itself an Automerge document). You can add, rename, reorder (↑/↓) and delete documents. Deleting moves a document to the **archive**, where it can be restored, so no markdown is ever lost.
- Each document page shows its title from the list. The title is editable there too, and has a link back to the list.
- Documents sync through the public server at `wss://sync.automerge.org`. URLs are `#<list url>` for the list and `#<list url>/<document url>` for a document, so you can share any page's URL to collaborate. Links from before the list existed open in a new list containing that document.
- Every document you open is also saved in your browser (IndexedDB). If the sync server can't be reached, the document still loads and you can keep editing. The connection retries every 5 seconds, and when it comes back, changes from both sides are merged. The status line shows whether you're online or offline.
- To use a self-hosted sync server, add `?sync=wss://your-server` to the page URL.
- AI agents can read and edit the wiki through an MCP server or a CLI (see below). The **Copy link for an AI agent** button copies the page URL along with setup instructions.

This is a proof of concept: there is no authentication, and anyone who has a document URL can read and edit that document.

## Build and run

```sh
npm ci          # install exact locked dependencies
npm start       # dev server on http://localhost:8000 (rebuilds on reload)
npm run build   # produce public/app.js; public/ is then a static site
npm test        # list unit tests, then sync and MCP end-to-end tests against the public sync server
./deploy.sh     # build and force-push public/ to the gh-pages branch
```

For GitHub Pages, set the repo's Settings > Pages > Source to "Deploy from a branch", using `gh-pages` and `/ (root)`. The site is then served at `https://<user>.github.io/<repo>/`.

## Using with AI agents

The repo is also an npm package, `automerge-wiki`, which gives agents access to any wiki from its URL. It provides:

- an **MCP server** for Claude Desktop, Claude Code and other MCP clients
- a **CLI** for scripts and shell-using agents

It runs locally with `npx` and connects straight to the sync server; there's nothing to host. Collaborators only need Node.js 20+, and this GitHub repo must be public, since `npx` fetches it from GitHub.

### Claude Code

```sh
claude mcp add -s user automerge-wiki -e AUTOMERGE_WIKI_AUTHOR="claude (for alice)" -- npx -y github:RickMoynihan/amexp mcp
```

`-s user` makes it available in every project. The `-e` setting is optional; it sets the name the agent's edits appear under in the editor.

### Claude Desktop

Open Settings > Developer > Edit Config and add this to `claude_desktop_config.json`, then restart Claude:

```json
{
  "mcpServers": {
    "automerge-wiki": {
      "command": "npx",
      "args": ["-y", "github:RickMoynihan/amexp", "mcp"],
      "env": { "AUTOMERGE_WIKI_AUTHOR": "claude (for alice)" }
    }
  }
}
```

If Claude reports it can't start `npx`, use the full path from `which npx` as the `command`.

### Using it

Paste a wiki link into the chat, for example "Summarise the wiki at https://rickmoynihan.github.io/amexp/#automerge:…" or "Add a decisions section to the Meeting notes page". You don't need to configure individual wikis. Any page URL from the web app works, as does a bare `automerge:` URL. Documents are referred to by title or by URL.

| Tool | What it does |
| --- | --- |
| `list_documents` | Titles, URLs and page links, in order, plus the archive |
| `read_document` | Markdown, title and authors |
| `edit_document` | Replace one exact, unique piece of text (preferred: merges cleanly with concurrent human edits) |
| `append_to_document` | Add text to the end |
| `write_document` | Replace the whole text (large rewrites only) |
| `create_document` | Add a new document to the list |
| `rename_document` | Change a title |
| `archive_document` / `restore_document` | Remove from, or return to, the list. Nothing is ever deleted |

Agent edits are attributed to `AUTOMERGE_WIKI_AUTHOR` (default `agent (<your OS username>)`), so they show in their own colour in the editor. Every write is checked with a second connection to the sync server, and the tool says whether the server confirmed it.

### CLI

The same package works as a command line tool, which is useful for scripts, CI, or agents without MCP:

```sh
npx -y github:RickMoynihan/amexp ls   "https://rickmoynihan.github.io/amexp/#automerge:…"
npx -y github:RickMoynihan/amexp cat  "<url>" "Meeting notes" > notes.md
npx -y github:RickMoynihan/amexp edit "<url>" "Meeting notes" "old text" "new text"
npx -y github:RickMoynihan/amexp write "<url>" "Meeting notes" < notes.md
npx -y github:RickMoynihan/amexp new    # create an empty wiki and print its URL
```

Run it with no arguments to see all commands. A write only exits successfully once the sync server has confirmed it. Otherwise it exits with status 1, because the change would be lost when the process exits. From a checkout, use `node bin/automerge-wiki.js` instead of `npx …`.

Environment variables:
- `AUTOMERGE_WIKI_AUTHOR`: the name edits are attributed to
- `AUTOMERGE_WIKI_SYNC`: a sync server other than `wss://sync.automerge.org`

### Caveats

- **The URL is the password.** Anyone, or any agent, holding a wiki URL can read and edit all of it.
- **Document text is untrusted input to your agent.** Collaborators write it, and a document could contain instructions aimed at agents. The tools wrap document text in `<document>` tags and tell the agent to treat it as content, but you should still review what your agent does with a shared wiki.
- **Edits can be undone, but not from the app yet.** Archiving protects the list, but an agent can still overwrite a document's text. Automerge keeps the full history, so text can be recovered, though neither the app nor the tools have an undo yet.

## Layout

- `public/index.html`: the page, including all of its CSS
- `src/doc.js`: markdown document logic (join, turning a textarea edit into a splice and mark, author runs)
- `src/index.js`: list document logic. Entries are stored in a map keyed by document URL and sorted by an `order` number, so concurrent reorders can't duplicate or drop entries
- `src/main.js`: the browser UI
- `src/wiki.js`: Node access to a wiki (open by URL, find documents by title, read, edit, and confirm writes reached the sync server)
- `src/mcp.js`, `src/format.js`: the MCP tools and the text output they share with the CLI
- `bin/automerge-wiki.js`: the CLI, including the `mcp` command
- `test/index.test.js`: offline tests for the list, including concurrent edits merged together
- `test/sync.test.js`: end-to-end sync test against the public server
- `test/mcp.test.js`: starts the MCP server over stdio and calls its tools

The web app's runtime dependencies are `@automerge/automerge`, `@automerge/automerge-repo`, the websocket network adapter, the IndexedDB storage adapter, and `marked` for the preview. The MCP server adds `@modelcontextprotocol/sdk` and `zod`. `esbuild` is the only build tool. The Automerge wasm is inlined as base64, so no bundler plugins are needed. The cost is a bundle of about 5 MB.

The editor is a plain `<textarea>` with transparent text. It sits on top of a `<pre>` that shows the same text in each author's colour, so you keep all of the browser's normal editing behaviour.
