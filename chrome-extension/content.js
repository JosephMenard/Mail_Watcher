async function ensureServiceWorkerAlive() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "KEEPALIVE" }, (response) => {
      if (chrome.runtime.lastError) { setTimeout(resolve, 200); }
      else { resolve(); }
    });
  });
}

async function fetchViaBackground(url, options = {}) {
  await ensureServiceWorkerAlive();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "FETCH_PROXY", url, options },
      (response) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (response.success) resolve(response.data);
        else reject(new Error(response.error));
      }
    );
  });
}

function extractFromDOM(selectors, attr = null) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (attr) { const v = el.getAttribute(attr); if (v) return v; }
    else if (el.textContent?.trim()) return el.textContent.trim();
  }
  return "";
}

let hasBeenSent = false;
let lastSubject = null;

const BANNER_ID     = 'sentinel-banner';
const STYLE_ID      = 'sentinel-styles';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function extractEmailData() {
  const subject = extractFromDOM(['h2.hP', '.ha h2', '[data-legacy-thread-id] h2', '.nH .ii h2']);
  const sender  = extractFromDOM(['.gD[email]', 'span[email]', '[data-hovercard-id]'], 'email')
               || extractFromDOM(['.gD', '.go span']);
  if (!subject || !sender) return null;
  return { subject, sender };
}

