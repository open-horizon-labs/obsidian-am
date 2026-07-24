// evaluations/issue-55/harness/pr63-src/couchChanges.ts
var CouchChangesError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "CouchChangesError";
  }
};
var CouchChangesClient = class {
  constructor(credentials, transport) {
    this.transport = transport;
    this.databaseUrl = validatedDatabaseUrl(credentials.databaseUri);
    if (!credentials.databaseUser.trim() || !credentials.databasePassword) {
      throw new Error("Amazing Marvin database user and password are required");
    }
    this.authorization = `Basic ${base64Utf8(
      `${credentials.databaseUser}:${credentials.databasePassword}`
    )}`;
  }
  async changes(options) {
    const url = new URL(
      `${this.databaseUrl.pathname.replace(/\/+$/, "")}/_changes`,
      this.databaseUrl
    );
    url.searchParams.set("since", serializeSequence(options.since));
    url.searchParams.set("feed", options.feed ?? "normal");
    url.searchParams.set("include_docs", String(options.includeDocs ?? true));
    url.searchParams.set("limit", String(options.limit ?? 500));
    if (options.feed === "longpoll") {
      url.searchParams.set("timeout", String(options.timeoutMs ?? 25e3));
    }
    let response;
    try {
      response = await this.transport.request({
        url: url.toString(),
        headers: {
          Accept: "application/json",
          Authorization: this.authorization
        }
      });
    } catch {
      throw new CouchChangesError(
        "Could not reach the Amazing Marvin changes feed"
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new CouchChangesError(
        `Amazing Marvin changes feed failed with HTTP ${response.status}`,
        response.status
      );
    }
    let value;
    try {
      value = JSON.parse(response.text);
    } catch {
      throw new CouchChangesError(
        "Amazing Marvin changes feed returned invalid JSON",
        response.status
      );
    }
    return parseChangesPage(value);
  }
};
function validatedDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Amazing Marvin database URI is invalid");
  }
  if (url.username || url.password) {
    throw new Error(
      "Keep Amazing Marvin database credentials in their separate fields"
    );
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Amazing Marvin database URI must use HTTPS");
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error("Amazing Marvin database URI must include the database name");
  }
  url.search = "";
  url.hash = "";
  return url;
}
function serializeSequence(sequence) {
  if (sequence === "now" || typeof sequence === "string") {
    return sequence;
  }
  return JSON.stringify(sequence);
}
function parseChangesPage(value) {
  if (typeof value !== "object" || value === null || !Array.isArray(value.results) || !("last_seq" in value)) {
    throw new CouchChangesError(
      "Amazing Marvin changes feed returned an invalid page"
    );
  }
  const raw = value;
  const results = raw.results.map((entry) => {
    if (typeof entry !== "object" || entry === null || typeof entry.id !== "string" || !("seq" in entry)) {
      throw new CouchChangesError(
        "Amazing Marvin changes feed returned an invalid change"
      );
    }
    const change = entry;
    if (change.doc !== void 0 && (typeof change.doc !== "object" || change.doc === null || typeof change.doc._id !== "string")) {
      throw new CouchChangesError(
        "Amazing Marvin changes feed returned an invalid document"
      );
    }
    return {
      id: change.id,
      seq: change.seq,
      ...change.deleted === true ? { deleted: true } : {},
      ...change.doc === void 0 ? {} : { doc: change.doc }
    };
  });
  return {
    results,
    lastSeq: raw.last_seq,
    ...typeof raw.pending === "number" ? { pending: raw.pending } : {}
  };
}
function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// evaluations/issue-55/harness/pr63-src/incrementalCache.ts
var IncrementalMarvinCache = class {
  constructor(options) {
    this.options = options;
    this.resetting = false;
  }
  sync(feed = "normal") {
    if (this.resetting) {
      return Promise.reject(
        new Error("Incremental Amazing Marvin cache is being reset")
      );
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    const pending = this.syncOnce(feed).finally(() => {
      this.inFlight = void 0;
    });
    this.inFlight = pending;
    return pending;
  }
  getCategories() {
    return this.state ? projectableCategories(this.state.categories).map((item) => ({ ...item })) : void 0;
  }
  getChildren(parentId) {
    const children = this.state?.children[parentId];
    if (!children || !this.state) {
      return void 0;
    }
    const projectableIds = new Set(
      projectableCategories(this.state.categories).map((item) => item._id)
    );
    return children.filter((item) => item.type !== "category" && item.type !== "project" || projectableIds.has(item._id)).map((item) => ({ ...item }));
  }
  getStatus() {
    return {
      hydrated: this.state !== void 0,
      ...this.state === void 0 ? {} : { lastSuccessfulSyncAt: this.state.lastSuccessfulSyncAt }
    };
  }
  async clear() {
    this.resetting = true;
    try {
      await this.inFlight?.catch(() => void 0);
      this.state = void 0;
      await this.options.store.clear();
    } finally {
      this.resetting = false;
    }
  }
  async acknowledgeProjection() {
    if (!this.state || !this.state.projectionPending) {
      return;
    }
    this.state.projectionPending = false;
    await this.options.store.save(this.state);
  }
  async syncOnce(feed) {
    const hydrated = await this.ensureHydrated();
    if (hydrated) {
      return hydrated;
    }
    return this.pullChanges(feed);
  }
  async ensureHydrated() {
    if (this.state) {
      return void 0;
    }
    const stored = parseStoredState(
      await this.options.store.load(),
      this.options.sourceKey
    );
    if (stored) {
      this.state = stored;
      return void 0;
    }
    const checkpoint = await this.options.changes.changes({
      since: "now",
      feed: "normal",
      limit: 1,
      includeDocs: false
    });
    const categories = await this.options.snapshot.getCategories();
    const children = {};
    for (const category of categories) {
      children[category._id] = await this.options.snapshot.getChildren(
        category._id
      );
    }
    children.unassigned = await this.options.snapshot.getChildren("unassigned");
    const now = this.options.now?.() ?? Date.now();
    this.state = {
      version: 1,
      sourceKey: this.options.sourceKey,
      lastSeq: checkpoint.lastSeq,
      categories: dedupeItems(categories),
      children: Object.fromEntries(
        Object.entries(children).map(([parentId, items]) => [
          parentId,
          dedupeItems(items)
        ])
      ),
      lastSuccessfulSyncAt: now,
      projectionPending: true
    };
    await this.options.store.save(this.state);
    const caughtUp = await this.pullChanges("normal");
    return {
      ...caughtUp,
      fullRefresh: true,
      changed: true
    };
  }
  async pullChanges(initialFeed) {
    if (!this.state) {
      throw new Error("Incremental Marvin cache is not hydrated");
    }
    const combined = {
      changed: false,
      affectedContainerIds: /* @__PURE__ */ new Set(),
      inboxChanged: false
    };
    const projectionWasPending = this.state.projectionPending;
    const maxPages = this.options.maxPagesPerSync ?? 100;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await this.options.changes.changes({
        since: this.state.lastSeq,
        feed: pageNumber === 0 ? initialFeed : "normal",
        limit: 500,
        timeoutMs: 25e3,
        includeDocs: true
      });
      const applied = applyCouchChanges(this.state, page.results);
      this.state.projectionPending ||= applied.changed;
      this.state.lastSeq = page.lastSeq;
      this.state.lastSuccessfulSyncAt = this.options.now?.() ?? Date.now();
      mergeApplied(combined, applied);
      await this.options.store.save(this.state);
      if ((page.pending ?? 0) <= 0 && page.results.length < 500) {
        break;
      }
      if (pageNumber === maxPages - 1) {
        throw new Error(
          "Incremental Marvin sync exceeded its bounded page limit"
        );
      }
    }
    return {
      fullRefresh: projectionWasPending,
      changed: combined.changed,
      affectedContainerIds: [...combined.affectedContainerIds],
      inboxChanged: combined.inboxChanged,
      lastSuccessfulSyncAt: this.state.lastSuccessfulSyncAt
    };
  }
};
var IncrementalRetryBackoff = class {
  constructor(now = Date.now, baseDelayMs = 5e3, maximumDelayMs = 5 * 6e4) {
    this.now = now;
    this.baseDelayMs = baseDelayMs;
    this.maximumDelayMs = maximumDelayMs;
    this.failures = 0;
    this.retryAt = 0;
  }
  canRun() {
    return this.now() >= this.retryAt;
  }
  recordFailure() {
    const delay = Math.min(
      this.maximumDelayMs,
      this.baseDelayMs * 2 ** this.failures
    );
    this.failures += 1;
    this.retryAt = this.now() + delay;
    return delay;
  }
  recordSuccess() {
    this.failures = 0;
    this.retryAt = 0;
  }
};
function applyCouchChanges(state, changes) {
  validateRelevantChanges(changes);
  const affectedContainerIds = /* @__PURE__ */ new Set();
  let inboxChanged = false;
  let changed = false;
  const oldCategories = state.categories.map((item) => ({ ...item }));
  const changedCategoryIds = /* @__PURE__ */ new Set();
  for (const change of changes) {
    const previousCategory = state.categories.find(
      (item) => item._id === change.id
    );
    const previousLocations = childLocations(state.children, change.id);
    const previousChildren = previousLocations.flatMap((parentId) => state.children[parentId] ?? []).filter((item) => item._id === change.id);
    const previousCopies = [
      ...previousCategory ? [previousCategory] : [],
      ...previousChildren
    ];
    if (change.doc?._rev && previousCopies.length > 0 && previousCopies.every((item) => item._rev === change.doc?._rev)) {
      continue;
    }
    const previousCategoryIndex = state.categories.findIndex(
      (item) => item._id === change.id
    );
    state.categories = state.categories.filter(
      (item) => item._id !== change.id
    );
    for (const parentId of previousLocations) {
      state.children[parentId] = (state.children[parentId] ?? []).filter(
        (item) => item._id !== change.id
      );
      markParent(parentId, affectedContainerIds, () => {
        inboxChanged = true;
      });
    }
    const doc = change.doc;
    const physicallyDeleted = change.deleted || doc?._deleted;
    if (!physicallyDeleted && doc && doc.db === "Categories") {
      changedCategoryIds.add(change.id);
      const category = categoryFromDocument(doc);
      if (category && isPresentDocument(doc)) {
        const insertion = previousCategoryIndex >= 0 ? previousCategoryIndex : state.categories.length;
        state.categories.splice(insertion, 0, category);
        state.children[category._id] ??= [];
        if (doc.done !== true) {
          addChild(state.children, category.parentId, category);
          markParent(category.parentId, affectedContainerIds, () => {
            inboxChanged = true;
          });
        }
        affectedContainerIds.add(category._id);
      }
      changed = true;
      continue;
    }
    if (!physicallyDeleted && doc?.db === "Tasks") {
      const task = taskFromDocument(doc);
      if (task && isPresentDocument(doc) && doc.done !== true) {
        addChild(state.children, task.parentId, task);
        markParent(task.parentId, affectedContainerIds, () => {
          inboxChanged = true;
        });
      }
      changed = true;
      continue;
    }
    if (previousCategory) {
      changedCategoryIds.add(change.id);
      affectedContainerIds.add(change.id);
      changed = true;
    } else if (previousLocations.length > 0) {
      changed = true;
    }
  }
  for (const categoryId of changedCategoryIds) {
    for (const item of [
      ...descendantsOf(categoryId, oldCategories),
      ...descendantsOf(categoryId, state.categories)
    ]) {
      affectedContainerIds.add(item);
    }
    const oldParent = oldCategories.find(
      (item) => item._id === categoryId
    )?.parentId;
    const newParent = state.categories.find(
      (item) => item._id === categoryId
    )?.parentId;
    markParent(oldParent, affectedContainerIds, () => {
      inboxChanged = true;
    });
    markParent(newParent, affectedContainerIds, () => {
      inboxChanged = true;
    });
  }
  return { changed, affectedContainerIds, inboxChanged };
}
function parseStoredState(value, sourceKey) {
  if (typeof value !== "object" || value === null || value.version !== 1 || value.sourceKey !== sourceKey || !Array.isArray(value.categories) || typeof value.children !== "object" || value.children === null || Array.isArray(value.children) || typeof value.lastSuccessfulSyncAt !== "number" || !("lastSeq" in value) || value.lastSeq === void 0) {
    return void 0;
  }
  const stored = value;
  if (!stored.categories.every(isCachedContainer) || !Object.values(stored.children).every((items) => Array.isArray(items) && items.every(isCachedItem))) {
    return void 0;
  }
  return {
    ...stored,
    projectionPending: stored.projectionPending !== false
  };
}
function isCachedContainer(value) {
  return isCachedItem(value) && (value.type === "category" || value.type === "project");
}
function isCachedItem(value) {
  if (typeof value !== "object" || value === null || typeof value._id !== "string" || typeof value.title !== "string") {
    return false;
  }
  const item = value;
  if (item.type !== void 0 && item.type !== "task" && item.type !== "category" && item.type !== "project") {
    return false;
  }
  if (item.parentId !== void 0 && typeof item.parentId !== "string") {
    return false;
  }
  return item.type === "category" || item.type === "project" || typeof item.done === "boolean";
}
function projectableCategories(categories) {
  const byId = new Map(categories.map((item) => [item._id, item]));
  const projectable = /* @__PURE__ */ new Set();
  const rejected = /* @__PURE__ */ new Set();
  const reachesRoot = (item) => {
    const path = [];
    const visited = /* @__PURE__ */ new Set();
    let current = item;
    while (current) {
      if (projectable.has(current._id)) {
        for (const id of path) {
          projectable.add(id);
        }
        return true;
      }
      if (rejected.has(current._id) || visited.has(current._id)) {
        for (const id of path) {
          rejected.add(id);
        }
        return false;
      }
      visited.add(current._id);
      path.push(current._id);
      if (!current.parentId || current.parentId === "root") {
        for (const id of path) {
          projectable.add(id);
        }
        return true;
      }
      current = byId.get(current.parentId);
      if (!current) {
        for (const id of path) {
          rejected.add(id);
        }
        return false;
      }
    }
    return false;
  };
  return categories.filter(reachesRoot);
}
function categoryFromDocument(doc) {
  if (typeof doc.title !== "string") {
    return void 0;
  }
  const common = commonFields(doc);
  if (doc.type === "project") {
    return {
      ...common,
      title: doc.title,
      type: "project",
      ...typeof doc.parentId === "string" ? { parentId: doc.parentId } : {},
      ...categoryOptionalFields(doc)
    };
  }
  return {
    ...common,
    title: doc.title,
    type: "category",
    ...typeof doc.parentId === "string" ? { parentId: doc.parentId } : {},
    ...categoryOptionalFields(doc)
  };
}
function taskFromDocument(doc) {
  if (typeof doc.title !== "string") {
    return void 0;
  }
  return {
    ...commonFields(doc),
    title: doc.title,
    type: "task",
    done: doc.done === true,
    ...typeof doc.parentId === "string" ? { parentId: doc.parentId } : {},
    ...taskOptionalFields(doc)
  };
}
function commonFields(doc) {
  return {
    _id: doc._id,
    ...typeof doc._rev === "string" ? { _rev: doc._rev } : {},
    ...typeof doc.createdAt === "number" ? { createdAt: doc.createdAt } : {},
    ...typeof doc.updatedAt === "number" ? { updatedAt: doc.updatedAt } : {}
  };
}
function categoryOptionalFields(doc) {
  return copyDefined(doc, [
    "day",
    "firstScheduled",
    "startDate",
    "dueDate",
    "endDate",
    "done",
    "doneDate",
    "note",
    "labelIds",
    "timeEstimate",
    "priority",
    "rank",
    "recurring"
  ]);
}
function taskOptionalFields(doc) {
  return copyDefined(doc, [
    "day",
    "firstScheduled",
    "startDate",
    "dueDate",
    "endDate",
    "doneAt",
    "completedAt",
    "note",
    "labelIds",
    "timeEstimate",
    "priority",
    "rank",
    "recurring",
    "isRecurring",
    "subtasks"
  ]);
}
function copyDefined(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source[key] !== void 0 && source[key] !== null) {
      result[key] = source[key];
    }
  }
  return result;
}
function isPresentDocument(doc) {
  const restoredAt = typeof doc.restoredAt === "number" ? doc.restoredAt : 0;
  const deletedAt = typeof doc.deletedAt === "number" ? doc.deletedAt : 0;
  return !(deletedAt > restoredAt);
}
function validateRelevantChanges(changes) {
  for (const change of changes) {
    const doc = change.doc;
    if (!doc || change.deleted || doc._deleted) {
      continue;
    }
    if (doc._id !== change.id) {
      throw new Error(
        `Amazing Marvin change ${change.id} contained document ${doc._id}`
      );
    }
    if ((doc.db === "Tasks" || doc.db === "Categories") && (typeof doc.title !== "string" || typeof doc.parentId !== "string")) {
      throw new Error(
        `Amazing Marvin ${doc.db} document ${doc._id} is malformed`
      );
    }
  }
}
function childLocations(children, itemId) {
  return Object.entries(children).filter(([, items]) => items.some((item) => item._id === itemId)).map(([parentId]) => parentId);
}
function addChild(children, parentId, item) {
  if (!parentId || parentId === "root") {
    return;
  }
  const existing = children[parentId] ?? [];
  const index = existing.findIndex((candidate) => candidate._id === item._id);
  if (index === -1) {
    children[parentId] = [...existing, item];
  } else {
    const next = [...existing];
    next[index] = item;
    children[parentId] = next;
  }
}
function markParent(parentId, affected, inbox) {
  if (!parentId || parentId === "root") {
    return;
  }
  if (parentId === "unassigned") {
    inbox();
    return;
  }
  affected.add(parentId);
}
function descendantsOf(rootId, categories) {
  const descendants = [];
  const queue = [rootId];
  const visited = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index];
    for (const item of categories) {
      if (item.parentId === parentId && !visited.has(item._id)) {
        visited.add(item._id);
        descendants.push(item._id);
        queue.push(item._id);
      }
    }
  }
  return descendants;
}
function dedupeItems(items) {
  const byId = /* @__PURE__ */ new Map();
  for (const item of items) {
    if (!byId.has(item._id)) {
      byId.set(item._id, item);
    }
  }
  return [...byId.values()];
}
function mergeApplied(target, source) {
  target.changed ||= source.changed;
  target.inboxChanged ||= source.inboxChanged;
  for (const id of source.affectedContainerIds) {
    target.affectedContainerIds.add(id);
  }
}

