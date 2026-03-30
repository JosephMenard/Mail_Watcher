/**
 * sync.js — Synchronisation incrémentale : IMAP → Profils SQL → Vecteurs Gemini
 *
 * Dépendances : imapflow, better-sqlite3, sqlite-vec, html-to-text, mailparser, dotenv, @google/genai
 * Usage       : node sync.js
 */

import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { convert } from 'html-to-text';
import { simpleParser } from 'mailparser';
import { GoogleGenAI } from '@google/genai';

// ─── Config ───────────────────────────────────────────────────────────────────

const DB_PATH        = process.env.DB_PATH ?? './database.db';
const IMAP_BATCH     = 500;
const VEC_BATCH      = 100;
const VEC_LOG_EVERY  = 100;
const MAX_BODY_CHARS = parseInt(process.env.MAX_BODY_CHARS ?? '2000', 10);

if (!process.env.EMAIL || !process.env.APP_PASSWORD) {
  console.error('[FATAL] EMAIL et APP_PASSWORD doivent être définis dans le fichier .env');
  process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
  console.error('[FATAL] GEMINI_API_KEY doit être défini dans le fichier .env');
  process.exit(1);
}

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
sqliteVec.load(db);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS emails (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT UNIQUE,
    sender      TEXT,
    subject     TEXT,
    clean_body  TEXT,
    received_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sender_profiles (
    sender_email       TEXT    PRIMARY KEY,
    interaction_count  INTEGER NOT NULL,
    first_contact_date INTEGER NOT NULL,
    last_contact_date  INTEGER NOT NULL,
    trust_score        INTEGER NOT NULL DEFAULT 50
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS vec_emails USING vec0(embedding float[768]);
`);

// ─── Embedding ────────────────────────────────────────────────────────────────

const OLLAMA_URL   = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';

async function getEmbeddingGemini(text) {
  const response = await genai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: text,
    config: { outputDimensionality: 768 },
  });
  return response.embeddings[0].values; // 768 dims
}

async function getEmbeddingOllama(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.embedding) || json.embedding.length !== 768) {
    throw new Error(`Ollama: embedding invalide (dims=${json.embedding?.length})`);
  }
  return json.embedding;
}

async function getEmbedding(text) {
  try {
    return await getEmbeddingGemini(text);
  } catch (geminiErr) {
    console.warn(`[embed] Gemini échoué (${geminiErr.message}), fallback Ollama…`);
    return await getEmbeddingOllama(text);
  }
}

async function getEmbeddingWithRetry(text, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await getEmbedding(text);
    } catch (err) {
      if ((err.status === 429 || err.status === 503) && attempt < maxRetries - 1) {
        const waitMs = Math.pow(2, attempt) * 1000;
        console.warn('[sync] Rate limit embedding, retry dans ' + waitMs + 'ms');
        await new Promise(r => setTimeout(r, waitMs));
      } else throw err;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractBody(parsed) {
  if (parsed.text) {
    return parsed.text.replace(/\s+/g, ' ').trim();
  }
  if (parsed.html) {
    return convert(parsed.html, {
      wordwrap: false,
      selectors: [
        { selector: 'a',   options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
      ],
    }).replace(/\s+/g, ' ').trim();
  }
  return '';
}

// ─── Étape 1 : Ingestion IMAP incrémentale ────────────────────────────────────

async function syncImap() {
  console.log('\n==============================');
  console.log(' ÉTAPE 1 — IMAP SYNC');
  console.log('==============================');

  // Trouver la date du mail le plus récent en base
  const row = db.prepare('SELECT MAX(received_at) AS last_date FROM emails').get();
  const sinceDate = row?.last_date
    ? new Date(row.last_date * 1000)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // défaut : 30 jours

  console.log(`[IMAP] Recherche des nouveaux messages depuis ${sinceDate.toISOString().split('T')[0]}...`);

  const client = new ImapFlow({
    host:   'imap.gmail.com',
    port:   993,
    secure: true,
    auth: {
      user: process.env.EMAIL,
      pass: process.env.APP_PASSWORD,
    },
    logger: false,
  });

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO emails (message_id, sender, subject, clean_body, received_at)
    VALUES (@message_id, @sender, @subject, @clean_body, @received_at)
  `);

  // Compte uniquement les insertions réelles (changes = 0 si ignoré sur UNIQUE)
  const insertBatch = db.transaction((rows) => {
    let inserted = 0;
    for (const row of rows) {
      inserted += insertStmt.run(row).changes;
    }
    return inserted;
  });

  await client.connect();
  console.log('[IMAP] Connecté à Gmail (imap.gmail.com:993).');

  let totalInserted = 0;

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ since: sinceDate }, { uid: true });
      console.log(`[IMAP] ${uids.length} message(s) trouvé(s) dans la fenêtre temporelle.`);

      if (uids.length === 0) {
        console.log('[IMAP] Aucun nouveau message à ingérer.');
        return 0;
      }

      for (let i = 0; i < uids.length; i += IMAP_BATCH) {
        const batchUids = uids.slice(i, i + IMAP_BATCH);
        const uidRange  = batchUids.join(',');
        const rows      = [];

        for await (const msg of client.fetch(uidRange, { source: true }, { uid: true })) {
          try {
            // @ts-ignore — simpleParser retourne bien une Promise<ParsedMail> au runtime
            const parsed = await simpleParser(msg.source, { skipHtmlToText: true });

            rows.push({
              message_id: (parsed.messageId ?? `uid-${msg.uid}`).trim(),
              sender:     parsed.from?.text ?? '',
              subject:    parsed.subject    ?? '',
              clean_body: extractBody(parsed),
              received_at: parsed.date
                ? Math.floor(parsed.date.getTime() / 1000)
                : 0,
            });
          } catch (err) {
            console.warn(`  [SKIP] UID ${msg.uid} ignoré — ${err.message}`);
          }
        }

        const inserted = insertBatch(rows);
        totalInserted += inserted;

        const batchEnd = Math.min(i + IMAP_BATCH, uids.length);
        console.log(`[IMAP] Lot ${i + 1}–${batchEnd} : ${inserted}/${rows.length} insérés.`);
      }

    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
    console.log('[IMAP] Connexion fermée.');
  }

  console.log(`[IMAP] Synchronisation terminée — ${totalInserted} nouveaux mails insérés.`);
  return totalInserted;
}

