# Mail Watcher / Sentinel — Détection phishing email temps réel

Système de détection de phishing et de spear-phishing en temps réel pour Gmail, développé par **ZefCorp**.

## Stack technique

| Composant | Technologie |
|-----------|-------------|
| Extension navigateur | Chrome MV3 (Service Worker + Content Script) |
| Backend | Node.js ESM (bridge.js) |
| Base de données | SQLite + sqlite-vec (vecteurs float[768]) |
| Embeddings | Google text-embedding-004 (768 dims) |
| Analyse IA | Gemini 2.5 Flash (GraphRAG + SOC prompt) |
| Ingestion mail | IMAP via ImapFlow |

## Setup

```bash
# 1. Copier et remplir les variables d'environnement
cp .env.example .env
# Editer .env : renseigner GEMINI_API_KEY, EMAIL, APP_PASSWORD

# 2. Installer les dépendances
npm install

# 3. Démarrer le bridge (serveur HTTP :3000)
npm start

# 4. Lancer la synchronisation email (dans un autre terminal)
npm run sync
```

## Variables d'environnement

| Variable | Description | Défaut |
|----------|-------------|--------|
| `GEMINI_API_KEY` | Clé API Google Gemini (obligatoire) | — |
| `EMAIL` | Adresse Gmail à surveiller | — |
| `APP_PASSWORD` | Mot de passe d'application Gmail | — |
| `BRIDGE_PORT` | Port du serveur HTTP | `3000` |
| `DB_PATH` | Chemin vers la base SQLite | `./database.db` |
| `MAX_BODY_CHARS` | Taille max du corps analysé | `2000` |

## Architecture

```
sync.js          — Ingestion IMAP → SQLite → embeddings text-embedding-004
bridge.js        — Serveur HTTP :3000, GraphRAG + Gemini 2.5 Flash, trust score AWL, cache analyses
chrome-extension/
  background.js  — Service Worker MV3 (proxy fetch HTTP → évite Mixed Content)
  content.js     — Injection bannière Gmail, extraction DOM, délègue fetch au SW
  manifest.json  — MV3, permissions activeTab + storage
```

### Flux d'analyse

1. L'utilisateur ouvre un email dans Gmail
2. `content.js` détecte le changement DOM (MutationObserver), extrait expéditeur + sujet
3. `fetchViaBackground()` délègue la requête au Service Worker (évite Mixed Content HTTPS→HTTP)
4. `bridge.js` cherche l'email en base, vérifie le cache (`analyses`), appelle Gemini si nécessaire
5. Le trust score dynamique (`sender_history`) ajuste le score brut selon l'historique de l'expéditeur
6. La bannière colorée (vert/jaune/rouge) s'affiche dans Gmail avec le score, le type de menace et l'explication

## Scripts npm

| Commande | Action |
|----------|--------|
| `npm start` | Démarre le serveur bridge (port 3000) |
| `npm run sync` | Lance la synchronisation IMAP |
| `npm run dev` | Bridge en mode watch (rechargement auto) |
| `npm run verify` | Diagnostique la base de données |

## Charger l'extension Chrome

1. Ouvrir `chrome://extensions`
2. Activer le **mode développeur**
3. Cliquer **Load unpacked**
4. Sélectionner le dossier `./chrome-extension/`

## ZefCorp

Ce projet est développé et maintenu par **ZefCorp** dans le cadre de son infrastructure de sécurité email. Agent exécutant : **Zorro**.
