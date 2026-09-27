import { Repo, Automerge, initializeBase64Wasm } from "@automerge/automerge-repo/slim"
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64"
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"

const count = document.querySelector("#count")
const increment = document.querySelector("#increment")
const decrement = document.querySelector("#decrement")

try {
  await initializeBase64Wasm(automergeWasmBase64)
  const repo = new Repo({
    network: [new WebSocketClientAdapter("wss://sync.automerge.org")],
    storage: new IndexedDBStorageAdapter(),
  })
  const handle = location.hash
    ? await repo.find(location.hash.slice(1))
    : repo.create({ count: new Automerge.Counter(0) })

  window.handle = handle

  history.replaceState(null, "", `#${handle.url}`)
  const render = () => { count.textContent = handle.doc().count.value }
  handle.on("change", render)
  render()

  increment.onclick = () => handle.change(doc => doc.count.increment(1))
  decrement.onclick = () => handle.change(doc => doc.count.decrement(1))
  increment.disabled = decrement.disabled = false
} catch (error) {
  count.textContent = `Could not load counter: ${error.message}`
}

window.addEventListener("hashchange", () => location.reload())
