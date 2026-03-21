# STRUCTURE.md — Directory & File Structure
*Generated: 2026-03-21 | Project: Mail_Watcher (Sentinel)*

## Directory Layout

```
Mail_Watcher/
├── bridge.js              ← HTTP server (port 3000), GraphRAG + Gemini analysis
├── sync.js                ← Offline ingestion: IMAP → SQL → vectors
├── verify_table.js        ← DB diagnostic read-only script
├── package.json           ← ESM module config, dependencies
├── package-lock.json
├── .gitignore             ← excludes database.db*
├── CR.md                  ← Technical analysis report
├── CLAUDE.md              ← GitNexus instructions for Claude Code
├── AGENTS.md              ← Agent workspace instructions
├── chrome-extension/
│   ├── manifest.json      ← Chrome MV3 manifest
│   └── content.js         ← Gmail content script (observer + banner UI)
├── skills/
│   └── gsd/               ← GSD workflow skill (installed via clawhub)
├── .planning/             ← GSD project planning (created 2026-03-21)
│   ├── PROJECT.md
│   ├── config.json
│   └── codebase/          ← this directory
└── node_modules/
```

## Key Files & Responsibilities

| File | Lines | Role |
|------|-------|------|
| `bridge.js` | 276 | HTTP server, GraphRAG pipeline, Gemini integration |
| `sync.js` | 354 | IMAP ingestion, profile building, vectorization |
| `chrome-extension/content.js` | 264 | Gmail DOM observer, banner states, HTTP trigger |
| `verify_table.js` | 55 | DB smoke test |
| `chrome-extension/manifest.json` | 16 | Chrome extension config |

## Where to Add New Code

| Task | Location |
|------|----------|
| New HTTP endpoint | `bridge.js` — add route in `server.createServer` callback (line 256) |
| New DB table | `sync.js` — add to `db.exec()` block (line 38) |
| New sync step | `sync.js` — add function, call from `main()` (line 332) |
| New banner state | `chrome-extension/content.js` — add function following `showLoadingBanner` pattern |
| New analysis dimension | `bridge.js` — extend `buildPrompt()` (line 88) and `handleTrigger()` response |
| New SQL prepared statement | `bridge.js:50-71` — with other `db.prepare()` singletons |

## Database File

- `database.db` — SQLite database (excluded from git, ~local only)
- `database.db-wal` — WAL journal (transient, excluded)
- `database.db-shm` — Shared memory (transient, excluded)

## Missing Files (Bugs)

- `ingest.js` — referenced in `package.json "start"` script but **does not exist**
- `.env` — required but not present (must be created manually)
- `.env.example` — does not exist (should document required vars)
- `README.md` — does not exist
