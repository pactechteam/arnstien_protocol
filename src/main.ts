import * as path from 'path';
import {
	Editor,
	MarkdownRenderChild,
	MarkdownView,
	Notice,
	Plugin,
} from 'obsidian';
import {
	CryptoError,
	decryptImage,
	encryptImage,
	generateImageKey,
} from './crypto';
import {
	buildEncryptedImageBlock,
	buildPendingImageBlock,
	collectImageFiles,
	createPendingId,
	formatTimestamp,
	parseEncryptedImageBlock,
	parsePendingImageBlock,
	replacePendingBlockInEditor,
	type EncryptedImageBlockMeta,
} from './fs-utils';
import { BackgroundPrefetcher } from './prefetch';
import {
	DEFAULT_SETTINGS,
	ArnstienProtocolSettingTab,
	type ArnstienProtocolSettings,
} from './settings';
import { TorrentHost } from './torrent-host';

class EncryptedImageChild extends MarkdownRenderChild {
	private renderToken = 0;

	constructor(
		containerEl: HTMLElement,
		private readonly source: string,
		private readonly plugin: ArnstienProtocolPlugin,
	) {
		super(containerEl);
	}

	onload(): void {
		const meta = parseEncryptedImageBlock(this.source);
		if (!meta) {
			this.containerEl.empty();
			this.containerEl.addClass('arnstien-encrypted-image');
			this.containerEl.createDiv({
				cls: 'arnstien-encrypted-image-error',
				text: 'Invalid encrypted-image block. Expected magnet: and key: lines.',
			});
			return;
		}

		const localPath = this.plugin.torrentHost.findLocalPath(meta);

		if (localPath || this.plugin.settings.backgroundPrefetch) {
			void this.loadImage(meta, true);
			return;
		}

		this.showDownloadButton(meta);
	}

	private showDownloadButton(meta: EncryptedImageBlockMeta): void {
		const el = this.containerEl;
		el.empty();
		el.addClass('arnstien-encrypted-image');

		const panel = el.createDiv({ cls: 'arnstien-download-panel' });
		panel.createDiv({
			cls: 'arnstien-download-label',
			text: meta.alt || 'Encrypted image',
		});
		panel.createDiv({
			cls: 'arnstien-download-label',
			text: 'Local file missing — download via magnet to restore it.',
		});
		const button = panel.createEl('button', {
			cls: 'arnstien-download-button',
			text: 'Download image',
		});
		button.addEventListener('click', () => {
			void this.loadImage(meta, false);
		});
	}

	private stillActive(token: number): boolean {
		return token === this.renderToken && this.containerEl.isConnected;
	}

	private async loadImage(
		meta: EncryptedImageBlockMeta,
		auto: boolean,
	): Promise<void> {
		const token = ++this.renderToken;
		const el = this.containerEl;
		el.empty();
		el.addClass('arnstien-encrypted-image');

		const localPath = this.plugin.torrentHost.findLocalPath(meta);

		const status = el.createDiv({ cls: 'arnstien-encrypted-image-loading' });
		status.createDiv({ cls: 'arnstien-spinner' });
		const label = status.createSpan({
			text: localPath ? 'Loading local file…' : 'Downloading via magnet…',
		});

		try {
			const resolved = await this.plugin.torrentHost.resolveEncryptedPayload({
				path: meta.path,
				magnet: meta.magnet,
				alt: meta.alt,
			});
			if (!this.stillActive(token)) return;

			label.setText('Decrypting…');
			const decrypted = await decryptImage(resolved.data, meta.key);
			if (!this.stillActive(token)) return;

			const blob = new Blob([decrypted.data], { type: decrypted.mimeType });
			const url = URL.createObjectURL(blob);

			status.remove();
			const img = el.createEl('img', {
				cls: 'arnstien-encrypted-image-img',
				attr: {
					alt: meta.alt || 'Encrypted image',
				},
			});
			img.src = url;
			img.addEventListener(
				'load',
				() => {
					URL.revokeObjectURL(url);
				},
				{ once: true },
			);
			img.addEventListener(
				'error',
				() => {
					URL.revokeObjectURL(url);
				},
				{ once: true },
			);
		} catch (error) {
			if (!this.stillActive(token)) return;
			console.error(error);
			status.remove();
			const message =
				error instanceof CryptoError
					? error.message
					: error instanceof Error
						? error.message
						: 'Failed to load encrypted image.';

			const errorEl = el.createDiv({ cls: 'arnstien-encrypted-image-error' });
			errorEl.createDiv({ text: message });

			const retry = errorEl.createEl('button', {
				cls: 'arnstien-download-button',
				text: auto ? 'Retry' : 'Retry download',
			});
			retry.addEventListener('click', () => {
				void this.loadImage(meta, auto);
			});
		}
	}
}

