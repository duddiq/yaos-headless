/**
 * YAOS Headless Sync Client — CLI entry point.
 *
 * Connects to a YAOS Cloudflare Worker server and synchronizes .md files
 * bidirectionally between the server's CRDT state and a local directory.
 *
 * Usage:
 *   1. Copy .env.example to .env and fill in YAOS_HOST, YAOS_VAULT_ID, YAOS_TOKEN, YAOS_SYNC_DIR
 *   2. npm run dev        (development with tsx)
 *   3. npm run build && npm start   (production)
 */

import { loadConfig } from "./config.js";
import { setLogLevel, createLogger } from "./logger.js";
import { HeadlessSync } from "./headlessSync.js";
import { DiskMirror } from "./diskMirror.js";

const log = createLogger("main");

async function main(): Promise<void> {
	// Load configuration
	const config = loadConfig();
	setLogLevel(config.logLevel);

	// Parse CLI arguments
	const args = process.argv.slice(2);
	const listConflicts = args.includes("--list-conflicts");
	const resolveIdx = args.indexOf("--resolve-conflict");
	const resolvePath = resolveIdx >= 0 ? args[resolveIdx + 1] : undefined;
	const keepConflict = args.includes("--keep-conflict");

	log.info("╔═══════════════════════════════════════════════╗");
	log.info("║       YAOS Headless Sync Client v1.0.0        ║");
	log.info("╚═══════════════════════════════════════════════╝");
	log.info(`Host:      ${config.host}`);
	log.info(`Vault ID:  ${config.vaultId}`);
	log.info(`Sync dir:  ${config.syncDir}`);
	log.info(`Device:    ${config.deviceName}`);
	log.info(`Blobs:     ${config.blobSync ? "enabled" : "disabled"}`);
	log.info("");

	// Create sync engine
	const sync = new HeadlessSync(config);

	// Create disk mirror
	const diskMirror = new DiskMirror(sync, config);

	// Graceful shutdown handler
	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info(`\nReceived ${signal} — shutting down gracefully...`);
		await diskMirror.stop();
		await sync.destroy();
		log.info("Goodbye!");
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	// Status logging
	sync.on("status", (status) => {
		switch (status) {
			case "connecting":
				log.info("⟳ Connecting to server...");
				break;
			case "synced":
				log.info("✓ Connected and synced!");
				break;
			case "offline":
				log.warn("⊘ Offline — will reconnect automatically");
				break;
			case "error":
				log.error(`✗ Error: ${sync.fatalAuthCode || "unknown"}`);
				break;
			case "stopped":
				log.info("■ Stopped");
				break;
		}
	});

	// Connect to server
	await sync.connect();

	// Wait for initial sync
	log.info("Waiting for initial sync...");
	const synced = await sync.waitForSync();

	if (!synced) {
		if (sync.fatalAuthError) {
			log.error(`Cannot connect: ${sync.fatalAuthCode}`);
			if (sync.fatalAuthCode === "unclaimed") {
				log.error("Your YAOS server is not yet claimed. Please visit the server URL in a browser to set it up.");
			} else if (sync.fatalAuthCode === "unauthorized") {
				log.error("Invalid token. Check your YAOS_TOKEN in .env");
			} else if (sync.fatalAuthCode === "update_required") {
				log.error("Server requires a newer schema version. Update the headless client.");
			}
			process.exit(1);
		}
		log.warn("Initial sync timed out — starting in offline mode with cached state");
	}

	// One-shot conflict operations (no long-running watcher)
	if (listConflicts) {
		diskMirror.start();
		const artifacts = diskMirror.listConflictArtifacts();
		if (artifacts.length === 0) {
			console.log("NO_CONFLICTS");
		} else {
			console.log(JSON.stringify(artifacts, null, 2));
		}
		await shutdown("done");
		return;
	}

	if (resolvePath) {
		diskMirror.start();
		// Give the disk mirror a moment to materialize from CRDT before resolving
		await new Promise((r) => setTimeout(r, 1000));
		diskMirror.resolveConflictArtifact(
			resolvePath,
			keepConflict ? "keep-conflict" : "keep-original",
		);
		// Let the tombstone propagate to the server
		await new Promise((r) => setTimeout(r, 2000));
		await sync.destroy();
		console.log("RESOLVED");
		return;
	}

	// Start bidirectional disk synchronization
	diskMirror.start();

	log.info("");
	log.info("Sync is running. Press Ctrl+C to stop.");
	log.info(`Files are synchronized in: ${config.syncDir}`);
	log.info("");

	// Keep the process alive
	await new Promise(() => { /* hang forever until signal */ });
}

main().catch((err) => {
	log.error("Fatal error:", err);
	process.exit(1);
});
