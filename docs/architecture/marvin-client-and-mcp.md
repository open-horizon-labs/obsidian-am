# Marvin client and MCP boundaries

The Amazing Marvin client and first MCP server intentionally live in this
repository while the integration has two consumers. Their package boundaries
allow a later split without making separate repositories a prerequisite.

| Layer | Owns | Does not own |
| --- | --- | --- |
| `packages/marvin-client` | Limited-token endpoint models; request/error contract; Node fetch transport; local-first read routing; bounded cache; throttle circuit; stable-ID deduplication; Marvin deep links; source/action state machine | Obsidian vault/UI behavior; MCP schemas; source-note storage |
| `src/marvin` | Obsidian `requestUrl` transport adapter; source-action frontmatter adapter; bounded Today projection; non-destructive category/project projection | HTTP/API semantics, cache policy, or fallback decisions |
| Obsidian plugin | Commands, notices, task rendering, vault/editor changes, Obsidian links | A second Marvin API client |
| `packages/marvin-mcp` | Stdio lifecycle, seven tool schemas, tool-facing result/error presentation | A second Marvin API client; Obsidian access; generic LLM orchestration |

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

The stable label list uses the same local-first route and a longer bounded
cache. The plugin resolves task `labelIds` to namespaced Obsidian tags, while
the MCP exposes the same IDs to `marvin_create_task`; neither consumer
reimplements label API behavior.

Category and child reads are also exposed through the MCP and Obsidian object
API. This lets an agent discover stable parent IDs instead of guessing them.
Selective import remains a plugin projection concern: selected roots include
descendants, ancestors are structure-only, and deselection never authorizes
note deletion.

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

Category, project, and Inbox imports use a separate managed marker. Stable
Marvin IDs locate notes when their generated path or configured root changes.
Frontmatter updates are property-scoped, and the importer repairs the older
malformed list representation before asking Obsidian to parse and rewrite it.
Removed Marvin items are not inferred to be safe deletions, so their notes
remain recoverable.

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

### Cache holds only derived data

Everything in `marvin-incremental-cache-v1.json` must be reconstructible by
re-reading Amazing Marvin. Nothing unique lives there. That invariant is load
bearing in three places:

- **"Reset cache" is a recovery step, not data loss.** The settings button
  deletes the file outright, and the next sync rebuilds it.
- **A schema change re-hydrates instead of migrating.**
  `parseIncrementalCacheState` returns `undefined` on an unrecognized shape and
  the cache rebuilds. A store holding unique data could not simply discard
  itself.
- **The opt-in framing stays honest.** "Off by default, delete it any time, the
  limited REST API remains the source of truth" is only true while the file is
  derived.

The tempting violation is completion history. Marvin's REST API cannot list
what was completed on a day — `/dueItems` is documented as open-only, there is
no parameter for completed items, and no `doneItems` endpoint exists — while
the CouchDB documents do carry `done` and `doneAt`. Retaining those in the
cache would make it the only copy, which is precisely what turns a cache into a
system of record.

Durable user data belongs in the vault instead: versioned, backed up, portable,
and readable without this plugin. `src/marvin/todayProjection.ts` keeps checked
Marvin lines in the daily note for exactly this reason, so completion history
lives in the notes rather than in plugin state.

If a future need genuinely cannot be served from the notes, read it live at
projection time rather than storing it. A one-off query has a different
lifetime from a cache entry and no reason to share the file.

### Why edit and delete are not exposed

The limited API has no update or delete endpoint. Its writes are `addTask`,
`addProject`, `addEvent`, `markDone`, time tracking, reward points, reminders,
and `updateHabit` — nothing that renames an item, reparents it, or changes its
dates. Those need `/api/doc/update` and `/api/doc/delete`, which require a
third credential (`X-Full-Access-Token`) beyond the API token and the database
credentials, and which Marvin's own documentation warns about directly:
updating a document with the wrong shape "might cause Marvin to crash on
startup," and deleting through the API bypasses Marvin's client-side Trash so
"you won't be able to recover any documents deleted in this way."

A tool that can permanently destroy unrecoverable user data, or corrupt the
app's startup state, is not something to hand an autonomous caller because it
would round out a CRUD surface. Editing and deleting stay in Amazing Marvin's
own clients, which is also where users already do them.

This is a scope decision, not a missing feature: reopening it means writing an
evaluation for the third credential the way
`docs/evaluations/0053-amazing-marvin-client.md` did for the client fork.

Note for test planning: verifying that renames, moves, and deletions propagate
into the vault does **not** require MCP routes for them. Perform the operation
in Amazing Marvin and watch the plugin's incremental sync pick it up — which is
also how real users do it.

The MCP starts only a stdio transport; it does not construct a Hono HTTP
server, serve static files, or expose a network listener. Dependency audits may
still report the SDK's transitive Hono adapter. Treat that report as an
upstream-monitoring item rather than evidence of an exposed plugin route, and
reassess it whenever the MCP SDK changes.
