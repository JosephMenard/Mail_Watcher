# Mail Watcher / Sentinel — Documentation Agents

## Architecture réelle

| Fichier | Rôle |
|---------|------|
| `sync.js` | Ingestion IMAP → SQLite → embeddings Gemini text-embedding-004 |
| `bridge.js` | Serveur HTTP :3000, GraphRAG + Gemini 2.5 Flash, trust score AWL, cache analyses |
| `chrome-extension/background.js` | Service Worker MV3 — proxy fetch HTTPS (Mixed Content fix) |
| `chrome-extension/content.js` | Content script Gmail — MutationObserver, bannière, extractFromDOM |
| `chrome-extension/manifest.json` | Manifest MV3 — permissions, host_permissions, background SW |
| `verify_table.js` | Outil diagnostic base de données |

## Stack technique

| Composant | Détail |
|-----------|--------|
| Runtime | Node.js ESM (`"type": "module"`) |
| DB | SQLite (better-sqlite3) + sqlite-vec (float[768]) |
| Embeddings | Google text-embedding-004 via @google/genai |
| Analyse | Gemini 2.5 Flash (`gemini-2.5-flash`) |
| Ingestion | ImapFlow + mailparser + html-to-text |
| Extension | Chrome MV3 Service Worker |

## Rôles ZefCorp

| Agent | Rôle |
|-------|------|
| **Zlaw** | Chef de projet — décisions architecturales, priorités |
| **Zodiac** | Analyse et planification — conception des solutions |
| **Zola** | Recherche — investigation codebase, documentation externe |
| **Zorro** | Exécution — implémentation code, commits, livraisons |

## Conventions de développement

- **ESM uniquement** : tous les fichiers utilisent `import`/`export`, pas de `require()`
- **async/await** : pas de callbacks chaînés, pas de `.then()` imbriqués
- **Logs préfixés** : `[sync]`, `[bridge]`, `[trust]`, `[IMAP]`, `[VEC]`, `[SQL]`
- **MAX_BODY_CHARS = 2000** : troncature corps email à 2000 chars (configurable via `.env`)
- **Retry exponentiel** : Gemini et embeddings utilisent backoff 2^n × base_ms
- **Pas de dossier `src/`** : tous les fichiers JS à la racine du projet

## Phases implémentées

| Phase | Description |
|-------|-------------|
| 1.1 | Fix Mixed Content — background.js Service Worker MV3, manifest MV3, fetchViaBackground() |
| 1.2 | Fix package.json — name, scripts corrects |
| 1.3 | .gitignore complet, .env.example |
| 2.1 | normalizeEmail() dans bridge.js — recherche exacte par adresse |
| 2.2 | Migration embeddings Ollama → text-embedding-004 dans sync.js |
| 2.3 | Trust score dynamique — sender_history, computeTrustScore, updateSenderHistory |
| 2.4 | Cache analyses Gemini — table analyses, hashEmail, lookup avant appel |
| 2.5 | Retry Gemini — callGeminiWithRetry avec backoff exponentiel |
| 2.6 | MAX_BODY_CHARS = 2000 via env var dans sync.js et bridge.js |
| 3 | README.md complet |

---

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Mail_Watcher** (41 symbols, 93 relationships, 6 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/Mail_Watcher/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/Mail_Watcher/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Mail_Watcher/clusters` | All functional areas |
| `gitnexus://repo/Mail_Watcher/processes` | All execution flows |
| `gitnexus://repo/Mail_Watcher/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
