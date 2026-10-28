# Hapstore: THE CORE

A full-stack interactive game and dashboard platform built with React, TypeScript, Express, Vite, Socket.IO, and Firebase, styled with Tailwind CSS and the Orbitron typography system.

---

## 🛠️ Tech Stack

- **Frontend:** React 19, Vite 6, Tailwind CSS v4, Lucide Icons, Motion
- **Backend:** Node.js 22+, Express, Socket.IO, Firestore via the Firebase Admin SDK
- **Bot:** Telegraf (separate container, sole Telegram long-polling consumer)
- **Typography:** Orbitron & Futuristic Design System
- **Build Tooling:** TypeScript, `tsx`, `esbuild`, Vitest

---

## 🚀 Getting Started

### 1. Prerequisites

Make sure you have **Node.js v22 or higher** and `npm` installed
(`firebase-admin` and some transitive dependencies require Node 22+).

### 2. Installation

Clone the repository and install dependencies:

```bash
git clone <your-repository-url>
cd <repository-folder>
npm install
```

### 3. Environment Variables

Copy `.env.example` to `.env` and fill in your secrets:

```bash
cp .env.example .env
```

Generate the required secrets:

```bash
npm run hash-password -- 'your-strong-admin-password'
```

The command prints `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` and
`INTERNAL_API_SECRET` — copy all three into `.env`.

Required environment variables (the server refuses to start in production
without them):

- `ADMIN_PASSWORD_HASH`: PBKDF2 `salt:hash` of the admin password. The password
  itself is never stored anywhere.
- `SESSION_SECRET`: signing key for session tokens.
- `INTERNAL_API_SECRET`: shared secret between the server and the bot container,
  protecting the internal `/api/admin/bot-*` endpoints.

Optional:

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_CHAT_ID`, `TELEGRAM_ADMIN_USERNAME`
- `WEB_APP_URL`: public origin, also used for the CORS allow-list
- `DATA_DIR`: where persistent state is written (defaults to `./data`)
- `FIREBASE_*`: Firestore configuration
- `LEGACY_AES_PASSWORD`: only to migrate passwords from a pre-hardening release

> **Never commit `.env` or `firebase-applet-config.json`.** Both are ignored by
> git; Firebase credentials belong in environment variables.

### 4. Running locally in Development Mode

To start the full-stack server (Express + Vite hot reloading):

```bash
npm run dev
```

The application will be available at `http://localhost:3000`.

---

## 📦 Production Build & Launch

To build the production client assets and bundle the server:

```bash
npm run build
```

To start the production server:

```bash
npm start
```

## 🗂 Project Layout

```
server.ts                  HTTP + Socket.IO wiring
src/
  config/env.ts            the only module that reads process.env
  auth/session.ts          signed session tokens, legacy migration
  game/rules.ts            movement and prize rules (pure, unit-tested)
  game/data/cells.json     the 65-cell board
  persistence/firestore.ts Admin SDK access layer
  persistence/files.ts     atomic disk writes
  telegram/notifier.ts     outbound Telegram delivery
  telegram/initData.ts     Mini App signature verification (password-free entry)
  game/registrations.ts    persisted queue of pending registration requests
  validation/schemas.ts    zod schemas for every untrusted input
  utils/logger.ts          structured logging
  utils/security.ts        hashing, escaping, token signing
  i18n/                    translation catalogue (ru/en)
bot/
  src/index.ts             commands, buttons, admin decisions
  src/registration.ts      registration request flow
  src/adminManager.ts      trusted administrator list
  src/asyncQueue.ts        send queue with 429 back-off
tests/e2e/
  server.e2e.test.ts       HTTP + Socket.IO against the real bundle
  bot.e2e.test.ts          the real bot against a stub Telegram API
```

---

## 🤖 Joining the Game

Registration is driven entirely from the bot; nobody can create their own
account.

```
player: /start  ->  «📝 ЗАПРОСИТЬ РЕГИСТРАЦИЮ»  (or /register)
            |
            v
server:  request is queued on disk, admins are notified
            |
            v
admin:   «✅ ЗАРЕГИСТРИРОВАТЬ»            «❌ ОТКАЗАТЬ»
            |                                  |
            v                                  v
server:  player created, 8-10 char          request dropped,
         password generated & hashed        player informed
            |
            v
bot:     login + password sent to the player's private chat
```

**Afterwards the password is rarely needed.** Inside Telegram the Mini App
sends the signed `initData` blob to `POST /api/telegram/auth`; its HMAC is
verified against the bot token, so pressing «🎮 ИГРАТЬ» signs the player in
directly. The password only matters for signing in from an ordinary browser.

Two consequences worth knowing:

