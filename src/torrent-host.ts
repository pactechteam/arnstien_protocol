import * as fs from 'fs';
import * as path from 'path';
import { Notice } from 'obsidian';
import WebTorrentImport from 'webtorrent';
import { ENCRYPTED_EXTENSION, uniqueFilePath, writeBinaryFile } from './fs-utils';
import type { EncryptedImageBlockMeta } from './fs-utils';
import { ImagePayloadCache } from './image-cache';

type WebTorrentCtor = new (opts?: {
	dht?: boolean | object;
	tracker?: boolean | string[] | false;
	lsd?: boolean;
	utPex?: boolean;
}) => WebTorrentClient;

interface TorrentFile {
	name: string;
	length: number;
	arrayBuffer?: () => Promise<ArrayBuffer>;
	getBuffer?: (cb: (err: Error | null, buffer?: Buffer) => void) => void;
}

interface Torrent {
	infoHash: string;
	magnetURI: string;
	files: TorrentFile[];
	done: boolean;
	destroy: (opts?: { destroyStore?: boolean }, cb?: () => void) => void;
	on: (event: string, cb: (...args: unknown[]) => void) => void;
	off?: (event: string, cb: (...args: unknown[]) => void) => void;
	removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
}

interface WebTorrentClient {
	torrents: Torrent[];
	seed: (
		input: string | string[] | Buffer | File | File[],
		opts?: Record<string, unknown> | ((torrent: Torrent) => void),
		callback?: (torrent: Torrent) => void,
	) => Torrent;
	add: (
		input: string,
		opts?: Record<string, unknown> | ((torrent: Torrent) => void),
		callback?: (torrent: Torrent) => void,
	) => Torrent;
	get: (torrentId: string) => Torrent | undefined;
	destroy: (cb?: (err?: Error | null) => void) => void;
	on: (event: string, cb: (...args: unknown[]) => void) => void;
}

const WebTorrent = WebTorrentImport as unknown as WebTorrentCtor;

async function torrentFileToArrayBuffer(file: TorrentFile): Promise<ArrayBuffer> {
	if (typeof file.arrayBuffer === 'function') {
		return file.arrayBuffer();
	}

	if (typeof file.getBuffer === 'function') {
		return new Promise((resolve, reject) => {
			file.getBuffer?.((err, buffer) => {
				if (err || !buffer) {
					reject(err ?? new Error('Failed to read torrent file buffer.'));
					return;
				}
				const copy = new Uint8Array(buffer.byteLength);
				copy.set(
					new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
				);
				resolve(copy.buffer);
			});
		});
	}

	throw new Error('WebTorrent file API does not expose a buffer reader.');
}

function unlisten(
	torrent: Torrent,
	event: string,
	cb: (...args: unknown[]) => void,
): void {
	if (typeof torrent.off === 'function') {
		torrent.off(event, cb);
	} else if (typeof torrent.removeListener === 'function') {
		torrent.removeListener(event, cb);
	}
}

function waitForDone(torrent: Torrent): Promise<void> {
	if (torrent.done) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const onDone = () => {
			unlisten(torrent, 'done', onDone);
			unlisten(torrent, 'error', onError);
			resolve();
		};
		const onError = (err: unknown) => {
			unlisten(torrent, 'done', onDone);
			unlisten(torrent, 'error', onError);
			reject(err instanceof Error ? err : new Error(String(err)));
		};
		torrent.on('done', onDone);
		torrent.on('error', onError);
	});
}

export class TorrentHost {
	private client: WebTorrentClient | null = null;
	private readonly pathToMagnet = new Map<string, string>();
	private readonly seedingPaths = new Set<string>();
	private watcher: fs.FSWatcher | null = null;
	private folderPath = '';
	private watchTimer: ReturnType<typeof setTimeout> | null = null;
	/** basename(lowercase) -> absolute path for quick local lookups */
	private readonly localIndex = new Map<string, string>();
	readonly cache = new ImagePayloadCache();
	lastError = '';

