/**
 * HeadlessSync — the core sync engine.
 *
 * Manages a Y.Doc with the same map schema as the YAOS Obsidian plugin,
 * connects to the YAOS Cloudflare Worker via WebSocket (y-partyserver/provider),
 * and coordinates with DiskMirror for file materialization.
 */

import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SyncConfig } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("sync");

// ─── WebSocket polyfill for Node.js ───────────────────────────────────────────
// y-partyserver/provider expects a browser-compatible WebSocket.
// We assign `ws` to globalThis so the provider can use it.
if (typeof globalThis.WebSocket === "undefined") {
	// @ts-expect-error — ws is API-compatible with browser WebSocket for our usage
	globalThis.WebSocket = WebSocket;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 3;
const PROVIDER_SYNC_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_TIME_MS = 30_000;
const STATE_FILE_NAME = ".yaos-state";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SyncStatus = "connecting" | "synced" | "offline" | "error" | "stopped";

export interface HeadlessSyncEvents {
	status: [status: SyncStatus];
	synced: [];
	error: [error: Error];
}

// ─── HeadlessSync class ───────────────────────────────────────────────────────

export class HeadlessSync extends EventEmitter {
	readonly ydoc: Y.Doc;
	readonly provider: YSyncProvider;

	// CRDT maps — same schema as YAOS plugin
	readonly pathToId: Y.Map<string>;
	readonly idToText: Y.Map<Y.Text>;
	readonly meta: Y.Map<unknown>;
	readonly sys: Y.Map<unknown>;
	readonly pathToBlob: Y.Map<unknown>;
	readonly blobMeta: Y.Map<unknown>;
	readonly blobTombstones: Y.Map<unknown>;

	private _status: SyncStatus = "connecting";
	private _fatalAuthError = false;
	private _fatalAuthCode: string | null = null;
	private _syncedResolvers: Array<(value: boolean) => void> = [];
	private readonly _config: SyncConfig;
	private readonly _stateFilePath: string;

	constructor(config: SyncConfig) {
		super();
		this._config = config;
		this._stateFilePath = join(config.syncDir, STATE_FILE_NAME);

		// Create Y.Doc and maps
		this.ydoc = new Y.Doc();
		this.pathToId = this.ydoc.getMap<string>("pathToId");
		this.idToText = this.ydoc.getMap<Y.Text>("idToText");
		this.meta = this.ydoc.getMap("meta");
		this.sys = this.ydoc.getMap("sys");
		this.pathToBlob = this.ydoc.getMap("pathToBlob");
		this.blobMeta = this.ydoc.getMap("blobMeta");
		this.blobTombstones = this.ydoc.getMap("blobTombstones");

		// Load persisted Y.Doc state if available
		this.loadPersistedState();

		// Set up WebSocket sync provider
		const roomId = config.vaultId;
		const syncPrefix = `/vault/sync/${encodeURIComponent(roomId)}`;

		log.info(`Connecting to ${config.host} room=${roomId}`);

		this.provider = new YSyncProvider(config.host, roomId, this.ydoc, {
			prefix: syncPrefix,
			params: async () => ({
				schemaVersion: String(SCHEMA_VERSION),
				token: config.token,
				device: config.deviceName,
			}),
			connect: false,
			maxBackoffTime: MAX_BACKOFF_TIME_MS,
		});

		// Wire up provider events
		this.provider.on("status", (event: { status: string }) => {
			log.debug(`Provider status: ${event.status}`);
			if (event.status === "connected") {
				this.setStatus("connecting");
			} else if (event.status === "disconnected") {
				if (!this._fatalAuthError) {
					this.setStatus("offline");
				}
			}
		});

		this.provider.on("sync", (synced: boolean) => {
			if (synced) {
				log.info("Provider synced — room state received");
				this.setStatus("synced");
				this.emit("synced");
				// Resolve any pending sync waiters
				for (const resolve of this._syncedResolvers) {
					resolve(true);
				}
				this._syncedResolvers = [];
			}
		});

		// Handle fatal auth errors from server
		this.provider.on("custom-message", (payload: string) => {
			this.handleCustomMessage(payload);
		});

		// Persist state on Y.Doc updates (debounced via update events)
		let persistTimer: ReturnType<typeof setTimeout> | null = null;
		this.ydoc.on("update", () => {
			if (persistTimer) clearTimeout(persistTimer);
			persistTimer = setTimeout(() => {
				this.persistState();
			}, 5_000);
		});
	}

	get status(): SyncStatus {
		return this._status;
	}

	get connected(): boolean {
		return this.provider.wsconnected;
	}

	get fatalAuthError(): boolean {
		return this._fatalAuthError;
	}

	get fatalAuthCode(): string | null {
		return this._fatalAuthCode;
	}

	/** Start connecting to the server. */
	async connect(): Promise<void> {
		log.info("Starting sync connection...");
		this.setStatus("connecting");
		await this.provider.connect();
	}

	/** Wait for initial sync to complete (or timeout). */
	waitForSync(): Promise<boolean> {
		if (this._status === "synced") return Promise.resolve(true);
		if (this._fatalAuthError) return Promise.resolve(false);

		return new Promise<boolean>((resolve) => {
			const timeout = setTimeout(() => {
				log.warn("Sync timeout — entering offline mode");
				this._syncedResolvers = this._syncedResolvers.filter(r => r !== resolve);
				resolve(false);
			}, PROVIDER_SYNC_TIMEOUT_MS);

			const wrappedResolve = (value: boolean) => {
				clearTimeout(timeout);
				resolve(value);
			};
			this._syncedResolvers.push(wrappedResolve);
		});
	}

	/** Graceful shutdown. */
	async destroy(): Promise<void> {
		log.info("Shutting down sync...");
		this.setStatus("stopped");
		this.persistState();
		this.provider.disconnect();
		this.provider.destroy();
		this.ydoc.destroy();
	}

	// ─── Private ──────────────────────────────────────────────────────────────

	private setStatus(status: SyncStatus): void {
		if (this._status !== status) {
			this._status = status;
			this.emit("status", status);
		}
	}

	private handleCustomMessage(payload: string): void {
		// y-partyserver sends "__YPS:" prefixed control messages
		const raw = payload.startsWith("__YPS:") ? payload.slice(6) : payload;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return; // not JSON
		}

		if (parsed.type !== "error") return;

		const code = parsed.code as string;
		const fatalCodes = new Set(["unauthorized", "server_misconfigured", "unclaimed", "update_required"]);
		if (fatalCodes.has(code)) {
			this._fatalAuthError = true;
			this._fatalAuthCode = code;
			log.error(`Fatal auth error: ${code}`, parsed.reason || "");
			this.setStatus("error");
			this.provider.disconnect();
			this.emit("error", new Error(`YAOS auth error: ${code}`));
			// Resolve pending sync waiters
			for (const resolve of this._syncedResolvers) {
				resolve(false);
			}
			this._syncedResolvers = [];
		}
	}

	// ─── State persistence (file-based replacement for IndexedDB) ─────────

	private loadPersistedState(): void {
		try {
			if (existsSync(this._stateFilePath)) {
				const data = readFileSync(this._stateFilePath);
				Y.applyUpdate(this.ydoc, new Uint8Array(data));
				log.info("Loaded persisted Y.Doc state from disk");
			}
		} catch (err) {
			log.warn("Failed to load persisted state:", err);
		}
	}

	private persistState(): void {
		try {
			const dir = this._config.syncDir;
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			const state = Y.encodeStateAsUpdate(this.ydoc);
			writeFileSync(this._stateFilePath, Buffer.from(state));
			log.debug("Persisted Y.Doc state to disk");
		} catch (err) {
			log.warn("Failed to persist state:", err);
		}
	}
}
