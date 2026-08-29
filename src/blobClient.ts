/**
 * BlobHttpClient — lightweight HTTP client for YAOS R2 blob storage.
 *
 * Handles upload/download of binary attachments via the YAOS Cloudflare Worker,
 * which proxies to native R2 bindings.
 *
 * Endpoints:
 *   PUT  /vault/{vaultId}/blobs/{hash}  — upload blob bytes
 *   GET  /vault/{vaultId}/blobs/{hash}  — download blob bytes
 *   POST /vault/{vaultId}/blobs/exists  — batch existence check
 */

import { createLogger } from "./logger.js";

const log = createLogger("blob");

/** Timeout for upload/download requests. */
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
/** Timeout for exists check. */
const EXISTS_TIMEOUT_MS = 30_000;

export class BlobHttpClient {
	private readonly baseUrl: string;
	private readonly token: string;

	constructor(host: string, vaultId: string, token: string) {
		this.baseUrl = `https://${host}/vault/${encodeURIComponent(vaultId)}/blobs`;
		this.token = token;
	}

	/**
	 * Upload blob bytes to R2.
	 * Content-addressed: the hash IS the key.
	 */
	async upload(hash: string, contentType: string, data: Buffer): Promise<void> {
		const url = `${this.baseUrl}/${hash}`;
		const res = await fetchWithTimeout(url, {
			method: "PUT",
			headers: {
				"Authorization": `Bearer ${this.token}`,
				"Content-Type": contentType,
			},
			body: new Uint8Array(data),
		}, DEFAULT_TIMEOUT_MS);

		if (!res.ok && res.status !== 204) {
			const text = await res.text().catch(() => "");
			throw new Error(`Blob upload failed (${res.status}): ${text}`);
		}
		log.debug(`Uploaded blob ${hash.slice(0, 12)}… (${data.length} bytes)`);
	}

	/**
	 * Download blob bytes from R2.
	 * Returns the raw file content as a Buffer.
	 */
	async download(hash: string): Promise<Buffer> {
		const url = `${this.baseUrl}/${hash}`;
		const res = await fetchWithTimeout(url, {
			method: "GET",
			headers: {
				"Authorization": `Bearer ${this.token}`,
			},
		}, DEFAULT_TIMEOUT_MS);

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Blob download failed (${res.status}): ${text}`);
		}
		const arrayBuffer = await res.arrayBuffer();
		log.debug(`Downloaded blob ${hash.slice(0, 12)}… (${arrayBuffer.byteLength} bytes)`);
		return Buffer.from(arrayBuffer);
	}

	/**
	 * Batch existence check — which hashes already exist in R2?
	 * Returns the subset of provided hashes that are already stored.
	 */
	async exists(hashes: string[]): Promise<string[]> {
		if (hashes.length === 0) return [];

		const url = `${this.baseUrl}/exists`;
		const res = await fetchWithTimeout(url, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ hashes }),
		}, EXISTS_TIMEOUT_MS);

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Blob exists check failed (${res.status}): ${text}`);
		}
		const result = await res.json() as { present: string[] };
		return result.present;
	}
}

/**
 * fetch() with an AbortController timeout.
 */
async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}
