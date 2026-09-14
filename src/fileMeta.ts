/**
 * File metadata decoder — ported from YAOS plugin src/sync/fileMeta.ts.
 *
 * Handles both v2 (flat JSON object) and v3 (nested Y.Map) metadata shapes.
 * This is the ONLY interface for reading/writing file metadata values.
 */

import * as Y from "yjs";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Which shape the metadata entry was decoded from. */
export type FileMetaShape = "flat" | "nested";

/** Normalized decoded metadata from either v2 or v3 schema. */
export interface DecodedFileMeta {
	shape: FileMetaShape;
	path: string;
	deletedAt?: number;
	deleted?: boolean;
	mtime?: number;
	device?: string;
}

// ─── Type guards ──────────────────────────────────────────────────────────────

/** Check if a metadata value is a nested Y.Map (v3 schema). */
export function isNestedFileMeta(value: unknown): value is Y.Map<unknown> {
	return value instanceof Y.Map;
}

/** Check if a metadata value is a plain object record (v2 schema). */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !(value instanceof Y.Map);
}

// ─── Decoder ──────────────────────────────────────────────────────────────────

/**
 * Decode a metadata value from either flat (v2) or nested (v3) shape.
 * Returns null for invalid/unrecognizable values.
 */
export function decodeFileMeta(value: unknown): DecodedFileMeta | null {
	if (isNestedFileMeta(value)) {
		return decodeNestedMeta(value);
	}
	if (isObjectRecord(value)) {
		return decodeFlatMeta(value);
	}
	return null;
}

function decodeNestedMeta(map: Y.Map<unknown>): DecodedFileMeta | null {
	const path = map.get("path");
	if (typeof path !== "string" || path.length === 0) return null;

	const deletedAtRaw = map.get("deletedAt");
	const deletedRaw = map.get("deleted");
	const mtimeRaw = map.get("mtime");
	const deviceRaw = map.get("device");

	const result: DecodedFileMeta = { shape: "nested", path };

	if (typeof deletedAtRaw === "number" && Number.isFinite(deletedAtRaw)) {
		result.deletedAt = deletedAtRaw;
	}
	if (deletedRaw === true) {
		result.deleted = true;
	}
	if (typeof mtimeRaw === "number" && Number.isFinite(mtimeRaw)) {
		result.mtime = mtimeRaw;
	}
	if (typeof deviceRaw === "string") {
		result.device = deviceRaw;
	}

	return result;
}

function decodeFlatMeta(obj: Record<string, unknown>): DecodedFileMeta | null {
	const path = obj.path;
	if (typeof path !== "string" || path.length === 0) return null;

	const result: DecodedFileMeta = { shape: "flat", path };

	if (typeof obj.deletedAt === "number" && Number.isFinite(obj.deletedAt)) {
		result.deletedAt = obj.deletedAt;
	}
	if (obj.deleted === true) {
		result.deleted = true;
	}
	if (typeof obj.mtime === "number" && Number.isFinite(obj.mtime)) {
		result.mtime = obj.mtime;
	}
	if (typeof obj.device === "string") {
		result.device = obj.device;
	}

	return result;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

/** Check whether a metadata entry represents a deleted (tombstoned) file. */
export function isFileMetaDeleted(meta: DecodedFileMeta): boolean {
	return meta.deleted === true || (meta.deletedAt !== undefined && meta.deletedAt > 0);
}

/**
 * Read the path from a raw metadata value (v2 or v3).
 * Returns null if the value is invalid.
 */
export function getMetaPath(value: unknown): string | null {
	if (isNestedFileMeta(value)) {
		const p = value.get("path");
		return typeof p === "string" && p.length > 0 ? p : null;
	}
	if (isObjectRecord(value)) {
		const p = value.path;
		return typeof p === "string" && (p as string).length > 0 ? p as string : null;
	}
	return null;
}

// ─── Writer helpers ───────────────────────────────────────────────────────────

/**
 * Create a new nested Y.Map metadata entry for an active (non-deleted) file.
 * Always produces v3 (nested Y.Map) shape.
 */
export function createNestedActiveMeta(
	path: string,
	mtime: number,
	device?: string,
): Y.Map<unknown> {
	const map = new Y.Map<unknown>();
	map.set("path", path);
	map.set("mtime", mtime);
	if (device) {
		map.set("device", device);
	}
	return map;
}

/**
 * Create a tombstone metadata entry for a deleted file.
 */
export function createNestedTombstoneMeta(
	path: string,
	deletedAt: number,
	device?: string,
): Y.Map<unknown> {
	const map = new Y.Map<unknown>();
	map.set("path", path);
	map.set("deletedAt", deletedAt);
	if (device) {
		map.set("device", device);
	}
	return map;
}

/**
 * Update an existing nested Y.Map entry to mark it as deleted (tombstone).
 *
 * Mirrors upstream YAOS setMetaDeleted semantics: a document is considered
 * deleted by the presence of a positive `deletedAt`. The `deleted` flag is
 * removed (not set to true) and stale `mtime` is cleared, matching how the
 * YAOS server interprets tombstones. This is essential so the server does not
 * re-materialize the file on the next sync.
 */
export function markMetaAsDeleted(
	metaEntry: Y.Map<unknown>,
	deletedAt: number,
	device?: string,
): void {
	metaEntry.set("deletedAt", deletedAt);
	metaEntry.delete("deleted");
	metaEntry.delete("mtime");
	if (device) {
		metaEntry.set("device", device);
	}
}

/**
 * Update an existing nested Y.Map entry to revive it (remove tombstone).
 */
export function reviveMeta(
	metaEntry: Y.Map<unknown>,
	path: string,
	mtime: number,
	device?: string,
): void {
	metaEntry.set("path", path);
	metaEntry.set("mtime", mtime);
	metaEntry.delete("deleted");
	metaEntry.delete("deletedAt");
	if (device) {
		metaEntry.set("device", device);
	}
}