	get isRunning(): boolean {
		return this.client !== null;
	}

	get imageFolder(): string {
		return this.folderPath;
	}

	isCached(magnetURI: string): boolean {
		return this.cache.has(magnetURI);
	}

	cachePayload(magnetURI: string, data: ArrayBuffer): void {
		this.cache.put(magnetURI, data);
	}

	/** Set/keep the image folder for local lookups even before BitTorrent starts. */
	async prepareImageFolder(folderPath: string): Promise<void> {
		this.folderPath = folderPath.trim();
		if (!this.folderPath) {
			this.localIndex.clear();
			return;
		}
		this.cache.setDiskDir(path.join(this.folderPath, '.arnstien-cache'));
		await fs.promises.mkdir(this.folderPath, { recursive: true });
		await this.refreshLocalIndex();
	}

	async refreshLocalIndex(): Promise<void> {
		this.localIndex.clear();
		if (!this.folderPath) return;
		try {
			const entries = await fs.promises.readdir(this.folderPath, {
				withFileTypes: true,
			});
			for (const entry of entries) {
				if (
					entry.isFile() &&
					entry.name.toLowerCase().endsWith(ENCRYPTED_EXTENSION)
				) {
					this.localIndex.set(
						entry.name.toLowerCase(),
						path.join(this.folderPath, entry.name),
					);
				}
			}
		} catch (error) {
			console.error('Failed to index local image folder', error);
		}
	}

	async start(folderPath: string): Promise<void> {
		this.lastError = '';
		await this.stop();
		this.folderPath = folderPath.trim();
		if (!this.folderPath) {
			this.lastError = 'Image folder is not set.';
			return;
		}

		this.cache.setDiskDir(path.join(this.folderPath, '.arnstien-cache'));

		try {
			this.client = new WebTorrent({
				dht: true,
				tracker: true,
			});

			this.client.on('error', (err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				this.lastError = message;
				console.error('WebTorrent error:', err);
			});

			await fs.promises.mkdir(this.folderPath, { recursive: true });
			// Seed existing files in the background so plugin/Obsidian startup stays responsive.
			void this.seedExistingFiles();
			this.startWatching();
		} catch (error) {
			this.client = null;
			this.lastError =
				error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.watchTimer) {
			clearTimeout(this.watchTimer);
			this.watchTimer = null;
		}
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		this.pathToMagnet.clear();
		this.seedingPaths.clear();
		this.folderPath = '';

		const client = this.client;
		this.client = null;
		if (!client) return;

		await new Promise<void>((resolve) => {
			try {
				client.destroy(() => resolve());
			} catch {
				resolve();
			}
		});
	}

	async restart(folderPath: string): Promise<void> {
		await this.start(folderPath);
	}

	getMagnetForPath(filePath: string): string | undefined {
		return this.pathToMagnet.get(path.normalize(filePath));
	}

	async seedFile(filePath: string): Promise<string> {
		const normalized = path.normalize(filePath);
		const existing = this.pathToMagnet.get(normalized);
		if (existing) return existing;

		if (!this.client) {
			throw new Error(
				this.lastError
					? `Torrent host is not running: ${this.lastError}`
					: 'Torrent host is not running.',
			);
		}
		if (this.seedingPaths.has(normalized)) {
			for (let i = 0; i < 50; i++) {
				await sleep(100);
				const magnet = this.pathToMagnet.get(normalized);
				if (magnet) return magnet;
			}
			throw new Error(`Timed out seeding ${path.basename(normalized)}`);
		}

		this.seedingPaths.add(normalized);
		try {
			const magnet = await this.seedPath(normalized);
			this.pathToMagnet.set(normalized, magnet);
			try {
				const bytes = await fs.promises.readFile(normalized);
				const copy = new Uint8Array(bytes.byteLength);
				copy.set(bytes);
				this.cache.put(magnet, copy.buffer);
			} catch (error) {
				console.error('Failed to cache seeded file', error);
			}
			return magnet;
		} finally {
			this.seedingPaths.delete(normalized);
		}
	}

