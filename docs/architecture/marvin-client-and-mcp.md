# Marvin client and MCP boundaries

The Amazing Marvin client and first MCP server intentionally live in this
repository while the integration has two consumers. Their package boundaries
allow a later split without making separate repositories a prerequisite.

| Layer | Owns | Does not own |
| --- | --- | --- |
| `packages/marvin-client` | Limited-token endpoint models; request/error contract; Node fetch transport; local-first read routing; bounded cache; throttle circuit; stable-ID deduplication; Marvin deep links; source/action state machine | Obsidian vault/UI behavior; MCP schemas; source-note storage |
| `src/marvin` | Obsidian `requestUrl` transport adapter; source-action frontmatter adapter; bounded Today projection | HTTP/API semantics, cache policy, or fallback decisions |
| Obsidian plugin | Commands, notices, task rendering, vault/editor changes, Obsidian links | A second Marvin API client |
| `packages/marvin-mcp` | Stdio lifecycle, four tool schemas, tool-facing result/error presentation | A second Marvin API client; Obsidian access; generic LLM orchestration |

Both runtime adapters construct `MarvinApiClient` instances and one
`MarvinRouter`. Writes use the public API only. Safe reads may use the desktop
API when explicitly enabled, then fall back only when the local endpoint is
unavailable or unsupported.

The Node fetch transport enforces request timeouts with cancellation.
Obsidian's `requestUrl` API does not expose cancellation, so its timeout value
is advisory at that adapter boundary. Neither adapter retries automatically;
live Obsidian verification should include a stalled or unreachable endpoint.

The router caches successful reads in memory. Empty arrays are successful data;
errors are never cached as empty results. Stale-on-error responses are marked
`freshness: "stale"` and carry the current failure. Task creation and
completion invalidate today, due, and children entries.

## Source/action and Today projection

`SourceActionService` persists a pending association before calling Marvin.
Ambiguous transport, 5xx, or invalid-success responses retain that pending
record, so an unattended retry cannot create another task. Definite 4xx
rejections clear the pending state. A successful write promotes it to a linked
record containing the Marvin task ID and deep link.

The Obsidian adapter stores those records in the source note's
`amazing-marvin-actions` frontmatter property. Daily-note refresh reads the
linked task IDs to render a source wikilink when one exists. Tasks created
directly in Marvin render normally without a synthetic source note.

The managed Today region stores its initial morning IDs in a versioned HTML
comment. Refresh atomically replaces only that region against the latest note
contents; new IDs render below the morning list, and content outside the
markers is preserved.

Source/action identity is not a task title and does not belong in MCP prompt
text. The Obsidian projection remains responsible for note mutation; the
shared client remains responsible for Marvin state and explicit failures.

## Upstream and security boundary

The client is an internal fork of
[`@jacobboykin/amazing-marvin-client` v1.1.1](https://github.com/jacobboykin/amazing-marvin-client-js/tree/1f04630374c5ec9c3ff08e847dad96e8ad62fae9).
Its provenance and MIT license are retained in
`packages/marvin-client/UPSTREAM.md` and
`packages/marvin-client/LICENSE.upstream`.

Only Amazing Marvin's limited `X-API-Token` endpoints are in scope. Full-access
CouchDB operations are intentionally absent.
