import type { App } from 'obsidian';
import { extractEncryptedImageRefs } from './image-cache';
import type { TorrentHost } from './torrent-host';

const PREFETCH_CONCURRENCY = 3;

interface PrefetchJob {
	path: string;
	magnet: string;
}

/**
 * Walks the vault for encrypted-image blocks and downloads any missing local
 * files in the background via their magnet links.
 */
export class BackgroundPrefetcher {
	private stopped = false;
	private running = false;
	private readonly queued = new Set<string>();
	private readonly queue: PrefetchJob[] = [];
	private active = 0;
	private generation = 0;

	constructor(
		private readonly app: App,
		private readonly host: TorrentHost,
	) {}

	stop(): void {
		this.stopped = true;
		this.generation += 1;
		this.queue.length = 0;
		this.queued.clear();
		this.active = 0;
		this.running = false;
	}

	async startVaultScan(): Promise<void> {
		this.stopped = false;
		const generation = ++this.generation;
		this.running = true;

		try {
			const files = this.app.vault.getMarkdownFiles();
			for (const file of files) {
				if (this.stopped || generation !== this.generation) return;
				try {
					const content = await this.app.vault.cachedRead(file);
					for (const ref of extractEncryptedImageRefs(content)) {
						this.enqueue(ref);
					}
				} catch (error) {
					console.error(`Prefetch scan failed for ${file.path}`, error);
				}
				await sleep(0);
			}
		} finally {
			if (generation === this.generation) {
				this.running = false;
			}
		}
	}

	enqueue(ref: PrefetchJob): void {
		if (this.stopped) return;
		const magnet = ref.magnet.trim();
		if (!magnet || this.queued.has(magnet)) return;
		if (ref.path && this.host.localFileExists(ref.path)) return;
		if (this.host.isCached(magnet) && ref.path && this.host.localFileExists(ref.path)) {
			return;
		}
		this.queued.add(magnet);
		this.queue.push({ path: ref.path, magnet });
		this.pump();
	}

	get isScanning(): boolean {
		return this.running;
	}

	get pendingCount(): number {
		return this.queue.length + this.active;
	}

	private pump(): void {
		while (
			!this.stopped &&
			this.active < PREFETCH_CONCURRENCY &&
			this.queue.length > 0
		) {
			const job = this.queue.shift();
			if (!job) return;
			this.active += 1;
			void this.host
				.resolveEncryptedPayload({
					path: job.path,
					magnet: job.magnet,
				})
				.catch((error) => {
					console.error('Background prefetch failed', job.magnet, error);
				})
				.finally(() => {
					this.active -= 1;
					this.queued.delete(job.magnet);
					this.pump();
				});
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
