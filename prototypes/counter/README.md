# Automerge counter

```sh
npm install
npm start
```

Open http://localhost:8000. Use + and − to change a single Automerge `Counter`.
Copy the full URL (including its fragment) into another tab or browser to edit
the same counter. Remove the fragment to create a new counter.

Changes persist locally in IndexedDB and sync through
`wss://sync.automerge.org`, the [public Automerge sync server](https://automerge.org/docs/tutorial/network-sync/).
No framework or server setup is needed. `npm run build` produces `public/app.js`.
