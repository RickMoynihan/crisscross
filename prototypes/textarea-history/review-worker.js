import { initializeBase64Wasm } from '@automerge/automerge-repo/slim'
import { automergeWasmBase64 } from '@automerge/automerge/automerge.wasm.base64'
import { createReviewProcessor } from './review-worker-core.js'
import { ReviewStore } from './review-store.js'

const ready = initializeBase64Wasm(automergeWasmBase64)
const process = createReviewProcessor(new ReviewStore())
// Keep document updates serialized, including the asynchronous disk-cache lookup.
let queue = Promise.resolve()
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      await ready
      self.postMessage({ id: data.id, ...await process(data) })
    } catch (error) { self.postMessage({ id: data.id, error: error.message }) }
  })
}
