const MAGIC = new TextEncoder().encode('OBIMGv1');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
/** Lower than password KDF rates: keys are high-entropy random values, not human passphrases. */
const PBKDF2_ITERATIONS = 10_000;

export class CryptoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CryptoError';
	}
}

/** 256-bit random key, encoded as URL-safe base64 for the markdown code block. */
export function generateImageKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] ?? 0);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function concatBytes(...parts: Uint8Array[]): ArrayBuffer {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out.buffer;
}

async function deriveKey(
	passphrase: string,
	salt: Uint8Array,
): Promise<CryptoKey> {
	const saltCopy = salt.slice();
	const baseKey = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(passphrase),
		'PBKDF2',
		false,
		['deriveKey'],
	);

	return crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: saltCopy,
			iterations: PBKDF2_ITERATIONS,
			hash: 'SHA-256',
		},
		baseKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

/**
 * Encrypted container layout:
 * magic (7) | salt (16) | iv (12) | mimeLen u16be (2) | mime | ciphertext+tag
 */
export async function encryptImage(
	plaintext: ArrayBuffer,
	mimeType: string,
	passphrase: string,
): Promise<ArrayBuffer> {
	if (!passphrase) {
		throw new CryptoError('Encryption passphrase is not set.');
	}

	const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const key = await deriveKey(passphrase, salt);
	const mimeBytes = new TextEncoder().encode(mimeType || 'image/png');
	if (mimeBytes.length > 0xffff) {
		throw new CryptoError('MIME type is too long.');
	}

	const mimeLen = new Uint8Array(2);
	mimeLen[0] = (mimeBytes.length >> 8) & 0xff;
	mimeLen[1] = mimeBytes.length & 0xff;

	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
	);

	return concatBytes(MAGIC, salt, iv, mimeLen, mimeBytes, ciphertext);
}

export interface DecryptedImage {
	data: ArrayBuffer;
	mimeType: string;
}

export async function decryptImage(
	container: ArrayBuffer,
	passphrase: string,
): Promise<DecryptedImage> {
	if (!passphrase) {
		throw new CryptoError('Encryption passphrase is not set.');
	}

	const bytes = new Uint8Array(container);
	const headerLength = MAGIC.length + SALT_LENGTH + IV_LENGTH + 2;
	if (bytes.length < headerLength) {
		throw new CryptoError('Encrypted file is truncated or invalid.');
	}

	for (let i = 0; i < MAGIC.length; i++) {
		if (bytes[i] !== MAGIC[i]) {
			throw new CryptoError('Not a valid encrypted image file.');
		}
	}

	let offset = MAGIC.length;
	const salt = bytes.slice(offset, offset + SALT_LENGTH);
	offset += SALT_LENGTH;
	const iv = bytes.slice(offset, offset + IV_LENGTH);
	offset += IV_LENGTH;

	const mimeLen = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
	offset += 2;

	if (bytes.length < offset + mimeLen + 1) {
		throw new CryptoError('Encrypted file header is corrupt.');
	}

	const mimeType = new TextDecoder().decode(
		bytes.slice(offset, offset + mimeLen),
	);
	offset += mimeLen;

	const ciphertext = bytes.slice(offset);
	const key = await deriveKey(passphrase, salt);

	try {
		const data = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			key,
			ciphertext,
		);
		return { data, mimeType: mimeType || 'image/png' };
	} catch {
		throw new CryptoError(
			'Decryption failed. Check your passphrase or the file may be damaged.',
		);
	}
}
