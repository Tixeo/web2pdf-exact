'use strict';
// Orchestration : lance les tâches, exécute les captures demandées par l'agent
// (rendu natif de Gecko via tabs.captureTab), assemble et enregistre le PDF.

const jobs = new Map(); // id -> tâche
const jobByTab = new Map(); // onglet -> id de la tâche en cours
const blobUrls = []; // URL des derniers PDF (pour les rouvrir)
let seq = 0;

const COLORS = { run: '#4c6fff', ok: '#16a34a', err: '#dc2626' };

const RESTRICTED_HOSTS = new Set([
  'accounts-static.cdn.mozilla.net',
  'accounts.firefox.com',
  'addons.cdn.mozilla.net',
  'addons.mozilla.org',
  'api.accounts.firefox.com',
  'content.cdn.mozilla.net',
  'discovery.addons.mozilla.org',
  'install.mozilla.org',
  'oauth.accounts.firefox.com',
  'profile.accounts.firefox.com',
  'support.mozilla.org',
  'sync.services.mozilla.com',
]);

function restrictionReason(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return 'Adresse de page illisible.';
  }
  if (u.protocol === 'about:' && u.pathname === 'reader') {
    return 'Le mode lecture est une page interne : les extensions ne peuvent pas la capturer au pixel près. Utilisez le moteur « Vectoriel » ou quittez le mode lecture.';
  }
  if (!['http:', 'https:', 'file:', 'ftp:'].includes(u.protocol)) {
    return 'Cette page interne du navigateur est protégée : aucune extension ne peut y accéder.';
  }
  if (RESTRICTED_HOSTS.has(u.hostname)) {
    return `Le navigateur interdit aux extensions d’accéder à ${u.hostname}.`;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Badge, notifications, diffusion de l'état vers la popup
// -----------------------------------------------------------------------------

function setBadge(tabId, text, color) {
  browser.browserAction.setBadgeText({ text, tabId }).catch(() => {});
  if (color) browser.browserAction.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
  if (browser.browserAction.setBadgeTextColor) {
    browser.browserAction.setBadgeTextColor({ color: '#ffffff', tabId }).catch(() => {});
  }
}

function flashBadge(tabId, text, color, ms) {
  setBadge(tabId, text, color);
  setTimeout(() => {
    if (!jobByTab.has(tabId)) setBadge(tabId, '', null);
  }, ms);
}

const notificationDownloads = new Map();

function notify(job, title, message, downloadId) {
  if (!job.settings.notify) return;
  const id = `w2p-${job.id}`;
  if (downloadId != null) notificationDownloads.set(id, downloadId);
  browser.notifications
    .create(id, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-96.png'),
      title,
      message,
    })
    .catch(() => {});
}

browser.notifications.onClicked.addListener(async (id) => {
  const dl = notificationDownloads.get(id);
  if (dl == null) return;
  try {
    await browser.downloads.open(dl);
  } catch (e) {
    browser.downloads.show(dl).catch(() => {});
  }
});

const PHASES = {
  start: 'Préparation…',
  pick: 'En attente de votre sélection dans la page…',
  prepare: 'Préparation de la page…',
  preload: 'Chargement du contenu différé…',
  capture: 'Capture de la page…',
  build: 'Assemblage du PDF…',
  save: 'Enregistrement…',
  print: 'Impression vectorielle…',
  paused: 'En pause : revenez sur l’onglet pour continuer…',
};

function publicJob(job) {
  return {
    id: job.id,
    tabId: job.tabId,
    state: job.state,
    phase: job.phase,
    label: PHASES[job.phase] || '',
    done: job.done || 0,
    total: job.total || 0,
    error: job.error || null,
    result: job.result || null,
  };
}

function broadcast(job) {
  browser.runtime.sendMessage({ type: 'w2p:job', job: publicJob(job) }).catch(() => {});
}

function setPhase(job, phase, done = 0, total = 0) {
  job.phase = phase;
  job.done = done;
  job.total = total;
  if (job.state === 'running') {
    const pct = total > 0 ? `${Math.min(99, Math.round((100 * done) / total))}%` : '…';
    setBadge(job.tabId, phase === 'pick' ? '?' : phase === 'paused' ? '⏸' : pct, COLORS.run);
  }
  broadcast(job);
}

// -----------------------------------------------------------------------------
// Tâches
// -----------------------------------------------------------------------------