	async saveEncryptedFile(
		folder: string,
		baseName: string,
		encrypted: ArrayBuffer,
	): Promise<{ filePath: string; magnet: string }> {
		await fs.promises.mkdir(folder, { recursive: true });
		const filePath = await uniqueFilePath(
			folder,
			baseName,
			ENCRYPTED_EXTENSION,
		);
		await writeBinaryFile(filePath, encrypted);
		const magnet = await this.seedFile(filePath);
		return { filePath, magnet };
	}

	localFileExists(filePath: string): boolean {
		const normalized = filePath.trim();
		if (!normalized) return false;
		try {
			return fs.existsSync(path.normalize(normalized));
		} catch {
			return false;
		}
	}

	findLocalPath(meta: EncryptedImageBlockMeta): string | null {
		const candidates: string[] = [];
		const direct = meta.path?.trim();
		if (direct) candidates.push(path.normalize(direct));

		const alt = (meta.alt ?? '').trim();
		if (this.folderPath && alt) {
			const withExt = alt.toLowerCase().endsWith(ENCRYPTED_EXTENSION)
				? alt
				: `${alt}${ENCRYPTED_EXTENSION}`;
			candidates.push(path.join(this.folderPath, withExt));
			const indexed = this.localIndex.get(withExt.toLowerCase());
			if (indexed) candidates.push(indexed);
		}

		const dn = displayNameFromMagnet(meta.magnet ?? '');
		if (this.folderPath && dn) {
			candidates.push(path.join(this.folderPath, dn));
			const indexed = this.localIndex.get(dn.toLowerCase());
			if (indexed) candidates.push(indexed);
		}

		for (const candidate of candidates) {
			if (this.localFileExists(candidate)) return candidate;
		}
		return null;
	}

	/**
	 * Prefer the local encrypted file. If missing, download via magnet and
	 * write it into the image folder (using path when provided).
	 */
	async resolveEncryptedPayload(options: {
		path?: string;
		magnet: string;
		alt?: string;
	}): Promise<{ data: ArrayBuffer; fromLocal: boolean; localPath?: string }> {
		// Local index may be stale if files appeared after startup.
		if (this.folderPath && this.localIndex.size === 0) {
			await this.refreshLocalIndex();
		}

		const localPath = this.findLocalPath({
			path: options.path ?? '',
			magnet: options.magnet,
			key: '',
			alt: options.alt ?? '',
		});
		if (localPath) {
			const buffer = await fs.promises.readFile(localPath);
			const copy = new Uint8Array(buffer.byteLength);
			copy.set(buffer);
			this.cache.put(options.magnet, copy.buffer);
			return { data: copy.buffer, fromLocal: true, localPath };
		}

		if (!this.client) {
			throw new Error(
				`Local file not found${options.path ? ` (${options.path})` : ''}. Torrent host is still starting — retry in a moment, or wait for background seeding.`,
			);
		}

		const data = await this.fetchEncryptedBytes(options.magnet);
		const destination = await this.persistDownloadedFile({
			preferredPath: options.path?.trim() ?? '',
			alt: options.alt,
			magnet: options.magnet,
			data,
		});
		this.localIndex.set(
			path.basename(destination).toLowerCase(),
			destination,
		);

		try {
			await this.seedFile(destination);
		} catch (error) {
			console.error('Failed to seed restored local file', error);
		}

		return { data, fromLocal: false, localPath: destination };
	}

