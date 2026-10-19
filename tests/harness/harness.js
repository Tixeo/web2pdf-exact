'use strict';
// Reçoit un ordre du lanceur de tests (window.postMessage), lance la conversion
// sur l'onglet cible exactement comme la popup, puis expose le résultat dans le DOM.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

window.addEventListener('message', async (e) => {
  const d = e.data;
  if (!d || d.type !== 'w2p-test') return;
  document.body.dataset.state = 'running';
  document.body.dataset.result = '';
  let res;
  try {
    const tabs = await browser.tabs.query({});
    const tab = tabs.find((t) => t.url === d.url) || tabs.find((t) => (t.url || '').startsWith(d.url));
    if (!tab) throw new Error(`onglet cible introuvable : ${d.url} parmi ${JSON.stringify(tabs.map((t) => [t.id, t.url, t.active, t.windowId]))}`);
    await browser.tabs.update(tab.id, { active: true });
    if (d.zoom) await browser.tabs.setZoom(tab.id, d.zoom);
    await sleep(400);
    const t0 = Date.now();
    res = await browser.runtime.sendMessage({
      type: 'w2p:start',
      tabId: tab.id,
      scope: d.scope,
      overrides: d.overrides || {},
      wait: true,
    });
    if (res) res.elapsed = Date.now() - t0;
    if (res && res.downloadId != null) {
      for (let i = 0; i < 300; i++) {
        const [item] = await browser.downloads.search({ id: res.downloadId });
        if (item && item.state !== 'in_progress') {
          res.path = item.filename;
          res.downloadState = item.state;
          break;
        }
        await sleep(100);
      }
    }
    if (d.zoom) await browser.tabs.setZoom(tab.id, 1);
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  document.body.dataset.result = JSON.stringify(res || null);
  document.body.dataset.state = 'done';
});
