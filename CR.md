# Compte-Rendu d'Analyse Technique — Mail_Watcher (Sentinel)

> Généré le 2026-03-21 | Analyste : Claude Code (subagent)

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Architecture globale](#2-architecture-globale)
3. [Analyse fichier par fichier](#3-analyse-fichier-par-fichier)
4. [Diagramme de flux ASCII](#4-diagramme-de-flux-ascii)
5. [Points forts](#5-points-forts)
6. [Points faibles / Risques](#6-points-faibles--risques)
7. [Points d'amélioration](#7-points-damélioration)
8. [Résultats gitnexus](#8-résultats-gitnexus)

---

## 1. Vue d'ensemble

**Sentinel** est un système de détection de phishing et d'analyse de menaces email, conçu pour opérer en temps réel sur Gmail. Il combine :

- **Ingestion IMAP** d'une boîte Gmail via ImapFlow
- **Stockage SQL + vectoriel** via SQLite (better-sqlite3) + sqlite-vec
- **Embeddings sémantiques** générés par Ollama (nomic-embed-text, 768 dimensions)
- **Analyse GraphRAG** : recherche des emails les plus proches via KNN (distance L2 sur vecteurs)
- **Analyse LLM** : prompt SOC niveau 2 envoyé à Gemini 2.5 Flash
- **Extension Chrome** qui se greffe sur Gmail et affiche un bandeau de risque en temps réel

### Stack technique

| Couche | Technologie |
|--------|-------------|
| Runtime | Node.js (ESM, `"type": "module"`) |
| Base de données | SQLite (better-sqlite3) + sqlite-vec (virtuel float[768]) |
| Ingestion email | ImapFlow + mailparser + html-to-text |
| Embeddings | Ollama local (`nomic-embed-text`) |
| LLM analyse | Google Gemini 2.5 Flash (`@google/genai`) |
| Interface | Extension Chrome Manifest V3 (content script) |
| Transport | HTTP natif Node.js (pas d'Express) |
| Config | dotenv (.env) |

### Inventaire des fichiers sources

```
Mail_Watcher/
├── sync.js              — Pipeline d'ingestion IMAP → SQL → Vecteurs
├── bridge.js            — Serveur HTTP local (port 3000), GraphRAG + Gemini
├── verify_table.js      — Script de diagnostic de la base
├── package.json         — Manifest NPM
├── .gitignore           — Exclut database.db (fichiers WAL)
└── chrome-extension/
    ├── manifest.json    — Manifest Chromium MV3
    └── content.js       — Content script Gmail (observer + UI bannière)
```

---

## 2. Architecture globale

### Composants principaux

```
┌─────────────────────────────────────────────────────────────┐
│  PHASE OFFLINE (sync.js)                                    │
│  Exécuté manuellement ou en cron                            │
│                                                             │
│  Gmail IMAP ──► ImapFlow ──► mailparser ──► SQLite          │
│                                             emails          │
│                                             sender_profiles │
│                              Ollama ──────► vec_emails      │
│                          (nomic-embed-text)                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  PHASE ONLINE (bridge.js)                                   │
│  Serveur HTTP permanent sur localhost:3000                   │
│                                                             │
│  Chrome Extension ──POST /trigger──► bridge.js              │
│                                         │                   │
│                                    SQLite KNN               │
│                                    (vec_emails)             │
│                                         │                   │
│                                    Gemini 2.5 Flash         │
│                                         │                   │
│                                    JSON response            │
│                                         │                   │
│  Gmail UI ◄──── content.js ────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

### Schéma de base de données

```sql
emails              — stock brut des messages
  id, message_id (UNIQUE), sender, subject, clean_body, received_at

sender_profiles     — agrégat par expéditeur
  sender_email (PK), interaction_count, first_contact_date,
  last_contact_date, trust_score

vec_emails          — table virtuelle sqlite-vec
  rowid → FK vers emails.id
  embedding float[768]
```

---

## 3. Analyse fichier par fichier

### 3.1 `sync.js` — Pipeline d'ingestion

**Rôle :** Script autonome (lancé manuellement ou via cron) qui réalise la synchronisation en 3 étapes séquentielles.

**Étape 1 — IMAP Sync (`syncImap()`)**
- Connexion TLS à `imap.gmail.com:993` via ImapFlow
- Recherche incrémentale : récupère le `MAX(received_at)` en base pour ne télécharger que les nouveaux messages
- Fallback : si la base est vide, remonte 30 jours en arrière
- Traitement par lots de 500 UIDs (`IMAP_BATCH = 500`)
- Parse chaque message avec `simpleParser` (mailparser), extraction du corps : texte brut prioritaire, sinon HTML converti via `html-to-text`
- Insertion SQL transactionnelle avec `INSERT OR IGNORE` (déduplication sur `message_id`)
- Gestion des erreurs par message (skip avec log, pas d'abandon total)

**Étape 2 — Profils SQL (`updateProfiles()`)**
- Recalcul full par `INSERT … ON CONFLICT DO UPDATE`
- Normalisation de l'adresse email : extraction depuis `"Nom <email>"` via SQL pur (`INSTR`, `SUBSTR`, `REPLACE`)
- Agrège : `interaction_count`, `first_contact_date`, `last_contact_date`
- `trust_score` fixé à 50 (non calculé dynamiquement — voir points faibles)

**Étape 3 — Vectorisation (`vectorizeNew()`)**
- Identifie les emails sans vecteur via `LEFT JOIN vec_emails … WHERE v.rowid IS NULL`
- Table temporaire `vec_skip` pour blacklister les IDs en échec permanent (évite les boucles infinies)
- Construction d'un input enrichi (expéditeur + sujet + historique + date + contenu tronqué à 500 chars)
- Appel HTTP à Ollama (`nomic-embed-text`, 768 dims)
- Stockage dans `vec_emails` via `Float32Array`
- Traitement par lots de 100 (`VEC_BATCH = 100`)

**Points notables :**
- WAL mode activé + `synchronous = NORMAL` : bon compromis performance/sécurité
- Les transactions SQLite sont bien utilisées pour les insertions batch
- La gestion de la `vec_skip` table temporaire est astucieuse pour éviter les reruns infinis

---

### 3.2 `bridge.js` — Serveur HTTP + GraphRAG + Gemini

**Rôle :** Serveur HTTP léger sur `localhost:3000`, seul point d'entrée pour l'extension Chrome. Orchestre la récupération contextuelle (GraphRAG) et l'analyse Gemini.

**Endpoint unique : `POST /trigger`**

Payload attendu :
```json
{ "sender": "email@domain.com", "subject": "Sujet du mail" }
```

**Pipeline d'analyse :**
1. Recherche de l'email dans SQLite (`findEmail`) — match par `sender LIKE ?` et sujet exact
2. Récupération du profil expéditeur (`findProfile`)
3. Recherche KNN — 3 emails les plus proches sémantiquement via `vec_distance_L2` (hors email courant)
4. Construction du prompt SOC (contexte relationnel + historique similaire + email cible)
5. Appel Gemini 2.5 Flash → réponse JSON `{score_risque_sur_100, type_menace, explication}`
6. Retour JSON enrichi à l'extension

**Gestion CORS :**
- Restreint à `https://mail.google.com` (origine fixe)
- Support `OPTIONS` preflight

**Logging :**
- Logs colorés ANSI dans le terminal (SEP = `─`, SEP2 = `═`)
- Affichage du prompt complet envoyé à Gemini
- Code couleur du score (🟢 ≤30, 🟡 ≤60, 🔴 >60)

**Sécurité :**
- Base SQLite ouverte en **readonly** — excellente pratique
- CORS restreint à mail.google.com

**Limites détectées :**
- Le match `sender LIKE %email%` est fragile (voir section risques)
- Pas d'authentification sur le endpoint `/trigger`
- Gemini est appelé sans retry ni gestion de rate-limiting

---

### 3.3 `verify_table.js` — Outil de diagnostic

**Rôle :** Script read-only de vérification rapide de l'état de la base.

**Checks effectués :**
1. Comptage des 3 tables (`emails`, `sender_profiles`, `vec_emails`)
2. Alerte si le nombre de mails ≠ nombre de vecteurs
3. Vérification de la dimensionnalité via `vec_length(embedding)` (attendu : 768)
4. Affichage du top expéditeur (le plus de mails)

**Usage :** `node verify_table.js` — outil de débogage post-sync.

---

### 3.4 `chrome-extension/content.js` — Interface Gmail

**Rôle :** Content script injecté sur `mail.google.com`. Détecte l'ouverture d'un email et affiche un bandeau Sentinel.

**Mécanisme de détection :**
- `MutationObserver` sur `document.body` (childList + subtree)
- Extraction du sujet via `document.querySelector('h2.hP')` (sélecteur Gmail spécifique)
- Extraction de l'expéditeur via `span.gD[email]`
- Déduplication : `hasBeenSent` + comparaison `lastSubject` pour éviter les requêtes multiples

**États du banner :**
1. **Loading** : spinner SVG animé CSS (`@keyframes sentinel-spin`)
2. **Résultat** : score coloré, type de menace, profil expéditeur, accordéon détails (explication + emails similaires)
3. **Erreur** : "serveur inaccessible" si `localhost:3000` ne répond pas

**Insertion DOM :**
- Banner inséré juste avant `h2.hP` via `parentElement.insertBefore`

**Limites :**
- Sélecteurs CSS Gmail hardcodés (fragiles aux mises à jour Gmail)
- Pas de `host_permissions` pour `https://mail.google.com` dans le manifest (seulement `http://localhost:3000/`)
- Appel `http://` depuis `https://` = Mixed Content → bloqué par Chrome en production sans flag

---

### 3.5 `chrome-extension/manifest.json`

- Manifest V3 (correct, MV2 deprecated)
- `content_scripts` sur `https://mail.google.com/*`
- `host_permissions` sur `http://localhost:3000/` uniquement
- **Absence de `host_permissions` pour `https://mail.google.com`** — potentiellement problématique

---

### 3.6 `package.json`

- Nom interne : `sentinel-ingest` (incohérent avec le dossier `Mail_Watcher`)
- ESM natif (`"type": "module"`)
- Script `start` pointe vers `ingest.js` — **fichier inexistant** (devrait être `sync.js` ou `bridge.js`)
- Dépendance `gitnexus` et `get-shit-done-cc` en production (outils dev, inutiles en prod)

---

## 4. Diagramme de flux ASCII

```
╔══════════════════════════════════════════════════════════════════╗
║                    FLUX COMPLET — SENTINEL                       ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  PHASE 1 : INGESTION (sync.js)                                   ║
║                                                                  ║
║  ┌──────────┐   IMAP/TLS   ┌────────────┐  parse  ┌──────────┐  ║
║  │  Gmail   │─────────────►│ ImapFlow   │────────►│mailparser│  ║
║  │  INBOX   │              │ (batch 500)│         └────┬─────┘  ║
║  └──────────┘              └────────────┘              │        ║
║                                                        ▼        ║
║                                                 ┌────────────┐  ║
║                                                 │  SQLite    │  ║
║                                                 │  emails    │  ║
║                                                 └─────┬──────┘  ║
║                                                       │         ║
║                                               UPDATE  ▼         ║
║                                           ┌─────────────────┐  ║
║                                           │ sender_profiles │  ║
║                                           └────────┬────────┘  ║
║                                                    │           ║
║  ┌──────────────────┐   HTTP POST   ┌──────────┐   │           ║
║  │  Ollama local    │◄──────────────│ vectorize│◄──┘           ║
║  │  nomic-embed-text│               │ (batch   │               ║
║  │  768 dims        │               │  100)    │               ║
║  └────────┬─────────┘               └──────────┘               ║
║           │  Float32Array                                       ║
║           ▼                                                     ║
║  ┌─────────────────┐                                            ║
║  │   vec_emails    │  ← sqlite-vec virtual table                ║
║  │  float[768]     │                                            ║
║  └─────────────────┘                                            ║
║                                                                  ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  PHASE 2 : ANALYSE TEMPS RÉEL (bridge.js + content.js)          ║
║                                                                  ║
║  ┌─────────┐  ouverture   ┌──────────────┐                      ║
║  │  Gmail  │─────email───►│  content.js  │                      ║
║  │ (Chrome)│              │  (observer)  │                      ║
║  └────┬────┘              └──────┬───────┘                      ║
║       │                          │ POST /trigger                ║
║       │  bannière                │ {sender, subject}            ║
║       │  résultat                ▼                              ║
║       │             ┌─────────────────────┐                     ║
║       │             │     bridge.js        │                     ║
║       │             │    :3000             │                     ║
║       │             └──────────┬──────────┘                     ║
║       │                        │                                ║
║       │            ┌───────────┼────────────┐                   ║
║       │            ▼           ▼            ▼                   ║
║       │       findEmail   findProfile    findKnn                 ║
║       │       (SQLite)    (SQLite)      (vec L2 KNN)            ║
║       │            └───────────┼────────────┘                   ║
║       │                        ▼                                ║
║       │             ┌─────────────────────┐                     ║
║       │             │  buildPrompt (SOC)  │                     ║
║       │             └──────────┬──────────┘                     ║
║       │                        │                                ║
║       │                        ▼                                ║
║       │             ┌─────────────────────┐                     ║
║       │             │  Gemini 2.5 Flash   │                     ║
║       │             │  (Google Cloud)     │                     ║
║       │             └──────────┬──────────┘                     ║
║       │                        │ JSON                           ║
║       │                        │ {score, type, explication}     ║
║       │             ┌──────────┴──────────┐                     ║
║       └─────────────│   bannière résultat │                     ║
║                     └─────────────────────┘                     ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## 5. Points forts

### Architecture
- **Séparation claire des responsabilités** : ingestion (sync.js) / analyse (bridge.js) / UI (content.js)
- **SQLite + sqlite-vec** : stack locale sans infrastructure externe (Postgres, Redis, Pinecone) — déploiement ultra-simple
- **WAL mode** activé : permet lectures concurrentes pendant les écritures sync
- **Readonly DB** dans bridge.js : isolation de sécurité correcte

### Code
- **Gestion incrémentale intelligente** : `MAX(received_at)` évite de re-télécharger tous les emails
- **Transactions SQLite batch** pour les insertions : performance correcte
- **Table `vec_skip`** temporaire : évite les boucles infinies sur les emails non-vectorisables
- **Déduplication** par `message_id UNIQUE` : robuste aux reruns

### UX/Sécurité
- **CORS restreint** à `mail.google.com`
- **Prompt SOC niveau 2** : contexte relationnel + KNN = approche GraphRAG pertinente
- **Bandeau non-intrusif** avec état de chargement, erreur gracieuse si serveur absent
- **Score de risque visuel** (🟢🟡🔴) immédiatement compréhensible

### Infrastructure locale
- **Zéro dépendance cloud pour les embeddings** (Ollama local) — données restent sur la machine
- **Manifest V3** pour l'extension : conforme aux standards actuels Chrome

---

## 6. Points faibles / Risques

### 🔴 Risques critiques

**R1 — Mixed Content : HTTP depuis HTTPS**
- `content.js` appelle `http://localhost:3000/trigger` depuis `https://mail.google.com`
- Chrome bloque les requêtes HTTP depuis des pages HTTPS par défaut
- Impact : l'extension ne fonctionne qu'avec un flag Chrome non standard ou en mode développeur
- Solution requise : HTTPS local (certificat auto-signé) ou Chrome extension bypass via `"localhost"` exception

**R2 — Fichier `ingest.js` manquant**
- `package.json` définit `"start": "node ingest.js"` mais ce fichier n'existe pas
- Impact : `npm start` échoue immédiatement
- Le point d'entrée réel est `sync.js`

**R3 — Aucun fichier `.env`**
- `.gitignore` exclut `database.db*` mais aucune protection visible pour `.env`
- `EMAIL` et `APP_PASSWORD` (mot de passe applicatif Gmail) et `GEMINI_API_KEY` sont en clair dans l'environnement
- Risque de fuite si `.env` est accidentellement committé

### 🟡 Risques modérés

**R4 — Recherche email fragile (`LIKE %sender%`)**
- `findEmail` utilise `sender LIKE '%${sender}%'` — peut matcher plusieurs emails non liés
- Si un expéditeur a un email qui est substring d'un autre, faux positifs possibles
- Devrait utiliser une recherche exacte sur l'adresse normalisée

**R5 — trust_score non calculé**
- `trust_score` est toujours initialisé à 50 et jamais mis à jour dynamiquement
- Champ présent dans le schéma mais inutilisé dans l'analyse
- Perd une dimension d'information potentiellement utile pour le scoring

**R6 — Sélecteurs CSS Gmail hardcodés**
- `h2.hP`, `span.gD[email]` sont des classes internes Gmail non documentées
- Toute mise à jour de l'UI Gmail peut casser silencieusement l'extension
- Aucun mécanisme de fallback ou de détection d'échec

**R7 — Aucune authentification sur `/trigger`**
- N'importe quel processus local peut envoyer des requêtes à `localhost:3000`
- Risque limité (localhost uniquement) mais non nul (SSRF, extensions malveillantes)

**R8 — Ollama requis localement sans health-check**
- Si Ollama n'est pas démarré, sync.js échoue silencieusement email par email (tous en `vec_skip`)
- Pas de vérification préalable de la disponibilité du service

### 🟢 Points mineurs

**R9 — Dépendances de dev en production**
- `gitnexus` et `get-shit-done-cc` sont dans `dependencies` (pas `devDependencies`)
- Alourdissent inutilement le `node_modules` en production

**R10 — Nom du package incohérent**
- `package.json` déclare `"name": "sentinel-ingest"` alors que le projet s'appelle `Mail_Watcher`

**R11 — Pas de tests automatisés**
- Aucun fichier de test présent
- `verify_table.js` fait office de smoke test mais n'est pas automatisé

**R12 — MAX_BODY_CHARS très court (500 chars)**
- Le contexte tronqué peut manquer des indicateurs de phishing dans le corps long d'un email
- Commentaire indique "~150-200 tokens" mais le contexte de nomic-embed-text supporte 8192 tokens

---

## 7. Points d'amélioration

### P1 — Critique (Bloquant en production)

#### P1.1 — Corriger le Mixed Content HTTP/HTTPS
- **Description** : Remplacer l'appel `http://localhost:3000` par une solution compatible Chrome. Options : (a) utiliser `chrome.runtime.sendMessage` + service worker pour proxifier, (b) générer un certificat auto-signé pour localhost, (c) utiliser l'API `chrome.declarativeNetRequest` pour rewrite l'URL.
- **Impact** : Sans cette correction, l'extension ne fonctionne pas en contexte réel.
- **Effort** : Moyen (2-4h selon l'approche choisie)

#### P1.2 — Corriger le script `start` dans package.json
- **Description** : Remplacer `"start": "node ingest.js"` par `"sync": "node sync.js"` et `"serve": "node bridge.js"`.
- **Impact** : `npm start` échoue. Confusion pour tout nouveau développeur.
- **Effort** : Faible (5 min)

#### P1.3 — Protéger le fichier .env
- **Description** : Ajouter `.env` et `.env.*` au `.gitignore`. Créer un `.env.example` avec des valeurs placeholder. Documenter les variables requises dans le README.
- **Impact** : Risque de fuite de credentials Gmail et Gemini API Key.
- **Effort** : Faible (15 min)

---

### P2 — Important (Améliore la robustesse)

#### P2.1 — Robustifier la recherche d'email dans bridge.js
- **Description** : Remplacer le `sender LIKE '%..%'` par une normalisation de l'adresse et une comparaison exacte. Ajouter un index sur `emails(received_at)` et `sender_profiles(sender_email)`.
- **Impact** : Élimine les faux positifs dans la recherche. Améliore les performances sur grandes bases.
- **Effort** : Moyen (1-2h)

#### P2.2 — Health-check Ollama avant vectorisation
- **Description** : Ajouter un `GET http://localhost:11434/` ou `/api/tags` avant de lancer `vectorizeNew()`. Si Ollama est down, lever une erreur claire et arrêter le script proprement plutôt que de spam `vec_skip`.
- **Impact** : Évite de corrompre silencieusement la base (tous les nouveaux mails en skip).
- **Effort** : Faible (30 min)

#### P2.3 — Calculer dynamiquement le trust_score
- **Description** : Implémenter une logique de trust_score basée sur : ancienneté de la relation (`first_contact_date`), fréquence d'interaction, domaine email (whitelist/blacklist), score moyen des analyses Gemini passées. Mettre à jour via trigger ou colonne dérivée.
- **Impact** : Enrichit le contexte transmis à Gemini et améliore la qualité de l'analyse.
- **Effort** : Moyen-élevé (4-8h)

#### P2.4 — Ajouter un mécanisme de résilience sur les sélecteurs Gmail
- **Description** : Dans `content.js`, logguer une erreur explicite si `h2.hP` ou `span.gD[email]` ne sont pas trouvés. Ajouter des sélecteurs alternatifs en fallback. Implémenter un test de présence DOM avant l'observe.
- **Impact** : Détecte les ruptures d'API Gmail silencieusement.
- **Effort** : Faible (1h)

#### P2.5 — Augmenter MAX_BODY_CHARS
- **Description** : Passer `MAX_BODY_CHARS` de 500 à 2000-4000 caractères. Nomic-embed-text supporte 8192 tokens. Un corps plus long améliore la qualité des embeddings et donc la pertinence du KNN.
- **Impact** : Meilleure détection d'anomalies sémantiques dans les corps d'emails longs.
- **Effort** : Faible (changement d'une constante + test de perf)

---

### P3 — Nice-to-have (Qualité & maintenabilité)

#### P3.1 — Mettre en place un README
- **Description** : Créer un `README.md` documentant : prérequis (Ollama, Node.js, extension Chrome), variables d'environnement, commandes de démarrage (`sync.js`, `bridge.js`), architecture, installation de l'extension.
- **Impact** : Onboarding impossible sans documentation actuellement.
- **Effort** : Faible-Moyen (2-3h)

#### P3.2 — Ajouter des tests automatisés
- **Description** : Implémenter des tests avec Node.js `test` runner (natif, pas de Jest nécessaire) : (a) unit tests sur `extractBody`, `extractAddress`, `buildPrompt`, (b) integration test sur `verify_table.js` (smoke test à intégrer en CI).
- **Impact** : Évite les régressions lors des modifications.
- **Effort** : Moyen (4-6h)

#### P3.3 — Mettre `gitnexus` et `get-shit-done-cc` en devDependencies
- **Description** : Déplacer ces packages de `dependencies` vers `devDependencies` dans package.json.
- **Impact** : Réduit le poids de `node_modules` en production.
- **Effort** : Minimal (5 min)

#### P3.4 — Implémenter un retry/backoff pour Gemini
- **Description** : Ajouter une logique de retry (3 tentatives, backoff exponentiel) sur l'appel `analyzeWithGemini`. Google Gemini peut retourner des 429 (rate limit) ou des 5xx transitoires.
- **Impact** : Améliore la fiabilité en production.
- **Effort** : Faible (1h)

#### P3.5 — Persister les résultats d'analyse Gemini
- **Description** : Ajouter une table `analyses` (email_id, score, type_menace, explication, analyzed_at) pour stocker les résultats Gemini. Permet de re-consulter une analyse sans rappeler l'API, de tracer l'historique des scores, et d'alimenter le `trust_score`.
- **Impact** : Meilleure traçabilité, économie d'appels API, enrichissement du contexte.
- **Effort** : Moyen (2-4h)

---

## 8. Résultats gitnexus

```
GitNexus Analyzer

  Repository indexed successfully (3.3s)

  41 nodes | 93 edges | 5 clusters | 6 flows
  LadybugDB 0.6s | FTS 2.2s | Embeddings off
  Context: AGENTS.md (created), CLAUDE.md (created), .claude/skills/gitnexus/ (6 skills)
```

**Interprétation :**
- **41 nœuds** : variables, fonctions, modules identifiés dans le graphe de code
- **93 edges** : dépendances et relations entre composants
- **5 clusters** : groupes logiques détectés (sync pipeline, bridge server, chrome extension, DB schema, helpers)
- **6 flows** : flux de données principaux identifiés (IMAP→SQL, SQL→VEC, HTTP→KNN, KNN→Gemini, Gemini→Chrome, etc.)

---

*Analyse générée par Claude Code — subagent Sentinel CR v1.0*
