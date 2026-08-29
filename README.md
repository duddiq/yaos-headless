# YAOS Headless Sync Client

[![License: 0-BSD](https://img.shields.io/badge/License-0--BSD-blue.svg)](https://opensource.org/licenses/0BSD)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Upstream YAOS](https://img.shields.io/badge/Upstream-kavinsood%2Fyaos-orange.svg)](https://github.com/kavinsood/yaos)

A lightweight, headless Node.js sync client for the **[YAOS](https://github.com/kavinsood/yaos) (Yet Another Obsidian Sync)** ecosystem. It provides continuous, bidirectional synchronization of Markdown notes and binary attachments directly between your Cloudflare Worker server and a local filesystem directory — without needing the Obsidian desktop app or any graphical interface.

---

> [!NOTE]
> ### 🔗 Upstream Project & Credits
> This project is a standalone headless client built for the **[YAOS (Yet Another Obsidian Sync)](https://github.com/kavinsood/yaos)** ecosystem developed by [Kavin Sood](https://github.com/kavinsood).
> 
> * **Official YAOS Repository:** [https://github.com/kavinsood/yaos](https://github.com/kavinsood/yaos)
> * **Obsidian Plugin:** Search for *YAOS* in Obsidian Community Plugins.
> * **Server:** Cloudflare Worker with Durable Objects (Yjs CRDT) and Cloudflare R2 (attachments/blobs).
> 
> Huge thanks to Kavin Sood for creating such an elegant, fast, and reliable sync architecture!

---

## 🚀 Use Cases

- **Home Servers, NAS & Raspberry Pi:** Keep an always-up-to-date, live copy of your Obsidian vault on your home lab or server.
- **Static Site Generators (SSG):** Power automated publishing workflows for [Quartz](https://quartz.jzhao.xyz/), Astro, Hugo, or MkDocs without manual git commits or exports.
- **RAG / AI / LLM Pipelines:** Feed live notes into local embeddings, vector stores, or search indices in real time.
- **Automated Backups:** Run server-side automated backups (e.g. Git, Restic, Borg, S3) on plain `.md` files without disturbing your active desktop app.
- **Scripts & Bots:** Edit or generate notes directly on the server via scripts, and see them appear immediately in Obsidian across all your devices.

---

## 🏗️ Architecture & How It Works

The client connects to your YAOS Cloudflare Worker via WebSocket, participates in the Yjs CRDT synchronization session as a peer node, and materializes changes directly to and from your local disk.

```
┌─────────────────┐       WebSocket       ┌────────────────────────┐       WebSocket       ┌───────────────────┐
│ Obsidian Client │ ◄───────────────────► │   Cloudflare Worker    │ ◄───────────────────► │   yaos-headless   │
│  (Desktop/App)  │       Yjs CRDT        │      (YAOS Server)     │       Yjs CRDT        │  (Server / VPS)   │
└─────────────────┘                       └────────────────────────┘                       └───────────────────┘
         ▲                                      │            ▲                                       │
         │                                      │            │                                       │
   Local Vault                           Durable Object   Cloudflare R2                        Local Disk
 (Obsidian App)                         (Y.Doc + SQLite)  (Binary Blobs)                     (e.g. ./vault/)
```

### Key Highlights

1. **Real-Time Bidirectional Sync:**
   - Edits in Obsidian → CRDT update → Cloudflare Worker → `yaos-headless` → file written to disk.
   - Edits on disk → monitored by `chokidar` → character-level diff → CRDT update → Cloudflare Worker → updated in Obsidian instantly.
2. **Binary Attachments (Cloudflare R2):**
   - Seamlessly downloads and uploads images, PDFs, audio, and other binary assets using SHA-256 content-addressable storage on Cloudflare R2.
3. **Smart Character-Level Diffing:**
   - Local file modifications use `diff-match-patch` instead of full-text overwrites. This preserves Yjs item identities, history, and prevents unnecessary conflict resolution spikes.
4. **Echo-Loop Prevention:**
   - Writes to disk are cryptographically hashed and remembered. When the filesystem watcher fires on our own writes, the event is recognized and safely ignored.
5. **Schema v3 Compatibility:**
   - Full compatibility with the modern YAOS v3 protocol and data model.

---

## 📦 Prerequisites

- **Node.js**: Version 20.x or higher
- A running **[YAOS server on Cloudflare Workers](https://github.com/kavinsood/yaos)**
- The **YAOS** community plugin installed and configured in Obsidian

---

## ⚡ Quick Start

### Step 1: Deploy the YAOS Server

If you haven't deployed the YAOS server yet, follow the official instructions at [kavinsood/yaos](https://github.com/kavinsood/yaos):

```bash
# Clone the upstream repository
git clone https://github.com/kavinsood/yaos.git
cd yaos/server

# Install Wrangler CLI and deploy
npm install -g wrangler
wrangler login
wrangler deploy
```

Once deployed, open your Worker URL in a browser (e.g. `https://yaos.your-subdomain.workers.dev`), complete the claim setup, and take note of:
- **Host** (e.g. `yaos.your-subdomain.workers.dev`)
- **Vault ID**
- **Auth Token**

Also configure the YAOS plugin in your Obsidian desktop/mobile app using the same credentials.

### Step 2: Install and Configure yaos-headless

Clone this repository and install dependencies:

```bash
git clone https://github.com/duddiq/yaos-headless.git
cd yaos-headless

npm install
```

Create your configuration file from the template:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Hostname of your Cloudflare Worker (omit https://)
YAOS_HOST=yaos.your-subdomain.workers.dev

# Credentials obtained during server claim
YAOS_VAULT_ID=your-vault-id
YAOS_TOKEN=your-secret-token

# Local directory where files will be synced (created automatically if missing)
YAOS_SYNC_DIR=./vault

# Identifier for this device in CRDT metadata
YAOS_DEVICE_NAME=home-server

# Log level: debug | info | warn | error
YAOS_LOG_LEVEL=info

# Enable/disable binary attachment sync via Cloudflare R2
YAOS_BLOB_SYNC=true
```

### Step 3: Run the Client

**Development mode (using tsx with hot-reloading):**
```bash
npm run dev
```

**Production build:**
```bash
npm run build
npm start
```

---

## 🛠️ Production Deployments

### Option A: Systemd Service (Linux / Debian / Ubuntu / Arch)

1. Build the project:
   ```bash
   npm run build
   ```

2. Create a systemd service unit file:
   ```bash
   sudo nano /etc/systemd/system/yaos-headless.service
   ```

3. Paste the following configuration (adjust paths and user accordingly):
   ```ini
   [Unit]
   Description=YAOS Headless Sync Client
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=your-user
   WorkingDirectory=/path/to/yaos-headless
   ExecStart=/usr/bin/node dist/index.js
   Restart=always
   RestartSec=10
   Environment=NODE_ENV=production

   [Install]
   WantedBy=multi-user.target
   ```

4. Enable and start the service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now yaos-headless

   # Follow live logs:
   sudo journalctl -u yaos-headless -f
   ```

---

### Option B: Docker / Docker Compose

You can easily run `yaos-headless` inside a lightweight Docker container.

**Example `docker-compose.yml`:**
```yaml
services:
  yaos-sync:
    image: node:20-alpine
    container_name: yaos-headless
    restart: unless-stopped
    working_dir: /app
    volumes:
      - ./:/app
      - /path/to/local/vault:/app/vault
    environment:
      - YAOS_HOST=yaos.your-subdomain.workers.dev
      - YAOS_VAULT_ID=your-vault-id
      - YAOS_TOKEN=your-secret-token
      - YAOS_SYNC_DIR=/app/vault
      - YAOS_DEVICE_NAME=docker-node
      - YAOS_LOG_LEVEL=info
      - YAOS_BLOB_SYNC=true
    command: sh -c "npm install && npm run build && npm start"
```

---

## ⚙️ Environment Variables

| Variable | Required | Default | Description |
|----------|:--------:|:-------:|-------------|
| `YAOS_HOST` | **Yes** | — | Hostname of your Cloudflare Worker (e.g. `yaos.example.workers.dev`) |
| `YAOS_VAULT_ID` | **Yes** | — | Vault ID generated during server configuration |
| `YAOS_TOKEN` | **Yes** | — | Secret authentication token configured during claim |
| `YAOS_SYNC_DIR` | No | `./vault` | Local filesystem path where files are synchronized |
| `YAOS_DEVICE_NAME` | No | `headless-server` | Device name identified in CRDT metadata |
| `YAOS_LOG_LEVEL` | No | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |
| `YAOS_BLOB_SYNC` | No | `true` | Enable/disable binary attachment syncing via Cloudflare R2 |
| `YAOS_MAX_ATTACHMENT_SIZE_KB` | No | `102400` (100 MB) | Maximum permitted size for individual attachments in KB |

---

## 🔍 Troubleshooting

<details>
<summary><b>1. WebSocket connection fails or disconnects immediately</b></summary>

- Ensure `YAOS_HOST` contains only the domain name (e.g. `yaos.xyz.workers.dev`) **without** `https://` or trailing slashes `/`.
- Verify that `YAOS_TOKEN` and `YAOS_VAULT_ID` match the exact values displayed in your Worker dashboard.
- Verify that the Cloudflare Worker is active and accessible via your browser.
</details>

<details>
<summary><b>2. Attachments / images are not syncing</b></summary>

- Confirm that your YAOS Cloudflare Worker has a **Cloudflare R2** bucket bound with the binding name `ATTACHMENTS`.
- Make sure `YAOS_BLOB_SYNC` is not set to `false`.
- Check if file sizes exceed `YAOS_MAX_ATTACHMENT_SIZE_KB`.
</details>

<details>
<summary><b>3. Empty folders or `.obsidian/` configuration missing</b></summary>

- In accordance with the YAOS protocol specification, `.obsidian/` configuration directories are not synchronized.
- Yjs CRDT tracks document instances; empty directories on disk are not represented in the CRDT model until they contain at least one file.
</details>

---

## 📄 License

This project is licensed under the **0-BSD License** (consistent with the upstream [YAOS](https://github.com/kavinsood/yaos) project).
You are free to use, copy, modify, and distribute this software for any purpose, with or without fee.
