/**
 * DiskMirror — bidirectional synchronization between CRDT and local filesystem.
 *
 * CRDT → Disk: Observes Y.Doc changes and materializes .md files and blob attachments.
 * Disk → CRDT: Watches filesystem via chokidar and propagates changes back.
 *
 * Markdown files use Y.Text with incremental diffs.
 * Blob attachments are content-addressed via SHA-256 and stored in R2.
 *
 * Write-suppression prevents echo loops: when DiskMirror writes a file to disk,
 * it records the expected content hash. When chokidar reports that same file
 * changed, DiskMirror checks if the content matches and suppresses the event.
 */

import * as Y from "yjs";
import { watch, type FSWatcher } from "chokidar";
import {
	readFileSync,
	writeFileSync,
	unlinkSync,
	existsSync,
	mkdirSync,
	readdirSync,
} from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { diff_match_patch as DiffMatchPatch } from "diff-match-patch";
import { createLogger } from "./logger.js";
import type { HeadlessSync } from "./headlessSync.js";
import type { SyncConfig } from "./config.js";
import {
	decodeFileMeta,
	isFileMetaDeleted,
	isNestedFileMeta,
	createNestedActiveMeta,
	markMetaAsDeleted,
	reviveMeta,
} from "./fileMeta.js";
import { sha256Hex, sha256HexBuffer, randomId, normalizePath, isMdFile, guessMime, isConflictArtifactPath } from "./utils.js";
import { BlobHttpClient } from "./blobClient.js";

const log = createLogger("disk");

/** Origin marker so we can distinguish our own transactions from remote ones. */
const ORIGIN_LOCAL_DISK = "yaos-headless-disk";

/** Debounce delay for file-change batching (ms). */
const CHANGE_DEBOUNCE_MS = 300;

/** Grace period after our own write, during which we suppress chokidar events (ms). */
const WRITE_SUPPRESSION_WINDOW_MS = 2_000;

// ─── BlobRef type (matches YAOS plugin schema) ───────────────────────────────

interface BlobRef {
	/** SHA-256 hex hash of the file content. */
	hash: string;
	/** File size in bytes. */
	size?: number;
	/** Modification time (ms since epoch). */
	mtime?: number;
}

// ─── DiskMirror ───────────────────────────────────────────────────────────────

export class DiskMirror {
	private readonly sync: HeadlessSync;
	private readonly syncDir: string;
	private readonly deviceName: string;
	private readonly config: SyncConfig;
	private readonly blobClient: BlobHttpClient | null;
	private watcher: FSWatcher | null = null;

	/**
	 * Write-suppression table.
	 * Maps vault-relative path → { hash, timestamp } of our last write.
	 * If chokidar reports a change and the content hash matches, we suppress it.
	 */
	private readonly pendingWrites = new Map<string, { hash: string; at: number }>();

	/**
	 * Tracks paths currently being processed from CRDT → disk to avoid re-entry.
	 */
	private readonly materializing = new Set<string>();

	/**
	 * Pending disk changes debounced for batch processing.
	 */
	private readonly pendingDiskChanges = new Map<string, "change" | "unlink">();
	private diskChangeTimer: ReturnType<typeof setTimeout> | null = null;

	/** DiffMatchPatch instance for incremental text updates. */
	private readonly dmp = new DiffMatchPatch();

	constructor(sync: HeadlessSync, config: SyncConfig) {
		this.sync = sync;
		this.syncDir = config.syncDir;
		this.deviceName = config.deviceName;
		this.config = config;
		this.blobClient = config.blobSync
			? new BlobHttpClient(config.host, config.vaultId, config.token)
			: null;
	}

	/** Start observing both CRDT and filesystem. */
	start(): void {
		log.info(`Starting DiskMirror on ${this.syncDir}`);

		// Ensure sync directory exists
		if (!existsSync(this.syncDir)) {
			mkdirSync(this.syncDir, { recursive: true });
			log.info(`Created sync directory: ${this.syncDir}`);
		}

		// 1. Initial materialization: write current CRDT state to disk
		this.fullMaterialize();

		// 2. Observe CRDT changes for ongoing sync (remote → disk)
		this.observeCrdtChanges();

		// 3. Watch filesystem for local changes (disk → CRDT)
		this.startFileWatcher();
	}

	// ─── Conflict-artifact helpers (used by Hermes / daily scan) ──────────────

