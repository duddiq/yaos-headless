# YAOS Headless Sync Client

Headless Node.js klient do synchronizacji plików z serwerem [YAOS](https://github.com/kavinsood/yaos) (Yet Another Obsidian Sync). Obsługuje zarówno pliki Markdown jak i załączniki (obrazy, PDF, audio itp.) przez Cloudflare R2.

Łączy się z Twoim Cloudflare Worker przez WebSocket, synchronizuje stan CRDT (Yjs) i materializuje/obserwuje pliki na lokalnym dysku — **dwukierunkowo**. Pliki Markdown synchronizowane są przez CRDT, a załączniki binarne (obrazy, PDF itp.) przez Cloudflare R2.

## Jak to działa

```
┌──────────────┐    WebSocket     ┌──────────────────┐    Filesystem     ┌─────────────┐
│   Obsidian   │ ◄──────────────► │  Cloudflare       │ ◄──────────────► │  Twój serwer │
│   (plugin)   │    Yjs CRDT      │  Worker (YAOS)    │    Yjs CRDT      │  (headless)  │
└──────────────┘                  └──────────────────┘                   └─────────────┘
                                         ▲                                      │
                                         │              Pliki .md               │
                                    Durable Object      sync na dysk            │
                                    (Y.Doc + SQLite)    ◄──────────────► ./vault/
```

1. **Obsidian** edytuje notatki → zmiany trafiają do CRDT → serwer → headless klient → pliki na dysku
2. **Pliki na dysku** zmienione → headless klient → CRDT → serwer → Obsidian

## Szybki start

### 1. Postaw serwer YAOS na Cloudflare

Najprostszy sposób — kliknij przycisk **Deploy to Cloudflare** na stronie repozytorium:

👉 https://github.com/kavinsood/yaos

Albo ręcznie:

```bash
# Sklonuj repo
git clone https://github.com/kavinsood/yaos.git
cd yaos/server

# Zainstaluj wrangler (CLI Cloudflare)
npm install -g wrangler

# Zaloguj się do Cloudflare
wrangler login

# Deploy
wrangler deploy
```

Po deployu, otwórz URL Workera w przeglądarce (np. `https://yaos.twoj-account.workers.dev`).
Zobaczysz stronę konfiguracji. **Skopiuj:**
- **Host** (np. `yaos.twoj-account.workers.dev`)
- **Vault ID** (wygenerowany automatycznie)
- **Token** (ustawiony podczas "claim")

### 2. Zainstaluj plugin YAOS w Obsidian

1. W Obsidian: Settings → Community plugins → Browse → szukaj "YAOS"
2. Zainstaluj i włącz
3. W ustawieniach pluginu wpisz Host, Vault ID i Token ze swojego Workera
4. Obsidian zacznie synchronizować notatki

### 3. Skonfiguruj headless klienta

```bash
# Sklonuj ten projekt
cd yaos-headless

# Zainstaluj zależności
npm install

# Skonfiguruj
cp .env.example .env
```

Edytuj `.env`:

```env
YAOS_HOST=yaos.twoj-account.workers.dev
YAOS_VAULT_ID=twoje-vault-id
YAOS_TOKEN=twoj-token
YAOS_SYNC_DIR=/srv/obsidian-vault
YAOS_DEVICE_NAME=home-server
YAOS_LOG_LEVEL=info
```

### 4. Uruchom

```bash
# Development (z hot-reload)
npm run dev

# Lub produkcyjnie
npm run build
npm start
```

## Uruchomienie jako systemd service (Linux)

```ini
# /etc/systemd/system/yaos-headless.service

[Unit]
Description=YAOS Headless Sync Client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/opt/yaos-headless
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable yaos-headless
sudo systemctl start yaos-headless
sudo journalctl -u yaos-headless -f  # logi
```

## Zmienne środowiskowe

| Zmienna | Wymagana | Opis |
|---------|----------|------|
| `YAOS_HOST` | ✅ | Hostname serwera YAOS (bez `https://`) |
| `YAOS_VAULT_ID` | ✅ | ID vault'a z konfiguracji serwera |
| `YAOS_TOKEN` | ✅ | Token autoryzacyjny |
| `YAOS_SYNC_DIR` | ❌ | Katalog synchronizacji (domyślnie: `./vault`) |
| `YAOS_DEVICE_NAME` | ❌ | Nazwa urządzenia w metadanych CRDT (domyślnie: `headless-server`) |
| `YAOS_LOG_LEVEL` | ❌ | Poziom logowania: `debug`, `info`, `warn`, `error` (domyślnie: `info`) |
| `YAOS_BLOB_SYNC` | ❌ | Synchronizacja załączników via R2: `true`/`false` (domyślnie: `true`) |
| `YAOS_MAX_ATTACHMENT_SIZE_KB` | ❌ | Max rozmiar załącznika w KB (domyślnie: `102400` = 100MB) |

## Jak działa synchronizacja

### Markdown: CRDT → Dysk (zdalne zmiany)
- Obserwuje mapę `meta` (Y.Map) — wykrywa nowe pliki, zmiany ścieżek, tombstones (usunięcia)
- Obserwuje mapę `idToText` (Y.Map<Y.Text>) — wykrywa zmiany treści
- Materializuje `Y.Text.toString()` do pliku `.md` na dysku
- Tombstoned pliki usuwa z dysku
- Przy zmianie nazwy (rename) — automatycznie usuwa stary plik

### Markdown: Dysk → CRDT (lokalne zmiany)
- Używa `chokidar` do obserwacji katalogu synchronizacji
- Nowe/zmienione pliki `.md` → tworzy/aktualizuje wpisy w CRDT
- Usunięte pliki `.md` → tworzy tombstone w CRDT
- Stosuje **diff** (nie replace-all) do zachowania Yjs identity i historii

### Załączniki (blobs): CRDT → Dysk
- Obserwuje mapę `pathToBlob` (Y.Map) — wykrywa nowe/zmienione referencje blobów
- Obserwuje mapę `blobTombstones` (Y.Map) — wykrywa usunięte blobs
- Pobiera pliki binarne z Cloudflare R2 po hashu SHA-256
- Content-addressing zapewnia automatyczną deduplikację

### Załączniki (blobs): Dysk → CRDT
- Nowe/zmienione pliki binarne → hashuje SHA-256 → upload do R2 → ustaw `pathToBlob`
- Usunięte pliki → tombstone w `blobTombstones`
- Two-phase commit: CRDT aktualizowane dopiero PO udanym uploadzie

### Ochrona przed echo-loop
- Po każdym zapisie na dysk zapamiętuje hash treści/danych
- Gdy chokidar raportuje zmianę, sprawdza czy hash się zgadza
- Jeśli tak — ignoruje (to nasze własne echo)
- Działa zarówno dla plików .md jak i binarnych

## Ograniczenia

- Foldery `.obsidian` nie są synchronizowane (zgodnie z YAOS)
- Puste foldery nie są synchronizowane (Yjs nie ma koncepcji pustego folderu)
- Załączniki wymagają skonfigurowanego Cloudflare R2 na serwerze YAOS

## Rozwój

```bash
# Build
npm run build

# Dev (tsx z auto-reload)
npm run dev
```

## Licencja

0-BSD (zgodnie z YAOS)
