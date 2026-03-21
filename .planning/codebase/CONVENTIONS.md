# CONVENTIONS.md — Coding Conventions
*Generated: 2026-03-21 | Project: Mail_Watcher (Sentinel)*

## Module System

- **ESM only** — all files use `import`/`export`, `"type": "module"` in package.json
- No CommonJS (`require`) — use `import` for all dependencies
- `import.meta.url` / `fileURLToPath` for `__dirname` equivalent (see `bridge.js:9`)

## JavaScript Style

### Naming
- `camelCase` for variables and functions: `syncImap`, `findEmail`, `buildPrompt`, `extractAddress`
- `UPPER_SNAKE_CASE` for constants: `IMAP_BATCH`, `VEC_BATCH`, `MAX_BODY_CHARS`, `OLLAMA_URL`, `BANNER_ID`
- Descriptive names preferred over abbreviations

### Functions
- Async functions for I/O: `async function syncImap()`, `async function vectorizeNew()`
- Pure synchronous helpers: `extractBody()`, `extractAddress()`, `formatTs()`, `buildPrompt()`
- No arrow functions for top-level async functions (uses `async function` declaration)
- Arrow functions used for callbacks and short helpers

### Database (better-sqlite3)
- **Always use `db.prepare()` singletons** — never inline SQL in handlers
- Statements declared at module level (before server starts)
- Batch inserts wrapped in `db.transaction()` for performance
- `INSERT OR IGNORE` for deduplication patterns
- `INSERT … ON CONFLICT DO UPDATE` for upsert patterns

### Error Handling
- Try/catch wrapping async entry points
- Per-item skip with `console.warn` (don't abort batch on single failure)
- `logError(context, err)` helper for bridge.js error display
- `process.exit(1)` only for fatal startup errors

## Visual/Display Style (Console)

- ANSI color object `C` with named properties: `C.cyan`, `C.green`, `C.red`, etc.
- Separator constants: `SEP` (single `─`), `SEP2` (double `═`)
- `riskColor(score)` / `riskEmoji(score)` for risk display
- Logs prefixed with `[COMPONENT]` e.g. `[IMAP]`, `[SQL]`, `[VEC]`, `[Sentinel]`

## Chrome Extension Style

- Vanilla JS (no framework, no bundler)
- DOM helpers grouped at top (`extractEmailData`, `getInsertionAnchor`, `injectStyles`)
- Banner state functions: `showLoadingBanner()`, `showResultBanner(json)`, `showErrorBanner()`
- CSS injected via `<style>` tag with unique id `STYLE_ID` (idempotent check)
- Element ids via constants: `BANNER_ID = 'sentinel-banner'`, `STYLE_ID = 'sentinel-styles'`

## Linting / Formatting

- No ESLint or Prettier config present
- No `.editorconfig`
- Follow existing style when contributing — 2-space indentation, single quotes for strings

## Comments

- Section separators: `// ─── Section Name ─────────────────────────────────` (ANSI-style)
- JSDoc not used — inline comments for non-obvious logic
- `// @ts-ignore` used where TypeScript would complain in pure JS context
