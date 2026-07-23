import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import AmazingMarvinPlugin from "./main";

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
	todayTasksToShow: 'due' | 'scheduled' | 'both';
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
	todayTasksToShow: 'both',
	attemptToMarkTasksAsDone: false
};

export class AmazingMarvinSettingsTab extends PluginSettingTab {
	plugin: AmazingMarvinPlugin;

	constructor(app: App, plugin: AmazingMarvinPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// refactor a function for link creation that takes the href and text as parameters

private a(href: string, text: string) {
	const a = document.createElement('a');
	a.href = href;
	a.text = text;
	a.target = '_blank';
	return a;

}
	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		const TokenDescEl = document.createDocumentFragment();
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
			.setHeading().setName("Task creation");


		const noteLink = document.createDocumentFragment();
		// make this text much shorter
		noteLink.appendText('Text for note back to Obsidian on tasks created with this plugin. If empty, a link be added.');
		noteLink.append(document.createElement('br'));

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
			.setHeading().setName("Task formatting");

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
			const lsDescEl = document.createDocumentFragment();
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
