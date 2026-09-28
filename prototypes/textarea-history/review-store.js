import { ANALYSIS_VERSION } from './analysis-cache.js'

// Derived data only: losing this database never loses edits or checkpoints.
// Persist closed snapshots, not every transient state produced while typing.
export class ReviewStore {
  constructor(factory = globalThis.indexedDB, limit = 256) {
    this.limit = limit
    this.database = factory ? new Promise((resolve, reject) => {
      const request = factory.open('textarea-history-analysis', 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('reviews', { keyPath: 'key' })
        store.createIndex('accessed', 'accessed')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }).catch(() => null) : Promise.resolve(null)
  }
  async get(key) {
    const db = await this.database
    if (!db) return undefined
    return new Promise(resolve => {
      const tx = db.transaction('reviews', 'readwrite'), store = tx.objectStore('reviews')
      const request = store.get(`${ANALYSIS_VERSION}:${key}`)
      let value
      request.onsuccess = () => {
        if (request.result) {
          value = request.result.issues
          store.put({ ...request.result, accessed: Date.now() })
        }
      }
      tx.oncomplete = () => resolve(value)
      tx.onerror = tx.onabort = () => resolve(undefined)
    })
  }
  async set(key, issues) {
    const db = await this.database
    if (!db) return
    return new Promise(resolve => {
      const tx = db.transaction('reviews', 'readwrite'), store = tx.objectStore('reviews')
      store.put({ key: `${ANALYSIS_VERSION}:${key}`, issues, accessed: Date.now() })
      const count = store.count()
      count.onsuccess = () => {
        let excess = count.result - this.limit
        if (excess <= 0) return
        const cursor = store.index('accessed').openCursor()
        cursor.onsuccess = () => {
          if (cursor.result && excess-- > 0) { cursor.result.delete(); cursor.result.continue() }
        }
      }
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve()
    })
  }
}