// ─── Étape 2 : Mise à jour du graphe relationnel ──────────────────────────────

function updateProfiles() {
  console.log('\n==============================');
  console.log(' ÉTAPE 2 — PROFILS SQL');
  console.log('==============================');
  console.log('[SQL] Recalcul des profils expéditeurs...');

  const { changes } = db.prepare(`
    INSERT INTO sender_profiles
          (sender_email, interaction_count, first_contact_date, last_contact_date, trust_score)
    SELECT
      LOWER(TRIM(
        CASE
          WHEN INSTR(sender, '<') > 0
            THEN REPLACE(SUBSTR(sender, INSTR(sender, '<') + 1), '>', '')
          ELSE sender
        END
      )) AS sender_email,
      COUNT(*)         AS interaction_count,
      MIN(received_at) AS first_contact_date,
      MAX(received_at) AS last_contact_date,
      50               AS trust_score
    FROM  emails
    WHERE sender IS NOT NULL
      AND TRIM(sender) != ''
    GROUP BY sender_email

    ON CONFLICT(sender_email) DO UPDATE SET
      interaction_count  = excluded.interaction_count,
      first_contact_date = excluded.first_contact_date,
      last_contact_date  = excluded.last_contact_date
  `).run();

  const { total } = db.prepare('SELECT COUNT(*) AS total FROM sender_profiles').get();
  console.log(`[SQL] Profils mis à jour — ${changes} modifié(s), ${total} expéditeur(s) uniques au total.`);
}

// ─── Étape 3 : Vectorisation incrémentale ─────────────────────────────────────

