# Automerge Markdown

A minimal collaborative markdown editor that demonstrates the [Automerge](https://automerge.org) CRDT.

- Enter a username to start. Each user's text is shown in a colour derived from their username.
- Authorship is stored in the CRDT itself using Automerge **marks** (`author: <username>`) over each insert, so it merges correctly under concurrent edits.
- When a remote edit arrives, your caret stays in place using Automerge **cursors**.
- Documents sync through the public server at `wss://sync.automerge.org`. The document URL is in the page's `#hash`, so you can share the page URL to collaborate. "New document" starts a fresh document.
- Every document you open is also saved in your browser (IndexedDB). If the sync server can't be reached, the document still loads and you can keep editing. The connection retries every 5 seconds, and when it comes back, changes from both sides are merged. The status line shows whether you're online or offline.
- To use a self-hosted sync server, add `?sync=wss://your-server` to the page URL.

This is a proof of concept: there is no authentication, and anyone who has a document URL can read and edit that document.

## Build and run

```sh
npm ci          # install exact locked dependencies
npm start       # dev server on http://localhost:8000 (rebuilds on reload)
npm run build   # produce public/app.js; public/ is then a static site
npm test        # two clients edit concurrently via the sync server and must converge
./deploy.sh     # build and force-push public/ to the gh-pages branch
```

For GitHub Pages, set the repo's Settings > Pages > Source to "Deploy from a branch", using `gh-pages` and `/ (root)`. The site is then served at `https://<user>.github.io/<repo>/`.

## Layout

- `public/index.html`: the page, including all of its CSS
- `src/doc.js`: document logic (join, turning a textarea edit into a splice and mark, author runs)
- `src/main.js`: the browser UI
- `test/sync.test.js`: end-to-end sync test against the public server

The runtime dependencies are `@automerge/automerge`, `@automerge/automerge-repo`, the websocket network adapter, the IndexedDB storage adapter, and `marked` for the preview. `esbuild` is the only build tool. The Automerge wasm is inlined as base64, so no bundler plugins are needed. The cost is a bundle of about 5 MB.

The editor is a plain `<textarea>` with transparent text. It sits on top of a `<pre>` that shows the same text in each author's colour, so you keep all of the browser's normal editing behaviour.
