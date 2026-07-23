# Amazing Marvin Integration for Obsidian

This plugin brings Amazing Marvin tasks, categories, and projects into
[Obsidian](https://obsidian.md) without treating the vault as disposable. It
also includes a companion MCP server for agents that need Marvin access
without mutating an Obsidian vault.

## Use Marvin, Obsidian, and an agent together

Amazing Marvin remains the task system of record. The Obsidian plugin projects
that work into notes you can use for context and execution. The companion MCP
lets an agent work directly with Marvin: discover a project by stable ID, read
its work, create a task, or complete it.

Use the plugin for vault-coupled work such as imports, managed daily-note
regions, and source-note associations. Use the MCP for Marvin-only work. The
two surfaces share the same client, local-first read behavior, cache rules, and
error model. Run the relevant plugin refresh or import to project a task an
agent creates through MCP into the vault.

## Plugin overview

The Amazing Marvin Plugin provides a way to bring your tasks and project structures from Amazing Marvin directly into your Obsidian vault. It respects the Amazing Marvin hierarchy of categories and projects, creating a matching folder and note structure within Obsidian.

### Key Features

- **Non-destructive imports**: Category, project, and Inbox notes refresh only
  their managed region; adjacent prose and non-plugin frontmatter survive.
- **Hierarchy and selective roots**: Import everything or selected
  category/project roots with their descendants while keeping ancestor notes as
  navigation-only structure.
- **Task projection**: Render nested Marvin tasks as checklists, with deep
  links, parent navigation, optional labels-as-tags, and Dataview or Obsidian
  Tasks-compatible metadata.
- **Task creation and completion**: Create a task at the cursor, defaulting to
  the current imported category/project when applicable; optionally mark linked
  tasks complete in Marvin when checked in Obsidian.
- **Refreshable daily notes**: A bounded Today region keeps due and scheduled
  tasks current without rerunning a template or overwriting the rest of a note.
- **Agent-ready API**: Templater and other in-Obsidian automation can use a
  typed API with idempotent source/action task creation. The companion MCP
  shares the Marvin client for Marvin-only workflows.

## Usage Instructions

### Sync Direction

Amazing Marvin remains the source of truth for imported data. The plugin does
not sync arbitrary Obsidian edits back to Marvin. The deliberate exceptions
are creating a Marvin task from Obsidian and, when enabled, marking a linked
Marvin task done after its checklist item is checked.

### Sync Behavior

Each import updates only the Amazing Marvin-managed region in an existing note.
Custom frontmatter properties and prose before or after that region are
preserved. The first import of an older note adopts its recognizable generated
category/project or Inbox task section; future imports use explicit markers.
The importer also repairs the known malformed legacy list syntax before
writing native YAML arrays such as `labelIds`.

The managed folder defaults to `AmazingMarvin` and can be changed in plugin
settings. Existing imported categories, projects, and Inbox notes are moved by
their Marvin ID when possible; empty folders from an earlier location are left
in place. Notes for Marvin items no longer returned by the API are also left in
place rather than deleted automatically.

Imports can include all categories/projects or selected roots. A selected root
includes all descendants; its ancestors remain as navigation-only notes so the
Marvin hierarchy and backlinks stay intact, while sibling branches and
ancestor tasks are excluded. Inbox import is controlled independently. An
empty selected-root list intentionally imports no category/project notes, and
changing the selection never deletes notes from an earlier import.

### Running a Sync

To initiate a sync:

1. Open Obsidian's Command Palette with `Ctrl/Cmd + P`.
2. Search for and select the command `Amazing Marvin Integration: Import categories and tasks`.
3. The plugin updates its managed regions from the current Marvin structure and
   task data.

Once imported, your Obsidian vault will contain the configured managed folder. Inside, you'll find the structured notes corresponding to your categories and projects from Amazing Marvin.

Before importing, use **Settings → Amazing Marvin Integration → Category
and project import** to choose the managed folder, all items or selected roots,
and whether Inbox is included. A selected root includes all descendants;
changing the selection deliberately leaves older notes in place for review.

### Creating a Marvin Task

The task creation dialog is designed to mirror the task input experience in Amazing Marvin closely. It includes the following features:

- Autocomplete for Categories and Projects using `#` syntax or a search sub-dialog.
- Recognizes shorthand notations for properties like start date (`~`), due date (`@`), and labels (`+`).
- Places a link to the Marvin task as a deep link in Obsidian at the cursor location upon task creation.
- The created Marvin task links back to the Obsidian note that instigated the task.
- The source note records the Marvin task ID and deep link in its
  `amazing-marvin-actions` frontmatter property.
- The link can use either Advanced URI (the default, for the Advanced URI
  community plugin) or Obsidian's standard URI format.

When invoked from an imported category or project note, the modal and the
selected-text shortcut default to that Marvin item. You can still choose Inbox
or another parent in the modal.

To create a task:

1. Open Obsidian's Command Palette with `Ctrl/Cmd + P`.
2. Search for and select the command `Amazing Marvin Integration: Create task`.
3. Input the task details and select the appropriate category from the dropdown, which shows suggestions as you type.
4. Upon task creation, a markdown checklist item with a link to the Marvin task is inserted at your cursor location in Obsidian.

### Keeping Today's Tasks Current

Run `Amazing Marvin Integration: Refresh today's tasks` from a daily note. On
the first run, the plugin adopts existing Marvin checklist entries under
`## Today's tasks` as the morning set and surrounds the recognized generated
task content with managed HTML-comment markers. Copy completed legacy task
history out before that first refresh: current Marvin reads may not return it,
so it is not retained by the live projection. Content outside the recognized
legacy checklist and later managed region is preserved.

Later scheduled and due tasks appear under `### Added since morning`. Results
are deduplicated by Marvin task ID, completion state is rerendered from Marvin,
and a successful empty response remains visibly distinct from a fetch failure.
A failed fetch leaves the existing note untouched.

Once a note has a managed region, the plugin can refresh it on startup, when
Obsidian regains focus, and at the configured interval. Automatic refresh does
not initialize or adopt an unmarked note; run the command once (or use the API
below) to establish the boundary.

### Templater and In-Obsidian Automation

The plugin exposes a stable object API at
`app.plugins.plugins["cloudatlas-o-am"].api`. For example:

```js
const marvin = app.plugins.plugins["cloudatlas-o-am"].api;
const sourcePath = tp.file.path(true);

await marvin.ensureTaskForSource({
  sourcePath,
  actionKey: "decide-whether-to-pursue",
  title: "Decide whether to pursue Titan AI",
  day: tp.date.now("YYYY-MM-DD"),
});

await marvin.refreshTodayTasks({
  date: tp.date.now("YYYY-MM-DD"),
  filePath: tp.file.path(true),
});
```

`actionKey` is a caller-owned stable identity for one action in one source
note. Do not derive it from the mutable task title. Repeating the same
`sourcePath` and `actionKey` returns the existing Marvin association.

The API writes a pending source association before creating the Marvin task.
If a connection drops at an ambiguous point, a repeat is stopped rather than
silently creating a duplicate. After inspecting Marvin, callers can use
`resolvePendingSourceAction({ sourcePath, actionKey, taskId })` or explicitly
`clearPendingSourceAction({ sourcePath, actionKey })`.

Additional object-returning methods are available for automation:

- `getToday(date)`
- `getDue(date)`
- `getTodayAndDue(date)`
- `getCategories()`
- `getChildren(parentId)`
- `getLabels()`
- `createTask(task)`
- `ensureTaskForSource(input)`
- `refreshTodayTasks(input)`

### Task formatting and labels

The default projection remains the existing Dataview format. In settings,
tasks can instead use Obsidian Tasks' Dataview fields or emoji date format.
Tasks-compatible presets always put the readable title first; the current
Dataview preset has a separate title-first option.

Dataview date links use a configurable Moment format. For example,
`YYYY-[W]WW` renders `2026-07-23` as `[[2026-W30|2026-07-23]]`, which lets a
daily date alias resolve to a weekly note. An optional task tag supports an
Obsidian Tasks global filter.

Marvin labels can be projected as namespaced Obsidian tags such as
`#marvin/Knowledge-work`. Label IDs are resolved through the limited `/labels`
API and cached for an hour; unknown IDs are not exposed as opaque tags. If
labels are enabled and cannot be read or recovered from the stale cache, the
managed projection is left unchanged rather than silently removing tags.

### Auto-Mark as Done Feature

One of the highlights in this version is the ability to auto-mark tasks as done in Amazing Marvin when they are checked off in Obsidian. When this feature is enabled in the plugin settings, checking a task off in your Obsidian note will automatically update the task status in Amazing Marvin.

Here's how to enable this feature:

1. Go to `Settings > Amazing Marvin Integration`.
2. Check the option `Attempt to mark tasks as done in Amazing Marvin when checked off in Obsidian`.
3. Save your settings.

Now, when you check off a task with an Amazing Marvin Link in an Obsidian note, a request will be sent to Amazing Marvin to mark the task as done there as well.

### Important Considerations

- **Managed regions**: Changes inside an Amazing Marvin-managed category, project, or Inbox region are refreshed on the next import. Keep lasting notes outside the marked region.
- **Conflicting moves**: If a destination file already exists or multiple notes claim the same Marvin item, import stops rather than overwriting either note.
- **Recoverable stale notes**: Notes for removed or hidden Marvin items are not automatically deleted. Review and remove them manually.

By following these guidelines, you can ensure your Amazing Marvin data is accurately reflected in Obsidian while being mindful of the plugin's current limitations.


## Installing

### Using BRAT

1. Install the BRAT plugin
    1. Open `Settings` -> `Community Plugins`
    2. Disable safe mode, if enabled
    3. *Browse*, and search for "BRAT"
    4. Install the latest version of **Obsidian42 - BRAT**
2. Open BRAT settings (`Settings` -> `BRAT`)
    1. Scroll to the `Beta Plugin List` section
    2. `Add Beta Plugin`
    3. Specify this repository: `open-horizon-labs/obsidian-am`
3. Enable **Amazing Marvin Integration** (`Settings` -> `Community Plugins`)

### Manually

1. If you haven't enabled community plugins in Obsidian, follow these [instructions](https://help.obsidian.md/Extending+Obsidian/Community+plugins#Install+a+community+plugin) to do so.
2. From the desired [release](https://github.com/open-horizon-labs/obsidian-am/releases), download `main.js`, `manifest.json`, and `styles.css`.
3. Copy those files into `<vault>/.obsidian/plugins/cloudatlas-o-am`.
4. Restart Obsidian and enable **Amazing Marvin Integration** under Community Plugins.
5. Add your limited Marvin API token in the plugin settings. Find it in the [Amazing Marvin API page](https://app.amazingmarvin.com/pre?api).

## Trust boundaries

The plugin reads and writes only the vault files needed for its configured
workflows: imported Marvin notes and their managed regions, initialized Today
regions, and task lines or source associations created through its commands or
automation API. It does not delete arbitrary vault files; when an imported
Marvin item disappears, its existing note is left for you to review.

The plugin uses Marvin's limited API token for its public API and can use the
local Marvin desktop API for reads when enabled. Marvin links and help links
open `app.amazingmarvin.com` and `help.amazingmarvin.com`; API requests use
`serv.amazingmarvin.com` or the configured local server. Keep the token in
plugin settings or a local secret mechanism, never in a shared note.

The companion MCP is a separate local stdio process. It can operate on Marvin,
but it does not edit the vault; use the plugin's in-Obsidian API when a
workflow must both create a task and record its source note.

## Development

1. Ensure NodeJS and npm are installed on your system.
2. Clone this repository.
3. Run `npm install` to install the dependencies.
4. Make your desired changes.
5. Use `npm run dev` to watch for changes and compile the plugin to `dist/main.js`.
6. Run `npm test` for the shared-client, plugin-adapter, and MCP contract tests.
7. Run `npm run build` to build the shared client, Obsidian plugin, and MCP server.

For more detailed development instructions, refer to the [sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin) provided by Obsidian.

## Companion MCP server

The repository includes a local **stdio MCP server** for direct agent access
to Marvin. It is the right surface for reading Marvin, discovering a parent
ID, creating a task, or completing a task. It never edits an Obsidian vault.
Use the plugin API above when an operation must also persist a source/action
association or update a managed note.

### Build and register it

```sh
npm ci
npm run build
```

The executable is:

```text
<repository>/packages/marvin-mcp/dist/server.js
```

The server requires `AMAZING_MARVIN_API_TOKEN`, Marvin's **limited API token**.
Do not copy that token into an MCP-host configuration file. Prefer a local
launcher that reads your existing secret at startup and then executes the
server. For example, configure the host with the launcher rather than the
token:

```json
{
  "mcpServers": {
    "amazing-marvin": {
      "command": "/absolute/path/to/run-amazing-marvin-mcp.mjs",
      "args": []
    }
  }
}
```

That launcher should set `AMAZING_MARVIN_API_TOKEN` only in the spawned
process's environment and execute:

```sh
node /absolute/path/to/obsidian-am/packages/marvin-mcp/dist/server.js
```

For a temporary shell-only run, export the token in that shell instead of
persisting it in configuration. `AMAZING_MARVIN_USE_LOCAL=true` enables
local-first reads through the Amazing Marvin desktop API. The optional
`AMAZING_MARVIN_LOCAL_API_URL` and `AMAZING_MARVIN_PUBLIC_API_URL` override
their endpoints.

### Tool workflow

| Tool | Use it for |
| --- | --- |
| `marvin_categories` | Discover stable category/project IDs and parent hierarchy. |
| `marvin_children` | Read direct tasks/projects under a discovered parent ID. |
| `marvin_labels` | Discover stable label IDs before task creation. |
| `marvin_today` / `marvin_due` | Read scheduled or due work for an optional `YYYY-MM-DD` date. |
| `marvin_create_task` | Create a task, optionally with `parentId`, dates, labels, note, and estimate. |
| `marvin_mark_done` | Complete a task or project by stable ID. |

An agent should discover the parent with `marvin_categories` before supplying
`parentId` to `marvin_create_task`; it should not guess an ID from a title.
`marvin_children` then lets it inspect one branch without loading everything.

Read responses include `origin`, `freshness`, `fetchedAt`, `ageMs`, and
`warnings`. A second equivalent read may report `freshness: "cached"`. With
local-first enabled, an unavailable or unsupported local read falls back to
the public API; a valid local empty result does not. Writes use the public API
and invalidate relevant cached reads.

Every tool returns JSON text plus `structuredContent`. Runtime and semantic
input errors use `isError: true` and a structured envelope such as:

```json
{
  "error": {
    "kind": "input",
    "field": "date",
    "message": "Use YYYY-MM-DD"
  }
}
```

The MCP uses the limited API token only. It does not use Marvin's full-access
CouchDB database credentials.

See
[`docs/architecture/marvin-client-and-mcp.md`](docs/architecture/marvin-client-and-mcp.md)
for package boundaries and the #51 extension seam.

### Testing

While you're testing, you're going to send a lot of requests to the Amazing Marvin API. To avoid hitting the rate limit, you can use the Desktop local API server. See [Desktop Local API Server](https://help.amazingmarvin.com/en/articles/5165191-desktop-local-api-server) for more information. Once setup, you can specify the local API server in the plugin settings.

The desktop API implements a subset of the public API. Unsupported local read
endpoints, historically including `/api/children`, fall back to the public
API. A valid empty local response does not trigger fallback.
