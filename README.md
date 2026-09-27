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

This is a proof of concept: there is no authentication, and anyone who has a document URL can read and edit that document.

## Build and run

```sh
npm ci          # install exact locked dependencies
npm start       # dev server on http://localhost:8000 (rebuilds on reload)
npm run build   # produce public/app.js; public/ is then a static site
npm test        # list unit tests, then two clients editing concurrently via the sync server
./deploy.sh     # build and force-push public/ to the gh-pages branch
```

For GitHub Pages, set the repo's Settings > Pages > Source to "Deploy from a branch", using `gh-pages` and `/ (root)`. The site is then served at `https://<user>.github.io/<repo>/`.

## Layout

- `public/index.html`: the page, including all of its CSS
- `src/doc.js`: markdown document logic (join, turning a textarea edit into a splice and mark, author runs)
- `src/index.js`: list document logic. Entries are stored in a map keyed by document URL and sorted by an `order` number, so concurrent reorders can't duplicate or drop entries
- `src/main.js`: the browser UI
- `test/index.test.js`: offline tests for the list, including concurrent edits merged together
- `test/sync.test.js`: end-to-end sync test against the public server

The runtime dependencies are `@automerge/automerge`, `@automerge/automerge-repo`, the websocket network adapter, the IndexedDB storage adapter, and `marked` for the preview. `esbuild` is the only build tool. The Automerge wasm is inlined as base64, so no bundler plugins are needed. The cost is a bundle of about 5 MB.

The editor is a plain `<textarea>` with transparent text. It sits on top of a `<pre>` that shows the same text in each author's colour, so you keep all of the browser's normal editing behaviour.
