/**
 * Utility helpers: hashing, debounce, random IDs, MIME detection.
 */

import { createHash } from "node:crypto";

/** SHA-256 hex digest of a string. */
export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** SHA-256 hex digest of binary data (Buffer). */
export function sha256HexBuffer(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Generate a short random ID. */
export function randomId(length = 8): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";
	const bytes = new Uint8Array(length);
	globalThis.crypto.getRandomValues(bytes);
	for (let i = 0; i < length; i++) {
		result += chars[bytes[i]! % chars.length];
	}
	return result;
}

/** Simple debounce returning a disposable timer. */
export function debounce<T extends (...args: never[]) => void>(
	fn: T,
	delayMs: number,
): (...args: Parameters<T>) => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return (...args: Parameters<T>) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn(...args);
		}, delayMs);
	};
}

/** Normalize a vault-relative path (forward slashes, no leading slash). */
export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Check if a vault-relative path is a Markdown file. */
export function isMdFile(vaultPath: string): boolean {
	return vaultPath.toLowerCase().endsWith(".md");
}

/**
 * Guess MIME type from file extension.
 * Covers common attachment types in Obsidian vaults.
 */
export function guessMime(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const mimes: Record<string, string> = {
		// Images
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		svg: "image/svg+xml",
		webp: "image/webp",
		bmp: "image/bmp",
		ico: "image/x-icon",
		avif: "image/avif",
		// Documents
		pdf: "application/pdf",
		// Audio
		mp3: "audio/mpeg",
		wav: "audio/wav",
		ogg: "audio/ogg",
		flac: "audio/flac",
		m4a: "audio/mp4",
		// Video
		mp4: "video/mp4",
		webm: "video/webm",
		mov: "video/quicktime",
		mkv: "video/x-matroska",
		// Archives
		zip: "application/zip",
		// Data
		json: "application/json",
		csv: "text/csv",
		txt: "text/plain",
		// Obsidian special
		canvas: "application/json",
		excalidraw: "application/json",
	};
	return mimes[ext] ?? "application/octet-stream";
}

