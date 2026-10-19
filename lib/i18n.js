'use strict';
// Traductions de l'interface : anglais par défaut, français quand le navigateur est
// en français (_locales/*/messages.json, générés par tools/messages.py).
var W2P = globalThis.W2P || (globalThis.W2P = {});

(() => {
  const t = (key, ...subs) => {
    const list = subs.flat().map(String);
    return browser.i18n.getMessage(key, list.length ? list : undefined) || key;
  };

  const lang = () => browser.i18n.getUILanguage() || 'en';

  // Balisage limité et sûr, sans innerHTML : <code>, <kbd>, <strong>, <em>.
  function render(el, text) {
    el.textContent = '';
    const re = /<(code|kbd|strong|em)>([\s\S]*?)<\/\1>/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) el.append(text.slice(last, m.index));
      const node = document.createElement(m[1]);
      node.textContent = m[2];
      el.append(node);
      last = re.lastIndex;
    }
    if (last < text.length) el.append(text.slice(last));
  }

  function apply(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) render(el, t(el.dataset.i18n));
    for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
    document.documentElement.lang = lang().split('-')[0];
  }

  function formatBytes(n) {
    if (n >= 1e6) {
      const nf = new Intl.NumberFormat(lang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      return t('unitMB', nf.format(n / 1e6));
    }
    return t('unitKB', String(Math.max(1, Math.round(n / 1e3))));
  }

  W2P.t = t;
  W2P.i18n = { t, apply, render, lang, formatBytes };
})();
