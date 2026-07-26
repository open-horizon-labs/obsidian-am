import {
	Notice,
	type Editor,
	Platform,
	Plugin,
	TFile,
	TFolder,
	moment,
	normalizePath,
	requestUrl,
	stringifyYaml,
} from "obsidian";

import {
	Category,
	Task
} from "./interfaces";
import {
	type AddTaskRequest,
	type Label,
	type MarvinItem,
	type MarvinReadResult,
	type TaskOrProject,
	type EnsureSourceActionResult,
	MarvinApiClient,
	MarvinError,
	MarvinRouteError,
	MarvinRouter,
	SourceActionError,
	SourceActionService,
	marvinDeepLink,
} from "@open-horizon/marvin-client";

import {
	AmazingMarvinSettingsTab,
	AmazingMarvinPluginSettings,
	DEFAULT_SETTINGS,
} from "./settings";

import {
	getAllDailyNotes,
	getDailyNote,
	getDateFromFile,
} from "obsidian-daily-notes-interface";
import { amTaskWatcher } from "./amTaskWatcher";
import { AddTaskModal } from "./addTaskModal";
import type {
	AmazingMarvinApi,
	EnsureTaskForSourceInput,
	RefreshTodayTasksInput,
	RefreshTodayTasksResult,
} from "./api";
import {
	buildSourceActionTaskNote,
} from "./marvin/obsidianLinks";
import {
	managedImportItemId,
	marvinFrontmatter,
	refreshCategoryRegion,
	repairLegacyMarvinFrontmatter,
	updateMarvinFrontmatter,
} from "./marvin/categoryProjection";
import {
	categoryNotePath,
	normalizeManagedFolder,
} from "./marvin/categoryPaths";
import { marvinParentIdFromFrontmatter } from "./marvin/noteContext";
import {
	ObsidianSourceActionStore,
} from "./marvin/obsidianSourceActions";
import { createObsidianTransport } from "./marvin/obsidianTransport";
import {
	hasTodayRegion,
	type TodayProjectionItem,
} from "./marvin/todayProjection";
import { runTodayProjection } from "./marvin/todayWorkflow";
import {
	buildTargetedPlan,
	categoryProjectionItems,
	planCategorySync,
	targetedContainerIds,
	type CategorySyncPlan,
} from "./marvin/syncSelection";
import {
	formatTaskMetadata,
	formatMarvinLabelTags,
	orderTaskBody,
	taskTitleComesFirst,
	type TaskFormattingOptions,
} from "./marvin/taskFormatting";
import { createAsyncLock } from "./marvin/asyncLock";
import { CouchChangesClient } from "./marvin/couchChanges";
import { CouchBulkClient, CouchBulkSnapshotSource } from "./marvin/couchBulkSnapshot";
import {
	IncrementalMarvinCache,
	IncrementalRetryBackoff,
	type IncrementalUpdate,
} from "./marvin/incrementalCache";
import {
	ObsidianIncrementalCacheStore,
	createObsidianCouchTransport,
	type IncrementalFileAdapter,
} from "./marvin/obsidianIncremental";

function getAMTimezoneOffset() {
	return new Date().getTimezoneOffset() * -1;
}

const animateNotice = (notice: Notice) => {
	if (!notice.noticeEl.isConnected) {
		return;
	}
	let message = notice.noticeEl.innerText;
	const dots = [...message].filter((c) => c === ".").length;
	if (dots == 0) {
		message = message.replace("    ", " .  ");
	} else if (dots == 1) {
		message = message.replace(" .  ", " .. ");
	} else if (dots == 2) {
		message = message.replace(" .. ", " ...");
	} else if (dots == 3) {
		message = message.replace(" ...", "    ");
	}
	notice.setMessage(message);
	window.setTimeout(() => animateNotice(notice), 500);
};

export default class AmazingMarvinPlugin extends Plugin {

	settings: AmazingMarvinPluginSettings;
	categories: Category[] = [];
	private marvinRouter?: MarvinRouter;
	private marvinRouterKey = "";
	private sourceActionStore?: ObsidianSourceActionStore;
	private sourceActionService?: SourceActionService;
	private sourceActionRouter?: MarvinRouter;
	private marvinLabelsById = new Map<string, Label>();
	private readonly todayRefreshes = new Map<string, Promise<RefreshTodayTasksResult>>();
	private lastAutomaticRefreshAt = 0;
	private lastAutomaticRefreshError = "";
	private incrementalCache?: IncrementalMarvinCache;
	private incrementalCacheKey = "";
	private readonly incrementalBackoff = new IncrementalRetryBackoff();
	private incrementalSyncInFlight?: Promise<void>;
	private lastAutomaticIncrementalAt = 0;
	private lastIncrementalError = "";
	private lastIncrementalSyncAt = 0;
	// The REST full sync and the incremental targeted sync both mutate this
	// shared `categories` field and use it for parent-link rendering.
	// Incremental sync now runs automatically in the background (focus,
	// interval, startup, online) — without this, it can interleave with a
	// user-triggered REST import and corrupt category path computation.
	private readonly categoriesLock = createAsyncLock();
	private settingsTab?: AmazingMarvinSettingsTab;

	readonly api: AmazingMarvinApi = {
		getToday: (date) => this.getMarvinRouter().getTodayItems(date),
		getDue: (date) => this.getMarvinRouter().getDueItems(date),
		getTodayAndDue: (date) => this.getMarvinRouter().getTodayAndDue(date),
		getCategories: () => this.getMarvinRouter().getCategories(),
		getChildren: (parentId) => this.getMarvinRouter().getChildren(parentId),
		getLabels: () => this.getMarvinRouter().getLabels(),
		createTask: async (task) => {
			const created = await this.getMarvinRouter().addTask(task);
			this.queueManagedTodayRefresh("creating a task");
			return created;
		},
		ensureTaskForSource: (input) => this.ensureTaskForSource(input),
		resolvePendingSourceAction: async (input) => {
			const result = await this.getSourceActionService().resolvePending({
				sourceKey: input.sourcePath,
				actionKey: input.actionKey,
				taskId: input.taskId,
				...(input.title === undefined ? {} : { title: input.title }),
			});
			this.queueManagedTodayRefresh("resolving a contextual task");
			return result;
		},
		clearPendingSourceAction: (input) => (
			this.getSourceActionService().clearPending({
				sourceKey: input.sourcePath,
				actionKey: input.actionKey,
			})
		),
		refreshTodayTasks: (input) => this.refreshTodayTasks(input),
	};

