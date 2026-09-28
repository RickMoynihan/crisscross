import { branchLinks, registerBranch } from './branches.js'

// Keep every discovered branch subscribed, even while another branch or a
// historical snapshot is selected. Heads also change for commits with no patches.
export function watchBranches(repo, { author, onUpdate }) {
  const documents = new Map(), loading = new Set(), unavailable = new Map()
  const listeners = new Map()
  let scheduled = false, stopped = false

  function schedule() {
    if (scheduled || stopped) return
    scheduled = true
    // Run outside DocHandle's state transition; discovering/registering branches
    // can itself change a document. Batch those changes into one UI update.
    queueMicrotask(() => {
      scheduled = false
      if (stopped) return
      for (const doc of documents.values()) discover(doc)
      for (const doc of documents.values()) {
        const source = documents.get(doc.doc().branch?.source)
        if (source) registerBranch(source, doc, author())
      }
      onUpdate()
    })
  }

  function watch(doc) {
    if (stopped || documents.has(doc.url)) return
    documents.set(doc.url, doc)
    unavailable.delete(doc.url)
    doc.on('heads-changed', schedule)
    listeners.set(doc, schedule)
    schedule()
  }

  function discover(doc) {
    for (const { url } of branchLinks(doc)) {
      if (documents.has(url) || loading.has(url) || unavailable.has(url)) continue
      loading.add(url)
      repo.find(url).then(found => {
        if (!stopped) watch(found)
      }).catch(() => {
        if (!stopped && !documents.has(url)) unavailable.set(url, Date.now())
      }).finally(() => {
        loading.delete(url)
        schedule()
      })
    }
  }

  return {
    documents, loading, unavailable, watch,
    retry() {
      let retry = false
      for (const [url, time] of unavailable) {
        if (Date.now() - time > 15000) { unavailable.delete(url); retry = true }
      }
      if (retry) schedule()
    },
    stop() {
      stopped = true
      for (const [doc, listener] of listeners) doc.off('heads-changed', listener)
      listeners.clear()
    },
  }
}