	private async persistDownloadedFile(options: {
		preferredPath: string;
		alt?: string;
		magnet: string;
		data: ArrayBuffer;
	}): Promise<string> {
		let destination = options.preferredPath
			? path.normalize(options.preferredPath)
			: '';

		if (!destination) {
			if (!this.folderPath) {
				throw new Error(
					'Cannot store downloaded image: image folder is not set.',
				);
			}
			const baseName =
				(options.alt || '').trim() ||
				`downloaded-${options.magnet.slice(0, 16)}`;
			const safe = baseName.replace(/[<>:"/\\|?*]/g, '_');
			destination = path.join(
				this.folderPath,
				safe.toLowerCase().endsWith(ENCRYPTED_EXTENSION)
					? safe
					: `${safe}${ENCRYPTED_EXTENSION}`,
			);
		}

		await fs.promises.mkdir(path.dirname(destination), { recursive: true });
		if (!fs.existsSync(destination)) {
			await fs.promises.writeFile(destination, Buffer.from(options.data));
		}
		return destination;
	}

	async fetchEncryptedBytes(magnetURI: string): Promise<ArrayBuffer> {
		return this.cache.getOrLoad(magnetURI, () => this.downloadMagnet(magnetURI));
	}

	private async downloadMagnet(magnetURI: string): Promise<ArrayBuffer> {
		if (!this.client) {
			throw new Error(
				this.lastError
					? `Torrent host is not running: ${this.lastError}`
					: 'Torrent host is not running. Set an image folder in plugin settings and click Restart seeding.',
			);
		}

		const existing = this.client.get(magnetURI);
		const torrent =
			existing ??
			(await new Promise<Torrent>((resolve, reject) => {
				let settled = false;
				const t = this.client!.add(magnetURI, (ready: Torrent) => {
					if (settled) return;
					settled = true;
					resolve(ready);
				});
				t.on('error', (err: unknown) => {
					if (settled) return;
					settled = true;
					reject(err instanceof Error ? err : new Error(String(err)));
				});
			}));

		await waitForDone(torrent);
		const file = torrent.files[0];
		if (!file) {
			throw new Error('Torrent has no files.');
		}
		return torrentFileToArrayBuffer(file);
	}

	private async seedExistingFiles(): Promise<void> {
		const entries = await fs.promises.readdir(this.folderPath, {
			withFileTypes: true,
		});
		const files = entries
			.filter(
				(entry) =>
					entry.isFile() &&
					entry.name.toLowerCase().endsWith(ENCRYPTED_EXTENSION),
			)
			.map((entry) => path.join(this.folderPath, entry.name));

		let seeded = 0;
		for (const filePath of files) {
			try {
				await this.seedFile(filePath);
				seeded += 1;
			} catch (error) {
				console.error(`Failed to seed ${filePath}`, error);
			}
		}

		if (seeded > 0) {
			new Notice(
				`Seeding ${seeded} encrypted image${seeded === 1 ? '' : 's'} over BitTorrent DHT`,
			);
		}
	}

	private startWatching(): void {
		try {
			this.watcher = fs.watch(this.folderPath, () => {
				if (this.watchTimer) clearTimeout(this.watchTimer);
				this.watchTimer = setTimeout(() => {
					void this.seedExistingFiles();
				}, 500);
			});
		} catch (error) {
			console.error('Failed to watch image folder for torrent seeding', error);
		}
	}

	private seedPath(filePath: string): Promise<string> {
		return new Promise((resolve, reject) => {
			if (!this.client) {
				reject(new Error('Torrent host is not running.'));
				return;
			}

			let settled = false;
			const torrent = this.client.seed(
				filePath,
				{
					name: path.basename(filePath),
					private: false,
				},
				(ready: Torrent) => {
					if (settled) return;
					settled = true;
					resolve(ready.magnetURI);
				},
			);

			torrent.on('error', (err: unknown) => {
				if (settled) return;
				settled = true;
				reject(err instanceof Error ? err : new Error(String(err)));
			});
		});
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function displayNameFromMagnet(magnetURI: string): string | null {
	const match = /[?&]dn=([^&]+)/i.exec(magnetURI);
	if (!match?.[1]) return null;
	try {
		return decodeURIComponent(match[1].replace(/\+/g, ' '));
	} catch {
		return match[1];
	}
}
