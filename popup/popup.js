'use strict';
// Popup : réglages rapides (mémorisés), lancement et suivi de la conversion.

const $ = (id) => document.getElementById(id);
const { t } = W2P.i18n;
let settings = null;
let tab = null;
let started = false;

// 'reader' : seul le moteur vectoriel convient ; 'internal' : page inaccessible.
function pageRestriction(tab) {
  if (tab.isInReaderMode) return { kind: 'reader', message: t('noticeReader') };
  const url = tab.url;
  if (!url) return { kind: 'internal', message: t('noticeInternal') };
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return { kind: 'internal', message: t('restrictedBadUrl') };
  }
  if (u.protocol === 'about:' && u.pathname === 'reader') return { kind: 'reader', message: t('noticeReader') };
  if (!['http:', 'https:', 'file:', 'ftp:'].includes(u.protocol)) {
    return { kind: 'internal', message: t('noticeInternal') };
  }
  return null;
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
  $('engineHint').textContent = t(settings.engine === 'vector' ? 'engineHintVector' : 'engineHintExact');
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
    showError((res && res.error) || t('errStart'));
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
    $('statusText').textContent = job.label || t('statusDefault');
    const hints = { print: 'hintPrint', paused: 'hintPaused', pick: 'hintPick', build: 'hintBuild', save: 'hintBuild' };
    $('statusHint').textContent = t(hints[job.phase] || 'hintScroll');
    return;
  }
  if (job.state === 'error') {
    showError(job.error || t('errFailed'));
    return;
  }
  if (job.state !== 'done' || !job.result) return;
  const r = job.result;
  $('result').hidden = false;
  if (r.vector) {
    $('resultText').textContent = t('resultVector');
    $('openPdf').hidden = $('showPdf').hidden = true;
  } else if (r.cancelledSave) {
    $('resultText').textContent = t('resultSaveCancelled');
    $('openPdf').hidden = $('showPdf').hidden = true;
  } else {
    const size = W2P.i18n.formatBytes(r.bytes);
    $('resultText').textContent = r.pages > 1 ? t('resultReadyMany', r.pages, size) : t('resultReadyOne', size);
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
  W2P.i18n.apply();
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
  const restriction = pageRestriction(tab);
  if (restriction) {
    $('notice').textContent = restriction.message;
    $('notice').hidden = false;
    if (restriction.kind !== 'reader') $('go').disabled = true;
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
