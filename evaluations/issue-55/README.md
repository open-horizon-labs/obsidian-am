# Issue #55 evaluation: incremental Marvin cache

Working notes and tooling for re-evaluating the CouchDB-based incremental
cache approach (originally PR #63) against evidence instead of assumptions.
See `docs/evaluations/0053-amazing-marvin-client.md` for the sibling
evaluation this one is meant to match in rigor.

## Findings, in the order they overturned an assumption

1. **REST throttling is real, broad, and support-confirmed** — not limited
   to the categories→children N+1 pattern, and not avoided by the local
   desktop API fallback. This is the actual justification for paying the
   CouchDB full-database-credential cost. See `couch-resilience.test.mjs`.
2. Marvin's own conflict model is an app-level `fieldUpdates` timestamp
   merge, not CouchDB's native revision-tree conflict resolution — meaning a
   read-only `_changes` consumer never needs PouchDB-style conflict
   handling, because Marvin's write side already resolves conflicts before
   `_changes` ever sees them.
3. `_all_docs` pulls back the **entire** database, not just Tasks/Categories
   — confirmed 10 distinct doc types (`Tasks`, `Categories`, `Events`,
   `Goals`, `PlannerItems`, `SmartLists`, `SavedItems`, `RecurringTasks`,
   `ProfileItems`, `DayItems`), including an `email` field and calendar
   integration URLs. Any bulk-hydration design must filter to the relevant
   `db` types **before** persisting to local disk, not just before display.
4. Tested directly against real (local) CouchDB 3.5.2: **resuming from a
   pre-compaction `since` does not error** — contradicts the "invalidated
   checkpoint" failure mode `couch-resilience.test.mjs` originally modeled.
   Not yet verified against Cloudant specifically (Marvin's actual backend),
   since Cloudant manages compaction internally and it can't be triggered
   externally.
5. `fieldUpdates` is not reliably present — a real task created via REST
   `addTask` and then completed via `markDone` had no `fieldUpdates` field
   at either step. It's likely conflict-resolution-only, not present on
   every write.
6. A real doc created via `addTask` has dozens of fields
   (`masterRank`, `dailySection`, `email`, `times`, `rewardPoints`, ...)
   that `incrementalCache.ts`'s field allowlists don't capture — harmless
   for projection purposes, but worth knowing the allowlist is intentionally
   narrow, not exhaustive.
7. A real in-app delete **is** a genuine CouchDB tombstone (`deleted: true`,
   doc collapses to `{_id, _rev, db, _deleted: true}`) — not the soft-delete
   via a `deletedAt` field I assumed from reading `isPresentDocument()`.
   `incrementalCache.ts`'s existing `physicallyDeleted` check already
   handles this shape correctly; that part of PR #63 didn't need fixing.

## Tooling

- `capture-real-couch.mjs` — one-time, manual capture of a real Marvin
  database via `_all_docs`, reading credentials from `.env.marvin-db`
  (gitignored). Never commit its raw output.
- `scrub-fixture.mjs` — turns a raw capture into a fixture safe to commit:
  keeps structural fields, replaces `title`/`note` with placeholders, drops
  everything else (including anything not on its explicit allowlist).
- `restore-fixture.mjs` — loads a scrubbed fixture into a real local
  CouchDB (`docker run -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test
  couchdb:3`) for integration testing.
- `synthesize-changes.mjs` — performs known operations (create/rename/
  complete/move/delete) against the local restored CouchDB and captures the
  real `_changes` record each one produces. No personal data involved,
  since the operations use synthetic content we authored — only the
  *shape* comes from real CouchDB. See the caveat in finding #7: this
  script's own delete example used a raw CouchDB `DELETE`, which happens to
  match real app-driven deletes, but that was luck, not verification —
  `fixtures/real-changes-examples.json` is the actually-verified version.
- `couch-resilience.test.mjs` — unit tests (fake transport) for the
  decision logic: hydration-vs-throttle, backoff, checkpoint-only-advances-
  on-success.
- `couch-integration.test.mjs` — integration tests against real local
  CouchDB, gated on `COUCH_TEST_URL`. This is where findings #3/#4 were
  actually verified, not assumed.

## Fixtures

- `fixtures/marvin-db-snapshot.json` — scrubbed, structure-preserving
  snapshot of a real Marvin database (1,992 docs). Safe to commit.
- `fixtures/changes-examples.json` — `_changes` records from synthetic
  operations against local CouchDB. Useful for volume/pagination testing;
  do **not** treat its field sets as representative of real Marvin docs.
- `fixtures/real-changes-examples.json` — the three REST/app-verified real
  `_changes` records (create via `addTask`, complete via `markDone`, delete
  via the app UI). This is the authoritative shape reference.

## Credentials

`.env.marvin-db` and `.env.marvin-api` are gitignored. Fill them in your own
editor; nothing reads them except the scripts above, and none of the
scripts print their values.
