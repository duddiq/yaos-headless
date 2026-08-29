/**
 * Configuration loading and validation.
 */

import { config as loadDotenv } from "dotenv";
import type { LogLevel } from "./logger.js";

export interface SyncConfig {
	/** YAOS server hostname (e.g. yaos.my-account.workers.dev) */
	host: string;
	/** Vault ID (set during claim) */
	vaultId: string;
	/** Auth token */
	token: string;
	/** Local directory for synced files */
	syncDir: string;
	/** Device name reported in CRDT metadata */
	deviceName: string;
	/** Log level */
	logLevel: LogLevel;
	/** CRDT schema version (must match server) */
	schemaVersion: number;
	/** Whether to sync attachments (blobs) via R2 */
	blobSync: boolean;
	/** Max attachment size in bytes */
	maxAttachmentSizeBytes: number;
}

export function loadConfig(): SyncConfig {
	loadDotenv();

	const host = requireEnv("YAOS_HOST");
	const vaultId = requireEnv("YAOS_VAULT_ID");
	const token = requireEnv("YAOS_TOKEN");
	const syncDir = process.env.YAOS_SYNC_DIR || "./vault";
	const deviceName = process.env.YAOS_DEVICE_NAME || "headless-server";
	const logLevel = (process.env.YAOS_LOG_LEVEL || "info") as LogLevel;
	const schemaVersion = 3; // current YAOS schema version

	// Blob sync config
	const blobSyncStr = (process.env.YAOS_BLOB_SYNC ?? "true").toLowerCase();
	const blobSync = blobSyncStr !== "false" && blobSyncStr !== "0";
	const maxAttachmentSizeKB = parseInt(process.env.YAOS_MAX_ATTACHMENT_SIZE_KB || "102400", 10);
	const maxAttachmentSizeBytes = maxAttachmentSizeKB * 1024;

	// Validate host: strip protocol if provided
	let cleanHost = host.trim();
	if (cleanHost.startsWith("https://")) cleanHost = cleanHost.slice(8);
	if (cleanHost.startsWith("http://")) cleanHost = cleanHost.slice(7);
	if (cleanHost.endsWith("/")) cleanHost = cleanHost.slice(0, -1);

	return {
		host: cleanHost,
		vaultId,
		token,
		syncDir,
		deviceName,
		logLevel,
		schemaVersion,
		blobSync,
		maxAttachmentSizeBytes,
	};
}

function requireEnv(key: string): string {
	const value = process.env[key];
	if (!value || value.trim() === "") {
		throw new Error(
			`Missing required environment variable: ${key}\n` +
			`Copy .env.example to .env and fill in the values.`
		);
	}
	return value.trim();
}