	createFolder = async (path: string) => {
		try {
			await this.app.vault.createFolder(path);
		} catch (e) {
			console.debug(e);
		}
	};

	create = async (path: string, content: string) => {
		try {
			await this.app.vault.create(path, content);
		} catch (e) {
			console.debug(e);
		}
	};

	onload(): void {
		void this.initialize().catch((error) => {
			console.error("Could not initialize Amazing Marvin Integration:", error);
			new Notice("Could not initialize Amazing Marvin Integration.");
		});
	}

	private async initialize(): Promise<void> {
		await this.loadSettings();
		this.settingsTab = new AmazingMarvinSettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);
		if (this.settings.attemptToMarkTasksAsDone) {
			this.registerEditorExtension(amTaskWatcher(this.app, this));
		}
		this.registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => {
			if (
				this.sourceActionStore?.shouldInvalidateFor(
					file.path,
					cache.frontmatter,
				)
			) {
				this.sourceActionStore.invalidateIndex(true);
			}
		}));
		this.registerEvent(this.app.metadataCache.on("deleted", (file) => {
			if (this.sourceActionStore?.shouldInvalidateFor(file.path, undefined)) {
				this.sourceActionStore.invalidateIndex(true);
			}
		}));

		this.addCommand({
			id: "create-task",
			name: "Create task",
			editorCallback: (editor, view) => {
				void this.createTaskFromEditor(editor, view);
      }});

      this.addCommand({
        id: 'import',
        name: 'Import categories and tasks',
		callback: () => {
			void this.importFromMarvin();
        }
      });
		this.addCommand({
			id: "import-today",
			name: "Refresh today's tasks",
			editorCallback: (_editor, view) => {
				void this.refreshTodayFromEditor(view);
			}
		});

		this.registerDomEvent(activeWindow, "focus", () => {
			void this.runAutomaticTodayRefresh("window focus");
		});
		this.registerInterval(window.setInterval(() => {
			void this.runAutomaticTodayRefresh("interval");
		}, 60_000));
		this.app.workspace.onLayoutReady(() => {
			void this.runAutomaticTodayRefresh("startup");
		});

		this.addCommand({
			id: "incremental-sync-now",
			name: "Sync Amazing Marvin now (incremental)",
			callback: () => {
				void this.runIncrementalSync("command").then(
					() => new Notice("Amazing Marvin incremental sync complete."),
					(error) => new Notice(
						`Amazing Marvin incremental sync failed: ${this.errorMessage(error)}`,
						10_000,
					),
				);
			},
		});
		this.registerDomEvent(activeWindow, "focus", () => {
			void this.runAutomaticIncrementalSync("window focus");
		});
		this.registerDomEvent(window, "online", () => {
			void this.runAutomaticIncrementalSync("network recovery");
		});
		this.registerInterval(window.setInterval(() => {
			void this.runAutomaticIncrementalSync("interval");
		}, 60_000));
		// Short poll for an MCP-dropped sync request. One exists() per tick,
		// and only while incremental sync is actually configured — this is
		// what lets an agent ask for current data instead of waiting out the
		// 60s interval above. See INCREMENTAL_SYNC_REQUEST_FILENAME.
		this.registerInterval(window.setInterval(() => {
			void this.serveIncrementalSyncRequest();
		}, 2_000));
		this.app.workspace.onLayoutReady(() => {
			void this.runAutomaticIncrementalSync("startup");
		});
	}

	private async createTaskFromEditor(
		editor: Editor,
		view: { file: TFile | null },
	): Promise<void> {
		try {
			const defaultParentId = this.marvinParentIdForFile(view.file);
			await this.refreshLabelsForProjection();
			if (editor.somethingSelected() && editor.getSelection().length > 2) {
				await this.insertCreatedTask(
					editor,
					view,
					defaultParentId ?? "",
					editor.getSelection(),
					true,
				);
				return;
			}

			const categories = await this.getCategories();
			new AddTaskModal(this.app, categories, (taskDetails) => {
				void this.insertCreatedTask(
					editor,
					view,
					taskDetails.catId,
					taskDetails.task,
					false,
				);
			}, defaultParentId).open();
		} catch (error) {
			console.error("Error fetching Amazing Marvin categories:", error);
			new Notice("Failed to load categories from Amazing Marvin.");
		}
	}

	private async insertCreatedTask(
		editor: Editor,
		view: { file: TFile | null },
		parentId: string,
		title: string,
		replaceSelection: boolean,
	): Promise<void> {
		try {
			const task = await this.addMarvinTask(
				parentId,
				title,
				view.file?.path,
				this.app.vault.getName(),
			);
			const line = `- [${task.done ? "x" : " "}] ${this.renderTaskBody(task)}`;
			if (replaceSelection) {
				editor.replaceSelection(line);
			} else {
				editor.replaceRange(line, editor.getCursor());
			}
		} catch (error) {
			console.error("Could not create Marvin task:", error);
		}
	}

	private async importFromMarvin(): Promise<void> {
		const notice = new Notice("Importing from Amazing Marvin...");
		animateNotice(notice);
		try {
			await this.sync();
			notice.hide();
			new Notice("Amazing Marvin data imported successfully.");
		} catch (error) {
			console.error("Sync error:", error);
			new Notice("Error syncing with Amazing Marvin.");
		}
	}

	private async refreshTodayFromEditor(view: { file: TFile | null }): Promise<void> {
		try {
			if (!view.file) {
				throw new Error("Open the daily note you want to refresh");
			}
			const fileDate = getDateFromFile(view.file, "day");
			if (!fileDate) {
				throw new Error(`${view.file.path} is not recognized as a daily note`);
			}
			const date = fileDate.format("YYYY-MM-DD");
			const result = await this.refreshTodayTasks({ date, filePath: view.file.path });
			new Notice(
				result.changed
					? `Refreshed Amazing Marvin tasks for ${date}.`
					: `Amazing Marvin tasks for ${date} are already current.`,
			);
		} catch (error) {
			new Notice(`Error refreshing today's tasks: ${this.errorMessage(error)}`);
			console.error("Error refreshing today's tasks:", error);
		}
	}

	async addMarvinTask(catId: string, taskTitle: string, notePath: string = '', vaultName: string = ''): Promise<Task> {
		const requestBody: AddTaskRequest = {
			title: taskTitle.trim(),
			timeZoneOffset: getAMTimezoneOffset(),
		};

		if (catId && catId !== '' && catId !== 'root' && catId !== '__inbox-faux__') {
			requestBody.parentId = catId;
		}

		try {
			let task: TaskOrProject;
			if (notePath) {
				const actionKey = `manual-${this.newOperationId()}`;
				requestBody.note = buildSourceActionTaskNote({
					vaultName: vaultName || this.app.vault.getName(),
					sourcePath: notePath,
					actionKey,
					linkText: this.settings.linkBackToObsidianText,
					format: this.settings.obsidianLinkFormat,
				});
				const ensured = await this.getSourceActionService().ensure({
					sourceKey: notePath,
					actionKey,
					task: requestBody,
				});
				if (!ensured.task) {
					throw new Error(
						`Manual source action unexpectedly reused Marvin task ${ensured.taskId}`,
					);
				}
				task = ensured.task;
			} else {
				task = await this.getMarvinRouter().addTask(requestBody);
			}
			new Notice("Task added in Amazing Marvin.");
			this.queueManagedTodayRefresh("creating a task");
			return this.decorateWithDeepLink(task) as Task;
		} catch (error) {
			console.error('Error creating task:', error);
			if (error instanceof SourceActionError) {
				new Notice(error.message, 0);
				throw error;
			}
			this.showManualActionError(
				this.isThrottle(error)
					? 'Your request was throttled by Amazing Marvin. Wait before trying again, or do it '
					: 'Error creating task in Amazing Marvin. You can try again or do it ',
				'https://app.amazingmarvin.com/',
			);
			throw error;
		}
	}

	private marvinParentIdForFile(file: TFile | null): string | undefined {
		if (!file) {
			return undefined;
		}
		return marvinParentIdFromFrontmatter(
			this.app.metadataCache.getFileCache(file)?.frontmatter,
		);
	}

	onunload() { }

	async loadSettings() {
		const stored = await this.loadData() as Partial<AmazingMarvinPluginSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(stored ?? {}),
		};
	}

	async saveSettings() {
		this.marvinRouter = undefined;
		this.marvinRouterKey = "";
		this.sourceActionService = undefined;
		this.sourceActionRouter = undefined;
		await this.saveData(this.settings);
	}

	async markDone(taskId: string) {
		try {
			const result = await this.getMarvinRouter().markDone(
				taskId,
				getAMTimezoneOffset(),
			);
			const note = createFragment();
			const a = activeDocument.createElement('a');
			a.href = 'https://app.amazingmarvin.com/#t=' + taskId;
			a.target = '_blank';
			a.text = 'Task';
			note.append(a);
			note.appendText(' marked as done in Amazing Marvin.');
			new Notice(note, 5000);
			this.queueManagedTodayRefresh("completing a task");
			return result;
		} catch (error) {
			console.error('Error marking task as done:', error);
			this.showManualActionError(
				this.isThrottle(error)
					? 'Your request was throttled by Amazing Marvin. Wait before trying again, or do it '
					: 'Error marking task as done in Amazing Marvin. You should do it ',
				'https://app.amazingmarvin.com/#t=' + taskId,
			);
			throw error;
		}
	}

	async ensureTaskForSource(
		input: EnsureTaskForSourceInput,
	): Promise<EnsureSourceActionResult> {
		const request: AddTaskRequest = {
			title: input.title.trim(),
			timeZoneOffset: getAMTimezoneOffset(),
			note: buildSourceActionTaskNote({
				vaultName: this.app.vault.getName(),
				sourcePath: input.sourcePath,
				actionKey: input.actionKey,
				linkText: this.settings.linkBackToObsidianText,
				format: this.settings.obsidianLinkFormat,
				...(input.note === undefined ? {} : { note: input.note }),
			}),
			...(input.parentId === undefined ? {} : { parentId: input.parentId }),
			...(input.day === undefined ? {} : { day: input.day }),
			...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
			...(input.labelIds === undefined ? {} : { labelIds: input.labelIds }),
		};
		const result = await this.getSourceActionService().ensure({
			sourceKey: input.sourcePath,
			actionKey: input.actionKey,
			task: request,
		});
		this.queueManagedTodayRefresh("creating a contextual task");
		return result;
	}

	async refreshTodayTasks(
		input: RefreshTodayTasksInput,
	): Promise<RefreshTodayTasksResult> {
		const date = this.requireDate(input.date);
		const file = this.resolveDailyNote(date, input.filePath);
		const key = `${file.path}\u0000${date}`;
		const existing = this.todayRefreshes.get(key);
		if (existing) {
			return existing;
		}

		const pending = this.refreshTodayTasksOnce(date, file).finally(() => {
			this.todayRefreshes.delete(key);
		});
		this.todayRefreshes.set(key, pending);
		return pending;
	}

	private async refreshTodayTasksOnce(
		date: string,
		file: TFile,
	): Promise<RefreshTodayTasksResult> {
		await this.refreshLabelsForProjection();
		const workflow = await runTodayProjection({
			date,
			read: () => this.readTodaySelection(date),
			project: (data) => this.toTodayProjectionItems(data),
			process: async (update) => {
				await this.app.vault.process(file, update);
			},
		});
		const { read, projection } = workflow;
		this.reportReadState(read, `tasks for ${date}`);
		return {
			date,
			filePath: file.path,
			changed: projection.changed,
			createdRegion: projection.createdRegion,
			morningIds: projection.morningIds,
			lateIds: projection.lateIds,
			freshness: read.freshness,
			origin: read.origin,
			warnings: read.warnings,
		};
	}

	private toTodayProjectionItems(data: TaskOrProject[]): TodayProjectionItem[] {
		const sourceLinks = this.getSourceActionStore().findLinkedTasks(
			data.map((item) => item._id),
		);
		return data.map((item) => {
			const deepLink = marvinDeepLink({
				...item,
				type: item.type ?? "task",
			});
			const source = sourceLinks.get(item._id);
			const details = this.formatTaskDetails(item as Task);
			return {
				id: item._id,
				title: item.title,
				done: Boolean(item.done),
				deepLink,
				...(details ? { details } : {}),
				...(source === undefined
					? {}
					: {
						sourcePath: source.sourcePath,
						sourceTitle: item.title,
					}),
			};
		});
	}

	private async readTodaySelection(
		date: string,
	): Promise<MarvinReadResult<TaskOrProject[]>> {
		if (this.settings.todayTasksToShow === "due") {
			return this.getMarvinRouter().getDueItems(date);
		}
		if (this.settings.todayTasksToShow === "scheduled") {
			return this.getMarvinRouter().getTodayItems(date);
		}
		return this.getMarvinRouter().getTodayAndDue(date);
	}

	private resolveDailyNote(date: string, filePath?: string): TFile {
		if (filePath) {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) {
				throw new Error(`Daily note not found: ${filePath}`);
			}
			return file;
		}
		const file = getDailyNote(
			moment(date, "YYYY-MM-DD", true),
			getAllDailyNotes(),
		);
		if (!file) {
			throw new Error(`No daily note exists for ${date}`);
		}
		return file;
	}

	private requireDate(date: string): string {
		const normalized = date.trim();
		if (!moment(normalized, "YYYY-MM-DD", true).isValid()) {
			throw new Error(`Expected a date in YYYY-MM-DD format, received: ${date}`);
		}
		return normalized;
	}

	private async runAutomaticTodayRefresh(reason: string): Promise<void> {
		if (!this.settings.autoRefreshTodayTasks) {
			return;
		}
		const now = Date.now();
		const minimumDelay = reason === "interval"
			? Math.max(1, this.settings.todayRefreshIntervalMinutes) * 60_000
			: 15_000;
		if (now - this.lastAutomaticRefreshAt < minimumDelay) {
			return;
		}
		this.lastAutomaticRefreshAt = now;
		try {
			await this.refreshManagedTodayIfPresent();
			this.lastAutomaticRefreshError = "";
		} catch (error) {
			const message = this.errorMessage(error);
			console.warn(
				`Could not automatically refresh Amazing Marvin tasks after ${reason}:`,
				error,
			);
			if (message !== this.lastAutomaticRefreshError) {
				this.lastAutomaticRefreshError = message;
				new Notice(
					`Amazing Marvin automatic refresh failed; the existing daily-note tasks were left unchanged. ${message}`,
					10_000,
				);
			}
		}
	}

	private buildObsidianFileAdapter(): IncrementalFileAdapter {
		const adapter = this.app.vault.adapter;
		return {
			exists: (path) => adapter.exists(path),
			read: (path) => adapter.read(path),
			write: (path, data) => adapter.write(path, data),
			async process(path, update) {
				const next = update(await adapter.read(path));
				await adapter.write(path, next);
				return next;
			},
			remove: (path) => adapter.remove(path),
		};
	}

	private getPluginDataDir(): string {
		return normalizePath(
			this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
		);
	}

	private getOrCreateIncrementalCache(): IncrementalMarvinCache | undefined {
		// Desktop-only at the runtime, not just in settings. The settings
		// section is desktop-gated because full-database credentials are the
		// wrong thing to type on a phone keyboard — but plugin settings sync
		// between devices, so gating only the UI left mobile running a
		// background sync with those credentials and no way to see its
		// status, read its errors, sync manually, or reset its cache. An
		// invisible, uncontrollable background process is worse than not
		// having the optimization: mobile falls back to the REST importer,
		// which works there and stays the default everywhere anyway.
		if (!Platform.isDesktopApp) {
			return undefined;
		}
		if (!this.settings.incrementalSyncEnabled) {
			return undefined;
		}
		const { databaseServer, databaseName, databaseUser, databasePassword } = this.settings;
		if (!databaseServer.trim() || !databaseName.trim() || !databaseUser.trim() || !databasePassword) {
			return undefined;
		}
		// Stored as the two fields Amazing Marvin's own API settings page
		// shows (server, database) for copy-paste convenience; joined back
		// into the one URI the shared CouchDB clients expect.
		const databaseUri = `${databaseServer.trim().replace(/\/+$/, "")}/${databaseName.trim().replace(/^\/+/, "")}`;
		const key = JSON.stringify([databaseUri, databaseUser, databasePassword]);
		if (this.incrementalCache && this.incrementalCacheKey === key) {
			return this.incrementalCache;
		}
		const credentials = { databaseUri, databaseUser, databasePassword };
		const transport = createObsidianCouchTransport(requestUrl);
		this.incrementalCache = new IncrementalMarvinCache({
			sourceKey: key,
			changes: new CouchChangesClient(credentials, transport),
			snapshot: new CouchBulkSnapshotSource(new CouchBulkClient(credentials, transport)),
			store: new ObsidianIncrementalCacheStore(
				this.buildObsidianFileAdapter(),
				this.getPluginDataDir(),
			),
			// The library default (60s) exactly matches this plugin's own
			// automatic "interval" trigger cadence, so a no-op poll would
			// still cross the threshold almost every tick and rewrite the
			// whole cache file anyway — the exact write amplification the
			// default exists to prevent. Use a materially larger interval.
			checkpointPersistIntervalMs: 5 * 60_000,
		});
		this.incrementalCacheKey = key;
		// New credentials deserve a clean retry slate — otherwise a backoff
		// delay earned by the OLD (possibly bad) credentials would still
		// throttle automatic retries after the user fixes a typo, for up to
		// this.incrementalBackoff's max delay (5 minutes).
		this.incrementalBackoff.recordSuccess();
		return this.incrementalCache;
	}

	/** Picks up a sync request dropped by the MCP server and services it.
	 * Deliberately bypasses runAutomaticIncrementalSync's rate limiting: the
	 * request is an explicit ask from a caller that is currently blocked
	 * waiting on it, not a background tick. Backoff is still respected, so a
	 * failing endpoint can't be hammered through this path. */
	private async serveIncrementalSyncRequest(): Promise<void> {
		// Checked here as well as in getOrCreateIncrementalCache so mobile
		// isn't stat-ing for a request file every couple of seconds that it
		// could never service anyway.
		if (!Platform.isDesktopApp || !this.settings.incrementalSyncEnabled) {
			return;
		}
		const store = new ObsidianIncrementalCacheStore(
			this.buildObsidianFileAdapter(),
			this.getPluginDataDir(),
		);
		let requested: boolean;
		try {
			requested = await store.consumeSyncRequest();
		} catch (error) {
			console.warn("Could not read the Amazing Marvin sync request:", error);
			return;
		}
		if (!requested || !this.incrementalBackoff.canRun()) {
			return;
		}
		try {
			await this.runIncrementalSync("MCP request");
		} catch (error) {
			// The requester's bounded wait times out and falls back to REST;
			// no notice, since nothing the user did triggered this.
			console.warn("Amazing Marvin sync requested by MCP failed:", error);
		}
	}

	private async runAutomaticIncrementalSync(reason: string): Promise<void> {
		if (!this.settings.incrementalSyncEnabled) {
			return;
		}
		const now = Date.now();
		const minimumDelay = reason === "interval" ? 60_000 : 15_000;
		if (now - this.lastAutomaticIncrementalAt < minimumDelay) {
			return;
		}
		if (!this.incrementalBackoff.canRun()) {
			return;
		}
		this.lastAutomaticIncrementalAt = now;
		// Captured before the call: runIncrementalSync already overwrites
		// lastIncrementalError with the new message on failure, so comparing
		// against it afterward would always be comparing a value to itself.
		const previousError = this.lastIncrementalError;
		try {
			await this.runIncrementalSync(reason);
		} catch (error) {
			const message = this.errorMessage(error);
			console.warn(`Amazing Marvin incremental sync failed after ${reason}:`, error);
			if (message !== previousError) {
				new Notice(
					`Amazing Marvin incremental sync failed; existing notes were left unchanged. ${message}`,
					10_000,
				);
			}
		}
	}

	/** Runs fn only after every previously queued categories-mutating
	 * operation has settled, regardless of that operation's own success or
	 * failure. Both the REST sync() and the incremental path's
	 * applyIncrementalUpdate() go through this so they never interleave
	 * writes to this.categories. */
	private async withCategoriesLock<T>(fn: () => Promise<T>): Promise<T> {
		return this.categoriesLock.run(fn);
	}

	/** Serializes concurrent triggers (focus + interval firing together, for
	 * example) onto one in-flight sync rather than racing the same cache. */
	async runIncrementalSync(trigger: string): Promise<void> {
		if (this.incrementalSyncInFlight) {
			return this.incrementalSyncInFlight;
		}
		const pending = this.runIncrementalSyncOnce(trigger).finally(() => {
			this.incrementalSyncInFlight = undefined;
		});
		this.incrementalSyncInFlight = pending;
		return pending;
	}

	private async runIncrementalSyncOnce(trigger: string): Promise<void> {
		try {
			const cache = this.getOrCreateIncrementalCache();
			if (!cache) {
				// Inside the try, not before it: a missing-credentials
				// failure must still update lastIncrementalError and the
				// backoff, exactly like any other failure — otherwise this
				// specific error bypasses both, and the automatic-sync
				// notice-dedup (which compares against lastIncrementalError)
				// re-fires on every single trigger forever instead of once.
				throw new Error(
					"Incremental sync is disabled or missing database credentials.",
				);
			}
			const update = await cache.sync();
			this.incrementalBackoff.recordSuccess();
			this.lastIncrementalError = "";
			this.lastIncrementalSyncAt = Date.now();
			await this.withCategoriesLock(() => this.applyIncrementalUpdate(cache, update));
			await cache.acknowledgeProjection();
		} catch (error) {
			this.incrementalBackoff.recordFailure();
			this.lastIncrementalError = this.errorMessage(error);
			console.warn(`Amazing Marvin incremental sync failed (trigger: ${trigger}):`, error);
			throw error;
		} finally {
			// Covers automatic (focus/interval/startup/online) syncs too,
			// not just the manual "Sync now" button — otherwise the Status
			// line in an already-open settings tab goes stale until the
			// user does something to force a re-render.
			// Targeted status-row update, not a full display() rebuild: this
			// fires on automatic syncs too (focus/interval/startup/online),
			// and rebuilding the tab would collapse the advanced sections
			// and drop focus out of a field being typed into.
			this.settingsTab?.refreshIncrementalStatus();
		}
	}

	/** Targeted reconciliation: only the categories/inbox the sync actually
	 * touched are re-rendered, sourced from the cache — never a REST call —
	 * so incremental sync never reintroduces the throttling it exists to
	 * avoid. Respects the user's existing selective-import settings: an
	 * unselected category's change is not suddenly imported. */
	private async applyIncrementalUpdate(
		cache: IncrementalMarvinCache,
		update: IncrementalUpdate,
	): Promise<void> {
		const cachedCategories = cache.getCategories();
		if (!cachedCategories) {
			return;
		}
		this.categories = cachedCategories.map(
			(item) => this.decorateWithDeepLink(item, "category"),
		) as Category[];

		const fullPlan = planCategorySync(
			this.categories,
			this.settings.syncSelectionMode,
			this.settings.syncRoots.map((root) => root.id),
		);
		// fullRefresh means "the initial hydration snapshot" (or a previous
		// sync's projection went unacknowledged) — affectedContainerIds only
		// covers changes since the hydration checkpoint, not the snapshot
		// itself. Without this, first enablement would hydrate the cache
		// but never actually write a single note.
		const targetedIds = update.fullRefresh
			? new Set(fullPlan.includedIds)
			: targetedContainerIds(update.affectedContainerIds, fullPlan);

		if (targetedIds.size > 0) {
			const existingFiles = await this.findManagedImportFiles();
			const targetedPlan = buildTargetedPlan(targetedIds, fullPlan);
			const preFetchedChildrenByCategoryId = new Map<string, (Task | Category)[]>();
			for (const id of targetedPlan.contentIds) {
				const children = cache.getChildren(id) ?? [];
				preFetchedChildrenByCategoryId.set(
					id,
					children.map((item) => this.decorateWithDeepLink(item)),
				);
			}
			await this.processCategories(existingFiles, targetedPlan, preFetchedChildrenByCategoryId);
		}

		if ((update.inboxChanged || update.fullRefresh) && this.settings.syncInbox) {
			const existingFiles = await this.findManagedImportFiles();
			const inboxItems = (cache.getChildren("unassigned") ?? []).map(
				(item) => this.decorateWithDeepLink(item),
			);
			await this.processInbox(existingFiles, inboxItems);
		}
	}

	getIncrementalSyncStatus(): { lastError?: string; lastSuccessfulSyncAt?: number } {
		return {
			...(this.lastIncrementalError ? { lastError: this.lastIncrementalError } : {}),
			...(this.lastIncrementalSyncAt ? { lastSuccessfulSyncAt: this.lastIncrementalSyncAt } : {}),
		};
	}

	/** Clears the persisted cache file directly, independent of whether
	 * credentials are currently valid — a stale file left over from before
	 * the user disabled incremental sync or cleared credentials must still
	 * be clearable from settings, not stuck with no way to remove it. */
	async resetIncrementalCache(): Promise<void> {
		if (this.incrementalCache) {
			await this.incrementalCache.clear();
		} else {
			await new ObsidianIncrementalCacheStore(
				this.buildObsidianFileAdapter(),
				this.getPluginDataDir(),
			).clear();
		}
		this.incrementalCache = undefined;
		this.incrementalCacheKey = "";
		this.incrementalBackoff.recordSuccess();
		this.lastIncrementalError = "";
		this.lastIncrementalSyncAt = 0;
	}

	private async refreshManagedTodayIfPresent(): Promise<boolean> {
		const date = moment().format("YYYY-MM-DD");
		let file: TFile;
		try {
			file = this.resolveDailyNote(date);
		} catch {
			return false;
		}
		const content = await this.app.vault.cachedRead(file);
		if (!hasTodayRegion(content, date)) {
			return false;
		}
		await this.refreshTodayTasks({ date, filePath: file.path });
		return true;
	}

	private queueManagedTodayRefresh(context: string): void {
		void this.refreshManagedTodayIfPresent().catch((error) => {
			console.warn(
				`Amazing Marvin succeeded at ${context}, but the managed daily-note refresh failed:`,
				error,
			);
			new Notice(
				`Amazing Marvin succeeded at ${context}, but today's managed task region could not be refreshed. ${this.errorMessage(error)}`,
				10_000,
			);
		});
	}


	async sync() {
		return this.withCategoriesLock(async () => {
			await this.refreshLabelsForProjection();
			const categories = await this.getCategories();
			this.categories = categories;
			const plan = planCategorySync(
				categories,
				this.settings.syncSelectionMode,
				this.settings.syncRoots.map((root) => root.id),
			);
			const existingFiles = await this.findManagedImportFiles();
			await this.processCategories(existingFiles, plan);
			if (this.settings.syncInbox) {
				await this.processInbox(existingFiles);
			}
		});
	}

	async getCategories(): Promise<Category[]> {
		const result = await this.getMarvinRouter().getCategories();
		this.reportReadState(result, "categories");
		return result.data.map(item => this.decorateWithDeepLink(item, "category") as Category);
	}

	async getChildren(parentId: string): Promise<(Task | Category)[]> {
		const result = await this.getMarvinRouter().getChildren(parentId);
		this.reportReadState(result, `children of ${parentId}`);
		return result.data.map(item => this.decorateWithDeepLink(item));
	}

	async getScheduledTasks(date: string): Promise<(Task | Category)[]> {
		const result = await this.getMarvinRouter().getTodayItems(date);
		this.reportReadState(result, "scheduled tasks");
		return result.data.map(item => this.decorateWithDeepLink(item));
	}

	async getDueTasks(date: string): Promise<(Task | Category)[]> {
		const result = await this.getMarvinRouter().getDueItems(date);
		this.reportReadState(result, "due tasks");
		return result.data.map(item => this.decorateWithDeepLink(item));
	}

	decorateWithDeepLink(
		item: MarvinItem,
		defaultType: "task" | "category" = "task",
	): Task | Category {
		const type = item.type ?? defaultType;
		return {
			...item,
			deepLink: marvinDeepLink({ ...item, type }),
			type,
		} as Task | Category;
	}

	async processInbox(
		existingFiles: Map<string, TFile>,
		preFetchedItems?: (Task | Category)[],
	) {
		const inboxItems = preFetchedItems ?? await this.getChildren("unassigned");
		const content = this.formatItems(inboxItems);
		const inboxFilePath = normalizePath(`${this.getSyncBaseDir()}/Inbox.md`);
		await this.moveManagedFile(existingFiles.get("unassigned"), inboxFilePath);
		await this.createOrUpdateManaged(
			inboxFilePath,
			"unassigned",
			content,
			"inbox",
			{
				_id: "unassigned",
				type: "inbox",
				title: "Inbox",
			},
		);
	}

	async createOrUpdateManaged(
		path: string,
		itemId: string,
		rendered: string,
		legacyKind: "category" | "inbox",
		item?: object,
	) {
		const normalizedPath = normalizePath(path);
		await this.ensureParentFolder(normalizedPath);
		let file = this.app.vault.getAbstractFileByPath(normalizedPath);
		if (file && !(file instanceof TFile)) {
			throw new Error(`Cannot write Amazing Marvin note over folder: ${normalizedPath}`);
		}
		if (!file) {
			const frontmatter = item
				? `---\n${stringifyYaml(marvinFrontmatter({ ...item })).trimEnd()}\n---\n`
				: "";
			const projected = refreshCategoryRegion(frontmatter, {
				itemId,
				rendered,
				legacyKind,
			});
			await this.app.vault.create(normalizedPath, projected.content);
			return;
		}

		await this.app.vault.process(file, repairLegacyMarvinFrontmatter);
		if (item) {
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				updateMarvinFrontmatter(frontmatter, { ...item });
			});
		}
		await this.app.vault.process(file, (content) => (
			refreshCategoryRegion(content, {
				itemId,
				rendered,
				legacyKind,
			}).content
		));
	}

	getPathForCategory(category: Category) {
		return normalizePath(categoryNotePath(
			category,
			this.categories,
			this.getSyncBaseDir(),
		));
	}

	async processCategories(
		existingFiles: Map<string, TFile>,
		plan: CategorySyncPlan,
		preFetchedChildrenByCategoryId?: Map<string, (Task | Category)[]>,
	) {
		for (const category of this.categories.filter(
			(item) => plan.includedIds.has(item._id),
		)) {
			const path = this.getPathForCategory(category);
			await this.moveManagedFile(existingFiles.get(category._id), path);
			const content = await this.createContentForCategory(
				category,
				plan,
				preFetchedChildrenByCategoryId?.get(category._id),
			);
			await this.createOrUpdateManaged(
				path,
				category._id,
				content,
				"category",
				category,
			);
		}
	}

	formatItems(
		items: (Task | Category)[],
		level = 0,
		isSubtask = false,
		allowedContainerIds?: ReadonlySet<string>,
	) {
		let taskContent = '';
		let categoryContent = '';

		for (const item of items) {
			const indentation = ' '.repeat(level * 2);
			const isCategoryOrProject = item.type === 'category' || item.type === 'project';

			if (isCategoryOrProject) {
				if (allowedContainerIds && !allowedContainerIds.has(item._id)) {
					continue;
				}
				// Handle category or project formatting
				const path = this.getPathForCategory(item);
				categoryContent += `${indentation}- [[${this.wikiTarget(path)}|${this.wikiAlias(item.title)}]] [⚓](${item.deepLink})\n`;
			} else {
				if (!isSubtask) { // Only add deep links to top-level tasks
					taskContent += `${indentation}- [${item.done ? 'x' : ' '}] ${this.renderTaskBody(item as Task)}`;
				} else {
					taskContent += `${indentation}- [${item.done ? 'x' : ' '}] ${this.inlineMarkdown(item.title)}`;
				}
				taskContent += "\n";

				// Recursively format sub-tasks if any
				if ('subtasks' in item && item.subtasks && Object.keys(item.subtasks).length > 0) {
					const subtasks = Object.values(item.subtasks).map(subtask => ({
						...subtask,
						type: "task" as const,
						deepLink: "",
					})) as Task[];
					taskContent += this.formatItems(
						subtasks,
						level + 1,
						true,
						allowedContainerIds,
					);
				}
			}
		}

		// Combine categories/projects and tasks into one content string
		let content = '';
		if (categoryContent) {
			content += `\n## Categories and Projects\n${categoryContent}`;
		}
		if (taskContent && !isSubtask) { // Only add "Tasks" header for top-level tasks
			content += `\n## Tasks\n${taskContent}`;
		} else if (isSubtask) {
			content += taskContent;
		}
		return content;
	}

	formatTaskDetails(task: Task): string {
		return formatTaskMetadata(
			task,
			this.taskFormattingOptions(),
			this.marvinLabelsById,
		);
	}

	private renderTaskBody(task: Task): string {
		const options = this.taskFormattingOptions();
		return orderTaskBody(
			this.inlineMarkdown(task.title),
			task.deepLink,
			formatTaskMetadata(task, options, this.marvinLabelsById),
			taskTitleComesFirst(options),
		);
	}

	private taskFormattingOptions(): TaskFormattingOptions {
		return {
			format: this.settings.taskMetadataFormat,
			titleFirst: this.settings.taskTitleFirst,
			showDueDate: this.settings.showDueDate,
			showStartDate: this.settings.showStartDate,
			showScheduledDate: this.settings.showScheduledDate,
			taskTag: this.settings.taskTag,
			showMarvinLabelsAsTags: this.settings.showMarvinLabelsAsTags,
			labelTagPrefix: this.settings.marvinLabelTagPrefix,
			dateLinkTarget: (date) => {
				const parsed = moment(date, "YYYY-MM-DD", true);
				return parsed.isValid()
					? parsed.format(this.settings.taskDateLinkFormat)
					: date;
			},
		};
	}

	async createContentForCategory(
		category: Category,
		plan: CategorySyncPlan,
		// When supplied, skips the REST children fetch — the incremental
		// sync path already has this category's children from its cache,
		// and re-fetching via REST here would reintroduce the same N+1
		// throttling exposure incremental sync exists to avoid.
		preFetchedChildren?: (Task | Category)[],
	): Promise<string> {
		const labelTags = this.settings.showMarvinLabelsAsTags
			? formatMarvinLabelTags(
				category.labelIds,
				this.settings.marvinLabelTagPrefix,
				this.marvinLabelsById,
			)
			: [];
		let content = [
			`# [⚓](${category.deepLink}) ${this.inlineMarkdown(category.title)}`,
			...labelTags,
		].join(" ") + "\n\n";

		// Link to parent category, if it exists
		if (category.parentId && category.parentId !== "root") {
			const parentCategory = this.categories.find(cat => cat._id === category.parentId);
			if (parentCategory) {
				content += `Back to [[${this.wikiTarget(this.getPathForCategory(parentCategory))}|${this.wikiAlias(parentCategory.title)}]]\n\n`;
			}
		}
		// Fetch and format tasks
		const fetchedChildren = preFetchedChildren ?? (
			plan.contentIds.has(category._id)
				? await this.getChildren(category._id)
				: undefined
		);
		const children = categoryProjectionItems(
			category._id,
			plan,
			this.categories,
			fetchedChildren,
		);
		content += this.formatItems(
			children,
			0,
			false,
			plan.includedIds,
		);

		return content;
	}

	private getSyncBaseDir(): string {
		return normalizePath(normalizeManagedFolder(this.settings.syncFolder));
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const separator = path.lastIndexOf("/");
		if (separator === -1) {
			return;
		}
		const segments = path.slice(0, separator).split("/");
		let current = "";
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing && !(existing instanceof TFolder)) {
				throw new Error(
					`Cannot create Amazing Marvin folder ${current}; a vault file already exists there`,
				);
			}
			if (!existing) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	private async moveManagedFile(
		existing: TFile | undefined,
		destination: string,
	): Promise<void> {
		if (!existing || existing.path === destination) {
			return;
		}
		await this.ensureParentFolder(destination);
		const collision = this.app.vault.getAbstractFileByPath(destination);
		if (collision && collision !== existing) {
			throw new Error(
				`Cannot move ${existing.path} to ${destination}; another vault item already exists there`,
			);
		}
		await this.app.fileManager.renameFile(existing, destination);
	}

	private inlineMarkdown(value: string): string {
		return value
			.replace(/[\r\n]+/g, " ")
			.replace(/<!--/g, "&lt;!--")
			.replace(/-->/g, "--&gt;")
			.trim();
	}

	private wikiAlias(value: string): string {
		return this.inlineMarkdown(value)
			.replace(/\|/g, "\\|")
			.replace(/\]/g, "\\]");
	}

	private wikiTarget(value: string): string {
		return value.replace(/\|/g, "\\|").replace(/\]/g, "\\]");
	}

	private async findManagedImportFiles(): Promise<Map<string, TFile>> {
		const byId = new Map<string, TFile>();
		const rootsToInspect = new Set([
			`${this.getSyncBaseDir()}/`,
			"AmazingMarvin/",
		]);
		for (const file of this.app.vault.getMarkdownFiles()) {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const isLegacyLocation = [...rootsToInspect].some(
				(root) => file.path.startsWith(root),
			);
			let itemId = managedImportItemId(
				"",
				frontmatter,
				file.path,
			);
			if (
				!itemId
				&& isLegacyLocation
			) {
				const content = await this.app.vault.cachedRead(file);
				itemId = managedImportItemId(
					content,
					frontmatter,
					file.path,
					true,
				);
			}
			if (!itemId) {
				continue;
			}
			const duplicate = byId.get(itemId);
			if (duplicate && duplicate.path !== file.path) {
				throw new Error(
					`Multiple Obsidian notes claim Amazing Marvin item ${itemId}: ${duplicate.path} and ${file.path}`,
				);
			}
			byId.set(itemId, file);
		}
		return byId;
	}

	private async refreshLabelsForProjection(): Promise<void> {
		if (!this.settings.showMarvinLabelsAsTags) {
			this.marvinLabelsById.clear();
			return;
		}
		const result = await this.getMarvinRouter().getLabels();
		this.reportReadState(result, "labels");
		this.marvinLabelsById = new Map(
			result.data.map((label) => [label._id, label]),
		);
	}

	private getMarvinRouter(): MarvinRouter {
		const key = [
			this.settings.apiKey,
			this.settings.useLocalServer,
			this.settings.localServerHost,
			this.settings.localServerPort,
		].join("\u0000");
		if (this.marvinRouter && this.marvinRouterKey === key) {
			return this.marvinRouter;
		}

		const transport = createObsidianTransport(requestUrl);
		const publicClient = new MarvinApiClient({
			apiToken: this.settings.apiKey,
			baseUrl: "https://serv.amazingmarvin.com/api",
			origin: "public",
			transport,
		});
		const localClient = this.settings.useLocalServer
			? new MarvinApiClient({
				apiToken: this.settings.apiKey,
				baseUrl: `http://${this.settings.localServerHost}:${this.settings.localServerPort}/api`,
				origin: "local",
				transport,
			})
			: undefined;

		this.marvinRouter = new MarvinRouter({
			publicClient,
			...(localClient === undefined ? {} : { localClient }),
		});
		this.marvinRouterKey = key;
		return this.marvinRouter;
	}

	private getSourceActionStore(): ObsidianSourceActionStore {
		this.sourceActionStore ??= new ObsidianSourceActionStore(this.app);
		return this.sourceActionStore;
	}

	private getSourceActionService(): SourceActionService {
		const router = this.getMarvinRouter();
		if (this.sourceActionService && this.sourceActionRouter === router) {
			return this.sourceActionService;
		}
		this.sourceActionService = new SourceActionService({
			router,
			store: this.getSourceActionStore(),
		});
		this.sourceActionRouter = router;
		return this.sourceActionService;
	}

	private reportReadState<T>(result: MarvinReadResult<T>, description: string) {
		if (result.freshness === "stale") {
			new Notice(
				`Amazing Marvin is unavailable. Showing stale ${description} from ${new Date(result.fetchedAt).toLocaleTimeString()}.`,
				8000,
			);
			console.warn(`Using stale Amazing Marvin ${description}`, result.warnings);
		} else if (result.warnings.length > 0) {
			console.debug(
				`Amazing Marvin ${description} loaded via ${result.origin} fallback`,
				result.warnings,
			);
		}
	}

	private isThrottle(error: unknown): boolean {
		if (error instanceof MarvinError) {
			return error.status === 429;
		}
		if (error instanceof MarvinRouteError) {
			return error.attempts.some((attempt) => attempt.status === 429);
		}
		if (error instanceof SourceActionError) {
			return this.isThrottle(error.cause);
		}
		return false;
	}

	private newOperationId(): string {
		return globalThis.crypto?.randomUUID?.()
			?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private showManualActionError(message: string, href: string) {
		const errorNote = createFragment();
		errorNote.appendText(message);
		const link = activeDocument.createElement('a');
		link.href = href;
		link.text = 'manually';
		link.target = '_blank';
		errorNote.appendChild(link);
		errorNote.appendText('.');
		new Notice(errorNote, 0);
	}

}
