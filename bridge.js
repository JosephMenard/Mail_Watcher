import 'dotenv/config';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, 'database.db');
const MAX_BODY_CHARS = parseInt(process.env.MAX_BODY_CHARS ?? '2000', 10);

const db = new Database(DB_PATH);
sqliteVec.load(db);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS sender_history (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    total_score REAL NOT NULL DEFAULT 0,
    count INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_hash TEXT NOT NULL UNIQUE,
    sender TEXT NOT NULL,
    subject TEXT,
    raw_score REAL,
    trust_score REAL,
    verdict TEXT,
    explanation TEXT,
    analyzed_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

const deepinfra = new OpenAI({
  apiKey: process.env.DEEPINFRA,
  baseURL: 'https://api.deepinfra.com/v1/openai',
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://mail.google.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const C = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  dim    : '\x1b[2m',
  cyan   : '\x1b[36m',
  green  : '\x1b[32m',
  yellow : '\x1b[33m',
  red    : '\x1b[31m',
  magenta: '\x1b[35m',
};
const SEP  = `${C.dim}${'─'.repeat(72)}${C.reset}`;
const SEP2 = `${C.dim}${'═'.repeat(72)}${C.reset}`;

function riskColor(score) {
  if (score <= 30) return C.green;
  if (score <= 60) return C.yellow;
  return C.red;
}
function riskEmoji(score) {
  if (score <= 30) return '🟢';
  if (score <= 60) return '🟡';
  return '🔴';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeEmail(raw) {
  if (!raw) return '';
  const match = raw.match(/<([^>]+)>/);
  const address = match ? match[1] : raw;
  return address.trim().toLowerCase();
}

function hashEmail(sender, subject, body) {
  return crypto.createHash('sha256')
    .update(sender + '|' + subject + '|' + (body || '').slice(0, MAX_BODY_CHARS))
    .digest('hex');
}

function formatTs(unixSec) {
  if (!unixSec) return 'Inconnue';
  return new Date(unixSec * 1000).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Trust Score ──────────────────────────────────────────────────────────────

function computeTrustScore(email, rawScore, history) {
  const FIRST_CONTACT_MALUS = 0.10;
  let finalScore = rawScore;
  if (!history || history.count === 0) {
    finalScore = Math.min(1.0, rawScore + FIRST_CONTACT_MALUS);
  } else {
    const mean = history.total_score / history.count;
    const delta = (mean - rawScore) * 0.5;
    finalScore = rawScore + delta;
  }
  return Math.max(0.0, Math.min(1.0, finalScore));
}

function updateSenderHistory(db, email, rawScore) {
  const normalized = email.toLowerCase().trim();
  const existing = db.prepare('SELECT * FROM sender_history WHERE email = ?').get(normalized);
  if (existing) {
    db.prepare('UPDATE sender_history SET total_score = total_score + ?, count = count + 1, last_seen_at = unixepoch() WHERE email = ?')
      .run(rawScore, normalized);
  } else {
    db.prepare('INSERT INTO sender_history (email, total_score, count) VALUES (?, ?, 1)')
      .run(normalized, rawScore);
  }
}

// ─── Statements ───────────────────────────────────────────────────────────────

const findEmail = db.prepare(
  `SELECT id, sender, subject, clean_body, received_at
   FROM emails
   WHERE LOWER(TRIM(
     CASE WHEN INSTR(sender, '<') > 0
       THEN REPLACE(SUBSTR(sender, INSTR(sender, '<') + 1), '>', '')
       ELSE sender
     END
   )) = ? AND subject = ?
   ORDER BY received_at DESC LIMIT 1`
);

const findProfile = db.prepare(
  `SELECT interaction_count, first_contact_date
   FROM sender_profiles
   WHERE sender_email = ?`
);

const findKnn = db.prepare(
  `SELECT e.subject, e.clean_body, e.received_at,
          vec_distance_L2(v.embedding, (SELECT embedding FROM vec_emails WHERE rowid = ?)) as distance
   FROM vec_emails v
   JOIN emails e ON v.rowid = e.id
   WHERE v.rowid != ?
   ORDER BY distance ASC
   LIMIT 3`
);

const findAnalysisCache = db.prepare(
  'SELECT * FROM analyses WHERE email_hash = ?'
);

const saveAnalysis = db.prepare(
  `INSERT OR REPLACE INTO analyses (email_hash, sender, subject, raw_score, trust_score, verdict, explanation)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

// ─── Display ──────────────────────────────────────────────────────────────────

function buildPrompt({ email, profile, knn }) {
  const firstContact = profile?.first_contact_date
    ? formatTs(profile.first_contact_date)
    : 'Inconnu';

  const historique = knn.length
    ? knn.map((r, i) =>
        `[${i + 1}] Date : ${formatTs(r.received_at)} | Distance L2 : ${r.distance.toFixed(4)}\n` +
        `     Sujet : ${r.subject}\n` +
        `     ${(r.clean_body ?? '').slice(0, 500)}`
      ).join('\n---\n')
    : '(aucun historique similaire trouvé)';

  return `Tu es un analyste SOC de niveau 2 spécialisé dans la détection de phishing et d'usurpation d'identité (Spear-phishing, BEC).
Ta mission est d'analyser l'email cible en le comparant STRICTEMENT à l'historique de communication de l'utilisateur. Cherche des anomalies : urgence inhabituelle, ton différent, demande financière ou de mot de passe hors norme.

<CONTEXTE_RELATIONNEL>
Expéditeur de la cible : ${email.sender}
Nombre d'interactions historiques : ${profile?.interaction_count ?? 0}
Premier contact : ${firstContact}
</CONTEXTE_RELATIONNEL>

<HISTORIQUE_SIMILAIRE>
Voici les 3 emails les plus proches sémantiquement dans la boîte mail (Distance L2 faible = très similaire) :
---
${historique}
---
</HISTORIQUE_SIMILAIRE>

<EMAIL_CIBLE>
Date : ${formatTs(email.received_at)}
Sujet : ${email.subject}
Contenu :
${(email.clean_body ?? '').slice(0, MAX_BODY_CHARS)}
</EMAIL_CIBLE>

Analyse cet email cible. Le comportement est-il cohérent avec l'historique ? Renvoie ton analyse au format JSON strict : {"score_risque_sur_100": int, "type_menace": "string", "explication": "string"}.`;
}

function logPrompt(email, prompt) {
  const ts = new Date().toLocaleTimeString('fr-FR');
  console.log(`\n${SEP2}`);
  console.log(`${C.cyan}${C.bold}  📨  ANALYSE SENTINEL${C.reset}  ${C.dim}[${ts}]${C.reset}`);
  console.log(SEP);
  console.log(`  ${C.bold}Expéditeur${C.reset}  :  ${C.cyan}${email.sender}${C.reset}`);
  console.log(`  ${C.bold}Sujet      ${C.reset}  :  ${email.subject}`);
  console.log(`  ${C.bold}ID local   ${C.reset}  :  ${email.id}`);
  console.log(SEP);
  console.log(`  ${C.bold}${C.dim}PROMPT ENVOYÉ À DEEPINFRA (DeepSeek R1)${C.reset}`);
  console.log(SEP);
  prompt.split('\n').forEach(line => console.log(`  ${C.dim}${line}${C.reset}`));
  console.log(SEP2);
}

function logGeminiResponse(result) {
  const score  = result.score_risque_sur_100 ?? '?';
  const color  = typeof score === 'number' ? riskColor(score) : C.dim;
  const emoji  = typeof score === 'number' ? riskEmoji(score) : '❓';

  console.log(`\n${SEP}`);
  console.log(`  🤖 ${C.magenta}${C.bold}RÉPONSE DEEPINFRA (DeepSeek R1)${C.reset}`);
  console.log(SEP);
  console.log(`  ${C.bold}Score de risque${C.reset}  :  ${color}${C.bold}${score} / 100${C.reset}  ${emoji}`);
  console.log(`  ${C.bold}Type de menace ${C.reset}  :  ${result.type_menace ?? '—'}`);
  console.log(`  ${C.bold}Explication    ${C.reset}  :`);
  const expl = result.explication ?? '—';
  const words = expl.split(' ');
  let line = '    ';
  for (const word of words) {
    if (line.length + word.length > 72) {
      console.log(`  ${line}`);
      line = '    ' + word + ' ';
    } else {
      line += word + ' ';
    }
  }
  if (line.trim()) console.log(`  ${line}`);
  console.log(SEP);
}

function logError(context, err) {
  console.error(`\n${SEP}`);
  console.error(`  ❌ ${C.red}${C.bold}ERREUR — ${context}${C.reset}`);
  console.error(`  ${C.dim}${err.message || err}${C.reset}`);
  console.error(SEP);
}

// ─── DeepInfra call with retry ────────────────────────────────────────────────

async function callGeminiWithRetry(prompt, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const completion = await deepinfra.chat.completions.create({
        model: 'deepseek-ai/DeepSeek-R1',
        messages: [{ role: 'user', content: prompt }],
      });
      const rawText = completion.choices[0].message.content ?? '';
      // Strip <think>...</think> reasoning block from DeepSeek R1
      return rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (err) {
      const status = err.status ?? err.response?.status;
      const retryable = status === 429 || status === 503 || status === 500;
      if (retryable && attempt < maxRetries - 1) {
        const waitMs = Math.pow(2, attempt) * 1500;
        console.warn('[bridge] DeepInfra error ' + status + ', retry in ' + waitMs + 'ms');
        await new Promise(r => setTimeout(r, waitMs));
      } else throw err;
    }
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function handleTrigger(req, res) {
  let rawBody = '';
  req.on('data', chunk => { rawBody += chunk; });
  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, CORS_HEADERS);
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

    const { sender, subject } = payload;
    if (!sender || !subject) {
      res.writeHead(400, CORS_HEADERS);
      return res.end(JSON.stringify({ error: 'Missing sender or subject' }));
    }

    const normalizedSender = normalizeEmail(sender);
    const email = findEmail.get(normalizedSender, subject);
    if (!email) {
      console.log(`[bridge] Aucun match — sender: ${sender} | subject: ${subject}`);
      res.writeHead(200, CORS_HEADERS);
      return res.end(JSON.stringify({ found: false }));
    }

    try {
      // Cache check
      const emailHash = hashEmail(normalizedSender, email.subject, email.clean_body);
      const cached = findAnalysisCache.get(emailHash);
      if (cached) {
        console.log('[bridge] Cache hit — skip Gemini');
        res.writeHead(200, CORS_HEADERS);
        return res.end(JSON.stringify({ found: true, cached: true, analysis: cached }));
      }

      const profile = findProfile.get(normalizedSender);
      const knn     = findKnn.all(email.id, email.id);
      const prompt  = buildPrompt({ email, profile, knn });

      logPrompt(email, prompt);

      const rawText = await callGeminiWithRetry(prompt);
      const cleanText = rawText.replace(/```json|```/g, '').trim();
      const result = JSON.parse(cleanText);

      logGeminiResponse(result);

      const rawScore = (result.score_risque_sur_100 ?? 50) / 100;
      const senderHistory = db.prepare('SELECT * FROM sender_history WHERE email = ?').get(normalizedSender);
      const trustScore = computeTrustScore(normalizedSender, rawScore, senderHistory);
      updateSenderHistory(db, normalizedSender, rawScore);

      const verdict = result.type_menace ?? '';
      const explanation = result.explication ?? '';

      saveAnalysis.run(emailHash, email.sender, email.subject, rawScore, trustScore, verdict, explanation);

      console.log(`[trust] ${normalizedSender} — raw: ${(rawScore * 100).toFixed(0)}/100 → trust: ${(trustScore * 100).toFixed(0)}/100`);

      res.writeHead(200, CORS_HEADERS);
      res.end(JSON.stringify({
        found:    true,
        id:       email.id,
        sender:   email.sender,
        subject:  email.subject,
        profile: {
          interaction_count:  profile?.interaction_count  ?? 0,
          first_contact_date: profile?.first_contact_date ?? null,
        },
        similar: knn.map(r => ({
          subject:     r.subject,
          received_at: r.received_at,
          distance:    r.distance,
        })),
        analysis: {
          ...result,
          trust_score: Math.round(trustScore * 100),
        },
      }));
    } catch (err) {
      logError('GraphRAG / DeepInfra', err);
      res.writeHead(500, CORS_HEADERS);
      res.end(JSON.stringify({ error: 'Analysis failed' }));
    }
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.BRIDGE_PORT ?? '3000', 10);

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (req.method === 'POST' && req.url === '/trigger') {
    return handleTrigger(req, res);
  }

  res.writeHead(404, CORS_HEADERS);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`\n${SEP2}`);
  console.log(`  🛡️  ${C.green}${C.bold}Sentinel Bridge démarré${C.reset}  →  port ${C.cyan}${PORT}${C.reset}`);
  console.log(`  ${C.dim}GraphRAG + DeepInfra DeepSeek R1 — trust score AWL — analyses cache${C.reset}`);
  console.log(SEP2 + '\n');
});
