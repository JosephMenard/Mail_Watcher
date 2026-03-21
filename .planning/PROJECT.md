# Mail Watcher

## What This Is

Mail Watcher est un système de surveillance d'emails basé sur Gmail (via MCP Gmail), avec une extension Chrome et un bridge Node.js. Il synchronise et monitore des emails en temps réel, avec une architecture bridge → extension Chrome.

## Core Value

Surveiller et notifier en temps réel les emails Gmail entrants, avec filtrage et vérification de table.

## Stack

- **Runtime:** Node.js
- **APIs:** Gmail MCP (`mcp__claude_ai_Gmail__*`)
- **Extension:** Chrome Extension (manifest v3)
- **Scripts:** `bridge.js`, `sync.js`, `verify_table.js`

## Code Intelligence

> Ce projet est indexé par **GitNexus** (41 symboles, 93 relations, 6 flux d'exécution).
> **Toutes les phases GSD DOIVENT utiliser GitNexus** pour l'exploration et la modification de code.

### GitNexus MCP Tools

| Tool | Usage |
|------|-------|
| `gitnexus_query` | Explorer les flux d'exécution par concept |
| `gitnexus_context` | Vue 360° d'un symbole (callers, callees, flows) |
| `gitnexus_impact` | Blast radius avant toute modification |
| `gitnexus_detect_changes` | Vérifier scope avant commit |
| `gitnexus_rename` | Renommer en respectant le graph |
| `gitnexus_cypher` | Requêtes graph personnalisées |

### GitNexus Resources

- `gitnexus://repo/Mail_Watcher/context` — Vue globale, fraîcheur de l'index
- `gitnexus://repo/Mail_Watcher/processes` — Tous les flux d'exécution
- `gitnexus://repo/Mail_Watcher/clusters` — Zones fonctionnelles

## Requirements

### Validated

- ✓ Surveillance emails Gmail via MCP — existing
- ✓ Bridge Chrome Extension ↔ Gmail — existing
- ✓ Synchronisation emails (`sync.js`) — existing
- ✓ Vérification de table (`verify_table.js`) — existing

### Active

(À définir lors de `/gsd new-project`)

### Out of Scope

(À définir lors de `/gsd new-project`)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| GitNexus obligatoire dans toutes les phases | 93 relations connues — éviter régressions | Enforced dans agents |

---
*Last updated: 2026-03-21 after GSD initialization*
