import {
	App,
	FuzzySuggestModal,
	Notice,
	Platform,
	PluginSettingTab,
	Setting,
} from "obsidian";
import AmazingMarvinPlugin from "./main";
import type { Category } from "./interfaces";
import type { ObsidianLinkFormat } from "./marvin/obsidianLinks";
import type {
	SyncRootSelection,
	SyncSelectionMode,
} from "./marvin/syncSelection";
import type { TaskMetadataFormat } from "./marvin/taskFormatting";

export interface AmazingMarvinPluginSettings {
	linkBackToObsidianText: string;
	attemptToMarkTasksAsDone: boolean;
	useLocalServer: boolean;
	localServerHost: string;
	localServerPort: number | string;
	apiKey: string;
	showDueDate: boolean;
	showStartDate: boolean;
	showScheduledDate: boolean;
	taskMetadataFormat: TaskMetadataFormat;
	taskTitleFirst: boolean;
	taskDateLinkFormat: string;
	taskTag: string;
	showMarvinLabelsAsTags: boolean;
	marvinLabelTagPrefix: string;
	todayTasksToShow: 'due' | 'scheduled' | 'both';
	autoRefreshTodayTasks: boolean;
	todayRefreshIntervalMinutes: number;
	obsidianLinkFormat: ObsidianLinkFormat;
	syncFolder: string;
	syncSelectionMode: SyncSelectionMode;
	syncRoots: SyncRootSelection[];
	syncInbox: boolean;
}

export const DEFAULT_SETTINGS: AmazingMarvinPluginSettings = {
	linkBackToObsidianText: '',
	useLocalServer: false,
	localServerHost: "localhost",
	localServerPort: 12082,
	apiKey: "",
	showDueDate: true,
	showStartDate: true,
	showScheduledDate: true,
	taskMetadataFormat: "dataview",
	taskTitleFirst: false,
	taskDateLinkFormat: "YYYY-MM-DD",
	taskTag: "",
	showMarvinLabelsAsTags: false,
	marvinLabelTagPrefix: "marvin",
	todayTasksToShow: 'both',
	autoRefreshTodayTasks: true,
	todayRefreshIntervalMinutes: 5,
	obsidianLinkFormat: "advanced-uri",
	syncFolder: "AmazingMarvin",
	syncSelectionMode: "all",
	syncRoots: [],
	syncInbox: true,
	attemptToMarkTasksAsDone: false,
};

class SyncRootSuggestModal extends FuzzySuggestModal<Category> {
	constructor(
		app: App,
		private readonly categories: Category[],
		private readonly choose: (category: Category) => void,
	) {
		super(app);
		this.setPlaceholder("Choose a category or project root");
	}

	getItems(): Category[] {
		return this.categories;
	}

	getItemText(category: Category): string {
		return categoryDisplayPath(category, this.categories);
	}

	onChooseItem(category: Category): void {
		this.choose(category);
	}
}

function categoryDisplayPath(
	category: Category,
	categories: Category[],
): string {
	const segments = [category.title];
	const visited = new Set([category._id]);
	let parentId = category.parentId;
	while (parentId && parentId !== "root") {
		if (visited.has(parentId)) {
			segments.unshift("[cycle]");
			break;
		}
		visited.add(parentId);
		const parent = categories.find((item) => item._id === parentId);
		if (!parent) {
			segments.unshift("[missing parent]");
			break;
		}
		segments.unshift(parent.title);
		parentId = parent.parentId;
	}
	return segments.join(" / ");
}

export class AmazingMarvinSettingsTab extends PluginSettingTab {
	plugin: AmazingMarvinPlugin;