async function startJob({ tabId, scope, overrides }) {
  if (jobByTab.has(tabId)) {
    return { ok: false, error: 'Une capture est déjà en cours dans cet onglet.' };
  }
  const tab = await browser.tabs.get(tabId);
  const reason = restrictionReason(tab.url || '');
  const base = await W2P.loadSettings();
  const settings = W2P.normalizeSettings({ ...base, ...(overrides || {}), ...(scope ? { scope } : {}) });
  if (reason && !(settings.engine === 'vector' && /mode lecture/.test(reason))) {
    return { ok: false, error: reason };
  }
  const job = {
    id: `w2p-${Date.now().toString(36)}-${++seq}`,
    tabId,
    settings,
    scope: settings.scope,
    state: 'running',
    phase: 'start',
    images: [],
    placements: [],
    css: [],
    cancelled: false,
    ratio: 1,
    zoom: 1,
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  jobByTab.set(tabId, job.id);
  const done = runJob(job, tab);
  return { ok: true, jobId: job.id, done };
}

async function runJob(job, tab) {
  setPhase(job, 'start');
  let result;
  try {
    result = job.settings.engine === 'vector' ? await runVector(job, tab) : await runExact(job, tab);
    if (result.cancelled) {
      job.state = 'cancelled';
      setBadge(job.tabId, '', null);
    } else {
      job.state = 'done';
      flashBadge(job.tabId, '✓', COLORS.ok, 5000);
      if (!result.vector && !result.cancelledSave) {
        const size = result.bytes > 1e6 ? `${(result.bytes / 1e6).toFixed(1)} Mo` : `${Math.ceil(result.bytes / 1e3)} Ko`;
        notify(
          job,
          'PDF créé',
          `${result.filename} — ${result.pages} page${result.pages > 1 ? 's' : ''}, ${size}` +
            (result.warnings && result.warnings.length ? `\n${result.warnings[0]}` : ''),
          result.downloadId,
        );
      }
    }
  } catch (e) {
    if ((e && e.cancelled) || job.cancelled) {
      // Interruption volontaire (Échap, bouton Annuler, onglet fermé) : pas une erreur.
      job.state = 'cancelled';
      setBadge(job.tabId, '', null);
      result = { ok: false, cancelled: true };
    } else {
      const message = (e && e.message) || String(e);
      job.state = 'error';
      job.error = message;
      flashBadge(job.tabId, '!', COLORS.err, 8000);
      notify(job, 'Conversion impossible', message);
      result = { ok: false, error: message };
    }
  } finally {
    // Filet de sécurité : retire le CSS injecté si l'agent n'a pas pu le faire.
    for (const css of job.css) {
      browser.scripting.removeCSS({ target: { tabId: job.tabId, frameIds: [0] }, css, origin: 'USER' }).catch(() => {});
    }
    job.css = [];
    job.images = [];
    job.placements = [];
    jobByTab.delete(job.tabId);
    job.result = result;
    broadcast(job);
    setTimeout(() => jobs.delete(job.id), 15 * 60 * 1000);
  }
  return result;
}

async function injectAgent(tabId) {
  try {
    await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['/content/agent.js'] });
  } catch (e) {
    throw new Error(
      `Impossible d’accéder à cette page (${(e && e.message) || e}). ` +
        'Les pages internes du navigateur et certains sites protégés sont inaccessibles aux extensions.',
    );
  }
}

async function runExact(job, tab) {
  await injectAgent(tab.id);
  job.zoom = await browser.tabs.getZoom(tab.id).catch(() => 1);
  setPhase(job, job.scope === 'element' || job.scope === 'region' || job.settings.cleanupBefore ? 'pick' : 'prepare');
  let res;
  try {
    res = await browser.tabs.sendMessage(
      tab.id,
      { type: 'w2p:run', jobId: job.id, settings: job.settings, scope: job.scope },
      { frameId: 0 },
    );
  } catch (e) {
    throw new Error('La page a été rechargée ou fermée pendant la capture.');
  }
  if (!res) throw new Error('La page ne répond plus.');
  if (res.cancelled || job.cancelled) return { ok: false, cancelled: true };
  if (!res.ok) throw new Error(res.error || 'Échec de la capture.');
  if (!job.placements.length) throw new Error('Aucune image n’a pu être capturée.');

  setPhase(job, 'build', 0, 1);
  const t0 = performance.now();
  const { blob, pages } = await W2P.buildPdf(job, res.manifest, (d, t) => setPhase(job, 'build', d, t));
  const timings = { ...(res.manifest.meta.timings || {}), build: Math.round(performance.now() - t0) };
  setPhase(job, 'save');
  const saved = await deliver(job, blob, res.manifest.meta, tab);
  return {
    ok: true,
    ...saved,
    pages,
    bytes: blob.size,
    warnings: res.manifest.warnings || [],
    size: res.manifest.output,
    timings,
  };
}