class PendingImageChild extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private readonly source: string,
	) {
		super(containerEl);
	}

	onload(): void {
		const el = this.containerEl;
		el.empty();
		el.addClass('arnstien-encrypted-image');

		const meta = parsePendingImageBlock(this.source);
		const row = el.createDiv({ cls: 'arnstien-encrypted-image-loading' });
		row.createDiv({ cls: 'arnstien-spinner' });
		row.createSpan({
			text: meta?.status || 'Processing image…',
		});
	}
}

export default class ArnstienProtocolPlugin extends Plugin {
	settings!: ArnstienProtocolSettings;
	torrentHost = new TorrentHost();
	prefetcher: BackgroundPrefetcher | null = null;

	async onload() {
		await this.loadSettings();
		this.prefetcher = new BackgroundPrefetcher(this.app, this.torrentHost);
		this.addSettingTab(new ArnstienProtocolSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor(
			'encrypted-image',
			(source, el, ctx) => {
				ctx.addChild(new EncryptedImageChild(el, source, this));
			},
		);

		this.registerMarkdownCodeBlockProcessor(
			'encrypted-image-pending',
			(source, el, ctx) => {
				ctx.addChild(new PendingImageChild(el, source));
			},
		);

		this.registerEvent(
			this.app.workspace.on('editor-paste', (evt, editor) => {
				void this.handleImageTransfer(evt, editor);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('editor-drop', (evt, editor) => {
				void this.handleImageTransfer(evt, editor);
			}),
		);

		const folder = this.getEffectiveImageFolder();
		if (folder) {
			void this.torrentHost.prepareImageFolder(folder);
		}

		this.app.workspace.onLayoutReady(() => {
			void this.startBackgroundServices();
		});
	}

	private async startBackgroundServices(): Promise<void> {
		try {
			await this.restartTorrentHost();
			if (this.torrentHost.isRunning) {
				new Notice('Arnstien Protocol: torrent host started', 3000);
			}
			this.refreshOpenReadingViews();
		} catch (error) {
			console.error(error);
			new Notice(
				`Torrent host failed to start: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	refreshOpenReadingViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			if (view.getMode() !== 'preview') continue;
			try {
				view.previewMode.rerender(true);
			} catch (error) {
				console.error('Failed to refresh markdown preview', error);
			}
		}
	}

	async onunload() {
		this.prefetcher?.stop();
		await this.torrentHost.stop();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ArnstienProtocolSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getEffectiveImageFolder(): string {
		return this.settings.imageFolderPath.trim();
	}

	async restartTorrentHost(): Promise<void> {
		const folder = this.getEffectiveImageFolder();
		if (!folder) {
			this.prefetcher?.stop();
			await this.torrentHost.stop();
			return;
		}

		await this.torrentHost.restart(folder);
		await this.syncPrefetchMode();
	}

	async syncPrefetchMode(): Promise<void> {
		if (!this.prefetcher) return;
		this.prefetcher.stop();
		this.prefetcher = new BackgroundPrefetcher(this.app, this.torrentHost);

		if (!this.settings.backgroundPrefetch || !this.torrentHost.isRunning) {
			return;
		}

		void this.prefetcher.startVaultScan();
	}

	private async handleImageTransfer(
		evt: ClipboardEvent | DragEvent,
		editor: Editor,
	): Promise<void> {
		const folder = this.getEffectiveImageFolder();
		if (!folder) {
			new Notice('Set an image folder in plugin settings before pasting.');
			return;
		}

		const dataTransfer =
			evt instanceof DragEvent ? evt.dataTransfer : evt.clipboardData;
		const images = collectImageFiles(dataTransfer);
		if (images.length === 0) return;

		evt.preventDefault();
		if (evt instanceof DragEvent) {
			evt.stopPropagation();
		}

		const jobs = images.map((image, index) => ({
			image,
			index,
			pendingId: createPendingId(),
		}));

		const placeholders = jobs
			.map((job) =>
				buildPendingImageBlock(
					job.pendingId,
					images.length > 1
						? `Processing image ${job.index + 1} of ${images.length}…`
						: 'Encrypting and seeding image…',
				),
			)
			.join('\n\n');

		const cursor = editor.getCursor();
		editor.replaceRange(placeholders, cursor);
		const placeholderLines = placeholders.split('\n');
		const lastPlaceholderLine =
			placeholderLines[placeholderLines.length - 1] ?? '';
		editor.setCursor({
			line: cursor.line + placeholderLines.length - 1,
			ch:
				placeholderLines.length === 1
					? cursor.ch + lastPlaceholderLine.length
					: lastPlaceholderLine.length,
		});

		try {
			if (!this.torrentHost.isRunning) {
				await this.restartTorrentHost();
			}
			if (!this.torrentHost.isRunning) {
				const message = this.torrentHost.lastError
					? `Torrent host is not running: ${this.torrentHost.lastError}`
					: 'Torrent host is not running. Check the image folder setting.';
				for (const job of jobs) {
					replacePendingBlockInEditor(
						editor,
						job.pendingId,
						`> [!error] ${message}`,
					);
				}
				new Notice(message);
				return;
			}

			await this.torrentHost.prepareImageFolder(folder);

			await Promise.all(
				jobs.map(async (job) => {
					try {
						replacePendingBlockInEditor(
							editor,
							job.pendingId,
							buildPendingImageBlock(
								job.pendingId,
								images.length > 1
									? `Encrypting image ${job.index + 1} of ${images.length}…`
									: 'Encrypting image…',
							),
						);

						const stamp = formatTimestamp();
						const suffix = images.length > 1 ? `-${job.index + 1}` : '';
						const baseName = `${this.settings.filenamePrefix} ${stamp}${suffix}`;
						const key = generateImageKey();
						const plaintext = await job.image.arrayBuffer();
						const mimeType = job.image.type || 'image/png';
						const encrypted = await encryptImage(plaintext, mimeType, key);

						replacePendingBlockInEditor(
							editor,
							job.pendingId,
							buildPendingImageBlock(
								job.pendingId,
								images.length > 1
									? `Seeding image ${job.index + 1} of ${images.length}…`
									: 'Seeding over BitTorrent…',
							),
						);

						const saved = await this.torrentHost.saveEncryptedFile(
							folder,
							baseName,
							encrypted,
						);
						const altText = path.basename(saved.filePath, '.obimg');

						const finalBlock = buildEncryptedImageBlock(
							saved.filePath,
							saved.magnet,
							key,
							altText,
						);
						replacePendingBlockInEditor(editor, job.pendingId, finalBlock);
					} catch (error) {
						console.error(error);
						const message =
							error instanceof Error ? error.message : 'Unknown error';
						replacePendingBlockInEditor(
							editor,
							job.pendingId,
							`> [!error] Failed to save encrypted image: ${message}`,
						);
					}
				}),
			);
		} catch (error) {
			console.error(error);
			const message =
				error instanceof Error ? error.message : 'Unknown error';
			for (const job of jobs) {
				replacePendingBlockInEditor(
					editor,
					job.pendingId,
					`> [!error] Failed to save encrypted image: ${message}`,
				);
			}
			new Notice(`Failed to save encrypted image: ${message}`);
		}
	}
}
