'use strict';
// Noms de fichiers des PDF : variables du modèle et nettoyage selon les règles
// du validateur de téléchargements de Gecko (sinon le téléchargement est refusé).
var W2P = globalThis.W2P || (globalThis.W2P = {});

(() => {
  // Classes de caractères construites par code (aucun caractère invisible dans la source).
  const chars = (...ranges) =>
    ranges
      .map((r) => (Array.isArray(r) ? `${String.fromCharCode(r[0])}-${String.fromCharCode(r[1])}` : String.fromCharCode(r)))
      .join('');
  const RE_ILLEGAL = new RegExp(`[\\\\/:*?"<>|${chars([0, 0x1f], [0x7f, 0x9f])}]`, 'g');
  const RE_BIDI = new RegExp(`[${chars(0x61c, 0x200e, 0x200f, [0x202a, 0x202e], [0x2066, 0x2069], 0xfeff, [0xfff9, 0xfffb])}]`, 'g');
  const RE_SPACES = new RegExp(`[${chars(9, 10, 11, 12, 13, 0xa0, 0x1680, [0x2000, 0x200a], 0x2028, 0x2029, 0x202f, 0x205f, 0x3000)}]`, 'g');
  const RE_EDGES = new RegExp(`^[\\s.${chars(0x180e)}]+|[\\s.${chars(0x180e)}]+$`, 'g');
  const RE_COMBINING = new RegExp(`[${chars([0x300, 0x36f])}]`, 'g');

  function sanitizeSegment(s) {
    return String(s)
      .replace(RE_ILLEGAL, '_')
      .replace(RE_BIDI, '_')
      .replace(RE_SPACES, ' ')
      .replace(/ {2,}/g, ' ')
      .replace(RE_EDGES, '')
      .slice(0, 150)
      .replace(RE_EDGES, '');
  }

  function buildFilename(template, meta, simple) {
    const d = new Date(meta.date || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    let u = null;
    try {
      u = new URL(meta.url);
    } catch (e) {
      u = null;
    }
    const vars = {
      title: meta.title || (u && u.hostname) || 'page',
      domain: u ? u.hostname.replace(/^www\./, '') : '',
      host: u ? u.host : '',
      path: u ? decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, '').replace(/\//g, '-') : '',
      date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      time: `${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`,
    };
    vars.datetime = `${vars.date} ${vars.time}`;
    let name = String(template || '{title}').replace(/\{(\w+)\}/g, (m, key) =>
      key in vars ? String(vars[key]).replace(/\//g, '-') : m,
    );
    if (simple) {
      name = name
        .normalize('NFKD')
        .replace(RE_COMBINING, '')
        .replace(/[^A-Za-z0-9 _.()/-]+/g, '_');
    }
    const segs = name
      .split('/')
      .map(sanitizeSegment)
      .filter((x) => x && x !== '..');
    let last = (segs.pop() || 'page').replace(/\.pdf$/i, '');
    last = sanitizeSegment(last) || 'page';
    segs.push(`${last}.pdf`);
    return segs.join('/');
  }

  W2P.buildFilename = buildFilename;
})();
