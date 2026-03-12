import 'dotenv/config';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'database.db'), { readonly: true });
sqliteVec.load(db);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

// ─── Statements ───────────────────────────────────────────────────────────────

const findEmail = db.prepare(
  `SELECT id, sender, subject, clean_body, received_at
   FROM emails
   WHERE sender LIKE ? AND subject = ?
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTs(unixSec) {
  if (!unixSec) return 'Inconnue';
  return new Date(unixSec * 1000).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function extractAddress(sender) {
  const match = sender.match(/<([^>]+)>/);
  return (match ? match[1] : sender).trim().toLowerCase();
}

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
${email.clean_body}
</EMAIL_CIBLE>

Analyse cet email cible. Le comportement est-il cohérent avec l'historique ? Renvoie ton analyse au format JSON strict : {"score_risque_sur_100": int, "type_menace": "string", "explication": "string"}.`;
}

// ─── Display ──────────────────────────────────────────────────────────────────

function logPrompt(email, prompt) {
  const ts = new Date().toLocaleTimeString('fr-FR');
  console.log(`\n${SEP2}`);
  console.log(`${C.cyan}${C.bold}  📨  ANALYSE SENTINEL${C.reset}  ${C.dim}[${ts}]${C.reset}`);
  console.log(SEP);
  console.log(`  ${C.bold}Expéditeur${C.reset}  :  ${C.cyan}${email.sender}${C.reset}`);
  console.log(`  ${C.bold}Sujet      ${C.reset}  :  ${email.subject}`);
  console.log(`  ${C.bold}ID local   ${C.reset}  :  ${email.id}`);
  console.log(SEP);
  console.log(`  ${C.bold}${C.dim}PROMPT ENVOYÉ À GEMINI${C.reset}`);
  console.log(SEP);
  // Indente chaque ligne du prompt pour la lisibilité
  prompt.split('\n').forEach(line => console.log(`  ${C.dim}${line}${C.reset}`));
  console.log(SEP2);
}

function logGeminiResponse(result) {
  const score  = result.score_risque_sur_100 ?? '?';
  const color  = typeof score === 'number' ? riskColor(score) : C.dim;
  const emoji  = typeof score === 'number' ? riskEmoji(score) : '❓';

  console.log(`\n${SEP}`);
  console.log(`  🤖 ${C.magenta}${C.bold}RÉPONSE GEMINI${C.reset}`);
  console.log(SEP);
  console.log(`  ${C.bold}Score de risque${C.reset}  :  ${color}${C.bold}${score} / 100${C.reset}  ${emoji}`);
  console.log(`  ${C.bold}Type de menace ${C.reset}  :  ${result.type_menace ?? '—'}`);
  console.log(`  ${C.bold}Explication    ${C.reset}  :`);
  // Wrap l'explication sur 70 chars
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

// ─── Gemini call ──────────────────────────────────────────────────────────────

async function analyzeWithGemini(prompt) {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  let text = response.text.replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function handleTrigger(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, CORS_HEADERS);
      return res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }

    const { sender, subject } = payload;
    if (!sender || !subject) {
      res.writeHead(400, CORS_HEADERS);
      return res.end(JSON.stringify({ error: 'Missing sender or subject' }));
    }

    const email = findEmail.get(`%${sender}%`, subject);
    if (!email) {
      console.log(`[Sentinel] Aucun match — sender: ${sender} | subject: ${subject}`);
      res.writeHead(200, CORS_HEADERS);
      return res.end(JSON.stringify({ found: false }));
    }

    try {
      const senderAddr = extractAddress(email.sender);
      const profile    = findProfile.get(senderAddr);
      const knn        = findKnn.all(email.id, email.id);
      const prompt     = buildPrompt({ email, profile, knn });

      logPrompt(email, prompt);

      const result = await analyzeWithGemini(prompt);
      logGeminiResponse(result);

      res.writeHead(200, CORS_HEADERS);
      res.end(JSON.stringify({
        found:    true,
        id:       email.id,
        sender:   email.sender,
        subject:  email.subject,
        profile: {
          interaction_count: profile?.interaction_count ?? 0,
          first_contact_date: profile?.first_contact_date ?? null,
        },
        similar: knn.map(r => ({
          subject:     r.subject,
          received_at: r.received_at,
          distance:    r.distance,
        })),
        analysis: result,
      }));
    } catch (err) {
      logError('GraphRAG / Gemini', err);
      res.writeHead(500, CORS_HEADERS);
      res.end(JSON.stringify({ error: 'Analysis failed' }));
    }
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

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

server.listen(3000, () => {
  console.log(`\n${SEP2}`);
  console.log(`  🛡️  ${C.green}${C.bold}Sentinel Bridge démarré${C.reset}  →  port ${C.cyan}3000${C.reset}`);
  console.log(`  ${C.dim}GraphRAG + Gemini 2.5 Flash activés${C.reset}`);
  console.log(SEP2 + '\n');
});
