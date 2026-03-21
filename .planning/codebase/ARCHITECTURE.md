# ARCHITECTURE.md — System Architecture
*Generated: 2026-03-21 | Project: Mail_Watcher (Sentinel)*

## System Overview

Sentinel is a **local phishing/BEC detection system** with two independent phases:

```
PHASE OFFLINE                          PHASE ONLINE
─────────────────────────────────      ────────────────────────────────
sync.js (run manually/cron)            bridge.js (permanent HTTP server)
  │                                      │
  ▼                                      ▼
Gmail IMAP ──► SQLite (emails)         Chrome Extension (content.js)
                      │                  │  POST /trigger {sender, subject}
              sender_profiles            │
                      │                  ▼
              Ollama embed ──► vec_emails bridge.js:3000
                                              │
                                         SQLite KNN (L2 distance)
                                              │
                                         Gemini 2.5 Flash
                                              │
                                         JSON → Chrome banner
```

## Component Boundaries

| Component | Responsibility | Entry Point |
|-----------|---------------|-------------|
| `sync.js` | Offline ingestion pipeline: IMAP → SQL → vectors | `main()` at `sync.js:332` |
| `bridge.js` | Online HTTP server: GraphRAG + LLM analysis | `server.listen(3000)` at `bridge.js:270` |
| `verify_table.js` | DB diagnostic (read-only smoke test) | Direct execution |
| `chrome-extension/content.js` | Gmail UI injection + trigger | `MutationObserver` at `content.js:247` |

## Data Flow

### Sync Pipeline (`sync.js`)
```
syncImap()       → INSERT OR IGNORE into emails (dedup on message_id)
updateProfiles() → UPSERT sender_profiles (aggregated from emails)
vectorizeNew()   → SELECT unvectorized → Ollama embed → INSERT vec_emails
```

### Online Analysis (`bridge.js` + `content.js`)
```
Gmail DOM change
  → extractEmailData() {subject, sender}
  → POST /trigger
  → findEmail(sender LIKE %, subject =)   ← emails table
  → findProfile(sender_email =)            ← sender_profiles table
  → findKnn(vec_distance_L2, top 3)        ← vec_emails virtual table
  → buildPrompt(email + profile + knn)
  → analyzeWithGemini(prompt)              ← Gemini 2.5 Flash API
  → JSON {score, type_menace, explication}
  → showResultBanner() in Gmail DOM
```

## GitNexus Execution Flows (6 identified)

1. **IMAP→SQL**: `syncImap` → `ImapFlow.fetch` → `simpleParser` → `insertBatch`
2. **SQL→VEC**: `vectorizeNew` → `selectBatch` → Ollama HTTP → `insertVec`
3. **HTTP→KNN**: `handleTrigger` → `findEmail` + `findProfile` + `findKnn`
4. **KNN→Gemini**: `buildPrompt` → `analyzeWithGemini` → JSON parse
5. **Gemini→Chrome**: HTTP response → `showResultBanner` → DOM injection
6. **DOM→Trigger**: `MutationObserver` → `extractEmailData` → `trigger()`

## Clusters (5 detected by GitNexus)

1. **sync-pipeline** — `syncImap`, `updateProfiles`, `vectorizeNew`, `extractBody`
2. **bridge-server** — `handleTrigger`, `analyzeWithGemini`, `buildPrompt`, `formatTs`, `extractAddress`
3. **chrome-extension** — `trigger`, `extractEmailData`, `showResultBanner`, `showLoadingBanner`, `showErrorBanner`
4. **db-schema** — `findEmail`, `findProfile`, `findKnn`, `insertStmt`, `insertVec`
5. **helpers/display** — `riskColor`, `riskEmoji`, `logPrompt`, `logGeminiResponse`, `logError`, `C` (ANSI colors)

## State Management

- **No shared in-memory state** between bridge.js and sync.js — SQLite is the single source of truth
- **bridge.js** uses pre-compiled `db.prepare()` statements (singletons, `sync.js:50-71`)
- **content.js** maintains `hasBeenSent` + `lastSubject` booleans to debounce Gmail DOM events
