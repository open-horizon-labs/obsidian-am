# Amazing Marvin client, routing, and cache evaluation

Issue: [#53](https://github.com/open-horizon-labs/obsidian-am/issues/53)

Supports: [#52](https://github.com/open-horizon-labs/obsidian-am/issues/52) and [#51](https://github.com/open-horizon-labs/obsidian-am/issues/51)

Evaluated: 2026-07-23

## Decision

Fork and extend
[`@jacobboykin/amazing-marvin-client` v1.1.1](https://github.com/jacobboykin/amazing-marvin-client-js/tree/1f04630374c5ec9c3ff08e847dad96e8ad62fae9)
inside this repository for #52. Preserve its MIT attribution and useful endpoint
models, but do not take a runtime dependency on the published package.

This should initially be an internal fork, co-located with the plugin and MCP
as already planned in #52. It can move to a dedicated repository/package later
if another consumer makes that useful.

The current plugin is more complete in product-specific behavior: it uses
Obsidian's transport, attempts local-desktop reads before public API reads,
adds deep links, and presents human-facing throttle failures. The candidate is
more complete in API breadth, typed models, structured HTTP errors, timeouts,
and tests. The fork should combine those strengths.

Direct adoption is not viable:

- The package export map exposes only `require`. Native Node ESM import fails
  with `ERR_PACKAGE_PATH_NOT_EXPORTED`, and the plugin's esbuild import fails
  because no `browser`, `import`, `module`, or `default` condition exists.
- Its default three retries mean four public requests for a single 429 or
  retryable failure. The 65-test suite takes about 70 seconds because error
  cases exercise those real backoff delays.
- It has no local-to-public routing or cache.
- It discards error response bodies and models only one origin per client.
- The project was created in September 2025, contains seven commits and two
  releases over two days, has one star and no issue history, and has had no
  push since 2025-09-14. Its source is useful; its maintenance cadence is not a
  dependency boundary to rely on.

The upstream code is preferable to a clean-room rewrite because its limited
token endpoint coverage, types, retry/error tests, and dependency-free runtime
are substantial reusable work. Forking lets us correct the infrastructure
policy and packaging in one code line.

### Other JavaScript options screened

| Option | Useful material | Why it is not the shared client |
| --- | --- | --- |
| [`@pipedream/amazing_marvin`](https://www.npmjs.com/package/@pipedream/amazing_marvin) | Maintained integration actions and endpoint examples | Pipedream component boundary, not a reusable typed client |
| [Amazing Marvin browser-extension helpers](https://github.com/amazingmarvin/amazingmarvin-browserextension/blob/master/src/utils/api.js) | Official request behavior and endpoint examples | Coupled to extension storage, background messaging, and UI workflows |
| [`amazing-marvin-mcp-server`](https://www.npmjs.com/package/amazing-marvin-mcp-server) | MCP tool naming and API-reference material | MCP implementation rather than a shared plugin/MCP client; does not supply our local routing or #51 identity semantics |
| Current plugin client code | Proven Obsidian transport, local-first intent, links, and notices | Embedded in `src/main.ts`, weak error boundary, no cache/tests, and only a small endpoint subset |

These remain references for fork tests and API behavior. None changes the
decision to own one in-repository fork rather than stack adapters around
multiple libraries.

## Evidence

The candidate was checked out at
[`1f04630`](https://github.com/jacobboykin/amazing-marvin-client-js/commit/1f04630374c5ec9c3ff08e847dad96e8ad62fae9).

- `npm test -- --run`: 65/65 tests passed in 70.24 seconds.
- `npm run test:coverage`: 94.75% statement/line coverage and 85.18%
  branch coverage for `src/client.ts`.
- `npm run typecheck:all`, `npm run lint`, and `npm run build`: passed.
- A fresh `npm pack @jacobboykin/amazing-marvin-client@1.1.1` was
  file-for-file identical to a package built from the tagged source.
- CommonJS `require()` worked.
- Native Node ESM import failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- The same TypeScript-style import failed under this plugin's esbuild
  configuration because the export map has no matching condition.
- The tests use injected mock `fetch` implementations. They provide strong
  unit coverage, but the files named "integration" and "workflows" are not live
  Marvin contract tests.
- The package has no runtime dependencies and is MIT licensed. Its larger
  dependency tree is development tooling only.

The official API documentation confirms:

- `todayItems` uses `?date=YYYY-MM-DD` or `X-Date`;
- `dueItems` uses `?by=YYYY-MM-DD`;
- `children` is experimental and returns open children;
- the minimal `addTask` example sends only a title; and
- `markDone` is experimental and has incomplete Marvin feature parity.

Sources:
[official Marvin API wiki](https://github.com/amazingmarvin/MarvinAPI/wiki/Marvin-API),
[official API changelog](https://github.com/amazingmarvin/MarvinAPI/blob/5ca43bfd7ed23aa1956e00f9e5f555fe6240510a/CHANGELOG.md),
[desktop local API documentation](https://help.amazingmarvin.com/en/articles/5165191-desktop-local-api-server).

## Feature and reliability matrix

| Concern | Current plugin | Candidate v1.1.1 | Required fork behavior |
| --- | --- | --- | --- |
| Today items | Works with `date`; untyped transport result | Typed `getTodayItems(date)`, query plus header | Retain typed method; normalize and encode date once |
| Due items | Sends unsupported `date` query | Correctly sends documented `by` query | Use `by`; add a contract test so #51 gets the requested day |
| Categories | Public or attempted-local GET | Typed categories/projects | Retain types and stable IDs |
| Children | Public fallback exists; README records local 404 | Typed method against one base URL | Route local first only when enabled; treat 404 as endpoint-specific fallback |
| Add task | Public-only; adds Obsidian note link and timezone offset | Typed, configurable base URL, autocomplete header | Keep integration-specific link construction outside HTTP core; public-only until local write support is proven |
| Mark done | Public-only; user notices; some errors are swallowed | Typed request/error, but assumes response shape | Keep explicit errors and public-only default; contract-test the response |
| IDs and types | Small task/category interfaces plus deep links | Broad limited-token models | Seed from candidate; narrow/verify fields used by #51/#52; do not imply runtime validation |
| Empty vs. error | `fetchTasksAndCategories` converts every failure to `[]` | Successful empty array is distinct from thrown `MarvinError` | Preserve this distinction through plugin and MCP result envelopes |
| Timeout | Delegated to `requestUrl`; no explicit policy | 10 seconds per attempt using `AbortController` | One deadline per operation; transport reports whether cancellation is supported |
| 429 | No automatic retry; some operations show a notice | Retries 3 times by default, honors `Retry-After` | Default to zero retries; expose retry time and open a short public-origin circuit |
| Other retries | None | Retries network and 5xx with uncapped, non-jittered exponential delay | Router may opt into one jittered retry for idempotent public GETs only; never retry writes automatically |
| Error detail | String/console/notice; later failure overwrites local detail | Status, method, endpoint, timestamp; response body discarded | Preserve origin, status, response detail, cause, retry-after, and every attempted origin |
| Local routing | Intended local-first, but currently contacts local even when disabled | One base URL per instance | Correct setting gate; valid empty local result stops routing; fallback only for unavailable/unsupported local reads |
| Cache | None | None | Credential-scoped bounded memory cache with explicit freshness metadata |
| Test quality | No test command or transport tests | 65 mocked tests; high unit coverage; no live contract test | Keep unit suite; add routing/cache, packaging, adapter-contract, and optional live smoke tests |
| Obsidian runtime | Works through `requestUrl` | Published import cannot be bundled | Dual ESM/CJS exports plus an Obsidian transport adapter and bundle smoke test |
| MCP/Node runtime | Not available | `require` works; native ESM import fails | Native ESM entry point and Node fetch transport; same client contract as plugin |
| Dependencies/license | Existing plugin dependencies; MIT | Zero runtime dependencies; MIT | Preserve zero or near-zero runtime footprint and upstream attribution |
| Maintenance | Product code is ours but API access is embedded in `main.ts` | Brief release history and no ongoing activity | Own releases/tests in this repository; upstream can remain a reference |

Two current-plugin defects should be corrected while #52 migrates callers:

1. `fetchMarvinData` performs the local request before checking
   `useLocalServer`. When disabled, a successful local result is then ignored
   and the public API is called too.
2. `getDueTasks` uses `?date=`, but the documented parameter is `?by=`.

The current `Set` union of due and scheduled results also deduplicates by
JavaScript object identity, not Marvin `_id`; #52 already requires stable-ID
deduplication.

## Routing policy

The executable decision prototype is
[`evaluations/issue-53/local-first-router.test.mjs`](../../evaluations/issue-53/local-first-router.test.mjs).
Run it with:

```sh
node --test evaluations/issue-53/local-first-router.test.mjs
```

The production router should follow these rules:

1. Only safe reads are local-first. Writes remain public-only until a local
   endpoint is explicitly verified.
2. If local use is disabled, do not contact localhost.
3. A valid local response, including `[]`, is success and stops routing.
4. Fall back for local connection/timeout failures and unsupported/unavailable
   statuses such as 404, 405, 501, and transient 5xx.
5. Do not turn local 400/401/403/429 responses into a public request. Those are
   request, credential, permission, or throttle signals, not evidence that an
   endpoint is missing.
6. On public fallback success, return `origin: "public"` plus diagnostic
   metadata about the local failure.
7. If both origins fail, throw one structured error containing both attempts.
   Never replace it with an empty list.

Fallback eligibility belongs to endpoint/origin policy, not a blanket
`catch { try public }`.

## Cache and throttle policy

Use a credential-scoped, in-memory LRU cache. A cache instance belongs to one
configured client, so tokens never appear in cache keys. Recreate or clear it
when credentials or local-origin settings change. Within that instance, key
entries by operation plus canonical arguments (for example
`todayItems:2026-07-23` or `children:unassigned`).

| Read | Key arguments | Fresh TTL | Stale-if-error window |
| --- | --- | ---: | ---: |
| Today items | normalized date | 30 seconds | 10 minutes |
| Due items | normalized `by` date | 30 seconds | 10 minutes |
| Children | parent ID | 60 seconds | 15 minutes |
| Categories | none | 5 minutes | 60 minutes |

Additional rules:

- Maximum 128 entries and coalesce concurrent reads for the same key.
- Cache only successful, schema-valid reads. A successful empty array may be
  cached; an error may not.
- Return `{ data, freshness, origin, fetchedAt, ageMs, warnings }`, where
  `freshness` is `fresh`, `cached`, or `stale`.
- Return stale data only after a transient network, timeout, 429, or 5xx
  failure. Never return stale data for authentication, permission, validation,
  or malformed-response failures.
- A stale result must carry the current failure as a warning. Callers decide
  whether stale is acceptable; it is never presented as fresh.
- `addTask` invalidates today, due, and affected children entries because
  title autocomplete can alter scheduling/parentage.
- `markDone` invalidates today, due, and children entries. With only 128
  entries, invalidating all task-list reads is simpler and safer than keeping a
  reverse membership index.
- Do not retry 429 in the request loop. Record `Retry-After` as
  `publicBlockedUntil`, serve explicit stale data when allowed, or return an
  actionable throttle error without contacting public again during that
  interval.
- Automatic retries default to zero. If later evidence justifies it, allow at
  most one jittered retry for idempotent public GETs on network/5xx failures.
  Never automatically retry `addTask`.

## Minimal fork delta for #52

1. Seed an internal `packages/marvin-client` from upstream v1.1.1 with license
   and provenance, exposing dual ESM/CJS entry points.
2. Replace the hard `typeof fetch` assumption with the shared request/response
   transport contract needed by both an Obsidian `requestUrl` adapter and a
   Node fetch adapter. Make timeout/cancellation capability explicit.
3. Change retry defaults to zero, preserve response bodies and causes in
   errors, bound any delay, and add origin/attempt metadata at the router.
4. Add the local-first read router and bounded cache above the typed endpoint
   client. Keep writes public-only initially.
5. Correct/encode query parameters, especially `dueItems?by=`, and relax or
   default request fields where the official minimal request permits them.
6. Add package smoke tests for native Node ESM and the plugin's esbuild,
   adapter contract tests, routing/cache tests, and a token-gated live smoke
   test that is not required in normal CI.
7. Migrate the plugin and first MCP tools to the same client contract. Keep
   deep-link rendering, Obsidian note mutation, and #51 source/action identity
   above the HTTP/router layer.

Estimated follow-up scope is three small implementation slices: about half a
day for fork provenance/packaging, one day for transport/routing/cache and
tests, and one to two days to migrate the plugin and add the first MCP vertical
slice. No separate architecture spike is warranted.

## Verification still required during #52

This evaluation did not use a live Marvin token or running desktop API. The
official contract, current plugin behavior, and candidate mock suite are enough
to choose the code boundary, but #52 should use a token-gated smoke test to
confirm actual response shapes for `addTask` and `markDone` and record which
read endpoints the current desktop release supports.

The initial TTLs and stale windows are policy defaults, not measured truths.
Expose cache/throttle diagnostics so real plugin and MCP use can shorten or
lengthen them without changing result semantics.

## Exit test

This decision should be revisited only if the fork starts accumulating API
surface unrelated to actual plugin/MCP consumers, or if Amazing Marvin
publishes an actively maintained official limited-token client with compatible
routing hooks. Until then, the fork gives #52 one owned client contract without
reimplementing the candidate's useful work or inheriting its release defects.