function rememberBlobUrl(url) {
  blobUrls.push(url);
  while (blobUrls.length > 6) URL.revokeObjectURL(blobUrls.shift());
}

async function deliver(job, blob, meta, tab) {
  const s = job.settings;
  const url = URL.createObjectURL(blob);
  rememberBlobUrl(url);
  let filename = W2P.buildFilename(s.filenameTemplate, meta);
  let downloadId = null;
  if (s.afterAction !== 'open') {
    const attempts = [filename, W2P.buildFilename(s.filenameTemplate, meta, true), 'page-web.pdf'];
    let lastError = null;
    for (const name of attempts) {
      try {
        downloadId = await browser.downloads.download({ url, filename: name, saveAs: s.saveAs, conflictAction: 'uniquify' });
        filename = name;
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (/cancel/i.test((e && e.message) || '')) {
          return { filename, cancelledSave: true, blobUrl: url };
        }
      }
    }
    if (lastError) throw new Error(`Téléchargement refusé : ${lastError.message}`);
  }
  if (s.afterAction !== 'download') {
    await browser.tabs.create({ url, active: true, index: tab.index + 1, openerTabId: tab.id }).catch(() => {});
  }
  return { filename: filename.split('/').pop(), downloadId, blobUrl: url };
}

// --- Mode vectoriel : moteur d'impression de Firefox (tabs.saveAsPDF) ---------

function vectorPageSettings(s, info, filename) {
  const IN_PER_MM = 1 / 25.4;
  const pxToMm = (px) => (px * 25.4) / 96;
  let mt = s.marginTop;
  let mb = s.marginBottom;
  const ml = s.marginLeft;
  const mr = s.marginRight;
  if (s.headerFooter) {
    mt = Math.max(mt, 12);
    mb = Math.max(mb, 12);
  }
  const ps = {
    toFileName: filename,
    paperSizeUnit: 1,
    showBackgroundColors: true,
    showBackgroundImages: true,
    marginTop: mt * IN_PER_MM,
    marginBottom: mb * IN_PER_MM,
    marginLeft: ml * IN_PER_MM,
    marginRight: mr * IN_PER_MM,
    edgeTop: 0,
    edgeBottom: 0,
    edgeLeft: 0,
    edgeRight: 0,
    headerLeft: s.headerFooter ? '&T' : '',
    headerCenter: '',
    headerRight: s.headerFooter ? '&U' : '',
    footerLeft: s.headerFooter ? '&D' : '',
    footerCenter: '',
    footerRight: s.headerFooter ? '&PT' : '',
    orientation: 0,
    scaling: 1,
    shrinkToFit: false,
  };
  if (s.pageFormat === 'single') {
    ps.paperWidth = pxToMm(info.width) + ml + mr;
    ps.paperHeight = pxToMm(info.height) + mt + mb + 2;
  } else if (s.pageFormat === 'screen') {
    ps.paperWidth = pxToMm(info.vw) + ml + mr;
    ps.paperHeight = pxToMm(info.vh) + mt + mb;
  } else {
    let [pw, ph] = s.pageFormat === 'custom' ? [s.customWidthMm, s.customHeightMm] : W2P.PAPER_SIZES[s.pageFormat];
    if (s.orientation === 'landscape') [pw, ph] = [Math.max(pw, ph), Math.min(pw, ph)];
    ps.paperWidth = pw;
    ps.paperHeight = ph;
    if (s.vectorFitWidth) {
      // Mise en page à la largeur de l'écran, puis réduction pour tenir sur le papier.
      ps.scaling = Math.min(2, Math.max(0.1, (pw - ml - mr) / pxToMm(info.width)));
    } else {
      ps.shrinkToFit = true;
    }
  }
  return ps;
}