	/**
	 * List conflict artifacts currently present on disk (local safety copies that
	 * YAOS wrote during reconciliation). They ARE visible to Hermes here, but are
	 * distinct from the canonical document by filename.
	 */
	listConflictArtifacts(): string[] {
		const artifacts: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name.startsWith(".")) continue; // dotfiles / config
					walk(full);
				} else if (isConflictArtifactPath(relative(this.syncDir, full))) {
					artifacts.push(normalizePath(relative(this.syncDir, full)));
				}
			}
		};
		if (existsSync(this.syncDir)) walk(this.syncDir);
		return artifacts.sort();
	}

	/**
	 * Resolve a conflict artifact.
	 *
	 * This is the CRDT-aware deletion Hermes should use instead of a bare `rm`:
	 * it tombstones the document in the CRDT so the deletion propagates to every
	 * device, removing the copy from the shared state so it cannot re-materialize.
	 *
	 * @param artifactPath  vault-relative path of the conflict artifact
	 * @param decision      what to do with the canonical (original) document:
	 *    - "keep-original":  keep original, delete only the artifact (default)
	 *    - "keep-conflict":  overwrite original with the artifact's content, then delete artifact
	 */
	resolveConflictArtifact(artifactPath: string, decision: "keep-original" | "keep-conflict" = "keep-original"): void {
		const diskPath = join(this.syncDir, artifactPath);
		if (!existsSync(diskPath)) {
			log.warn(`Conflict artifact not found on disk: ${artifactPath}`);
			return;
		}

		// Derive canonical path: strip " (YAOS conflict ...) from <device> <stamp>).md"
		const canonical = artifactPath
			.replace(/\s*\(YAOS conflict(?: - (?:crdt|disk|editor))? from .+ \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\)(?: \d+)?\.md$/u, ".md");

		if (decision === "keep-conflict" && canonical !== artifactPath) {
			const canonicalDisk = join(this.syncDir, canonical);
			try {
				const conflictContent = readFileSync(diskPath, "utf8");
				if (existsSync(canonicalDisk)) {
					writeFileSync(canonicalDisk, conflictContent);
				} else {
					const dir = dirname(canonicalDisk);
					if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
					writeFileSync(canonicalDisk, conflictContent);
				}
				log.info(`→ Overwrote canonical ${canonical} with conflict content`);
			} catch (err) {
				log.error(`Failed to keep-conflict for ${artifactPath}:`, err);
				return;
			}
		}

		// Tombstone in CRDT (if it has an entry) — propagates deletion to all devices.
		this.sync.ydoc.transact(() => {
			this.tombstonePath(artifactPath, "keep-original");
			if (canonical !== artifactPath) {
				// If we resolved toward the conflict, make sure the canonical is imported fresh.
				if (decision === "keep-conflict") this.importFileIntoCrdt(canonical);
			}
		}, "resolve-conflict");

		// Remove local copy so it disappears from disk too.
		try {
			unlinkSync(diskPath);
			log.info(`✓ Resolved conflict artifact: ${artifactPath} (${decision})`);
		} catch (err) {
			log.error(`Failed to unlink ${artifactPath}:`, err);
		}

		// Verify the canonical file still materializes.
		if (decision === "keep-conflict" && canonical !== artifactPath) {
			this.importFileIntoCrdt(canonical);
		}
	}

	/** Tombstone a path in CRDT if it exists (marks its meta as deleted). */
	private tombstonePath(vaultPath: string, origin: string): void {
		const fileId = this.findFileIdByPath(vaultPath);
		if (!fileId) {
			log.debug(`No CRDT entry for ${vaultPath} — nothing to tombstone`);
			return;
		}
		const rawMeta = this.sync.meta.get(fileId);
		if (!rawMeta) return;
		if (isNestedFileMeta(rawMeta)) {
			const decoded = decodeFileMeta(rawMeta);
			if (decoded && !isFileMetaDeleted(decoded)) {
				markMetaAsDeleted(rawMeta, Date.now(), this.deviceName);
				log.info(`→ Tombstoned: ${vaultPath}`);
			}
		} else {
			const tombstone = new Y.Map<unknown>();
			tombstone.set("path", vaultPath);
			tombstone.set("deleted", true);
			tombstone.set("deletedAt", Date.now());
			if (this.deviceName) tombstone.set("device", this.deviceName);
			this.sync.meta.set(fileId, tombstone);
			log.info(`→ Tombstoned (v2→v3): ${vaultPath}`);
		}
	}

	/** Stop all observers and watchers. */
	async stop(): Promise<void> {
		log.info("Stopping DiskMirror");
		if (this.watcher) {
			await this.watcher.close();
			this.watcher = null;
		}
		if (this.diskChangeTimer) {
			clearTimeout(this.diskChangeTimer);
			this.diskChangeTimer = null;
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// CRDT → Disk  (Markdown)
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Full materialization: iterate all CRDT entries and sync to disk.
	 * Called once at startup.
	 */
	private fullMaterialize(): void {
		log.info("Running full materialization...");
		let created = 0;
		let updated = 0;
		let deleted = 0;

		const { meta, idToText } = this.sync;

		meta.forEach((rawMeta, fileId) => {
			const decoded = decodeFileMeta(rawMeta);
			if (!decoded) return;

			const vaultPath = decoded.path;
			const diskPath = join(this.syncDir, vaultPath);

			if (isFileMetaDeleted(decoded)) {
				// Tombstoned — remove from disk if exists
				if (existsSync(diskPath)) {
					try {
						unlinkSync(diskPath);
						deleted++;
						log.debug(`Deleted: ${vaultPath}`);
					} catch (err) {
						log.warn(`Failed to delete ${vaultPath}:`, err);
					}
				}
				return;
			}

			// Active file — materialize
			const ytext = idToText.get(fileId);
			if (!ytext) return;

			const content = ytext.toString();
			const dir = dirname(diskPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}

			// Check if file already exists with same content
			if (existsSync(diskPath)) {
				try {
					const existing = readFileSync(diskPath, "utf8");
					if (existing === content) return; // no change needed
					updated++;
				} catch {
					updated++;
				}
			} else {
				created++;
			}

			this.writeToDisk(vaultPath, content);
		});

		log.info(
			`Materialization complete: ${created} created, ${updated} updated, ${deleted} deleted ` +
			`(${meta.size} entries total)`
		);

		// Also materialize blobs
		if (this.blobClient) {
			void this.fullMaterializeBlobs();
		}
	}

	/**
	 * Observe CRDT changes in real-time.
	 * Watches meta map (observeDeep) for path/deletion changes,
	 * and idToText (observe) for content changes.
	 */
	private observeCrdtChanges(): void {
		const { meta, idToText } = this.sync;

		// Watch metadata changes (renames, deletions, new files)
		meta.observeDeep((events) => {
			const origin = events[0]?.transaction.origin;
			// Skip our own local-disk transactions
			if (origin === ORIGIN_LOCAL_DISK) return;

			// Collect affected file IDs and any old paths from rename events
			const affected = new Map<string, string | undefined>(); // fileId → oldPath
			for (const event of events) {
				if (event.target === meta) {
					// Top-level: new/deleted entries
					const ymapEvent = event as Y.YMapEvent<unknown>;
					for (const [key] of ymapEvent.changes.keys) {
						if (!affected.has(key)) affected.set(key, undefined);
					}
				} else if (event.target instanceof Y.Map && event.target.parent === meta) {
					// Nested field change (e.g. path renamed, deleted flag set)
					const nestedMap = event.target as Y.Map<unknown>;
					const ymapEvent = event as Y.YMapEvent<unknown>;

					// Find the fileId key for this nested map
					let fileId: string | undefined;
					meta.forEach((val, key) => {
						if (val === nestedMap) fileId = key;
					});
					if (!fileId) continue;

					// Check if the "path" field changed — this means a rename
					const pathChange = ymapEvent.changes.keys.get("path");
					if (pathChange && pathChange.action === "update") {
						// oldValue holds the previous path string
						const oldPath = pathChange.oldValue as string | undefined;
						if (oldPath && typeof oldPath === "string") {
							affected.set(fileId, oldPath);
						} else if (!affected.has(fileId)) {
							affected.set(fileId, undefined);
						}
					} else if (!affected.has(fileId)) {
						affected.set(fileId, undefined);
					}
				}
			}

			for (const [fileId, oldPath] of affected) {
				this.materializeEntry(fileId, oldPath);
			}
		});

		// Watch content changes
		idToText.observe((event) => {
			const origin = event.transaction.origin;
			if (origin === ORIGIN_LOCAL_DISK) return;

			for (const [fileId, change] of event.changes.keys) {
				if (change.action === "add" || change.action === "update") {
					this.materializeEntry(fileId);
				}
			}
		});

		// Also observe individual Y.Text changes for existing texts
		idToText.forEach((_ytext, fileId) => {
			this.observeText(fileId);
		});

		// Watch for new text entries
		idToText.observe((event) => {
			for (const [fileId, change] of event.changes.keys) {
				if (change.action === "add") {
					this.observeText(fileId);
				}
			}
		});

		// ── Blob observers ────────────────────────────────────────────────
		if (this.blobClient) {
			this.observeBlobCrdtChanges();
		}
	}

	/** Attach an observer to a specific Y.Text for content changes. */
	private readonly observedTexts = new Set<string>();

	private observeText(fileId: string): void {
		if (this.observedTexts.has(fileId)) return;
		this.observedTexts.add(fileId);

		const ytext = this.sync.idToText.get(fileId);
		if (!ytext) return;

		ytext.observe((event) => {
			const origin = event.transaction.origin;
			if (origin === ORIGIN_LOCAL_DISK) return;
			this.materializeEntry(fileId);
		});
	}

	/**
	 * Materialize a single file entry to disk.
	 * @param oldPath — if a rename was detected, the previous vault-relative path
	 *                  so we can clean up the stale file from disk.
	 */
	private materializeEntry(fileId: string, oldPath?: string): void {
		const { meta, idToText } = this.sync;

		const rawMeta = meta.get(fileId);
		if (!rawMeta) return;

		const decoded = decodeFileMeta(rawMeta);
		if (!decoded) return;

		const vaultPath = decoded.path;

		// Guard against re-entry
		if (this.materializing.has(vaultPath)) return;
		this.materializing.add(vaultPath);

		try {
			const diskPath = join(this.syncDir, vaultPath);

			// ── Handle rename: delete the old file from disk ──────────────
			if (oldPath && oldPath !== vaultPath) {
				const oldDiskPath = join(this.syncDir, oldPath);
				if (existsSync(oldDiskPath)) {
					try {
						unlinkSync(oldDiskPath);
						this.recordWrite(oldPath, ""); // suppress chokidar unlink echo
						log.info(`← Renamed: ${oldPath} → ${vaultPath}`);
					} catch (err) {
						log.warn(`Failed to delete old path ${oldPath} during rename:`, err);
					}
				}
			}

			if (isFileMetaDeleted(decoded)) {
				// Tombstoned — remove from disk
				if (existsSync(diskPath)) {
					try {
						unlinkSync(diskPath);
						this.recordWrite(vaultPath, ""); // suppress chokidar unlink
						log.info(`← Deleted: ${vaultPath}`);
					} catch (err) {
						log.warn(`Failed to delete ${vaultPath}:`, err);
					}
				}
				return;
			}

			// Active — write content
			const ytext = idToText.get(fileId);
			if (!ytext) return;

			const content = ytext.toString();

			// Check if content is already up to date
			if (existsSync(diskPath)) {
				try {
					const existing = readFileSync(diskPath, "utf8");
					if (existing === content) return; // no change
				} catch { /* read failed, write anyway */ }
			}

			this.writeToDisk(vaultPath, content);
			log.info(`← Synced: ${vaultPath} (${content.length} chars)`);
		} finally {
			this.materializing.delete(vaultPath);
		}
	}

	/** Write content to disk and record the write for suppression. */
	private writeToDisk(vaultPath: string, content: string): void {
		const diskPath = join(this.syncDir, vaultPath);
		const dir = dirname(diskPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(diskPath, content, "utf8");
		this.recordWrite(vaultPath, content);
	}

	/** Write binary content to disk and record for suppression. */
	private writeBinaryToDisk(vaultPath: string, data: Buffer): void {
		const diskPath = join(this.syncDir, vaultPath);
		const dir = dirname(diskPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(diskPath, data);
		this.recordBinaryWrite(vaultPath, data);
	}

	/** Record a text write for echo-suppression. */
	private recordWrite(vaultPath: string, content: string): void {
		this.pendingWrites.set(vaultPath, {
			hash: sha256Hex(content),
			at: Date.now(),
		});
	}

	/** Record a binary write for echo-suppression. */
	private recordBinaryWrite(vaultPath: string, data: Buffer): void {
		this.pendingWrites.set(vaultPath, {
			hash: sha256HexBuffer(data),
			at: Date.now(),
		});
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// CRDT → Disk  (Blobs / Attachments)
	// ═══════════════════════════════════════════════════════════════════════════

	/**
	 * Full blob materialization: iterate all pathToBlob entries and download
	 * missing attachments from R2.
	 */
	private async fullMaterializeBlobs(): Promise<void> {
		const { pathToBlob, blobTombstones } = this.sync;
		if (!this.blobClient) return;

		let downloaded = 0;
		let skipped = 0;
		let tombstoned = 0;
		const total = pathToBlob.size;

		if (total === 0) {
			log.info("No blob entries in CRDT");
			return;
		}

		log.info(`Materializing blobs: ${total} entries...`);

		// First handle tombstones — delete files that should be gone
		blobTombstones.forEach((_val, vaultPath) => {
			const diskPath = join(this.syncDir, vaultPath);
			if (existsSync(diskPath)) {
				try {
					unlinkSync(diskPath);
					tombstoned++;
					log.debug(`Blob deleted: ${vaultPath}`);
				} catch (err) {
					log.warn(`Failed to delete blob ${vaultPath}:`, err);
				}
			}
		});

		// Then download active blobs
		for (const [vaultPath, rawRef] of pathToBlob.entries()) {
			// Skip if tombstoned
			if (blobTombstones.has(vaultPath)) continue;

			const ref = rawRef as BlobRef;
			if (!ref || !ref.hash) continue;

			const diskPath = join(this.syncDir, vaultPath);

			// Check if file already exists with correct hash
			if (existsSync(diskPath)) {
				try {
					const existingData = readFileSync(diskPath);
					const existingHash = sha256HexBuffer(existingData);
					if (existingHash === ref.hash) {
						skipped++;
						continue; // already up to date
					}
				} catch { /* read failed, download anyway */ }
			}

			// Download from R2
			try {
				const data = await this.blobClient.download(ref.hash);
				this.writeBinaryToDisk(vaultPath, data);
				downloaded++;
				log.info(`← Blob: ${vaultPath} (${data.length} bytes)`);
			} catch (err) {
				log.warn(`Failed to download blob ${vaultPath} (${ref.hash.slice(0, 12)}…):`, err);
			}
		}

		log.info(
			`Blob materialization complete: ${downloaded} downloaded, ${skipped} skipped, ` +
			`${tombstoned} deleted (${total} entries total)`
		);
	}

	/**
	 * Observe blob CRDT maps for real-time remote changes.
	 */
	private observeBlobCrdtChanges(): void {
		const { pathToBlob, blobTombstones } = this.sync;

		// Watch pathToBlob — new/updated blob refs → download
		pathToBlob.observe((event) => {
			const origin = event.transaction.origin;
			if (origin === ORIGIN_LOCAL_DISK) return;

			for (const [vaultPath, change] of event.changes.keys) {
				if (change.action === "add" || change.action === "update") {
					const ref = pathToBlob.get(vaultPath) as BlobRef | undefined;
					if (!ref || !ref.hash) continue;

					// Handle rename: if this was an "update" and path changed,
					// the old path is in the key itself (pathToBlob is keyed by path)
					// For pathToBlob, a rename means: old path deleted + new path added
					// (the plugin handles this as two operations)

					void this.materializeBlob(vaultPath, ref);
				} else if (change.action === "delete") {
					// Blob reference removed — delete from disk
					const diskPath = join(this.syncDir, vaultPath);
					if (existsSync(diskPath)) {
						try {
							unlinkSync(diskPath);
							this.recordWrite(vaultPath, ""); // suppress chokidar
							log.info(`← Blob deleted: ${vaultPath}`);
						} catch (err) {
							log.warn(`Failed to delete blob ${vaultPath}:`, err);
						}
					}
				}
			}
		});

		// Watch blobTombstones — remote tombstones → delete from disk
		blobTombstones.observe((event) => {
			const origin = event.transaction.origin;
			if (origin === ORIGIN_LOCAL_DISK) return;

			for (const [vaultPath, change] of event.changes.keys) {
				if (change.action === "add") {
					const diskPath = join(this.syncDir, vaultPath);
					if (existsSync(diskPath)) {
						try {
							unlinkSync(diskPath);
							this.recordWrite(vaultPath, ""); // suppress chokidar
							log.info(`← Blob tombstoned: ${vaultPath}`);
						} catch (err) {
							log.warn(`Failed to delete tombstoned blob ${vaultPath}:`, err);
						}
					}
				}
			}
		});
	}

	/**
	 * Download and materialize a single blob to disk.
	 */
	private async materializeBlob(vaultPath: string, ref: BlobRef): Promise<void> {
		if (!this.blobClient) return;

		// Guard against re-entry
		if (this.materializing.has(vaultPath)) return;
		this.materializing.add(vaultPath);

		try {
			const diskPath = join(this.syncDir, vaultPath);

			// Check if file already exists with correct hash
			if (existsSync(diskPath)) {
				try {
					const existingData = readFileSync(diskPath);
					const existingHash = sha256HexBuffer(existingData);
					if (existingHash === ref.hash) return; // already up to date
				} catch { /* read failed, download anyway */ }
			}

			// Download from R2
			const data = await this.blobClient.download(ref.hash);
			this.writeBinaryToDisk(vaultPath, data);
			log.info(`← Blob synced: ${vaultPath} (${data.length} bytes)`);
		} catch (err) {
			log.warn(`Failed to download blob ${vaultPath} (${ref.hash.slice(0, 12)}…):`, err);
		} finally {
			this.materializing.delete(vaultPath);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Disk → CRDT
	// ═══════════════════════════════════════════════════════════════════════════

	/** Start watching the sync directory for file changes. */
	private startFileWatcher(): void {
		this.watcher = watch(this.syncDir, {
			persistent: true,
			ignoreInitial: true,
			ignored: [
				/(^|[/\\])\../, // dotfiles
				/node_modules/,
			],
			awaitWriteFinish: {
				stabilityThreshold: 200,
				pollInterval: 100,
			},
		});

		this.watcher.on("add", (filePath) => this.onFileEvent(filePath, "change"));
		this.watcher.on("change", (filePath) => this.onFileEvent(filePath, "change"));
		this.watcher.on("unlink", (filePath) => this.onFileEvent(filePath, "unlink"));

		this.watcher.on("error", (err) => {
			log.error("File watcher error:", err);
		});

		this.watcher.on("ready", () => {
			log.info("File watcher ready");
		});
	}

	/** Handle a chokidar file event. Debounces into batches. */
	private onFileEvent(filePath: string, action: "change" | "unlink"): void {
		const ext = extname(filePath).toLowerCase();

		// Skip files with no extension
		if (!ext) return;

		// If blob sync is disabled, only handle .md
		if (!this.config.blobSync && ext !== ".md") return;

		const vaultPath = normalizePath(relative(this.syncDir, filePath));

		// Skip dotfiles and state file
		if (vaultPath.startsWith(".")) return;

		// Check write-suppression
		if (action === "change" && this.shouldSuppressChange(vaultPath, ext === ".md")) {
			log.debug(`Suppressed echo for: ${vaultPath}`);
			return;
		}

		// Debounce
		this.pendingDiskChanges.set(vaultPath, action);
		if (this.diskChangeTimer) clearTimeout(this.diskChangeTimer);
		this.diskChangeTimer = setTimeout(() => {
			this.flushDiskChanges();
		}, CHANGE_DEBOUNCE_MS);
	}

	/** Check if a change event should be suppressed (it's our own echo). */
	private shouldSuppressChange(vaultPath: string, isText: boolean): boolean {
		const pending = this.pendingWrites.get(vaultPath);
		if (!pending) return false;

		// Check if within suppression window
		if (Date.now() - pending.at > WRITE_SUPPRESSION_WINDOW_MS) {
			this.pendingWrites.delete(vaultPath);
			return false;
		}

		// Compare content hash
		const diskPath = join(this.syncDir, vaultPath);
		try {
			if (isText) {
				const content = readFileSync(diskPath, "utf8");
				const hash = sha256Hex(content);
				if (hash === pending.hash) {
					this.pendingWrites.delete(vaultPath);
					return true;
				}
			} else {
				const data = readFileSync(diskPath);
				const hash = sha256HexBuffer(data);
				if (hash === pending.hash) {
					this.pendingWrites.delete(vaultPath);
					return true;
				}
			}
		} catch {
			// File read failed — don't suppress
		}

		return false;
	}

	/** Flush pending disk changes into CRDT. */
	private flushDiskChanges(): void {
		const changes = new Map(this.pendingDiskChanges);
		this.pendingDiskChanges.clear();

		if (changes.size === 0) return;

		// Separate md and blob changes
		const mdChanges = new Map<string, "change" | "unlink">();
		const blobChanges = new Map<string, "change" | "unlink">();

		for (const [vaultPath, action] of changes) {
			if (isMdFile(vaultPath)) {
				mdChanges.set(vaultPath, action);
			} else {
				blobChanges.set(vaultPath, action);
			}
		}

		// Process md changes in a single CRDT transaction
		if (mdChanges.size > 0) {
			this.sync.ydoc.transact(() => {
				for (const [vaultPath, action] of mdChanges) {
					if (action === "change") {
						this.importFileIntoCrdt(vaultPath);
					} else if (action === "unlink") {
						this.deleteFileFromCrdt(vaultPath);
					}
				}
			}, ORIGIN_LOCAL_DISK);
		}

		// Process blob changes (async — uploads go to R2)
		if (this.blobClient && blobChanges.size > 0) {
			void this.flushBlobChanges(blobChanges);
		}
	}

	// ─── Disk → CRDT: Markdown ────────────────────────────────────────────────

	/** Import a disk file into the CRDT. */
	private importFileIntoCrdt(vaultPath: string): void {
		const diskPath = join(this.syncDir, vaultPath);

		let content: string;
		try {
			content = readFileSync(diskPath, "utf8");
		} catch (err) {
			log.warn(`Failed to read ${vaultPath}:`, err);
			return;
		}

		const mtime = Date.now();
		const { meta, pathToId, idToText } = this.sync;

		// Look up existing file ID
		let fileId = this.findFileIdByPath(vaultPath);

		if (fileId) {
			// Existing file — check if it's tombstoned
			const rawMeta = meta.get(fileId);
			if (rawMeta && isNestedFileMeta(rawMeta)) {
				const decoded = decodeFileMeta(rawMeta);
				if (decoded && isFileMetaDeleted(decoded)) {
					// Revive tombstoned file
					reviveMeta(rawMeta, vaultPath, mtime, this.deviceName);
					log.info(`→ Revived: ${vaultPath}`);
				} else {
					// Update mtime
					rawMeta.set("mtime", mtime);
					if (this.deviceName) rawMeta.set("device", this.deviceName);
				}
			}

			// Update content via diff
			const ytext = idToText.get(fileId);
			if (ytext) {
				const existing = ytext.toString();
				if (existing !== content) {
					this.applyDiff(ytext, existing, content);
					log.info(`→ Updated: ${vaultPath} (${content.length} chars)`);
				}
			} else {
				// Y.Text missing — create it
				const newText = new Y.Text(content);
				idToText.set(fileId, newText);
				log.info(`→ Created text for existing ID: ${vaultPath}`);
			}
		} else {
			// New file — create new CRDT entry
			fileId = randomId(12);

			// pathToId
			pathToId.set(vaultPath, fileId);

			// meta
			const metaEntry = createNestedActiveMeta(vaultPath, mtime, this.deviceName);
			meta.set(fileId, metaEntry);

			// idToText
			const ytext = new Y.Text(content);
			idToText.set(fileId, ytext);

			log.info(`→ Imported: ${vaultPath} → ${fileId} (${content.length} chars)`);
		}
	}

	/** Mark a file as deleted (tombstoned) in the CRDT. */
	private deleteFileFromCrdt(vaultPath: string): void {
		const fileId = this.findFileIdByPath(vaultPath);
		if (!fileId) return; // unknown file

		const { meta } = this.sync;
		const rawMeta = meta.get(fileId);
		if (!rawMeta) return;

		if (isNestedFileMeta(rawMeta)) {
			const decoded = decodeFileMeta(rawMeta);
			if (decoded && !isFileMetaDeleted(decoded)) {
				markMetaAsDeleted(rawMeta, Date.now(), this.deviceName);
				log.info(`→ Tombstoned: ${vaultPath}`);
			}
		} else {
			// v2 flat — replace with nested tombstone
			const tombstone = new Y.Map<unknown>();
			tombstone.set("path", vaultPath);
			tombstone.set("deleted", true);
			tombstone.set("deletedAt", Date.now());
			if (this.deviceName) tombstone.set("device", this.deviceName);
			meta.set(fileId, tombstone);
			log.info(`→ Tombstoned (v2→v3): ${vaultPath}`);
		}
	}

	/**
	 * Find a fileId by vault-relative path.
	 * Searches meta map for an entry with matching path.
	 */
	private findFileIdByPath(vaultPath: string): string | null {
		// First try pathToId (fast lookup)
		const fromPathToId = this.sync.pathToId.get(vaultPath);
		if (fromPathToId) return fromPathToId;

		// Fallback: scan meta for matching path (v3 meta.path is authoritative)
		const { meta } = this.sync;
		let foundId: string | null = null;
		meta.forEach((rawMeta, fileId) => {
			if (foundId) return; // already found
			const decoded = decodeFileMeta(rawMeta);
			if (decoded && decoded.path === vaultPath && !isFileMetaDeleted(decoded)) {
				foundId = fileId;
			}
		});
		return foundId;
	}

	// ─── Disk → CRDT: Blobs ──────────────────────────────────────────────────

	/**
	 * Process pending blob changes: upload new/changed files, tombstone deleted ones.
	 */
	private async flushBlobChanges(changes: Map<string, "change" | "unlink">): Promise<void> {
		for (const [vaultPath, action] of changes) {
			if (action === "change") {
				await this.importBlobIntoCrdt(vaultPath);
			} else if (action === "unlink") {
				this.deleteBlobFromCrdt(vaultPath);
			}
		}
	}

	/** Import a binary file into CRDT as a blob (upload to R2, set pathToBlob). */
	private async importBlobIntoCrdt(vaultPath: string): Promise<void> {
		if (!this.blobClient) return;

		const diskPath = join(this.syncDir, vaultPath);

		let data: Buffer;
		try {
			data = readFileSync(diskPath);
		} catch (err) {
			log.warn(`Failed to read blob ${vaultPath}:`, err);
			return;
		}

		// Check size limit
		if (data.length > this.config.maxAttachmentSizeBytes) {
			log.warn(
				`Blob ${vaultPath} exceeds size limit (${data.length} > ${this.config.maxAttachmentSizeBytes} bytes), skipping`
			);
			return;
		}

		const hash = sha256HexBuffer(data);
		const { pathToBlob, blobTombstones } = this.sync;

		// Check if blob already has the same hash (no change needed)
		const existingRef = pathToBlob.get(vaultPath) as BlobRef | undefined;
		if (existingRef && existingRef.hash === hash) return;

		// Upload to R2 (only if not already present)
		try {
			const [existingHash] = await this.blobClient.exists([hash]);
			if (!existingHash) {
				const mime = guessMime(vaultPath);
				await this.blobClient.upload(hash, mime, data);
			}
		} catch (err) {
			log.warn(`Failed to upload blob ${vaultPath}:`, err);
			return;
		}

		// Update CRDT — two-phase: only after successful upload
		this.sync.ydoc.transact(() => {
			const ref: BlobRef = {
				hash,
				size: data.length,
				mtime: Date.now(),
			};
			pathToBlob.set(vaultPath, ref as unknown as string);

			// Clear tombstone if exists
			if (blobTombstones.has(vaultPath)) {
				blobTombstones.delete(vaultPath);
			}
		}, ORIGIN_LOCAL_DISK);

		log.info(`→ Blob uploaded: ${vaultPath} (${data.length} bytes, ${hash.slice(0, 12)}…)`);
	}

	/** Mark a blob as deleted (tombstoned) in the CRDT. */
	private deleteBlobFromCrdt(vaultPath: string): void {
		const { pathToBlob, blobTombstones } = this.sync;

		// Only tombstone if the blob actually exists in CRDT
		if (!pathToBlob.has(vaultPath)) return;

		this.sync.ydoc.transact(() => {
			pathToBlob.delete(vaultPath);
			blobTombstones.set(vaultPath, Date.now() as unknown as string);
		}, ORIGIN_LOCAL_DISK);

		log.info(`→ Blob tombstoned: ${vaultPath}`);
	}

	// ─── Text diff ────────────────────────────────────────────────────────────

	/**
	 * Apply a text diff to a Y.Text instead of replacing the full content.
	 * This preserves Yjs identity and produces cleaner CRDT operations.
	 */
	private applyDiff(ytext: Y.Text, oldContent: string, newContent: string): void {
		const diffs = this.dmp.diff_main(oldContent, newContent);
		this.dmp.diff_cleanupEfficiency(diffs);

		let cursor = 0;
		for (const [op, text] of diffs) {
			switch (op) {
				case 0: // EQUAL
					cursor += text.length;
					break;
				case -1: // DELETE
					ytext.delete(cursor, text.length);
					break;
				case 1: // INSERT
					ytext.insert(cursor, text);
					cursor += text.length;
					break;
			}
		}
	}
}