- **An administrator must press `/start` at least once.** Telegram refuses to
  deliver a private message addressed to `@handle` — only to a numeric chat id,
  which the bot learns from that first interaction. Until then registration
  requests cannot be delivered; the bot logs this loudly and `/pending` lists
  everything that is waiting.
- **A player without a Telegram `@username` cannot register.** The handle is
  the in-game name, so the bot asks them to set one first.

Generated passwords are 8–10 characters drawn from lower-case, upper-case,
digits and symbols, with at least one of each, produced with `crypto.randomInt`
(no modulo bias). Look-alike characters (`0O1lI`) are excluded because the
password is retyped by hand from a phone screen. The plaintext exists only in
the response that delivers it and is never logged, never shown to the
administrator and never written to disk — only its PBKDF2 hash is stored.

Admin commands: `/pending`, `/admin_logs`, `/set_admin`, `/list_admins`,
`/reload_admins`.

## ✅ Quality Gates

```bash
npm run lint        # tsc --noEmit + eslint
npm run format      # prettier --write
npm run test        # unit tests (fast)
npm run test:e2e    # boots the real bundle and drives it over HTTP/Socket.IO
npm run test:all    # both suites
npm run build       # client + server bundles
npm run check-secrets
```

## 🔧 Operations

```bash
npm run setup-env -- --password '<admin>'   # generate .env
bash scripts/check-deployment.sh            # pre-flight check on the host
npm run snapshot:list                       # list state snapshots
npm run restore -- --latest                 # restore the newest snapshot
```

`GET /healthz` reports liveness; `GET /metrics` exposes Prometheus gauges and
requires the internal token.

CI runs all of the above plus `npm audit`, secret scanning and Docker builds on
every push and pull request (`.github/workflows/ci.yml`).

---

## 🔐 Security Model

- **Authentication** — `/api/login` verifies a PBKDF2 hash (100k iterations,
  per-user salt, constant-time compare) and returns a signed, expiring session
  token. Socket.IO validates that token during the handshake, so a client can
  never act on behalf of another player by supplying a different id.
- **Telegram sign-in** — `/api/telegram/auth` verifies the `initData` HMAC
  against the bot token before issuing the same session token, and matches the
  player by **numeric Telegram id** first. Handles can be reassigned by their
  owner; ids cannot. A forged or replayed payload is rejected, and an unknown
  user is never created implicitly — they are told to request registration.
- **Authorisation** — admin rights come from the signed token only. Every
  privileged socket event and internal HTTP endpoint is guarded server-side.
- **Dice fairness** — roll results are generated with `crypto.randomInt` on the
  server; the client merely animates the value it is told.
- **Data protection** — Firestore is reached only through the Admin SDK with a
  service account, so `firestore.rules` denies **all** public access. Passwords
  are stored as one-way hashes and are never returned by any endpoint, and
  `/api/state` omits personal Telegram identifiers.
- **Graceful degradation** — the credential is verified at boot; if Firestore is
  unreachable the server logs the reason and keeps running on local disk
  persistence rather than silently dropping writes.
- **Hardening** — CORS allow-list, CSP and related headers, request rate limits,
  a 128 kB body cap, atomic state writes and graceful shutdown flushing.

---

## 🔥 Firestore Setup

The server persists state through the **Admin SDK**, which authenticates with a
service account and bypasses security rules. That is what allows the rules to
stay locked down (`allow read, write: if false`).

1. Firebase Console → Project settings → Service accounts →
   **Generate new private key**.
2. Supply it through **one** of:

   ```bash
   # A. contents as a single-line JSON string (secret managers, Cloud Run)
   FIREBASE_SERVICE_ACCOUNT='{"type":"service_account","project_id":"..."}'

   # B. path to the key file (mount it read-only in Docker)
   GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/service-account.json
   ```

3. Deploy the rules: `firebase deploy --only firestore:rules`

**Where does this go?** On the machine that runs `docker compose` — the `.env`
file must sit next to `docker-compose.yml`, because Compose only reads a `.env`
from its own working directory. It is never committed and never baked into the
image. Validate the host before deploying:

```bash
bash scripts/check-deployment.sh
```

Without a service account the server still starts and uses local disk
persistence; `GET /healthz` reports `"firestore":"disabled"`.

> The Firebase **web API key** is not a server credential. It is ignored by this
> integration and cannot be used to reach the database once the rules are closed.

---

## 🐳 Docker Deployment

You can run the application using Docker and Docker Compose:

```bash
docker-compose up --build -d
```

Or build and run manually:

```bash
docker build -t hapstore-core .
docker run -p 3000:3000 --env-file .env hapstore-core
```

---

## 📤 Pushing to GitHub

To publish this project to GitHub:

```bash
git init
git add .
git commit -m "Initial commit - Hapstore: THE CORE"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo-name>.git
git push -u origin main
```

---

## 📜 License

This project is licensed under the MIT License.