// evaluations/issue-55/harness/pr63-src/obsidianIncremental.ts
function createObsidianCouchTransport(request) {
  return {
    async request(input) {
      const response = await request({
        url: input.url,
        method: "GET",
        headers: input.headers,
        throw: false
      });
      return {
        status: response.status,
        text: response.text
      };
    }
  };
}
var ObsidianIncrementalCacheStore = class {
  constructor(adapter, pluginDirectory) {
    this.adapter = adapter;
    this.path = normalizeAdapterPath(
      `${pluginDirectory}/marvin-incremental-cache-v1.json`
    );
  }
  async load() {
    if (!await this.adapter.exists(this.path)) {
      return void 0;
    }
    const serialized = await this.adapter.read(this.path);
    try {
      return JSON.parse(serialized);
    } catch {
      throw new Error(
        "Persistent Amazing Marvin cache is invalid; reset it in plugin settings"
      );
    }
  }
  async save(state) {
    const serialized = JSON.stringify(state);
    if (await this.adapter.exists(this.path)) {
      await this.adapter.process(this.path, () => serialized);
    } else {
      await this.adapter.write(this.path, serialized);
    }
  }
  async clear() {
    if (await this.adapter.exists(this.path)) {
      await this.adapter.remove(this.path);
    }
  }
};
function normalizeAdapterPath(path) {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
export {
  CouchChangesClient,
  CouchChangesError,
  IncrementalMarvinCache,
  IncrementalRetryBackoff,
  ObsidianIncrementalCacheStore,
  applyCouchChanges,
  createObsidianCouchTransport
};
