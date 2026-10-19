'use strict';
// Popup : réglages rapides (mémorisés), lancement et suivi de la conversion.

const $ = (id) => document.getElementById(id);
let settings = null;
let tab = null;
let started = false;

const ENGINE_HINTS = {
  exact:
    'Le rendu du navigateur est capturé tel quel : identique à l’écran, avec texte sélectionnable, liens et signets.',
  vector:
    'Passe par le moteur d’impression : texte vectoriel et fichier léger, mais la mise en page peut s’écarter de l’écran.',
};

function pageRestriction(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return 'Adresse de page illisible.';
  }
  if (u.protocol === 'about:' && u.pathname === 'reader') {
    return 'Mode lecture : seul le moteur « Vectoriel » peut convertir cette vue.';
  }
  if (!['http:', 'https:', 'file:', 'ftp:'].includes(u.protocol)) {
    return 'Page interne du navigateur : les extensions n’y ont pas accès.';
  }
  return null;
}

function formatBytes(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} Mo`;
  return `${Math.max(1, Math.round(n / 1e3))} Ko`;
}

async function save(patch) {
  settings = await W2P.saveSettings(patch);
  render();
}

function render() {
  for (const seg of document.querySelectorAll('.seg[data-key]')) {
    const value = String(settings[seg.dataset.key]);
    for (const b of seg.querySelectorAll('button')) {
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(b.dataset.value === value));
    }
  }
  const fmt = document.querySelector('select[data-key="pageFormat"]');
  fmt.value = settings.pageFormat;
  const paper = !['single', 'screen'].includes(settings.pageFormat);
  for (const b of document.querySelectorAll('.seg[data-key="orientation"] button')) b.disabled = !paper;
  for (const input of document.querySelectorAll('input[type="checkbox"][data-key]')) {
    const key = input.dataset.key;
    input.checked = key === 'floatingHide' ? settings.floating === 'hide' : Boolean(settings[key]);
  }
  const vector = settings.engine === 'vector';
  for (const b of document.querySelectorAll('.seg[data-key="scope"] button')) {
    b.disabled = vector && b.dataset.value !== 'full';
  }
  for (const b of document.querySelectorAll('.seg[data-key="pixelRatio"] button')) b.disabled = vector;
  $('engineHint').textContent = ENGINE_HINTS[settings.engine];
  if (vector) $('more').open = true;
}

function bind() {
  for (const seg of document.querySelectorAll('.seg[data-key]')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const key = seg.dataset.key;
      const raw = b.dataset.value;
      save({ [key]: key === 'pixelRatio' ? Number(raw) : raw });
    });
  }
  document.querySelector('select[data-key="pageFormat"]').addEventListener('change', (e) => {
    save({ pageFormat: e.target.value });
    if (e.target.value === 'custom') browser.runtime.openOptionsPage();
  });
  for (const input of document.querySelectorAll('input[type="checkbox"][data-key]')) {
    input.addEventListener('change', () => {
      const key = input.dataset.key;
      if (key === 'floatingHide') save({ floating: input.checked ? 'hide' : 'once' });
      else save({ [key]: input.checked });
    });
  }
  $('openOptions').addEventListener('click', () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
  $('go').addEventListener('click', go);
  $('cancel').addEventListener('click', () => browser.runtime.sendMessage({ type: 'w2p:cancel', tabId: tab.id }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.target.closest('select, summary, input') && !$('go').disabled) {
      e.preventDefault();
      go();
    }
  });
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

async function go() {
  if (started) return;
  $('error').hidden = true;
  $('result').hidden = true;
  started = true;
  $('go').disabled = true;
  let res;
  try {
    res = await browser.runtime.sendMessage({ type: 'w2p:start', tabId: tab.id });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  if (!res || !res.ok) {
    started = false;
    $('go').disabled = false;
    showError((res && res.error) || 'Impossible de démarrer la conversion.');
    return;
  }
  const interactive =
    (settings.engine === 'exact' && (settings.scope === 'element' || settings.scope === 'region')) ||
    settings.cleanupBefore;
  // La sélection se fait dans la page : la popup doit se fermer.
  if (interactive) window.close();
}

function showJob(job) {
  if (!job) return;
  const running = job.state === 'running';
  $('status').hidden = !running;
  $('go').disabled = running;
  started = running;
  if (running) {
    $('error').hidden = true;
    $('result').hidden = true;
    const fill = $('fill');
    if (job.total > 0) {
      fill.classList.remove('indeterminate');
      fill.style.width = `${Math.min(100, Math.round((100 * job.done) / job.total))}%`;
    } else {
      fill.classList.add('indeterminate');
      fill.style.width = '';
    }
    $('statusText').textContent = job.label || 'Conversion…';
    $('statusHint').textContent =
      job.phase === 'print'
        ? 'Choisissez l’emplacement du fichier dans la fenêtre d’enregistrement.'
        : job.phase === 'paused'
          ? 'La capture reprendra dès que l’onglet sera de nouveau affiché.'
        : job.phase === 'pick'
          ? 'Faites votre sélection directement dans la page.'
          : job.phase === 'build' || job.phase === 'save'
            ? 'La page est déjà rendue à son état normal ; le PDF est en cours d’écriture.'
            : 'La page défile toute seule pendant la capture : laissez-la faire. Échap pour interrompre.';
    return;
  }
  if (job.state === 'error') {
    showError(job.error || 'La conversion a échoué.');
    return;
  }
  if (job.state !== 'done' || !job.result) return;
  const r = job.result;
  $('result').hidden = false;
  if (r.vector) {
    $('resultText').textContent = 'PDF enregistré (moteur vectoriel)';
    $('openPdf').hidden = $('showPdf').hidden = true;
  } else if (r.cancelledSave) {
    $('resultText').textContent = 'Enregistrement annulé';
    $('openPdf').hidden = $('showPdf').hidden = true;
  } else {
    $('resultText').textContent = `PDF prêt — ${r.pages} page${r.pages > 1 ? 's' : ''}, ${formatBytes(r.bytes)}`;
    $('openPdf').hidden = false;
    $('showPdf').hidden = r.downloadId == null;
    $('openPdf').onclick = async () => {
      if (r.downloadId != null) {
        try {
          await browser.downloads.open(r.downloadId);
          return;
        } catch (e) {
          /* repli ci-dessous */
        }
      }
      browser.runtime.sendMessage({ type: 'w2p:open-result', url: r.blobUrl });
    };
    $('showPdf').onclick = () => browser.downloads.show(r.downloadId);
  }
  const warnings = r.warnings || [];
  $('resultWarn').hidden = !warnings.length;
  $('resultWarn').textContent = warnings.join(' ');
}

async function init() {
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  settings = await W2P.loadSettings();
  bind();
  render();
  if (!tab) {
    $('go').disabled = true;
    return;
  }
  let host = '';
  try {
    host = new URL(tab.url).hostname;
  } catch (e) {
    host = '';
  }
  $('page').textContent = [host, tab.title].filter(Boolean).join(' — ') || tab.url;
  $('page').title = tab.url;
  const reason = pageRestriction(tab.url || '');
  if (reason) {
    $('notice').textContent = reason;
    $('notice').hidden = false;
    if (!/lecture/.test(reason)) $('go').disabled = true;
  }
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'w2p:job' && msg.job.tabId === tab.id) showJob(msg.job);
  });
  const st = await browser.runtime.sendMessage({ type: 'w2p:status', tabId: tab.id }).catch(() => null);
  if (st && st.job && (st.job.state === 'running' || Date.now() - parseInt(st.job.id.split('-')[1], 36) < 60000)) {
    showJob(st.job);
  }
  $('go').focus();
}

init();
