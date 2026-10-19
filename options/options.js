'use strict';
// Page d'options : chaque champ porte le nom d'un réglage et s'enregistre dès qu'il change.

const $ = (id) => document.getElementById(id);
const { t } = W2P.i18n;
const SCHEMA = W2P.SETTINGS_SCHEMA;
let settings = null;
let savedTimer = 0;
let textTimer = 0;

function fields(name) {
  return document.querySelectorAll(`[name="${name}"]`);
}

function render() {
  for (const key of Object.keys(SCHEMA)) {
    for (const el of fields(key)) {
      const value = settings[key];
      if (el.type === 'radio') el.checked = el.value === String(value);
      else if (el.type === 'checkbox') el.checked = Boolean(value);
      else if (el.tagName === 'SELECT') {
        el.value = String(value);
        if (el.value !== String(value)) {
          // Valeur hors liste (ex. netteté 2,5) : on l'ajoute pour l'afficher fidèlement.
          const opt = new Option(`×${new Intl.NumberFormat(W2P.i18n.lang()).format(value)}`, String(value));
          el.add(opt);
          el.value = String(value);
        }
      } else if (document.activeElement !== el) el.value = value;
    }
  }
  $('jpegQualityOut').textContent = settings.jpegQuality;
  for (const el of document.querySelectorAll('[data-show="custom"]')) el.hidden = settings.pageFormat !== 'custom';
  const paper = !['single', 'screen'].includes(settings.pageFormat);
  for (const el of fields('orientation')) el.disabled = !paper;
  for (const el of fields('fit')) el.disabled = !paper;
  for (const el of fields('limitPageSize')) el.disabled = settings.pageFormat !== 'single';
  for (const el of fields('jpegQuality')) el.disabled = settings.imageFormat === 'lossless';
  $('filenamePreview').textContent = W2P.buildFilename(settings.filenameTemplate, {
    title: t('previewTitle'),
    url: 'https://www.example.com/blog/article',
    date: new Date().toISOString(),
  });
}

function valueOf(el) {
  const def = SCHEMA[el.name];
  if (el.type === 'checkbox') return el.checked;
  if (def.type === 'int' || def.type === 'num') return el.value === '' ? def.def : Number(el.value);
  return el.value;
}

function flashSaved() {
  const el = $('saved');
  el.textContent = t('saved');
  el.classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('on'), 1400);
}

async function commit(el) {
  if (!SCHEMA[el.name]) return;
  if (el.type === 'radio' && !el.checked) return;
  settings = await W2P.saveSettings({ [el.name]: valueOf(el) });
  render();
  flashSaved();
}

document.addEventListener('change', (e) => {
  if (e.target.name) commit(e.target);
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.name === 'jpegQuality') $('jpegQualityOut').textContent = el.value;
  if (el.type === 'text') {
    clearTimeout(textTimer);
    textTimer = setTimeout(() => commit(el), 350);
  }
});

$('reset').addEventListener('click', async () => {
  if (!window.confirm(t('confirmReset'))) return;
  settings = await W2P.resetSettings();
  render();
  flashSaved();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = W2P.normalizeSettings(changes.settings.newValue);
    render();
  }
});

(async () => {
  W2P.i18n.apply();
  document.title = t('optPageTitle');
  $('version').textContent = browser.runtime.getManifest().version;
  settings = await W2P.loadSettings();
  render();
})();
