# CONCERNS.md — Technical Debt & Issues
*Generated: 2026-03-21 | Project: Mail_Watcher (Sentinel)*

## 🔴 CRITICAL (Blocking in production)

### C1 — Mixed Content: HTTP from HTTPS
- **File:** `chrome-extension/content.js:228`
- **Issue:** `fetch('http://localhost:3000/trigger')` called from `https://mail.google.com`
- **Impact:** Chrome blocks mixed content by default → extension non-functional in real use
- **Fix:** Use HTTPS on `bridge.js` with a self-signed cert, or service worker proxy pattern

### C2 — Missing `ingest.js` entry point
- **File:** `package.json` — `"start": "node ingest.js"`
- **Issue:** `ingest.js` does not exist; `npm start` fails immediately
- **Fix:** Change to `"sync": "node sync.js"` and `"serve": "node bridge.js"`

### C3 — `.env` not in `.gitignore`
- **File:** `.gitignore`
- **Issue:** `EMAIL`, `APP_PASSWORD`, `GEMINI_API_KEY` could be leaked if `.env` is committed
- **Fix:** Add `.env` and `.env.*` to `.gitignore`; create `.env.example`

## 🟡 MODERATE (Robustness issues)

### C4 — Fragile email match with `LIKE %sender%`
- **File:** `bridge.js:50-54`
- **Issue:** `WHERE sender LIKE ? AND subject = ?` with `%${sender}%` can produce false positives if one email is a substring of another
- **Fix:** Normalize address first (extract from `<email>` format), then exact match

### C5 — `trust_score` always 50, never updated
- **File:** `sync.js:186`
- **Issue:** `trust_score` column exists in schema but is hardcoded to 50 and never computed
- **Impact:** A key analytical dimension is unused; reduces Gemini analysis quality
- **Fix:** Compute dynamically from `interaction_count`, `first_contact_date`, domain reputation

### C6 — Hardcoded Gmail DOM selectors
- **File:** `chrome-extension/content.js:10-11`
- **Issue:** `h2.hP` and `span.gD[email]` are internal Gmail CSS classes — undocumented, can change any time
- **Impact:** Silent breakage on Gmail UI updates
- **Fix:** Add fallback selectors, log explicit error when selectors fail

### C7 — No Ollama health-check before vectorization
- **File:** `sync.js:216`
- **Issue:** If Ollama is down, every email in batch gets added to `vec_skip` silently
- **Impact:** Database populated with skipped emails, hard to recover without manual cleanup
- **Fix:** `GET http://localhost:11434/api/tags` check before `vectorizeNew()`

### C8 — No retry/backoff on Gemini calls
- **File:** `bridge.js:181`
- **Issue:** Single call to Gemini, no retry on 429/5xx
- **Impact:** Transient errors cause analysis to fail for that email
- **Fix:** 3-retry exponential backoff

## 🟢 MINOR (Quality & maintainability)

### C9 — `gitnexus` and `get-shit-done-cc` in `dependencies`
- **File:** `package.json`
- **Issue:** Dev tools in production dependencies — inflates `node_modules`
- **Fix:** Move to `devDependencies`

### C10 — Package name mismatch
- **File:** `package.json`
- **Issue:** `"name": "sentinel-ingest"` ≠ directory name `Mail_Watcher`
- **Fix:** Align name with project identity

### C11 — No automated tests
- **All files**
- **Issue:** Zero test coverage; `verify_table.js` is only manual smoke test
- **Fix:** Add node:test unit tests for pure functions

### C12 — `MAX_BODY_CHARS = 500` too restrictive
- **File:** `sync.js:21`
- **Issue:** 500 chars truncates email body; nomic-embed-text supports 8192 tokens
- **Fix:** Increase to 2000-4000 chars for better semantic embeddings

### C13 — No persistence of Gemini analysis results
- **File:** `bridge.js`
- **Issue:** Each email open re-calls Gemini; no caching or history
- **Fix:** Add `analyses` table (email_id, score, type_menace, explication, analyzed_at)

### C14 — No README
- **Root**
- **Issue:** No documentation for setup, prerequisites (Ollama, Node.js, Chrome extension), or env vars
- **Fix:** Create README.md

## GitNexus Debt Indicators

From the indexed graph (41 nodes, 93 edges, 6 flows):
- `bridge.js` has the highest coupling: `handleTrigger` calls `findEmail`, `findProfile`, `findKnn`, `buildPrompt`, `analyzeWithGemini`, `logPrompt`, `logGeminiResponse` — 7 direct dependencies at d=1
- `buildPrompt` is the most critical function: upstream from Gemini call, downstream from all DB queries
- `vectorizeNew` has a circular risk: the `vec_skip` temp table is session-scoped and lost on crash
