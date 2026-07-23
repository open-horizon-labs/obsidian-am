# Obsidian Amazing Marvin Plugin

This plugin for [Obsidian](https://obsidian.md) enables synchronization with Amazing Marvin, a comprehensive task management and planning system. It is developed and maintained by your productivity friends at [Cloud Atlas](https://www.cloud-atlas.ai/) to facilitate a seamless integration for users who utilize both platforms.

## Amazing Marvin Plugin Overview

The Amazing Marvin Plugin provides a way to bring your tasks and project structures from Amazing Marvin directly into your Obsidian vault. It respects the Amazing Marvin hierarchy of categories and projects, creating a matching folder and note structure within Obsidian.

### Key Features

- **Sync Categories and Projects**: Converts Amazing Marvin categories and projects into Obsidian folders and notes, maintaining the original hierarchy.
- **Task Integration**: Transforms tasks into markdown checklist items, with nested subtasks properly indented.
- **Parent Links**: For easy navigation, notes for subcategories and subprojects include backlinks to their parent category or project.
- **Wiki Links**: Sub-Categories and projects Amazing Marvin are added as wiki links.
- **Categories and Projects are folder notes**: Categories and projects are created as folder notes, compatible with [Obsidian folder notes](https://github.com/LostPaul/obsidian-folder-notes).
- **Task Creation**: Users can create Amazing Marvin tasks directly within Obsidian, with support for standard Marvin shorthand notations like `+` for dates or `@` for labels.
- **Deep Linking**: Each task and category is equipped with a deep link, providing quick navigation back to Amazing Marvin.
- **Refreshable Daily Notes**: A bounded Today region keeps scheduled and due tasks current without rerunning the full daily-note template or overwriting surrounding prose.
- **Automation API**: Templater, in-Obsidian agents, and other plugins can use the same typed operations as the UI, including idempotent source/action task creation.

## Usage Instructions

### Sync Direction

The Obsidian Amazing Marvin Plugin currently supports unidirectional synchronization. It imports and updates data from Amazing Marvin into your Obsidian vault, but it does not export or sync changes made in Obsidian back to Amazing Marvin.

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
2. Search for and select `Import categories and tasks`.
3. The plugin will then proceed to update your Obsidian vault with the current structure and content from Amazing Marvin.

Once imported, your Obsidian vault will contain the configured managed folder. Inside, you'll find the structured notes corresponding to your categories and projects from Amazing Marvin.

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

To create a task:

1. Open Obsidian's Command Palette with `Ctrl/Cmd + P`.
2. Search for and select the command `Create Marvin Task`.
3. Input the task details and select the appropriate category from the dropdown, which shows suggestions as you type.
4. Upon task creation, a markdown checklist item with a link to the Marvin task is inserted at your cursor location in Obsidian.

### Keeping Today's Tasks Current

Run `Amazing Marvin: Refresh today's tasks` from a daily note. On the first
run, the plugin adopts existing Marvin checklist entries under
`## Today's tasks` as the morning set and surrounds only the generated task
content with managed HTML-comment markers. It never rewrites content outside
those markers.

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

1. Go to `Settings > Obsidian Amazing Marvin Plugin`.
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
    3. Specify this repository: `cloud-atlas-ai/obsidian-am`
3. Enable the `Amazing Marvin` plugin (`Settings` -> `Community Plugins`)

### Manually

1. If you haven't enabled community plugins in Obsidian, follow these [instructions](https://help.obsidian.md/Extending+Obsidian/Community+plugins#Install+a+community+plugin) to do so.
2. Download `cloudatlas-obsidian-am.zip` from the [releases](https://github.com/cloud-atlas-ai/obsidian-am/releases).
3. Unzip the release and copy the directory into your vault's plugins folder: `<vault>/.obsidian/plugins/cloudatlas-o-am`.
4. Restart Obsidian to recognize the new plugin.
5. In Obsidian's settings under "Community Plugins," find and enable the Obsidian Amazing Marvin Plugin.
6. Add your key token to the plugin settings. You can find your key token in the [Amazing Marvin API page](https://app.amazingmarvin.com/pre?api).

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

The repository includes a local stdio MCP server for direct LLM access to
Amazing Marvin. Marvin-only operations do not need to pass through Obsidian.
The MCP and plugin use the same typed client, local/public routing, cache, and
error behavior.

Build it with:

```sh
npm install
npm run build
```

Then configure an MCP host with an absolute path to the generated server:

```json
{
  "mcpServers": {
    "amazing-marvin": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-am/packages/marvin-mcp/dist/server.js"],
      "env": {
        "AMAZING_MARVIN_API_TOKEN": "your-limited-api-token",
        "AMAZING_MARVIN_USE_LOCAL": "true"
      }
    }
  }
}
```

`AMAZING_MARVIN_USE_LOCAL` is optional and defaults to `false`. When enabled,
reads try `http://localhost:12082/api` before the public API. Override the
origins with `AMAZING_MARVIN_LOCAL_API_URL` and
`AMAZING_MARVIN_PUBLIC_API_URL`.

The initial tool surface is deliberately small:

- `marvin_today`
- `marvin_due`
- `marvin_categories`
- `marvin_children`
- `marvin_labels`
- `marvin_create_task`
- `marvin_mark_done`

Read results identify whether data is fresh, cached, or stale. Errors retain
the attempted local/public origins and throttling details. The server uses the
limited API token only; it does not use Marvin's full-access CouchDB API.
`marvin_create_task` accepts the stable label IDs returned by
`marvin_labels`.

The MCP owns Marvin-only operations and does not edit an Obsidian vault.
Cross-system operations that must atomically persist a source/action
association and update a managed note region use the plugin API above. Both
paths share the Marvin client, and the source/action state machine itself
lives in that shared package rather than in prompt instructions.

See
[`docs/architecture/marvin-client-and-mcp.md`](docs/architecture/marvin-client-and-mcp.md)
for package boundaries and the #51 extension seam.

### Testing

While you're testing, you're going to send a lot of requests to the Amazing Marvin API. To avoid hitting the rate limit, you can use the Desktop local API server. See [Desktop Local API Server](https://help.amazingmarvin.com/en/articles/5165191-desktop-local-api-server) for more information. Once setup, you can specify the local API server in the plugin settings.

The desktop API implements a subset of the public API. Unsupported local read
endpoints, historically including `/api/children`, fall back to the public
API. A valid empty local response does not trigger fallback.
