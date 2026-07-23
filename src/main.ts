import {
	Notice,
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
	setTimeout(() => animateNotice(notice), 500);
};

export default class AmazingMarvinPlugin extends Plugin {

	settings: AmazingMarvinPluginSettings;
	categories: Category[] = [];
	private marvinRouter?: MarvinRouter;
	private marvinRouterKey = "";
	private sourceActionStore?: ObsidianSourceActionStore;
	private sourceActionService?: SourceActionService;
	private sourceActionRouter?: MarvinRouter;
	private readonly todayRefreshes = new Map<string, Promise<RefreshTodayTasksResult>>();
	private lastAutomaticRefreshAt = 0;
	private lastAutomaticRefreshError = "";

	readonly api: AmazingMarvinApi = {
		getToday: (date) => this.getMarvinRouter().getTodayItems(date),
		getDue: (date) => this.getMarvinRouter().getDueItems(date),
		getTodayAndDue: (date) => this.getMarvinRouter().getTodayAndDue(date),
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

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AmazingMarvinSettingsTab(this.app, this));
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
			editorCallback: async (editor, view) => {
        // Fetch categories first and make sure they are loaded
        try {
			const defaultParentId = this.marvinParentIdForFile(view.file);
          // If a region of text is selected, at least 3 characters long, use that to add a new task and skip the modal
          if (editor.somethingSelected() && editor.getSelection().length > 2) {
            try {
              const task = await this.addMarvinTask(defaultParentId ?? '', editor.getSelection(), view.file?.path, this.app.vault.getName());
              editor.replaceSelection(`- [${task.done ? 'x' : ' '}] [⚓](${task.deepLink}) ${this.formatTaskDetails(task as Task, '')} ${task.title}`);
            } catch (error) {
              console.error('Could not create Marvin task:', error);
            }
            return;
          }

          const categories = await this.getCategories();
          new AddTaskModal(this.app, categories, async (taskDetails: { catId: string, task: string }) => {
            try {
              const task = await this.addMarvinTask(taskDetails.catId, taskDetails.task, view.file?.path, this.app.vault.getName());
              editor.replaceRange(`- [${task.done ? 'x' : ' '}] [⚓](${task.deepLink}) ${this.formatTaskDetails(task as Task, '')} ${task.title}`, editor.getCursor());
            } catch (error) {
              console.error('Could not create Marvin task:', error);
            }
          }, defaultParentId).open();
        } catch (error) {
          console.error('Error fetching categories:', error);
          new Notice('Failed to load categories from Amazing Marvin.');
        }
      }});

      this.addCommand({
        id: 'import',
        name: 'Import categories and tasks',
        callback: async () => {
          const notice = new Notice('Importing from Amazing Marvin...');
          animateNotice(notice);
          try {
            await this.sync();
            notice.hide(); // Hide the animating notice before showing success message
            new Notice('Amazing Marvin data imported successfully.');
          } catch (error) {
            console.error('Sync error:', error);
            new Notice('Error syncing with Amazing Marvin.');
          }
        }
      });
		this.addCommand({
			id: "import-today",
			name: "Refresh today's tasks",
			editorCallback: async (_editor, view) => {
				try {
					if (!view.file) {
						throw new Error("Open the daily note you want to refresh");
					}
					const fileDate = getDateFromFile(view.file, "day");
					if (!fileDate) {
						throw new Error(`${view.file.path} is not recognized as a daily note`);
					}
					const date = fileDate.format("YYYY-MM-DD");
					const result = await this.refreshTodayTasks({
						date,
						filePath: view.file.path,
					});
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
		});

		this.registerDomEvent(window, "focus", () => {
			void this.runAutomaticTodayRefresh("window focus");
		});
		this.registerInterval(window.setInterval(() => {
			void this.runAutomaticTodayRefresh("interval");
		}, 60_000));
		this.app.workspace.onLayoutReady(() => {
			void this.runAutomaticTodayRefresh("startup");
		});
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
			const note = document.createDocumentFragment();
			const a = document.createElement('a');
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
			const details = this.formatTaskDetails(item as Task, "").trim();
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
		const categories = await this.getCategories();
		this.categories = categories;
		const existingFiles = await this.findManagedImportFiles();
		await this.processCategories(existingFiles);
		await this.processInbox(existingFiles);
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

	async processInbox(existingFiles: Map<string, TFile>) {
		const inboxItems = await this.getChildren("unassigned");
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

	async processCategories(existingFiles: Map<string, TFile>) {
		for (const category of this.categories) {
			const path = this.getPathForCategory(category);
			await this.moveManagedFile(existingFiles.get(category._id), path);
			const content = await this.createContentForCategory(category);
			await this.createOrUpdateManaged(
				path,
				category._id,
				content,
				"category",
				category,
			);
		}
	}

	formatItems(items: (Task | Category)[], level = 0, isSubtask = false) {
		let taskContent = '';
		let categoryContent = '';

		for (const item of items) {
			const indentation = ' '.repeat(level * 2);
			const isCategoryOrProject = item.type === 'category' || item.type === 'project';

			if (isCategoryOrProject) {
				// Handle category or project formatting
				const path = this.getPathForCategory(item);
				categoryContent += `${indentation}- [[${this.wikiTarget(path)}|${this.wikiAlias(item.title)}]] [⚓](${item.deepLink})\n`;
			} else {
				if (!isSubtask) { // Only add deep links to top-level tasks
					taskContent += `${indentation}- [${item.done ? 'x' : ' '}] [⚓](${item.deepLink}) ${this.formatTaskDetails(item as Task, indentation)}`;
				} else {
					taskContent += `${indentation}- [${item.done ? 'x' : ' '}] `;
				}

				taskContent += `${this.inlineMarkdown(item.title)}\n`;

				// Recursively format sub-tasks if any
				if ('subtasks' in item && item.subtasks && Object.keys(item.subtasks).length > 0) {
					const subtasks = Object.values(item.subtasks).map(subtask => ({
						...subtask,
						type: "task" as const,
						deepLink: "",
					})) as Task[];
					taskContent += this.formatItems(subtasks, level + 1, true); // Pass true for isSubtask
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

	formatTaskDetails(task: Task, indentation: string) {
		let details = '';
		const settings = this.settings;

		if (settings.showDueDate && task.dueDate) {
			details += `Due Date:: [[${task.dueDate}]] `;
		}
		if (settings.showStartDate && task.startDate) {
			details += `Start Date:: [[${task.startDate}]] `;
		}
		if (settings.showScheduledDate && task.day && task.day !== 'unassigned') {
			details += `Scheduled Date:: [[${task.day}]] `;
		}

		return details;
	}

	async createContentForCategory(category: Category): Promise<string> {
		let content = `# [⚓](${category.deepLink}) ${this.inlineMarkdown(category.title)}\n\n`;

		// Link to parent category, if it exists
		if (category.parentId && category.parentId !== "root") {
			const parentCategory = this.categories.find(cat => cat._id === category.parentId);
			if (parentCategory) {
				content += `Back to [[${this.wikiTarget(this.getPathForCategory(parentCategory))}|${this.wikiAlias(parentCategory.title)}]]\n\n`;
			}
		}
		// Fetch and format tasks
		const children = await this.getChildren(category._id);
		content += this.formatItems(children);

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
		const errorNote = document.createDocumentFragment();
		errorNote.appendText(message);
		const link = document.createElement('a');
		link.href = href;
		link.text = 'manually';
		link.target = '_blank';
		errorNote.appendChild(link);
		errorNote.appendText('.');
		new Notice(errorNote, 0);
	}

}
