import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ArnstienProtocolPlugin from './main';
import { chooseFolder } from './fs-utils';

export interface ArnstienProtocolSettings {
	imageFolderPath: string;
	filenamePrefix: string;
	/**
	 * When true, scan the vault and download encrypted payloads in the background.
	 * When false, code blocks show a Download image button instead of auto-loading.
	 */
	backgroundPrefetch: boolean;
}

export const DEFAULT_SETTINGS: ArnstienProtocolSettings = {
	imageFolderPath: '',
	filenamePrefix: 'Pasted image',
	backgroundPrefetch: true,
};

export class ArnstienProtocolSettingTab extends PluginSettingTab {
	plugin: ArnstienProtocolPlugin;

	constructor(app: App, plugin: ArnstienProtocolPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('p', {
			text: 'Encrypted images live in a folder outside your notes. Each code block stores a local path and a magnet link. Preview prefers the local file; if it’s missing, the magnet is used to download and restore it.',
		});

		new Setting(containerEl)
			.setName('Image folder')
			.setDesc(
				'Absolute path where encrypted images are stored and seeded while Obsidian is open.',
			)
			.addText((text) => {
				text
					.setPlaceholder('C:\\Users\\You\\Pictures\\Obsidian')
					.setValue(this.plugin.settings.imageFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.imageFolderPath = value.trim();
						await this.plugin.saveSettings();
						await this.plugin.restartTorrentHost();
					});
				text.inputEl.style.width = '100%';
			})
			.addButton((button) => {
				button.setButtonText('Browse').onClick(async () => {
					const folder = await chooseFolder(
						this.plugin.settings.imageFolderPath || undefined,
					);
					if (!folder) return;
					this.plugin.settings.imageFolderPath = folder;
					await this.plugin.saveSettings();
					await this.plugin.restartTorrentHost();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName('Filename prefix')
			.setDesc(
				'Prefix used for encrypted files. A timestamp is appended automatically. Files use the .obimg extension.',
			)
			.addText((text) =>
				text
					.setPlaceholder('Pasted image')
					.setValue(this.plugin.settings.filenamePrefix)
					.onChange(async (value) => {
						this.plugin.settings.filenamePrefix =
							value.trim() || DEFAULT_SETTINGS.filenamePrefix;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Background prefetch')
			.setDesc(
				'Scan the vault and download any missing local image files via magnet in the background. Turn off to require a Download image button when the local file is missing.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.backgroundPrefetch)
					.onChange(async (value) => {
						this.plugin.settings.backgroundPrefetch = value;
						await this.plugin.saveSettings();
						await this.plugin.syncPrefetchMode();
						this.display();
					}),
			);

		if (this.plugin.settings.backgroundPrefetch) {
			new Setting(containerEl)
				.setName('Prefetch now')
				.setDesc(
					'Re-scan the vault and continue downloading missing payloads.',
				)
				.addButton((button) => {
					button.setButtonText('Scan vault').onClick(async () => {
						await this.plugin.syncPrefetchMode();
						new Notice('Background vault prefetch started');
					});
				});
		}

		const torrentHost = this.plugin.torrentHost;
		new Setting(containerEl)
			.setName('Torrent host')
			.setDesc(
				torrentHost.isRunning
					? 'Currently seeding the image folder over BitTorrent DHT.'
					: torrentHost.lastError
						? `Not seeding: ${torrentHost.lastError}`
						: 'Not seeding. Set an image folder to start.',
			)
			.addButton((button) => {
				button.setButtonText('Restart seeding').onClick(async () => {
					try {
						await this.plugin.restartTorrentHost();
						new Notice(
							torrentHost.isRunning
								? 'Torrent host restarted'
								: `Torrent host still stopped: ${
										torrentHost.lastError || 'unknown error'
									}`,
						);
						this.display();
					} catch (error) {
						console.error(error);
						new Notice(
							`Failed to restart torrent host: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
						this.display();
					}
				});
			});
	}
}