async function runVector(job, tab) {
  if (!browser.tabs.saveAsPDF) throw new Error('Ce navigateur ne propose pas l’impression PDF aux extensions.');
  const reader = /^about:reader/i.test(tab.url || '');
  // saveAsPDF imprime toujours l'onglet actif.
  await browser.tabs.update(tab.id, { active: true });
  let info = { width: 1280, height: 2000, vw: 1280, vh: 800, title: tab.title, url: tab.url };
  if (!reader) {
    await injectAgent(tab.id);
    setPhase(job, job.settings.cleanupBefore ? 'pick' : 'prepare');
    const prep = await browser.tabs.sendMessage(
      tab.id,
      { type: 'w2p:vector-prepare', jobId: job.id, settings: job.settings },
      { frameId: 0 },
    );
    if (!prep || prep.cancelled) return { ok: false, cancelled: true };
    if (!prep.ok) throw new Error(prep.error || 'Préparation impossible.');
    info = prep.info;
  }
  setPhase(job, 'print');
  let status;
  try {
    const filename = W2P.buildFilename(job.settings.filenameTemplate, {
      title: info.title,
      url: info.url,
      date: new Date().toISOString(),
    })
      .split('/')
      .pop();
    status = await browser.tabs.saveAsPDF(vectorPageSettings(job.settings, info, filename));
  } finally {
    if (!reader) {
      await browser.tabs.sendMessage(tab.id, { type: 'w2p:vector-restore', jobId: job.id }, { frameId: 0 }).catch(() => {});
    }
  }
  if (status === 'canceled') return { ok: false, cancelled: true };
  if (status === 'not_saved' || status === 'not_replaced') throw new Error('Le PDF n’a pas pu être enregistré.');
  const warnings = [];
  if (info.inaccessibleSheets) {
    warnings.push(
      `${info.inaccessibleSheets} feuille(s) de style d’un autre domaine n’ont pas pu être adaptées à l’écran.`,
    );
  }
  return { ok: true, vector: true, status, warnings };
}

// -----------------------------------------------------------------------------
// Messages de l'agent (capture, CSS, progression) et de la popup
// -----------------------------------------------------------------------------

async function pngSize(blob) {
  const head = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  const v = new DataView(head.buffer);
  return { pw: v.getUint32(16), ph: v.getUint32(20) };
}

async function onCapture(msg, sender) {
  const job = jobs.get(msg.jobId);
  if (!job || job.cancelled || job.state !== 'running') return { cancelled: true };
  if (!sender.tab || sender.tab.id !== job.tabId) return { error: 'Onglet inattendu.' };
  try {
    const dataUrl = await browser.tabs.captureTab(job.tabId, {
      format: 'png',
      rect: msg.rect,
      scale: job.ratio / (job.zoom || 1),
    });
    const blob = await (await fetch(dataUrl)).blob();
    const { pw, ph } = await pngSize(blob);
    if (pw <= 2 && ph <= 2 && msg.rect.width > 4) {
      return { error: 'Le navigateur a refusé la capture de cette page.' };
    }
    const imgId = job.images.length;
    job.images.push({ blob, rect: msg.rect, pw, ph });
    for (const p of msg.places || []) job.placements.push({ imgId, src: p.src, dest: p.dest });
    return { ok: true };
  } catch (e) {
    const message = (e && e.message) || String(e);
    // L'onglet vient d'être masqué : l'agent attendra son retour puis réessaiera.
    if (/invisible/i.test(message)) return { retry: true };
    return { error: `Capture impossible : ${message}` };
  }
}

