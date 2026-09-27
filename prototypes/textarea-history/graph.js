// A deterministic activity order, not a rewrite of Automerge history.
// Dependencies always come first; concurrent ready changes use timestamp,
// actor ID, sequence and hash as a consistent tie-breaker.
export function activityOrder(changes) {
  const children = new Map(changes.map(c => [c.hash, []]))
  const remaining = new Map(changes.map(c => [c.hash, c.deps.length]))
  for (const c of changes) for (const dep of c.deps) {
    if (!children.has(dep)) throw new Error('Incomplete change history')
    children.get(dep).push(c)
  }
  const compare = (a, b) => (a.time || 0) - (b.time || 0) ||
    (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0) || a.seq - b.seq ||
    (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
  const ready = changes.filter(c => !c.deps.length).sort(compare), ordered = []
  while (ready.length) {
    const c = ready.shift()
    ordered.push(c)
    for (const child of children.get(c.hash)) {
      remaining.set(child.hash, remaining.get(child.hash) - 1)
      if (!remaining.get(child.hash)) { ready.push(child); ready.sort(compare) }
    }
  }
  if (ordered.length !== changes.length) throw new Error('Invalid change history')
  return ordered
}

export function sameHeads(a, b) {
  return a?.length === b?.length && a.every(hash => b.includes(hash))
}

export function layout(changes, { grouped = false, selected = null } = {}) {
  const runs = [], heads = new Set()
  for (const c of activityOrder(changes)) {
    const beforeHeads = [...heads]
    for (const dep of c.deps) heads.delete(dep)
    heads.add(c.hash)
    const afterHeads = [...heads]
    const run = runs.at(-1), previous = run?.changes.at(-1)
    const extend = grouped && previous && previous.hash !== selected &&
      previous.actor === c.actor && author(previous) === author(c) &&
      c.time >= previous.time && c.time - previous.time <= 2
    if (extend) {
      run.changes.push(c); run.latest = c; run.afterHeads = afterHeads
    } else runs.push({ latest: c, changes: [c], beforeHeads, afterHeads })
  }
  const nodes = runs.reverse().map((run, row) => ({
    ...run.latest, changes: run.changes, beforeHeads: run.beforeHeads,
    afterHeads: run.afterHeads, row,
  }))
  return { nodes }
}
export function author(change) {
  try { return JSON.parse(change.message).author || 'Anonymous' } catch { return 'Initialization' }
}
export function color(id) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return `hsl(${Math.abs(hash) % 360} 55% 40%)`
}
