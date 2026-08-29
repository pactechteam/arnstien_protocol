import * as fs from 'fs';
import * as path from 'path';
import type { Editor } from 'obsidian';

interface ElectronDialogResult {
	canceled: boolean;
	filePaths: string[];
}

interface ElectronRemote {
	dialog: {
		showOpenDialog: (
			browserWindow: unknown,
			options: {
				title?: string;
				defaultPath?: string;
				properties: string[];
			},
		) => Promise<ElectronDialogResult>;
	};
	getCurrentWindow: () => unknown;
}

function getElectronRemote(): ElectronRemote | null {
	try {
		// Obsidian desktop exposes Electron's remote module to plugins.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const electron = require('electron') as {
			remote?: ElectronRemote;
		};
		return electron.remote ?? null;
	} catch {
		return null;
	}
}

export async function chooseFolder(
	defaultPath?: string,
): Promise<string | null> {
	const remote = getElectronRemote();
	if (!remote) {
		return null;
	}

	const result = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), {
		title: 'Choose image folder',
		defaultPath: defaultPath || undefined,
		properties: ['openDirectory', 'createDirectory'],
	});

	if (result.canceled || result.filePaths.length === 0) {
		return null;
	}

	return result.filePaths[0] ?? null;
}

export const ENCRYPTED_EXTENSION = '.obimg';

export function formatTimestamp(date = new Date()): string {
	const pad = (n: number, width = 2) => String(n).padStart(width, '0');
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

export async function ensureDirectory(dirPath: string): Promise<void> {
	await fs.promises.mkdir(dirPath, { recursive: true });
}

export async function uniqueFilePath(
	dirPath: string,
	baseName: string,
	extension: string,
): Promise<string> {
	let candidate = path.join(dirPath, `${baseName}${extension}`);
	let counter = 1;

	while (fs.existsSync(candidate)) {
		candidate = path.join(dirPath, `${baseName} ${counter}${extension}`);
		counter += 1;
	}

	return candidate;
}

export async function writeBinaryFile(
	filePath: string,
	data: ArrayBuffer,
): Promise<void> {
	await fs.promises.writeFile(filePath, Buffer.from(data));
}

export async function readBinaryFile(filePath: string): Promise<ArrayBuffer> {
	const buffer = await fs.promises.readFile(filePath);
	return buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength,
	);
}

export function buildEncryptedImageBlock(
	filePath: string,
	magnetURI: string,
	key: string,
	altText: string,
): string {
	return [
		'```encrypted-image',
		`path: ${filePath}`,
		`magnet: ${magnetURI}`,
		`key: ${key}`,
		`alt: ${altText}`,
		'```',
	].join('\n');
}

export function buildPendingImageBlock(id: string, status: string): string {
	return [
		'```encrypted-image-pending',
		`id: ${id}`,
		`status: ${status}`,
		'```',
	].join('\n');
}

export function createPendingId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace a pending code block (matched by id) with final markdown. */
export function replacePendingBlockInEditor(
	editor: Editor,
	pendingId: string,
	replacement: string,
): boolean {
	const text = editor.getValue();
	const pattern = new RegExp(
		'```encrypted-image-pending\\r?\\n[\\s\\S]*?^id:\\s*' +
			escapeRegExp(pendingId) +
			'\\s*\\r?\\n[\\s\\S]*?```',
		'm',
	);
	const match = pattern.exec(text);
	if (!match || match.index === undefined) return false;

	const startOffset = match.index;
	const endOffset = startOffset + match[0].length;
	const from = editor.offsetToPos(startOffset);
	const to = editor.offsetToPos(endOffset);
	editor.replaceRange(replacement, from, to);
	return true;
}

export function parsePendingImageBlock(source: string): {
	id: string;
	status: string;
} | null {
	const lines = source
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	let id = '';
	let status = 'Processing image…';

	for (const line of lines) {
		const idMatch = /^id:\s*(.+)$/i.exec(line);
		if (idMatch?.[1]) {
			id = idMatch[1].trim();
			continue;
		}
		const statusMatch = /^status:\s*(.*)$/i.exec(line);
		if (statusMatch) {
			status = (statusMatch[1] ?? '').trim() || status;
		}
	}

	if (!id) return null;
	return { id, status };
}

export interface EncryptedImageBlockMeta {
	path: string;
	magnet: string;
	key: string;
	alt: string;
}

export function parseEncryptedImageBlock(
	source: string,
): EncryptedImageBlockMeta | null {
	const lines = source
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	if (lines.length === 0) return null;

	let filePath = '';
	let magnet = '';
	let key = '';
	let alt = '';

	for (const line of lines) {
		const pathMatch = /^path:\s*(.+)$/i.exec(line);
		if (pathMatch?.[1]) {
			filePath = pathMatch[1].trim();
			continue;
		}

		const magnetMatch = /^magnet:\s*(magnet:\?.+)$/i.exec(line);
		if (magnetMatch?.[1]) {
			magnet = magnetMatch[1].trim();
			continue;
		}

		const keyMatch = /^key:\s*(.+)$/i.exec(line);
		if (keyMatch?.[1]) {
			key = keyMatch[1].trim();
			continue;
		}

		const altMatch = /^alt:\s*(.*)$/i.exec(line);
		if (altMatch) {
			alt = (altMatch[1] ?? '').trim();
			continue;
		}

		// Bare magnet fallback.
		if (!magnet && line.toLowerCase().startsWith('magnet:?')) {
			magnet = line;
		}
	}

	if (!magnet || !key) return null;
	return { path: filePath, magnet, key, alt };
}

export function collectImageFiles(dataTransfer: DataTransfer | null): File[] {
	if (!dataTransfer) return [];

	const images: File[] = [];
	const seen = new Set<File>();

	const add = (file: File | null) => {
		if (!file || !file.type.startsWith('image/') || seen.has(file)) return;
		seen.add(file);
		images.push(file);
	};

	if (dataTransfer.files?.length) {
		for (const file of Array.from(dataTransfer.files)) {
			add(file);
		}
	}

	if (images.length === 0 && dataTransfer.items?.length) {
		for (const item of Array.from(dataTransfer.items)) {
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				add(item.getAsFile());
			}
		}
	}

	return images;
}