async function onCss(msg, sender) {
  const job = jobs.get(msg.jobId);
  if (!sender.tab) return { ok: false };
  const target = { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
  if (msg.op === 'insert') {
    await browser.scripting.insertCSS({ target, css: msg.css, origin: 'USER' });
    if (job) job.css.push(msg.css);
  } else {
    await browser.scripting.removeCSS({ target, css: msg.css, origin: 'USER' });
    if (job) job.css = job.css.filter((c) => c !== msg.css);
  }
  return { ok: true };
}

function onBegin(msg) {
  const job = jobs.get(msg.jobId);
  if (!job) return { ratio: msg.dpr || 1 };
  let ratio = job.settings.pixelRatio > 0 ? job.settings.pixelRatio : msg.dpr || 1;
  // Bornes de sécurité : une tranche d'écran ≤ 40 Mpx, une largeur ≤ 16 000 px.
  ratio = Math.min(ratio, Math.sqrt(40e6 / Math.max(1, msg.vw * msg.vh)), 16000 / Math.max(1, msg.vw));
  job.ratio = Math.max(0.5, Math.round(ratio * 1000) / 1000);
  setPhase(job, 'prepare');
  return { ratio: job.ratio };
}

function onProgress(msg) {
  const job = jobs.get(msg.jobId);
  if (job && job.state === 'running') setPhase(job, msg.phase, msg.done, msg.total);
}

function cancelJob(tabId) {
  const job = jobs.get(jobByTab.get(tabId));
  if (!job) return { ok: false };
  job.cancelled = true;
  browser.tabs.sendMessage(tabId, { type: 'w2p:cancel', jobId: job.id }, { frameId: 0 }).catch(() => {});
  return { ok: true };
}

function statusFor(tabId) {
  const running = jobs.get(jobByTab.get(tabId));
  if (running) return { job: publicJob(running) };
  let last = null;
  for (const job of jobs.values()) if (job.tabId === tabId && (!last || job.startedAt > last.startedAt)) last = job;
  return { job: last ? publicJob(last) : null };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== 'string') return undefined;
  switch (msg.type) {
    case 'w2p:start':
      return startJob(msg).then(async (r) => {
        if (!r.ok) return r;
        if (msg.wait) return { jobId: r.jobId, ...(await r.done) };
        return { ok: true, jobId: r.jobId };
      });
    case 'w2p:status':
      return Promise.resolve(statusFor(msg.tabId));
    case 'w2p:cancel':
      return Promise.resolve(cancelJob(msg.tabId));
    case 'w2p:begin':
      return Promise.resolve(onBegin(msg));
    case 'w2p:capture':
      return onCapture(msg, sender);
    case 'w2p:css':
      return onCss(msg, sender).catch((e) => ({ ok: false, error: e.message }));
    case 'w2p:progress':
      onProgress(msg);
      return Promise.resolve({ ok: true });
    case 'w2p:open-result':
      if (msg.url && blobUrls.includes(msg.url)) {
        return browser.tabs.create({ url: msg.url, active: true }).then(() => ({ ok: true }));
      }
      return Promise.resolve({ ok: false });
    default:
      return undefined;
  }
});

// -----------------------------------------------------------------------------
// Menus contextuels et raccourcis clavier
// -----------------------------------------------------------------------------

const MENU = [
  ['w2p-full', 'Page entière en PDF', { scope: 'full' }],
  ['w2p-visible', 'Zone visible en PDF', { scope: 'visible' }],
  ['w2p-element', 'Choisir un élément…', { scope: 'element' }],
  ['w2p-region', 'Tracer une zone…', { scope: 'region' }],
  ['w2p-sep', null, null],
  ['w2p-vector', 'Page entière (vectoriel, via l’impression)', { scope: 'full', overrides: { engine: 'vector' } }],
  ['w2p-options', 'Réglages…', null],
];

function createMenus() {
  browser.menus.removeAll().then(() => {
    const contexts = ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio', 'editable'];
    browser.menus.create({ id: 'w2p-root', title: 'Web2PDF Exact', contexts });
    for (const [id, title] of MENU) {
      if (!title) browser.menus.create({ id, parentId: 'w2p-root', type: 'separator', contexts });
      else browser.menus.create({ id, parentId: 'w2p-root', title, contexts });
    }
  });
}

browser.menus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === 'w2p-options') {
    browser.runtime.openOptionsPage();
    return;
  }
  const entry = MENU.find(([id]) => id === info.menuItemId);
  if (!entry || !entry[2]) return;
  // Les entrées « au pixel près » forcent le moteur exact, quel que soit le réglage par défaut.
  const { scope, overrides = { engine: 'exact' } } = entry[2];
  startJob({ tabId: tab.id, scope, overrides }).then((r) => {
    if (!r.ok) {
      flashBadge(tab.id, '!', COLORS.err, 6000);
      browser.notifications
        .create({ type: 'basic', iconUrl: browser.runtime.getURL('icons/icon-96.png'), title: 'Web2PDF Exact', message: r.error })
        .catch(() => {});
    }
  });
});

browser.commands.onCommand.addListener(async (command) => {
  const scopes = {
    'capture-full': 'full',
    'capture-visible': 'visible',
    'capture-element': 'element',
    'capture-region': 'region',
  };
  if (!scopes[command]) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const r = await startJob({ tabId: tab.id, scope: scopes[command] });
  if (!r.ok) flashBadge(tab.id, '!', COLORS.err, 6000);
});

browser.tabs.onRemoved.addListener((tabId) => {
  const job = jobs.get(jobByTab.get(tabId));
  if (job) job.cancelled = true;
});

createMenus();
