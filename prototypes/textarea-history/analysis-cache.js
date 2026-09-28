// Version this when analysis semantics change. Heads name immutable snapshots,
// but cached interpretations must not survive an incompatible algorithm update.
export const ANALYSIS_VERSION = 2
export const headsKey = heads => [...heads].sort().join(',')
export class LruCache {
  constructor(limit = 256) { this.limit = limit; this.values = new Map() }
  get(key) {
    if (!this.values.has(key)) return undefined
    const value = this.values.get(key)
    this.values.delete(key); this.values.set(key, value)
    return value
  }
  set(key, value) {
    this.values.delete(key); this.values.set(key, value)
    if (this.values.size > this.limit) this.values.delete(this.values.keys().next().value)
    return value
  }
  clear() { this.values.clear() }
}