/** Insère le banner juste avant le sujet dans son parent direct. */
function getInsertionAnchor() {
  return document.querySelector('h2.hP')
      || document.querySelector('.ha h2')
      || document.querySelector('.nH .ii h2');
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes sentinel-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    #${BANNER_ID} {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px 10px;
      margin: 8px 0 4px 0;
      padding: 9px 14px;
      border-radius: 8px;
      border: 1px solid #c5cae9;
      background: #f8f9ff;
      font-family: "Google Sans", Roboto, Arial, sans-serif;
      font-size: 13px;
      color: #3c4043;
      box-shadow: 0 1px 3px rgba(0,0,0,.08);
      transition: background .3s, border-color .3s;
    }
    #${BANNER_ID} .s-label   { font-weight: 600; color: #1a73e8; }
    #${BANNER_ID} .s-dot     { color: #dadce0; }
    #${BANNER_ID} .s-status  { color: #80868b; font-style: italic; }
    #${BANNER_ID} .s-score   { font-weight: 700; }
    #${BANNER_ID} .s-threat  { color: #3c4043; }
    #${BANNER_ID} .s-details { margin-left: auto; font-size: 12px; color: #80868b; cursor: pointer; }
    #${BANNER_ID} .s-details summary { list-style: none; user-select: none; }
    #${BANNER_ID} .s-details summary::-webkit-details-marker { display: none; }
    #${BANNER_ID} .s-profile { color: #5f6368; font-size: 12px; }
    #${BANNER_ID} .s-expl {
      margin-top: 6px;
      padding: 7px 10px;
      background: rgba(0,0,0,.04);
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.55;
      max-width: 520px;
      color: #3c4043;
      white-space: pre-wrap;
    }
    #${BANNER_ID} .s-similar-title {
      margin-top: 8px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: #80868b;
    }
    #${BANNER_ID} .s-similar-row {
      display: flex;
      gap: 8px;
      align-items: baseline;
      font-size: 12px;
      padding: 3px 0;
      border-bottom: 1px solid rgba(0,0,0,.06);
    }
    #${BANNER_ID} .s-sim-dist {
      flex-shrink: 0;
      font-family: monospace;
      font-size: 11px;
      color: #80868b;
      min-width: 38px;
    }
    #${BANNER_ID} .s-sim-subj {
      flex: 1;
      color: #3c4043;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 340px;
    }
    #${BANNER_ID} .s-sim-date {
      flex-shrink: 0;
      color: #80868b;
      font-size: 11px;
    }
    #sentinel-spinner {
      animation: sentinel-spin 1s linear infinite;
      display: inline-block;
    }
  `;
  document.head.appendChild(style);
}

function removeBanner() {
  document.getElementById(BANNER_ID)?.remove();
}

// ─── Banner states ─────────────────────────────────────────────────────────────

function showLoadingBanner() {
  removeBanner();
  injectStyles();

  const anchor = getInsertionAnchor();
  if (!anchor) return;

  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.innerHTML = `
    <span>🛡️</span>
    <span class="s-label">Sentinel</span>
    <span class="s-dot">·</span>
    <span class="s-status">en cours d'analyse…</span>
    <svg id="sentinel-spinner" width="14" height="14" viewBox="0 0 24 24"
         fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83
               M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"
            stroke="#1a73e8" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `;

  anchor.parentElement.insertBefore(banner, anchor);
}

function formatDate(unixSec) {
  if (!unixSec) return null;
  return new Date(unixSec * 1000).toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function showResultBanner(json) {
  const banner = document.getElementById(BANNER_ID);
  if (!banner) return;

  const analysis = json.analysis ?? {};
  const profile  = json.profile  ?? {};
  const similar  = json.similar  ?? [];

  const score  = analysis.score_risque_sur_100 ?? null;
  const threat = analysis.type_menace ?? '—';
  const expl   = analysis.explication ?? '—';

  const count      = profile.interaction_count ?? 0;
  const firstDate  = formatDate(profile.first_contact_date);
  const profileTxt = count > 0
    ? `${count} échange${count > 1 ? 's' : ''}${firstDate ? ` · depuis le ${firstDate}` : ''}`
    : 'Premier contact';

  const similarHtml = similar.length
    ? similar.map(r =>
        `<div class="s-similar-row">` +
        `<span class="s-sim-dist">${r.distance.toFixed(3)}</span>` +
        `<span class="s-sim-subj">${r.subject ?? '(sans sujet)'}</span>` +
        `<span class="s-sim-date">${formatDate(r.received_at) ?? ''}</span>` +
        `</div>`
      ).join('')
    : '<div class="s-similar-row" style="color:#80868b">Aucun email similaire trouvé</div>';

  let emoji, scoreColor, bg, border;
  if (score === null) {
    emoji = '❓'; scoreColor = '#80868b'; bg = '#f1f3f4'; border = '#dadce0';
  } else if (score <= 30) {
    emoji = '🟢'; scoreColor = '#137333'; bg = '#e6f4ea'; border = '#ceead6';
  } else if (score <= 60) {
    emoji = '🟡'; scoreColor = '#b06000'; bg = '#fef7e0'; border = '#fde293';
  } else {
    emoji = '🔴'; scoreColor = '#c5221f'; bg = '#fce8e6'; border = '#f5c6c5';
  }

  banner.style.background  = bg;
  banner.style.borderColor = border;
  banner.innerHTML = `
    <span>🛡️</span>
    <span class="s-label">Sentinel</span>
    <span class="s-dot">·</span>
    <span class="s-score" style="color:${scoreColor}">${emoji} ${score ?? '?'} / 100</span>
    <span class="s-dot">·</span>
    <span class="s-threat">${threat}</span>
    <span class="s-dot">·</span>
    <span class="s-profile">${profileTxt}</span>
    <details class="s-details">
      <summary>Détails ▾</summary>
      <div class="s-expl">${expl}</div>
      <div class="s-similar-title">Emails similaires</div>
      ${similarHtml}
    </details>
  `;
}

function showErrorBanner() {
  const banner = document.getElementById(BANNER_ID);
  if (!banner) return;
  banner.style.background  = '#f1f3f4';
  banner.style.borderColor = '#dadce0';
  banner.innerHTML = `
    <span>🛡️</span>
    <span class="s-label">Sentinel</span>
    <span class="s-dot">·</span>
    <span class="s-status">serveur inaccessible</span>
  `;
}

// ─── Core ─────────────────────────────────────────────────────────────────────

async function trigger(data) {
  showLoadingBanner();
  try {
    const json = await fetchViaBackground('http://localhost:3000/trigger', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    if (json?.analysis) {
      showResultBanner(json);
    } else {
      removeBanner(); // mail non trouvé en base
    }
  } catch (err) {
    console.warn('[Sentinel] Serveur local inaccessible :', err.message);
    showErrorBanner();
  }
}

// ─── Observer ─────────────────────────────────────────────────────────────────

const observer = new MutationObserver(() => {
  const data = extractEmailData();
  if (!data) return;

  if (data.subject !== lastSubject) {
    hasBeenSent = false;
    lastSubject = data.subject;
    removeBanner(); // nettoie le banner du mail précédent
  }

  if (!hasBeenSent) {
    hasBeenSent = true;
    trigger(data);
  }
});

observer.observe(document.body, { childList: true, subtree: true });
