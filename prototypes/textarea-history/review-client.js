import { Automerge as A } from '@automerge/automerge-repo/slim'
import { LruCache, headsKey } from './analysis-cache.js'

// One in-flight job and a coalesced queue: fast typing cannot create an unbounded
// backlog of obsolete live snapshots. Results are always addressed by exact heads.
export class ReviewClient {
  constructor({ worker = new Worker(new URL('./review-worker.js', import.meta.url), { type: 'module' }), onUpdate = () => {} } = {}) {
    this.worker = worker; this.onUpdate = onUpdate
    this.results = new LruCache(256); this.pending = new Map(); this.sent = new Map()
    this.nextId = 0; this.active = null; this.failure = null; this.timer = null
    worker.onmessage = ({ data }) => this.receive(data)
    worker.onerror = event => {
      this.failure = event.message || 'Background review is unavailable'
      this.active = null; this.pending.clear(); this.onUpdate()
    }
  }
  get(handle, heads, { persist = false, live = false } = {}) {
    const key = headsKey(heads), result = this.results.get(key)
    const needsPersist = persist && result?.status === 'ready' && !result.persisted
    if (result && !needsPersist) return { ...result, heads }
    if (this.failure) return result ? { ...result, heads } : { status: 'error', error: this.failure, heads }
    if (live) for (const [oldKey, task] of this.pending) if (task.live && !task.persist && task.handle.url === handle.url && oldKey !== key) this.pending.delete(oldKey)
    if (this.active?.key !== key && !this.pending.has(key)) this.pending.set(key, { key, handle, heads: [...heads], persist, live })
    if (persist && this.pending.has(key)) { this.pending.get(key).persist = true; this.pending.get(key).live = false }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.pump() }, 20)
    return result ? { ...result, heads } : { status: 'pending', heads }
  }
  pump() {
    if (this.active || this.failure || !this.pending.size) return
    const task = [...this.pending.values()].find(t => t.live) || this.pending.values().next().value
    this.pending.delete(task.key)
    try {
      const doc = task.handle.doc(), previous = this.sent.get(task.handle.url) || []
      const since = previous.length && A.hasHeads(doc, previous) ? previous : []
      const changes = A.getChangesSince(doc, since)
      this.active = { ...task, id: ++this.nextId, sentHeads: A.getHeads(doc) }
      this.worker.postMessage({ id: this.active.id, url: task.handle.url, heads: task.heads, changes, persist: task.persist })
    } catch (error) {
      this.results.set(task.key, { status: 'error', error: error.message })
      this.active = null; this.onUpdate(); this.pump()
    }
  }
  receive(data) {
    const task = this.active
    if (!task || task.id !== data.id) return
    this.active = null
    if (data.error) {
      this.sent.delete(task.handle.url)
      this.results.set(task.key, { status: 'error', error: data.error })
    } else {
      this.sent.set(task.handle.url, task.sentHeads)
      this.results.set(task.key, { status: 'ready', issues: data.issues, persisted: task.persist })
    }
    this.onUpdate(); this.pump()
  }
  retry(heads) {
    this.results.values.delete(headsKey(heads))
    this.onUpdate()
  }
  stop() { clearTimeout(this.timer); this.worker.terminate(); this.pending.clear() }
}
