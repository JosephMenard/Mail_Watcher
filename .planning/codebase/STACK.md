# STACK.md — Technology Stack
*Generated: 2026-03-21 | Project: Mail_Watcher (Sentinel)*

## Runtime

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Runtime | Node.js ESM | ≥18 | `"type": "module"` |
| Package manager | npm | — | lockfile present |

## Core Dependencies

| Package | Role | File |
|---------|------|------|
| `better-sqlite3` ^9.6.0 | Synchronous SQLite ORM | `sync.js`, `bridge.js`, `verify_table.js` |
| `sqlite-vec` ^0.1.7-alpha.2 | Virtual table for float[768] vectors | `sync.js`, `bridge.js` |
| `imapflow` ^1.0.162 | IMAP client (TLS, incremental fetch) | `sync.js` |
| `mailparser` ^3.7.1 | MIME email parser | `sync.js` |
| `html-to-text` ^9.0.5 | HTML → plain text conversion | `sync.js` |
| `@google/genai` ^1.44.0 | Gemini 2.5 Flash LLM API | `bridge.js` |
| `dotenv` ^16.6.1 | `.env` loader | `sync.js`, `bridge.js` |

## External Services

| Service | Role | Protocol |
|---------|------|----------|
| Gmail IMAP (`imap.gmail.com:993`) | Email source | IMAP/TLS |
| Ollama local (`localhost:11434`) | `nomic-embed-text` embeddings, 768 dims | HTTP POST |
| Google Gemini 2.5 Flash | Phishing/BEC analysis LLM | HTTPS (API key) |

## Database Schema

```
SQLite (./database.db) — WAL mode, synchronous=NORMAL

emails              INTEGER PK, message_id UNIQUE TEXT, sender TEXT, subject TEXT,
                    clean_body TEXT, received_at INTEGER (unix sec)

sender_profiles     sender_email TEXT PK, interaction_count INT, first_contact_date INT,
                    last_contact_date INT, trust_score INT DEFAULT 50

vec_emails          VIRTUAL TABLE vec0 — rowid FK→emails.id, embedding float[768]
```

## Browser Layer

| Component | Technology |
|-----------|-----------|
| Extension | Chrome Manifest V3 |
| Injection | Content script on `https://mail.google.com/*` |
| Transport | `fetch()` → `http://localhost:3000/trigger` |

## Dev/Tooling (misplaced in `dependencies`)

- `gitnexus` ^1.4.7 — code intelligence index
- `get-shit-done-cc` ^1.27.0 — GSD workflow

> **Note:** These should be `devDependencies`.

## Environment Variables Required

| Variable | Used in |
|----------|---------|
| `EMAIL` | `sync.js` — Gmail IMAP user |
| `APP_PASSWORD` | `sync.js` — Gmail App Password |
| `GEMINI_API_KEY` | `bridge.js` — Gemini API |