	constructor(app: App, plugin: AmazingMarvinPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// refactor a function for link creation that takes the href and text as parameters

private a(href: string, text: string) {
	const a = activeDocument.createElement('a');
	a.href = href;
	a.text = text;
	a.target = '_blank';
	return a;

}
	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		const TokenDescEl = createFragment();
		TokenDescEl.appendText('Get your Token at the ');
		TokenDescEl.appendChild(this.a('https://app.amazingmarvin.com/pre?api', 'API page'));

		new Setting(containerEl)
			.setName("API Token")
			.setDesc(TokenDescEl)
			.addText((text) =>
				text
					.setPlaceholder("API token")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Mark tasks as done")
			.setDesc("Attempt to mark tasks as done in Amazing Marvin. Note that this only applies to Amazing Marvins tasks imported or created with this plugin.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.attemptToMarkTasksAsDone)
				.onChange(async (value) => {
					this.plugin.settings.attemptToMarkTasksAsDone = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setHeading().setName("Category and project import");

		new Setting(containerEl)
			.setName("Managed folder")
			.setDesc("Vault-relative folder for imported categories, projects, and Inbox. Existing category and project notes move when their Marvin ID can be identified; old empty folders are left in place.")
			.addText(text => text
				.setPlaceholder("AmazingMarvin")
				.setValue(this.plugin.settings.syncFolder)
				.onChange(async (value) => {
					this.plugin.settings.syncFolder = value.trim() || "AmazingMarvin";
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Items to import")
			.setDesc("Import everything, or selected roots with their descendants. Ancestors are retained as navigation structure; excluded notes are never deleted.")
			.addDropdown(dropdown => dropdown
				.addOption("all", "All categories and projects")
				.addOption("selected", "Selected roots")
				.setValue(this.plugin.settings.syncSelectionMode)
				.onChange(async (value: SyncSelectionMode) => {
					this.plugin.settings.syncSelectionMode = value;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (this.plugin.settings.syncSelectionMode === "selected") {
			for (const root of this.plugin.settings.syncRoots) {
				new Setting(containerEl)
					.setName(root.title)
					.setDesc(`Marvin ID: ${root.id}`)
					.addButton(button => button
						.setButtonText("Remove")
						.onClick(async () => {
							this.plugin.settings.syncRoots = (
								this.plugin.settings.syncRoots.filter(
									(candidate) => candidate.id !== root.id,
								)
							);
							await this.plugin.saveSettings();
							this.display();
						})
					);
			}

			new Setting(containerEl)
				.setName("Add import root")
				.setDesc(
					this.plugin.settings.syncRoots.length === 0
						? "No roots selected. Category/project import will make no changes."
						: "Selecting a root includes every category and project below it.",
				)
				.addButton(button => button
					.setButtonText("Choose")
					.onClick(async () => {
						try {
							const categories = await this.plugin.getCategories();
							const selected = new Set(
								this.plugin.settings.syncRoots.map((root) => root.id),
							);
							new SyncRootSuggestModal(
								this.app,
								categories.filter((category) => !selected.has(category._id)),
								(category) => {
									this.plugin.settings.syncRoots.push({
										id: category._id,
										title: categoryDisplayPath(category, categories),
									});
									void this.plugin.saveSettings()
										.then(() => this.display())
										.catch((error) => {
											console.error(
												"Could not save Amazing Marvin import root:",
												error,
											);
											new Notice("Could not save the import root.");
										});
								},
							).open();
						} catch (error) {
							console.error("Could not load Amazing Marvin import roots:", error);
							new Notice("Could not load Amazing Marvin categories and projects.");
						}
					})
				);
		}

		new Setting(containerEl)
			.setName("Import Inbox")
			.setDesc("Update the managed Inbox note independently of category/project selection.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncInbox)
				.onChange(async (value) => {
					this.plugin.settings.syncInbox = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setHeading().setName("Today Tasks");

		new Setting(containerEl)
			.setName("Tasks to Show")
			.setDesc("Choose whether to include due tasks, scheduled tasks, or both")
			.addDropdown(dropdown => dropdown
				.addOption('due', 'Due Tasks')
				.addOption('scheduled', 'Scheduled Tasks')
				.addOption('both', 'Due and Scheduled Tasks')
				.setValue(this.plugin.settings.todayTasksToShow)
				.onChange(async (value: 'due' | 'scheduled' | 'both') => {
					this.plugin.settings.todayTasksToShow = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Refresh managed Today tasks automatically")
			.setDesc("Refresh an initialized managed region while Obsidian is open and when the window regains focus.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoRefreshTodayTasks)
				.onChange(async (value) => {
					this.plugin.settings.autoRefreshTodayTasks = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Refresh interval")
			.setDesc("Minutes between background refreshes. Existing notes are only changed after their managed region has been initialized.")
			.addText(text => text
				.setPlaceholder("5")
				.setValue(this.plugin.settings.todayRefreshIntervalMinutes.toString())
				.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isFinite(parsed) && parsed > 0) {
						this.plugin.settings.todayRefreshIntervalMinutes = parsed;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setHeading().setName("Task creation");


		const noteLink = createFragment();
		// make this text much shorter
		noteLink.appendText('Text for note back to Obsidian on tasks created with this plugin. If empty, a link be added.');
		noteLink.append(activeDocument.createElement('br'));

		new Setting(containerEl)
			.setName("Note link text")
			.setDesc(noteLink)
			.addText((text) =>
				text
					.setPlaceholder("Note link text")
					.setValue(this.plugin.settings.linkBackToObsidianText)
					.onChange(async (value) => {
						this.plugin.settings.linkBackToObsidianText = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Obsidian link format")
			.setDesc("Advanced URI restores links for workflows using the Advanced URI community plugin; Standard works with Obsidian itself.")
			.addDropdown(dropdown => dropdown
				.addOption("advanced-uri", "Advanced URI")
				.addOption("standard", "Standard Obsidian URI")
				.setValue(this.plugin.settings.obsidianLinkFormat)
				.onChange(async (value: ObsidianLinkFormat) => {
					this.plugin.settings.obsidianLinkFormat = value;
					await this.plugin.saveSettings();
				})
			);


		new Setting(containerEl)
			.setHeading().setName("Task formatting");

		new Setting(containerEl)
			.setName("Metadata format")
			.setDesc("Keep the existing Dataview fields, or emit a format that Obsidian Tasks can query.")
			.addDropdown(dropdown => dropdown
				.addOption("dataview", "Dataview (current)")
				.addOption("tasks-dataview", "Tasks Dataview")
				.addOption("tasks-emoji", "Tasks emoji")
				.setValue(this.plugin.settings.taskMetadataFormat)
				.onChange(async (value: TaskMetadataFormat) => {
					this.plugin.settings.taskMetadataFormat = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Put task title first")
			.setDesc("For the current Dataview format, put readable task text before dates. Tasks-compatible formats always put the title first.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.taskTitleFirst)
				.onChange(async (value) => {
					this.plugin.settings.taskTitleFirst = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Date link format")
			.setDesc("Moment format for Dataview date links. For example, YYYY-[W]WW links each date to its weekly note while keeping the date as the alias.")
			.addText(text => text
				.setPlaceholder("YYYY-MM-DD")
				.setValue(this.plugin.settings.taskDateLinkFormat)
				.onChange(async (value) => {
					this.plugin.settings.taskDateLinkFormat = value.trim()
						|| "YYYY-MM-DD";
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Task query tag")
			.setDesc("Optional tag added to every projected Marvin task, such as #task for an Obsidian Tasks global filter.")
			.addText(text => text
				.setPlaceholder("#task")
				.setValue(this.plugin.settings.taskTag)
				.onChange(async (value) => {
					this.plugin.settings.taskTag = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Marvin labels as tags")
			.setDesc("Resolve Marvin label IDs through the limited API and add their names as Obsidian tags.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showMarvinLabelsAsTags)
				.onChange(async (value) => {
					this.plugin.settings.showMarvinLabelsAsTags = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Marvin label tag prefix")
			.setDesc("Optional tag namespace. The default turns “Knowledge work” into #marvin/Knowledge-work.")
			.addText(text => text
				.setPlaceholder("marvin")
				.setValue(this.plugin.settings.marvinLabelTagPrefix)
				.onChange(async (value) => {
					this.plugin.settings.marvinLabelTagPrefix = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show Due Date")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showDueDate)
				.onChange(async (value) => {
					this.plugin.settings.showDueDate = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show Start Date")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showStartDate)
				.onChange(async (value) => {
					this.plugin.settings.showStartDate = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show Scheduled Date")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showScheduledDate)
				.onChange(async (value) => {
					this.plugin.settings.showScheduledDate = value;
					await this.plugin.saveSettings();
				})
			);

		if (Platform.isDesktopApp) {
			const lsDescEl = createFragment();
			lsDescEl.appendText('The local API can speed up the plugin. See the ');
			lsDescEl.appendChild(this.a('https://help.amazingmarvin.com/en/articles/5165191-desktop-local-api-server', 'Desktop Local API Server'));
			lsDescEl.appendText(' for more information.');

			let ls = new Setting(containerEl)
				.setHeading().setName("Local Server");
			ls.descEl.appendChild(lsDescEl);

			// Local Server Toggle
			let localServerToggle = new Setting(containerEl)
				.setName("Use Local Server")
				.setDesc("Attempt to use the local Amazing Marvin server first");

			let localServerHostSetting = new Setting(containerEl)
				.setName("Host")
				.addText(text => text
					.setPlaceholder("localhost")
					.setValue(this.plugin.settings.localServerHost || "localhost")
					.setDisabled(!this.plugin.settings.useLocalServer)
					.onChange(async (value) => {
						this.plugin.settings.localServerHost = value;
						await this.plugin.saveSettings();
					})
				);

			// Local Server Port
			let localServerPortSetting = new Setting(containerEl)
				.setName("Port")
				.addText(text => text
					.setPlaceholder("12082")
					.setValue(this.plugin.settings.localServerPort?.toString() || "12082")
					.setDisabled(!this.plugin.settings.useLocalServer)
					.onChange(async (value) => {
						this.plugin.settings.localServerPort = value;
						await this.plugin.saveSettings();
					})
				);

			// Update the disabled state based on the toggle
			localServerToggle.addToggle(toggle => toggle.onChange(async (value) => {
				this.plugin.settings.useLocalServer = value;
				localServerHostSetting.setDisabled(!value);
				localServerPortSetting.setDisabled(!value);
				await this.plugin.saveSettings();
			}).setValue(this.plugin.settings.useLocalServer));

		}
	}
}