async function vectorizeNew() {
  console.log('\n==============================');
  console.log(' ÉTAPE 3 — VECTORISATION');
  console.log('==============================');

  // Table temporaire en mémoire : blacklist des IDs en échec permanent
  db.exec('CREATE TEMP TABLE IF NOT EXISTS vec_skip (id INTEGER PRIMARY KEY)');

  const countStmt = db.prepare(`
    SELECT COUNT(*) AS total
    FROM  emails e
    JOIN  sender_profiles p
          ON LOWER(TRIM(
               CASE WHEN INSTR(e.sender, '<') > 0
                 THEN REPLACE(SUBSTR(e.sender, INSTR(e.sender, '<') + 1), '>', '')
                 ELSE e.sender
               END
             )) = p.sender_email
    LEFT JOIN vec_emails v ON e.id = v.rowid
    WHERE v.rowid IS NULL
  `);

  const selectBatch = db.prepare(`
    SELECT
      e.id,
      e.subject,
      e.clean_body,
      e.received_at,
      p.sender_email,
      p.interaction_count
    FROM  emails e
    JOIN  sender_profiles p
          ON LOWER(TRIM(
               CASE WHEN INSTR(e.sender, '<') > 0
                 THEN REPLACE(SUBSTR(e.sender, INSTR(e.sender, '<') + 1), '>', '')
                 ELSE e.sender
               END
             )) = p.sender_email
    LEFT JOIN vec_emails v ON e.id = v.rowid
    WHERE v.rowid IS NULL
      AND e.id NOT IN (SELECT id FROM vec_skip)
    LIMIT ${VEC_BATCH}
  `);

  const insertVec  = db.prepare('INSERT INTO vec_emails(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)');
  const insertSkip = db.prepare('INSERT OR IGNORE INTO vec_skip(id) VALUES (?)');

  const { total } = countStmt.get();
  console.log(`[VEC] Vectorisation de ${total} nouveaux mails...`);

  if (total === 0) {
    console.log('[VEC] Tout est déjà vectorisé.');
    return;
  }

  let processed = 0;
  let errors    = 0;

  while (true) {
    const batch = selectBatch.all();
    if (batch.length === 0) break;

    for (const email of batch) {
      try {
        const safeBody = (email.clean_body || '').substring(0, MAX_BODY_CHARS);

        const input =
          `Expéditeur: ${email.sender_email}\n` +
          `Sujet: ${email.subject ?? ''}\n` +
          `Historique de relation: ${email.interaction_count} échanges.\n` +
          `Date d'envoi: ${new Date(email.received_at * 1000).toISOString()}\n` +
          `Contenu: ${safeBody}`;

        const embedding = await getEmbeddingWithRetry(input);

        if (!Array.isArray(embedding) || embedding.length === 0) {
          throw new Error('Réponse Gemini invalide : embeddings[0] absent ou vide');
        }

        const floatArray = new Float32Array(embedding);
        insertVec.run(email.id, floatArray);
        processed++;

        if (processed % VEC_LOG_EVERY === 0) {
          console.log(`[VEC] Progression : ${processed}/${total}...`);
        }

      } catch (err) {
        errors++;
        insertSkip.run(email.id);
        console.warn(`  [SKIP] id=${email.id} — ${err.message}`);
      }
    }
  }

  console.log(`[VEC] Terminé — ${processed} vectorisé(s), ${errors} ignoré(s) sur ${total} total.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════╗');
  console.log('║   SENTINEL — SYNC INCRÉMENTAL    ║');
  console.log('╚══════════════════════════════════╝');

  try {
    await syncImap();
    updateProfiles();
    await vectorizeNew();

    console.log('\n[DONE] Synchronisation complète terminée avec succès.');
  } finally {
    db.close();
    console.log('[DB]   Base de données fermée.');
  }
}

main().catch((err) => {
  console.error('[FATAL]', err.message ?? err);
  db.close();
  process.exit(1);
});
