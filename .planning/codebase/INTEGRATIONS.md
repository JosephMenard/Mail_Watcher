# INTEGRATIONS.md — External Integrations
*Generated: 2026-03-21 | Project: Mail_Watcher (Sentinel)*

## 1. Gmail via IMAP (`sync.js`)

- **Library:** `imapflow` ^1.0.162
- **Host:** `imap.gmail.com:993` (TLS)
- **Auth:** `user` + `pass` (App Password, not OAuth)
- **Pattern:** Incremental fetch — `MAX(received_at)` determines since-date; fallback = last 30 days
- **Batch size:** 500 UIDs per fetch
- **Key file:** `sync.js:79` — `syncImap()`

## 2. Ollama (Local Embeddings)

- **URL:** `http://localhost:11434/api/embed`
- **Model:** `nomic-embed-text` → 768-dimension float vectors
- **Pattern:** HTTP POST per batch of 100 emails, `Float32Array` stored in `vec_emails`
- **Input format:** enriched string = sender + subject + interaction_count + date + body (≤500 chars)
- **Key file:** `sync.js:216` — `vectorizeNew()`
- **Risk:** No health-check before run; failed emails silently added to `vec_skip`

## 3. Google Gemini 2.5 Flash (`bridge.js`)

- **Library:** `@google/genai` ^1.44.0
- **Model:** `gemini-2.5-flash`
- **Pattern:** Single call per `/trigger` request, no retry/backoff
- **Prompt style:** SOC Level-2 analyst prompt with relational context + KNN history + target email
- **Expected JSON response:** `{ score_risque_sur_100: int, type_menace: string, explication: string }`
- **Key file:** `bridge.js:181` — `analyzeWithGemini()`
- **Risk:** Rate limiting not handled; Gemini called once per email open in Chrome

## 4. Chrome Extension → Bridge HTTP

- **Extension:** Chrome MV3 content script, injected on `https://mail.google.com/*`
- **Endpoint:** `POST http://localhost:3000/trigger`
- **Payload:** `{ sender: string, subject: string }`
- **CORS:** Bridge restricts `Access-Control-Allow-Origin` to `https://mail.google.com`
- **Risk (CRITICAL):** Mixed Content — HTTP from HTTPS page; blocked by Chrome without flag/exception
- **Key files:** `chrome-extension/content.js:225` — `trigger()`, `bridge.js:193` — `handleTrigger()`

## 5. GitNexus (Code Intelligence MCP)

- **Package:** `gitnexus` ^1.4.7 (in `dependencies`)
- **Index:** 41 nodes, 93 edges, 5 clusters, 6 execution flows
- **MCP Tools available:** `gitnexus_query`, `gitnexus_context`, `gitnexus_impact`, `gitnexus_detect_changes`, `gitnexus_rename`, `gitnexus_cypher`
- **Resource URIs:** `gitnexus://repo/Mail_Watcher/processes`, `gitnexus://repo/Mail_Watcher/clusters`
