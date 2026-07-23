import {
	Notice,
	Plugin,
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
	MarvinApiClient,
	MarvinError,
	MarvinRouter,
	marvinDeepLink,
} from "@open-horizon/marvin-client";

import {
	AmazingMarvinSettingsTab,
	AmazingMarvinPluginSettings,
	DEFAULT_SETTINGS,
} from "./settings";

import {
	getDateFromFile
} from "obsidian-daily-notes-interface";
import { amTaskWatcher } from "./amTaskWatcher";
import { AddTaskModal } from "./addTaskModal";
import { createObsidianTransport } from "./marvin/obsidianTransport";

function getAMTimezoneOffset() {
	return new Date().getTimezoneOffset() * -1;
}

const animateNotice = (notice: Notice) => {
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

const CONSTANTS = {
	baseDir: "AmazingMarvin",
};


export default class AmazingMarvinPlugin extends Plugin {

	settings: AmazingMarvinPluginSettings;
	categories: Category[] = [];
	private marvinRouter?: MarvinRouter;
	private marvinRouterKey = "";

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

		this.addCommand({
			id: "create-task",
			name: "Create task",
			editorCallback: async (editor, view) => {
        // Fetch categories first and make sure they are loaded
        try {
          // If a region of text is selected, at least 3 characters long, use that to add a new task and skip the modal
          if (editor.somethingSelected() && editor.getSelection().length > 2) {
            try {
              const task = await this.addMarvinTask('', editor.getSelection(), view.file?.path, this.app.vault.getName());
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
          }).open();
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
			name: "Import today's tasks",
			editorCallback: async (editor, view) => {
				try {
					const today = new Date().toISOString().split('T')[0];
					const fileDate = view.file ? getDateFromFile(view.file, "day")?.format("YYYY-MM-DD") : today;

					const date = fileDate ? fileDate : today;
					let tasks: (Task | Category)[];
					if (this.settings.todayTasksToShow === 'both') {
						const result = await this.getMarvinRouter().getTodayAndDue(date);
						this.reportReadState(result, "today and due tasks");
						tasks = result.data.map(item => this.decorateWithDeepLink(item));
					} else if (this.settings.todayTasksToShow === 'due') {
						tasks = await this.getDueTasks(date);
					} else {
						tasks = await this.getScheduledTasks(date);
					}

					editor.replaceRange(this.formatItems(tasks, 0, false), editor.getCursor());
				} catch (error) {
					new Notice(`Error importing scheduled tasks: ${error}`);
					console.error(`Error importing scheduled tasks: ${error}`);
				}
			}
		});

	}
	async addMarvinTask(catId: string, taskTitle: string, notePath: string = '', vaultName: string = ''): Promise<Task> {
		const requestBody: AddTaskRequest = {
			title: taskTitle,
			timeZoneOffset: getAMTimezoneOffset(),
		};

		if (catId && catId !== '' && catId !== 'root' && catId !== '__inbox-faux__') {
			requestBody.parentId = catId;
		}

		if (notePath && notePath !== '') {
			let link = `obsidian://open?file=${encodeURI(notePath)}${vaultName !== '' ? `&vault=${encodeURI(vaultName)}` : ''}`;
			if (this.settings.linkBackToObsidianText !== '') {
				requestBody.note = `[${this.settings.linkBackToObsidianText}](${link})`;
			} else {
				requestBody.note = link;
			}
	}

		try {
			const task = await this.getMarvinRouter().addTask(requestBody);
			new Notice("Task added in Amazing Marvin.");
			return this.decorateWithDeepLink(task) as Task;
		} catch (error) {
			console.error('Error creating task:', error);
			this.showManualActionError(
				this.isThrottle(error)
					? 'Your request was throttled by Amazing Marvin. Wait before trying again, or do it '
					: 'Error creating task in Amazing Marvin. You can try again or do it ',
				'https://app.amazingmarvin.com/',
			);
			throw error;
		}
	}

	onunload() { }

	async loadSettings() {
		this.settings = Object.assign(
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		this.marvinRouter = undefined;
		this.marvinRouterKey = "";
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


	async sync() {
		const categories = await this.getCategories();
		const baseDirPath = normalizePath(CONSTANTS.baseDir);
		const baseDir = this.app.vault.getAbstractFileByPath(baseDirPath);
		if (baseDir) {
			await this.app.vault.delete(baseDir, true);
		}

		this.categories = categories;
		await this.processCategories();
		await this.processInbox();
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

	async processInbox() {
		const inboxItems = await this.getChildren("unassigned");
		const content = this.formatItems(inboxItems);

		// Define the path for the Inbox file
		const inboxFilePath = normalizePath("AmazingMarvin/Inbox.md");

		await this.createOrUpdate(inboxFilePath, content);
	}

	async createOrUpdate(path: string, content: string) {
		const normalizedPath = normalizePath(path);
		let dirPath = normalizedPath.replace(/^(.+)\/[^\/]*?$/, '$1');

		// Ensure the directory exists
		if (!await this.app.vault.adapter.exists(dirPath)) {
			await this.app.vault.createFolder(dirPath);
		}

		// Overwrite existing file
		if (await this.app.vault.adapter.exists(normalizedPath)) {
			const existingContent = await this.app.vault.adapter.remove(normalizedPath);
		}

		await this.app.vault.create(normalizedPath, content);
	}

	getPathForCategory(category: Category) {
		let pathSegments: string[] = [];

		// Function to recursively build the path segments array
		const buildPathSegments = (cat: Category) => {
			const safeTitle = cat.title.replace(/[^a-zA-Z0-9 -]/g, "");
			pathSegments.unshift(safeTitle); // Add at the beginning

			if (cat.parentId && cat.parentId !== "root") {
				const parentCat = this.categories.find(c => c._id === cat.parentId);
				if (parentCat) {
					buildPathSegments(parentCat);
				}
			}
		};

		buildPathSegments(category);

		// Determine the filename and if the category should be a folder based on its children
		const hasChildCategoriesOrProjects = this.categories.some(cat =>
			cat.parentId === category._id && (cat.type === 'project' || cat.type === 'category')
		);

		// If the category has children that are categories or projects, make it a folder
		const isFolder = hasChildCategoriesOrProjects;

		// Construct the path
		let path = `${CONSTANTS.baseDir}/${pathSegments.join('/')}`;
		path = isFolder ? `${path}/${category.title}.md` : `${path}.md`;

		return normalizePath(path);
	}

	async processCategories() {
		for (const category of this.categories) {
			const path = this.getPathForCategory(category);
			const content = this.createContentForCategory(category);
			await this.createOrUpdate(path, await content);
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
				categoryContent += `${indentation}- [[${path}|${item.title}]] [⚓](${item.deepLink})\n`;
			} else {
				if (!isSubtask) { // Only add deep links to top-level tasks
					taskContent += `${indentation}- [${item.done ? 'x' : ' '}] [⚓](${item.deepLink}) ${this.formatTaskDetails(item as Task, indentation)}`;
				} else {
					taskContent += `${indentation}- [${item.done ? 'x' : ' '}] `;
				}

				taskContent += `${item.title}\n`;

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
		let yamlFrontmatter = "---\n";
		// Iterate over category properties and add non-null values to YAML frontmatter
		for (const [key, value] of Object.entries(category)) {
			if (value !== null && value !== undefined) {
				yamlFrontmatter += `${key}: ${stringifyYaml(value)}\n`;
			}
		}

		// Close YAML frontmatter block
		yamlFrontmatter += "---\n";

		let content = `# [⚓](${category.deepLink}) ${category.title}\n\n`;

		// Link to parent category, if it exists
		if (category.parentId && category.parentId !== "root") {
			const parentCategory = this.categories.find(cat => cat._id === category.parentId);
			if (parentCategory) {
				content += `Back to [[${parentCategory.title}]]\n\n`;
			}
		}
		// Fetch and format tasks
		const children = await this.getChildren(category._id);
		content += this.formatItems(children);

		return yamlFrontmatter + content;
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
		return error instanceof MarvinError && error.status === 429;
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
