// Plain-text output shared by the CLI and the MCP server.

const title = (t) => `"${t?.trim() || "Untitled"}"`
const line = (e, bullet) => `${bullet} ${title(e.title)}  ${e.url}${e.page ? `  ${e.page}` : ""}`

export function formatList(list) {
  return [
    `Wiki: ${list.wiki}`,
    list.page && `Page: ${list.page}`,
    "",
    "Documents:",
    ...(list.documents.length ? list.documents.map((e, i) => line(e, `${i + 1}.`)) : ["(none)"]),
    "",
    "Archive (deleted, restorable):",
    ...(list.archived.length ? list.archived.map((e) => line(e, "-")) : ["(none)"]),
  ]
    .filter((l) => l !== null && l !== undefined)
    .join("\n")
}

// The document body is fenced so it's clearly content, not instructions.
export function formatDoc(d) {
  return [
    `Title: ${title(d.title)}`,
    `URL: ${d.url}`,
    d.page && `Page: ${d.page}`,
    d.archived && "Archived: yes (deleted from the list; can be restored)",
    `Authors: ${d.authors.join(", ") || "(none)"}`,
    "",
    "<document>",
    d.text,
    "</document>",
  ]
    .filter((l) => l !== null && l !== undefined && l !== false)
    .join("\n")
}

export function formatWrite(verb, r) {
  return [
    `${verb} ${title(r.title)}.`,
    r.url && `URL: ${r.url}`,
    r.page && `Page: ${r.page}`,
    r.confirmed
      ? "Saved to the sync server."
      : "Warning: the sync server hasn't confirmed this change yet (it may be unreachable). It is kept in memory and retried while this process runs.",
  ]
    .filter(Boolean)
    .join("\n")
}
