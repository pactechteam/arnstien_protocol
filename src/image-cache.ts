import * as fs from 'fs';
import * as path from 'path';

export function magnetCacheKey(magnetURI: string): string {
	const match = /xt=urn:btih:([a-fA-F0-9]+)/i.exec(magnetURI);
	return (match?.[1] ?? magnetURI).toLowerCase();
}

export interface EncryptedImageRef {
	path: string;
	magnet: string;
}

export function extractEncryptedImageRefs(content: string): EncryptedImageRef[] {
	const refs: EncryptedImageRef[] = [];
	const blockPattern = /```encrypted-image\s*\r?\n([\s\S]*?)```/gi;
	let blockMatch: RegExpExecArray | null;

	while ((blockMatch = blockPattern.exec(content)) !== null) {
		const body = blockMatch[1] ?? '';
		let filePath = '';
		let magnet = '';

		for (const line of body.split(/\r?\n/)) {
			const trimmed = line.trim();
			const pathMatch = /^path:\s*(.+)$/i.exec(trimmed);
			if (pathMatch?.[1]) {
				filePath = pathMatch[1].trim();
				continue;
			}
			const magnetMatch = /^magnet:\s*(magnet:\?.+)$/i.exec(trimmed);
			if (magnetMatch?.[1]) {
				magnet = magnetMatch[1].trim();
				continue;
			}
			if (!magnet && trimmed.toLowerCase().startsWith('magnet:?')) {
				magnet = trimmed;
			}
		}

		if (magnet) {
			refs.push({ path: filePath, magnet });
		}
	}

	return refs;
}

/**
 * Memory + optional disk cache for downloaded encrypted payloads.
 * Lets note blocks render independently from a warm cache.
 */
export class ImagePayloadCache {
	private readonly memory = new Map<string, ArrayBuffer>();
	private readonly inflight = new Map<string, Promise<ArrayBuffer>>();
	private diskDir = '';

	setDiskDir(dir: string): void {
		this.diskDir = dir.trim();
	}

	has(magnetURI: string): boolean {
		return this.memory.has(magnetCacheKey(magnetURI));
	}

	get(magnetURI: string): ArrayBuffer | undefined {
		return this.memory.get(magnetCacheKey(magnetURI));
	}

	put(magnetURI: string, data: ArrayBuffer): void {
		const key = magnetCacheKey(magnetURI);
		this.memory.set(key, data);
		void this.writeDisk(key, data);
	}

	async getOrLoad(
		magnetURI: string,
		loader: () => Promise<ArrayBuffer>,
	): Promise<ArrayBuffer> {
		const key = magnetCacheKey(magnetURI);
		const cached = this.memory.get(key);
		if (cached) return cached;

		const fromDisk = await this.readDisk(key);
		if (fromDisk) {
			this.memory.set(key, fromDisk);
			return fromDisk;
		}

		const existing = this.inflight.get(key);
		if (existing) return existing;

		const pending = (async () => {
			const data = await loader();
			this.memory.set(key, data);
			await this.writeDisk(key, data);
			return data;
		})().finally(() => {
			this.inflight.delete(key);
		});

		this.inflight.set(key, pending);
		return pending;
	}

	private cachePath(key: string): string | null {
		if (!this.diskDir) return null;
		const safe = key.replace(/[^a-f0-9]/gi, '').slice(0, 64) || 'unknown';
		return path.join(this.diskDir, `${safe}.obimg`);
	}

	private async readDisk(key: string): Promise<ArrayBuffer | null> {
		const filePath = this.cachePath(key);
		if (!filePath) return null;
		try {
			const buffer = await fs.promises.readFile(filePath);
			const copy = new Uint8Array(buffer.byteLength);
			copy.set(buffer);
			return copy.buffer;
		} catch {
			return null;
		}
	}

	private async writeDisk(key: string, data: ArrayBuffer): Promise<void> {
		const filePath = this.cachePath(key);
		if (!filePath) return;
		try {
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
			await fs.promises.writeFile(filePath, Buffer.from(data));
		} catch (error) {
			console.error('Failed to write image cache', error);
		}
	}
}
