'use strict';
// Agent de capture, injecté dans l'onglet (monde isolé des content scripts).
// Il travaille sur la page telle qu'elle est affichée : rien n'est rechargé,
// donc ni page de chargement ni page anti-robot. Il pilote le défilement,
// prépare la page, demande au background de capturer des rectangles (rendu
// natif de Gecko) et relève le texte, les liens et les titres pour le PDF.
(() => {
  if (window.__web2pdfExactAgent) return;
  window.__web2pdfExactAgent = true;

  const ATTR = {
    hide: 'data-w2p-hide',
    unstick: 'data-w2p-unstick',
    removed: 'data-w2p-removed',
    cv: 'data-w2p-cv',
  };
  const OVERLAY_ID = '__web2pdf_exact_overlay__';

  // CSS injecté en origine « utilisateur » : ses !important l'emportent sur ceux de la page.
  const CSS_BASE = `
html, body { scroll-behavior: auto !important; }
*, *::before, *::after { scroll-snap-type: none !important; caret-color: transparent !important; }
[${ATTR.cv}] { content-visibility: visible !important; }
[${ATTR.hide}] { visibility: hidden !important; opacity: 0 !important; }
[${ATTR.unstick}] { position: relative !important; inset: auto !important; }
[${ATTR.removed}] { display: none !important; }
`;
  // Durée quasi nulle (et non nulle) : les événements transitionend/animationend
  // restent émis, les carrousels et autres scripts ne se bloquent pas.
  const CSS_FREEZE = `
*, *::before, *::after {
  transition-duration: 0.001s !important; transition-delay: 0s !important;
  animation-duration: 0.001s !important; animation-delay: 0s !important;
}
`;

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link',
    'select', 'option', 'optgroup', 'datalist', 'textarea',
  ]);
  const MEDIA_TAGS = new Set([
    'img', 'picture', 'svg', 'video', 'canvas', 'iframe', 'embed', 'object',
    'button', 'input', 'select', 'textarea', 'tr', 'figure',
  ]);

  class CancelledError extends Error {
    constructor() {
      super('Capture annulée');
      this.cancelled = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // rAF ne tourne pas dans un onglet en arrière-plan : on borne l'attente.
  const nextFrame = () =>
    new Promise((r) => {
      const t = setTimeout(r, 120);
      requestAnimationFrame(() => {
        clearTimeout(t);
        r();
      });
    });
  async function frames(n) {
    for (let i = 0; i < n; i++) await nextFrame();
  }

  const scrollEl = () => document.scrollingElement || document.documentElement;
  function viewport() {
    const se = scrollEl();
    return {
      w: se.clientWidth || window.innerWidth,
      h: se.clientHeight || window.innerHeight,
    };
  }
  function docScrollTo(x, y) {
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
  }

  function intersect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w);
    const btm = Math.min(a.y + a.h, b.y + b.h);
    return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
  }
  const fromDOMRect = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const r2 = (v) => Math.round(v * 100) / 100;
  const INFINITE = { x: -1e7, y: -1e7, w: 2e7, h: 2e7 };

  function parseColor(str) {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(str || '');
    if (!m) return null;
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith('%')) a /= 100;
    if (a < 0.98) return null;
    return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  }
  function pageBackground() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const c = parseColor(getComputedStyle(el).backgroundColor);
      if (c) return c;
    }
    return [255, 255, 255];
  }

  // Parcourt tous les éléments, y compris dans les shadow roots (ouvertes ou fermées).
  function forEachElementDeep(root, fn) {
    const stack = [root];
    while (stack.length) {
      const r = stack.pop();
      const doc = r.nodeType === 9 ? r : r.ownerDocument || document;
      const walker = doc.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
      let el = walker.nextNode();
      while (el) {
        if (el.id !== OVERLAY_ID) {
          fn(el);
          const sr = el.openOrClosedShadowRoot;
          if (sr) stack.push(sr);
        }
        el = walker.nextNode();
      }
    }
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && i < 20; i++) {
      const sr = el.openOrClosedShadowRoot;
      if (!sr) break;
      const inner = sr.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // Parent « composé » : traverse les frontières de shadow DOM.
  function composedParent(el) {
    if (el.parentElement) return el.parentElement;
    const p = el.parentNode;
    return p && p.nodeType === 11 && p.host ? p.host : null;
  }
  function composedContains(ancestor, el) {
    for (let n = el; n; n = composedParent(n)) if (n === ancestor) return true;
    return false;
  }

  function isScrollable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.scrollHeight - el.clientHeight < 2) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
  }
  function scrollableAncestor(el) {
    const se = scrollEl();
    for (let n = composedParent(el); n; n = composedParent(n)) {
      if (n === se || n === document.documentElement) return null;
      if (n === document.body && se === document.body) return null;
      if (isScrollable(n)) return n;
    }
    return null;
  }

  // Images pas encore arrivées (option : seulement celles proches de l'écran).
  // Les pixels espions et images masquées (moins de 24 px affichés) sont ignorés :
  // certains ne finissent jamais de charger et ralentiraient la capture.
  function pendingImages(inViewOnly) {
    const out = [];
    const vp = inViewOnly ? viewport() : null;
    for (const img of document.images) {
      if (img.complete) continue;
      if (!img.currentSrc && !img.getAttribute('src') && !img.getAttribute('srcset')) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) continue;
      if (vp && (r.bottom < -64 || r.top > vp.h + 64)) continue;
      out.push(img);
    }
    return out;
  }
  async function waitImages(imgs, timeout) {
    if (!imgs.length) return;
    const each = imgs.map(
      (img) =>
        new Promise((res) => {
          if (img.complete) return res();
          img.addEventListener('load', res, { once: true });
          img.addEventListener('error', res, { once: true });
        }),
    );
    await Promise.race([Promise.all(each), sleep(timeout)]);
  }

  async function waitForDocument() {
    if (document.readyState !== 'complete') {
      await Promise.race([
        new Promise((r) => window.addEventListener('load', r, { once: true })),
        sleep(10000),
      ]);
    }
    if (document.fonts && document.fonts.status !== 'loaded') {
      await Promise.race([document.fonts.ready, sleep(4000)]);
    }
  }

  const bg = (msg) => browser.runtime.sendMessage(msg);

  // ---------------------------------------------------------------------------
  // Réécriture des media queries (mode vectoriel : imprimer « comme à l'écran »)
  // ---------------------------------------------------------------------------

  function rewriteMediaQuery(q) {
    const m = /^(not\s+|only\s+)?([a-z-]+)(\s+and\s[\s\S]*)?$/i.exec(q.trim());
    if (!m) return q.trim();
    const prefix = (m[1] || '').trim().toLowerCase();
    const type = m[2].toLowerCase();
    const rest = m[3] || '';
    if (type === 'screen' || type === 'all') return `${prefix ? prefix + ' ' : ''}all${rest}`;
    return prefix === 'not' ? 'all' : 'not all';
  }
  function rewriteMediaText(text) {
    if (!text || !text.trim()) return text;
    return text.split(',').map(rewriteMediaQuery).join(', ');
  }

  // ---------------------------------------------------------------------------
  // Tâche de capture
  // ---------------------------------------------------------------------------

  let current = null;

  class Job {
    constructor(id, settings, scope) {
      this.id = id;
      this.s = settings;
      this.scope = scope;
      this.cancelled = false;
      this.phase = 'init';
      this.restorers = [];
      this.css = [];
      this.marked = new Map(); // attribut -> Set d'éléments
      this.protect = new Set();
      this.doneText = new WeakSet(); // nœuds de texte entièrement relevés
      this.partialText = new WeakMap(); // nœud -> débuts des mots déjà relevés
      this.seenEl = new WeakSet();
      this.words = [];
      this.links = [];
      this.headings = [];
      this.avoid = [];
      this.warnings = [];
      this.lastProgress = 0;
      this.state = null;
      this.timings = { preload: 0, settle: 0, capture: 0, collect: 0 };
    }

    async timed(key, fn) {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        this.timings[key] += performance.now() - t0;
      }
    }

    check() {
      if (this.cancelled) throw new CancelledError();
    }

    progress(phase, done, total) {
      const now = Date.now();
      if (now - this.lastProgress < 180 && done < total) return;
      this.lastProgress = now;
      bg({ type: 'w2p:progress', jobId: this.id, phase, done, total }).catch(() => {});
    }

    async insertCss(css) {
      await bg({ type: 'w2p:css', jobId: this.id, op: 'insert', css });
      this.css.push(css);
    }

    // Onglet masqué (autre onglet affiché, fenêtre réduite) : le navigateur ne peut ni
    // dessiner ni déclencher les chargements différés. On attend son retour.
    async waitVisible() {
      if (document.visibilityState !== 'hidden') return;
      this.progress('paused', 0, 0);
      await new Promise((resolve) => {
        const check = () => {
          if (document.visibilityState !== 'hidden' || this.cancelled) {
            document.removeEventListener('visibilitychange', check);
            clearInterval(timer);
            resolve();
          }
        };
        const timer = setInterval(check, 400);
        document.addEventListener('visibilitychange', check);
      });
      this.check();
      await frames(2);
      this.progress(this.phase, 0, 1);
    }

    async capture(rect, places) {
      for (let attempt = 0; ; attempt++) {
        this.check();
        await this.waitVisible();
        const t0 = performance.now();
        const res = await bg({
          type: 'w2p:capture',
          jobId: this.id,
          rect: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
          places,
        });
        this.timings.capture += performance.now() - t0;
        if (!res || res.cancelled) {
          this.cancelled = true;
          throw new CancelledError();
        }
        if (res.retry && attempt < 50) {
          await sleep(300);
          continue;
        }
        if (res.error) throw new Error(res.error);
        return;
      }
    }

    mark(el, attr) {
      if (!el || el.hasAttribute(attr)) return false;
      el.setAttribute(attr, '');
      let set = this.marked.get(attr);
      if (!set) this.marked.set(attr, (set = new Set()));
      set.add(el);
      return true;
    }
    unmark(el, attr) {
      el.removeAttribute(attr);
      const set = this.marked.get(attr);
      if (set) set.delete(el);
    }

    saveState() {
      const sel = window.getSelection();
      const ranges = [];
      if (sel) {
        for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
        sel.removeAllRanges();
      }
      this.state = { x: window.scrollX, y: window.scrollY, ranges, containers: [] };
    }

    rememberScroll(el) {
      if (this.state && !this.state.containers.some((c) => c.el === el)) {
        this.state.containers.push({ el, left: el.scrollLeft, top: el.scrollTop });
      }
    }

    async restore() {
      for (const fn of this.restorers.reverse()) {
        try {
          fn();
        } catch (e) {
          /* élément disparu */
        }
      }
      this.restorers = [];
      for (const [attr, set] of this.marked) for (const el of set) el.removeAttribute(attr);
      this.marked.clear();
      const ov = document.getElementById(OVERLAY_ID);
      if (ov) ov.remove();
      for (const css of this.css) {
        await bg({ type: 'w2p:css', jobId: this.id, op: 'remove', css }).catch(() => {});
      }
      this.css = [];
      if (this.state) {
        for (const c of this.state.containers) {
          try {
            c.el.scrollTo({ left: c.left, top: c.top, behavior: 'instant' });
          } catch (e) {
            /* ignoré */
          }
        }
        docScrollTo(this.state.x, this.state.y);
        const sel = window.getSelection();
        if (sel && this.state.ranges.length) {
          sel.removeAllRanges();
          for (const r of this.state.ranges) sel.addRange(r);
        }
      }
    }

    // Attend que la page se stabilise après un défilement.
    async settle() {
      const t0 = performance.now();
      await this.waitVisible();
      await frames(2);
      await waitImages(pendingImages(true), 3000);
      if (this.s.settleDelay) await this.quiet(this.s.settleDelay);
      await frames(1);
      this.timings.settle += performance.now() - t0;
      this.check();
    }

    // Attente adaptative : on repart dès que la page est calme depuis 80 ms (aucune
    // modification du DOM, aucune animation finie en cours), au plus `max` ms.
    async quiet(max) {
      let last = performance.now();
      const mo = new MutationObserver(() => {
        last = performance.now();
      });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const animating = () => {
        if (!document.getAnimations) return false;
        for (const a of document.getAnimations()) {
          if (a.playState !== 'running') continue;
          const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
          if (t && Number.isFinite(t.endTime)) return true; // les animations infinies sont ignorées
        }
        return false;
      };
      const start = performance.now();
      try {
        while (performance.now() - start < max) {
          await sleep(40);
          if (performance.now() - last >= 80 && !animating()) break;
        }
      } finally {
        mo.disconnect();
      }
    }

    // -------------------------------------------------------------------------
    // Éléments flottants (fixed / sticky) et content-visibility
    // -------------------------------------------------------------------------

    scan() {
      const fixed = [];
      forEachElementDeep(document, (el) => {
        const cs = getComputedStyle(el);
        const pos = cs.position;
        if (pos === 'fixed') fixed.push(el);
        else if (pos === 'sticky' || pos === '-webkit-sticky') {
          if (this.scope !== 'visible') this.mark(el, ATTR.unstick);
        }
        if (cs.contentVisibility === 'auto') this.mark(el, ATTR.cv);
      });
      return fixed;
    }

    // Un élément fixe qui contient la cible (ou le conteneur) ne doit jamais être masqué.
    isProtected(el) {
      for (const p of this.protect) if (composedContains(el, p)) return true;
      return false;
    }

    // Grand calque fixe servant de fond (dégradé, image…) : on le garde partout.
    isBackdrop(el) {
      const vp = viewport();
      const r = el.getBoundingClientRect();
      const vis = intersect(fromDOMRect(r), { x: 0, y: 0, w: vp.w, h: vp.h });
      if (!vis || vis.w * vis.h < 0.85 * vp.w * vp.h) return false;
      const z = parseInt(getComputedStyle(el).zIndex, 10);
      return (Number.isFinite(z) && z < 0) || !(el.innerText || '').trim();
    }

    hideFixed(list) {
      for (const el of list) {
        if (!el.isConnected || el.hasAttribute(ATTR.hide)) continue;
        if (this.isProtected(el) || this.isBackdrop(el)) continue;
        if (!el.getClientRects().length) continue;
        this.mark(el, ATTR.hide);
      }
    }

    // Repère les éléments devenus fixed/sticky pendant le défilement (en-têtes JS…).
    sampleFloating() {
      const vp = viewport();
      const fixed = new Set();
      const xs = [0.02, 0.15, 0.3, 0.5, 0.7, 0.85, 0.98];
      const ys = [0.01, 0.05, 0.12, 0.25, 0.5, 0.75, 0.88, 0.95, 0.99];
      const checked = new Set();
      for (const fx of xs) {
        for (const fy of ys) {
          for (const el of document.elementsFromPoint(fx * vp.w, fy * vp.h)) {
            if (checked.has(el) || el.id === OVERLAY_ID) continue;
            checked.add(el);
            const pos = getComputedStyle(el).position;
            if (pos === 'fixed') fixed.add(el);
            else if (pos === 'sticky' || pos === '-webkit-sticky') this.mark(el, ATTR.unstick);
          }
        }
      }
      return [...fixed];
    }

    // -------------------------------------------------------------------------
    // Relevé du texte, des liens, des titres et des zones à ne pas couper
    // -------------------------------------------------------------------------

    // ctx : { clip (coords client du document principal), map(rect client) -> rect sortie,
    //         exclude (élément dont on ignore le sous-arbre), locate(el) -> {x,y} sortie }
    collect(roots, ctx) {
      if (!this.s.textLayer && !this.s.links && !this.s.bookmarks && !this.s.smartBreaks) return;
      const t0 = performance.now();
      ctx.vis = new Map();
      ctx.clipCache = new Map();
      ctx.styles = new Map();
      for (const root of roots) this.walk(root, ctx, { x: 0, y: 0 }, INFINITE, document);
      this.timings.collect += performance.now() - t0;
    }

    walk(root, ctx, off, frameClip, doc) {
      const range = doc.createRange();
      const stack = [root];
      while (stack.length) {
        const r = stack.pop();
        const walker = doc.createTreeWalker(r, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          if (node.nodeType === 3) {
            if (this.s.textLayer || this.s.smartBreaks) this.processText(node, ctx, off, frameClip, range);
            node = walker.nextNode();
            continue;
          }
          const name = node.localName;
          if (
            SKIP_TAGS.has(name) ||
            node.id === OVERLAY_ID ||
            (ctx.exclude && node === ctx.exclude)
          ) {
            if (MEDIA_TAGS.has(name)) this.processElement(node, ctx, off, frameClip);
            node = skipSubtree(walker);
            continue;
          }
          this.processElement(node, ctx, off, frameClip);
          const sr = node.openOrClosedShadowRoot;
          if (sr) stack.push(sr);
          if (name === 'iframe' || name === 'frame') this.walkFrame(node, ctx, off, frameClip);
          node = walker.nextNode();
        }
      }
    }

    walkFrame(frame, ctx, off, frameClip) {
      let doc = null;
      try {
        doc = frame.contentDocument;
      } catch (e) {
        doc = null;
      }
      if (!doc || !doc.documentElement) return;
      const r = frame.getBoundingClientRect();
      const cs = getComputedStyle(frame);
      const ox = off.x + r.left + frame.clientLeft + parseFloat(cs.paddingLeft || 0);
      const oy = off.y + r.top + frame.clientTop + parseFloat(cs.paddingTop || 0);
      const box = { x: ox, y: oy, w: frame.clientWidth, h: frame.clientHeight };
      const clip = intersect(box, frameClip);
      if (!clip) return;
      this.walk(doc.documentElement, ctx, { x: ox, y: oy }, clip, doc);
    }

    style(el, ctx) {
      let cs = ctx.styles.get(el);
      if (!cs) ctx.styles.set(el, (cs = el.ownerDocument.defaultView.getComputedStyle(el)));
      return cs;
    }

    visible(el, ctx) {
      let v = ctx.vis.get(el);
      if (v === undefined) {
        v =
          typeof el.checkVisibility === 'function'
            ? el.checkVisibility({
                opacityProperty: true,
                visibilityProperty: true,
                checkOpacity: true,
                checkVisibilityCSS: true,
              })
            : true;
        ctx.vis.set(el, v);
      }
      return v;
    }

    // Intersection des zones de rognage (overflow) des ancêtres, en coordonnées client.
    clipOf(el, ctx, off, frameClip) {
      if (!el || el.nodeType !== 1) return frameClip;
      const cached = ctx.clipCache.get(el);
      if (cached !== undefined) return cached;
      const cs = this.style(el, ctx);
      let clip;
      if (cs.position === 'fixed') clip = frameClip;
      else {
        const parent = composedParent(el);
        clip = parent ? this.clipOf(parent, ctx, off, frameClip) : frameClip;
      }
      if (clip && el !== el.ownerDocument.documentElement && el !== el.ownerDocument.body) {
        const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
        if (clips) {
          const r = el.getBoundingClientRect();
          const box = {
            x: r.left + el.clientLeft + off.x,
            y: r.top + el.clientTop + off.y,
            w: el.clientWidth || r.width,
            h: el.clientHeight || r.height,
          };
          clip = intersect(clip, box);
        }
      }
      ctx.clipCache.set(el, clip || null);
      return clip || null;
    }

    // Les mots sont relevés au moment où leur tranche est capturée : positions et image
    // restent synchrones, même si la page se recompose ou virtualise ses listes.
    processText(node, ctx, off, frameClip, range) {
      if (this.doneText.has(node)) return;
      const data = node.data;
      if (!/\S/.test(data)) {
        this.doneText.add(node);
        return;
      }
      const parent = node.parentElement;
      if (!parent) return;
      range.selectNodeContents(node);
      const br = range.getBoundingClientRect();
      if (br.width === 0 && br.height === 0) return; // pas (encore) rendu
      const box = { x: br.left + off.x, y: br.top + off.y, w: br.width, h: br.height };
      if (!intersect(box, ctx.clip)) return; // pas dans cette tranche : on réessaiera
      const sliceBottom = ctx.clip.y + ctx.clip.h;
      const passed = box.y + box.h <= sliceBottom + 0.5;
      // Encore invisible (animation d'apparition pas déclenchée…) : on retentera, sauf
      // s'il a entièrement défilé sans apparaître.
      if (!this.visible(parent, ctx)) {
        if (passed) this.doneText.add(node);
        return;
      }
      const clip = this.clipOf(parent, ctx, off, frameClip);
      if (!clip) {
        this.doneText.add(node);
        return;
      }
      const tt = this.style(parent, ctx).textTransform;
      const transform = (t) =>
        tt === 'uppercase'
          ? t.toUpperCase()
          : tt === 'lowercase'
            ? t.toLowerCase()
            : tt === 'capitalize'
              ? t.replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase())
              : t;
      let done = this.partialText.get(node);
      if (!done) this.partialText.set(node, (done = new Set()));

      // start : position du mot (ou du morceau de mot) dans le nœud, clé anti-doublon.
      const emit = (start, text, rect, space) => {
        if (done.has(start) || rect.width <= 0.5 || rect.height <= 0.5) return;
        const abs = { x: rect.left + off.x, y: rect.top + off.y, w: rect.width, h: rect.height };
        if (abs.y + abs.h / 2 >= sliceBottom) return; // sous la tranche : plus tard
        done.add(start);
        const vis = intersect(abs, clip);
        if (!vis || vis.w * vis.h < 0.5 * abs.w * abs.h) return;
        const o = ctx.map(abs);
        if (!o) return;
        if (this.s.smartBreaks) this.avoid.push([r2(o.y), r2(o.y + o.h), 3]);
        if (this.s.textLayer && this.words.length < 400000) {
          this.words.push([r2(o.x), r2(o.y), r2(o.w), r2(o.h), transform(text), space ? 1 : 0]);
        }
      };

      const re = /\S+/g;
      let m;
      while ((m = re.exec(data)) !== null) {
        const s = m.index;
        const e = s + m[0].length;
        if (done.has(s)) continue;
        const space = e < data.length;
        range.setStart(node, s);
        range.setEnd(node, e);
        const rects = range.getClientRects();
        if (!rects.length) continue;
        if (rects.length === 1) {
          emit(s, m[0], rects[0], space);
          continue;
        }
        const top0 = rects[0].top;
        let sameLine = true;
        for (const rc of rects) if (Math.abs(rc.top - top0) > 2) sameLine = false;
        if (sameLine) {
          emit(s, m[0], range.getBoundingClientRect(), space);
          continue;
        }
        this.splitByLine(node, s, e, range, emit, space);
      }
      if (passed) {
        this.doneText.add(node);
        this.partialText.delete(node);
      }
    }

    // Mot coupé sur plusieurs lignes (césure, texte CJK) : on regroupe caractère par caractère.
    splitByLine(node, s, e, range, emit, space) {
      const data = node.data;
      let group = null;
      const flush = (last) => {
        if (group) emit(group.start, group.text, group.rect, last ? space : false);
        group = null;
      };
      let i = s;
      while (i < e) {
        const cp = data.codePointAt(i);
        const len = cp > 0xffff ? 2 : 1;
        range.setStart(node, i);
        range.setEnd(node, i + len);
        const rc = range.getBoundingClientRect();
        const ch = data.slice(i, i + len);
        const at = i;
        i += len;
        if (rc.width === 0 && rc.height === 0) {
          if (group) group.text += ch;
          continue;
        }
        if (group && Math.abs(rc.top - group.rect.top) <= Math.max(2, rc.height * 0.4)) {
          const left = Math.min(group.rect.left, rc.left);
          const right = Math.max(group.rect.left + group.rect.width, rc.left + rc.width);
          const top = Math.min(group.rect.top, rc.top);
          const bottom = Math.max(group.rect.top + group.rect.height, rc.top + rc.height);
          group.rect = { left, top, width: right - left, height: bottom - top };
          group.text += ch;
        } else {
          flush(false);
          group = { start: at, text: ch, rect: { left: rc.left, top: rc.top, width: rc.width, height: rc.height } };
        }
      }
      flush(true);
    }

    processElement(el, ctx, off, frameClip) {
      if (this.seenEl.has(el)) return;
      const name = el.localName;
      let kind = null;
      if (name === 'a' && el.hasAttribute('href')) kind = 'link';
      else if (/^h[1-6]$/.test(name) || el.getAttribute('role') === 'heading') kind = 'heading';
      else if (MEDIA_TAGS.has(name)) kind = 'media';
      if (!kind) return;
      if (kind === 'link' && !this.s.links) return;
      if (kind === 'heading' && !this.s.bookmarks) return;
      if (kind === 'media' && !this.s.smartBreaks) return;
      const br = el.getBoundingClientRect();
      if (br.width === 0 && br.height === 0) return;
      const box = { x: br.left + off.x, y: br.top + off.y, w: br.width, h: br.height };
      if (!intersect(box, ctx.clip)) return;
      if (!this.visible(el, ctx)) {
        if (box.y + box.h <= ctx.clip.y + ctx.clip.h + 0.5) this.seenEl.add(el);
        return;
      }
      this.seenEl.add(el);
      const clip = this.clipOf(el, ctx, off, frameClip);
      if (!clip) return;

      if (kind === 'media') {
        const vis = intersect(box, clip);
        const o = vis && ctx.map(vis);
        if (o) this.avoid.push([r2(o.y), r2(o.y + o.h), 1]);
        return;
      }

      if (kind === 'heading') {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!text) return;
        let level = parseInt(name.slice(1), 10);
        if (!Number.isFinite(level)) level = parseInt(el.getAttribute('aria-level'), 10) || 2;
        const o = ctx.map(box);
        if (o) this.headings.push({ level: Math.min(6, Math.max(1, level)), text, y: r2(o.y), x: r2(o.x) });
        return;
      }

      // Lien
      let href = el.href;
      if (href && typeof href === 'object' && 'baseVal' in href) {
        try {
          href = new URL(href.baseVal, el.baseURI).href;
        } catch (e) {
          href = '';
        }
      }
      if (!href || /^\s*javascript:/i.test(href)) return;
      const rects = [...el.getClientRects()].map((r) => ({
        x: r.left + off.x,
        y: r.top + off.y,
        w: r.width,
        h: r.height,
      }));
      let n = 0;
      for (const m of el.querySelectorAll('img, svg, picture, video, canvas')) {
        if (++n > 12) break;
        const r = m.getBoundingClientRect();
        if (r.width && r.height) rects.push({ x: r.left + off.x, y: r.top + off.y, w: r.width, h: r.height });
      }
      let target = null;
      try {
        const u = new URL(href);
        const here = new URL(el.ownerDocument.URL);
        if (u.hash && u.origin === here.origin && u.pathname === here.pathname && u.search === here.search) {
          const id = decodeURIComponent(u.hash.slice(1));
          const doc = el.ownerDocument;
          const t =
            id === '' || id.toLowerCase() === 'top'
              ? doc.documentElement
              : doc.getElementById(id) || doc.getElementsByName(id)[0];
          if (t && doc === document) target = ctx.locate(t);
        }
      } catch (e) {
        /* URL invalide */
      }
      for (const r of rects) {
        const vis = intersect(r, clip);
        if (!vis || vis.w < 1 || vis.h < 1) continue;
        const o = ctx.map(vis);
        if (!o) continue;
        const link = { x: r2(o.x), y: r2(o.y), w: r2(o.w), h: r2(o.h) };
        if (target) link.target = target;
        else link.url = href;
        this.links.push(link);
      }
    }

    // -------------------------------------------------------------------------
    // Préchargement (contenu paresseux) et capture
    // -------------------------------------------------------------------------

    makeEager() {
      for (const el of document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]')) {
        el.setAttribute('loading', 'eager');
        this.restorers.push(() => el.setAttribute('loading', 'lazy'));
      }
    }

    async preload(sc, endContentY) {
      const t0 = performance.now();
      this.phase = 'preload';
      this.makeEager();
      const win = sc.window();
      const step = Math.max(200, Math.floor(win.h * 0.95));
      const x0 = sc.left();
      let y = 0;
      for (let i = 0; i < 5000; i++) {
        await this.waitVisible();
        sc.scrollTo(x0, y);
        await nextFrame();
        await sleep(70);
        this.check();
        const max = Math.max(0, Math.min(sc.maxTop(), endContentY() - win.h));
        this.progress('preload', Math.min(y, max), max);
        if (y >= max) break;
        y = Math.min(y + step, max);
      }
      await waitImages(pendingImages(false), 4000);
      sc.scrollTo(x0, 0);
      await frames(2);
      await sleep(250);
      this.timings.preload += performance.now() - t0;
      this.check();
    }

    // Moteur générique « défiler puis capturer ».
    // sc : défileur (document ou conteneur), roi : zone voulue en coordonnées de contenu,
    // toOut(cx, cy) : coordonnées de contenu -> coordonnées de sortie.
    async stitch(sc, roi, toOut, opts) {
      this.phase = 'capture';
      const end = roi.y + roi.h;
      const right = roi.x + roi.w;
      let needY = roi.y;
      let first = !opts.frameCaptured;
      let shot = 0;
      while (needY < end - 0.5) {
        let rowBottom = needY;
        let needX = roi.x;
        while (needX < right - 0.5) {
          // Certaines pages repoussent le défilement (ancrage, scripts) : on réessaie pour
          // ne laisser aucune bande non capturée.
          for (let tries = 0; tries < 3; tries++) {
            sc.scrollTo(needX, needY - sc.window().offsetY);
            await this.settle();
            if (sc.window().contentTop <= needY + 0.5) break;
          }
          // Après la première tranche, les éléments devenus fixes (en-têtes JS…) sont masqués.
          if (!first || this.hideAllFloating) this.hideFixed(this.sampleFloating());
          await nextFrame();

          const win = sc.window(); // fenêtre visible (coords client) et origine du contenu
          const cTop = win.contentTop; // y de contenu au bord haut de la fenêtre
          const cLeft = win.contentLeft;
          // Le bas de l'écran n'est pas retenu (sauf en fin de page) : les animations
          // d'apparition s'y déclenchent souvent en retard (AOS : 120 px, seuils
          // d'IntersectionObserver…). La limite est placée entre deux blocs, pour que
          // chaque bloc soit photographié en entier là où il est bien visible.
          const y0 = Math.max(needY, cTop);
          let y1;
          if (cTop + win.h >= end - 0.5) y1 = end;
          else {
            // Coupes en pixels entiers : une origine fractionnaire décalerait le rendu
            // d'une fraction de pixel (léger flou, raccords visibles).
            const margin = Math.round(Math.min(win.h * 0.25, Math.max(120, win.h * 0.2)));
            const hi = Math.floor(Math.min(end, cTop + win.h - margin));
            const lo = Math.ceil(Math.max(y0 + 1, Math.min(hi, cTop + win.h * 0.45)));
            y1 = Math.max(Math.min(hi, lo), this.chooseCut(win, cTop, lo, hi));
          }
          const x0 = Math.max(needX, cLeft);
          const x1 = Math.min(right, cLeft + win.w);
          if (y1 <= needY + 0.25 || x1 <= x0) {
            // Impossible d'avancer (contenu plus court que prévu).
            needX = right;
            rowBottom = end;
            break;
          }
          const sx = window.scrollX;
          const sy = window.scrollY;
          const rect = {
            x: win.x + (x0 - cLeft) + sx,
            y: win.y + (y0 - cTop) + sy,
            w: x1 - x0,
            h: y1 - y0,
          };
          const dest = toOut(x0, y0);
          await this.capture(rect, [{ src: { x: 0, y: 0, w: rect.w, h: rect.h }, dest }]);
          shot++;

          // Texte relevé sur la bande retenue : il reste synchrone avec l'image.
          const clip = { x: win.x, y: win.y, w: win.w, h: y1 - cTop };
          this.collect(opts.roots, {
            clip,
            exclude: null,
            map: (r) => {
              const p = toOut(r.x - win.x + cLeft, r.y - win.y + cTop);
              return { x: p.x, y: p.y, w: r.w, h: r.h };
            },
            locate: opts.locate,
          });

          if (first) {
            first = false;
            if (this.s.floating === 'once') this.hideFixed(opts.fixed);
          }
          this.progress('capture', Math.min(y1, end) - roi.y, roi.h);
          needX = x1;
          rowBottom = Math.max(rowBottom, y1);
        }
        if (rowBottom <= needY + 0.25) break;
        needY = rowBottom;
      }
      if (!shot) throw new Error('Rien à capturer : la zone est vide ou hors de la page.');
    }

    // Choisit, entre lo et hi (coordonnées de contenu), la ligne de coupe qui traverse
    // le moins de blocs (paragraphes, cartes, images…) ; à égalité, la plus basse.
    chooseCut(win, cTop, lo, hi) {
      if (hi - lo < 8) return hi;
      const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => win.x + win.w * f);
      const small = win.h * 0.5;
      const rects = new Map();
      const crossings = (cy) => {
        const y = win.y + (cy - cTop);
        let n = 0;
        const counted = new Set();
        for (const x of xs) {
          for (const el of document.elementsFromPoint(x, y)) {
            if (counted.has(el)) continue;
            counted.add(el);
            let r = rects.get(el);
            if (!r) rects.set(el, (r = el.getBoundingClientRect()));
            if (r.height >= small || r.height < 2) continue;
            if (r.top < y - 2 && r.bottom > y + 2) n++;
          }
        }
        return n;
      };
      let best = hi;
      let bestN = Infinity;
      for (let cy = hi; cy >= lo; cy -= 6) {
        const n = crossings(cy);
        if (n < bestN) {
          bestN = n;
          best = cy;
          if (n === 0) break;
        }
      }
      return best;
    }

    // -------------------------------------------------------------------------
    // Plans de capture
    // -------------------------------------------------------------------------

    docScroller() {
      return {
        horizontal: true,
        left: () => window.scrollX,
        top: () => window.scrollY,
        maxTop: () => Math.max(0, scrollEl().scrollHeight - viewport().h),
        scrollTo: (x, y) => docScrollTo(Math.max(0, x), Math.max(0, y)),
        window: () => {
          const vp = viewport();
          return {
            x: 0,
            y: 0,
            w: vp.w,
            h: vp.h,
            offsetY: 0,
            contentTop: window.scrollY,
            contentLeft: window.scrollX,
          };
        },
      };
    }

    containerScroller(S) {
      this.rememberScroll(S);
      const win = () => {
        const vp = viewport();
        const r = S.getBoundingClientRect();
        const cr = { x: r.left + S.clientLeft, y: r.top + S.clientTop, w: S.clientWidth, h: S.clientHeight };
        const vis = intersect(cr, { x: 0, y: 0, w: vp.w, h: vp.h }) || { ...cr, h: 0 };
        return {
          x: vis.x,
          y: vis.y,
          w: vis.w,
          h: vis.h,
          offsetY: vis.y - cr.y,
          contentTop: S.scrollTop + (vis.y - cr.y),
          contentLeft: S.scrollLeft + (vis.x - cr.x),
          cr,
        };
      };
      return {
        horizontal: false,
        left: () => S.scrollLeft,
        top: () => S.scrollTop,
        maxTop: () => Math.max(0, S.scrollHeight - S.clientHeight),
        scrollTo: (x, y) => S.scrollTo({ left: S.scrollLeft, top: Math.max(0, y), behavior: 'instant' }),
        window: win,
      };
    }

    // Page entière ou zone du document.
    async captureDocument(roiFn, method, fixed) {
      const sc = this.docScroller();
      const vp = viewport();
      const locate = (el) => {
        const r = el.getBoundingClientRect();
        const roi = this.roi;
        return { x: r2(r.left + window.scrollX - roi.x), y: r2(r.top + window.scrollY - roi.y) };
      };

      if (this.s.preloadLazy && (this.scope === 'full' || method === 'scroll')) {
        await this.preload(sc, () => Math.min(this.s.maxHeight, scrollEl().scrollHeight));
      }
      const roi = (this.roi = roiFn());
      if (roi.h > this.s.maxHeight) {
        roi.h = this.s.maxHeight;
        this.warnings.push(`Page tronquée à ${this.s.maxHeight} px de haut (réglage « Hauteur maximale »).`);
      }
      const toOut = (x, y) => ({ x: x - roi.x, y: y - roi.y });

      if (method === 'direct') {
        this.phase = 'capture';
        if (this.scope === 'full') docScrollTo(0, 0);
        else if (this.scope !== 'visible') {
          // Amène la zone à l'écran (chargements paresseux, animations d'apparition).
          if (roi.y < window.scrollY || roi.y + roi.h > window.scrollY + vp.h) {
            docScrollTo(window.scrollX, Math.max(0, roi.y - Math.max(0, (vp.h - roi.h) / 2)));
          }
        }
        await this.settle();
        if (this.hideAllFloating) this.hideFixed(fixed);
        await nextFrame();
        const ratio = this.ratio;
        const tileH = Math.max(64, Math.floor(Math.min(8192, 16e6 / Math.max(1, roi.w * ratio)) / ratio));
        let shots = 0;
        for (let y = roi.y; y < roi.y + roi.h; y += tileH) {
          const h = Math.min(tileH, roi.y + roi.h - y);
          await this.capture({ x: roi.x, y, w: roi.w, h }, [
            { src: { x: 0, y: 0, w: roi.w, h }, dest: toOut(roi.x, y) },
          ]);
          shots++;
          this.progress('capture', y + h - roi.y, roi.h);
        }
        if (!shots) throw new Error('Zone vide.');
        const sx = window.scrollX;
        const sy = window.scrollY;
        this.collect([document], {
          clip: { x: roi.x - sx, y: roi.y - sy, w: roi.w, h: roi.h },
          map: (r) => ({ x: r.x + sx - roi.x, y: r.y + sy - roi.y, w: r.w, h: r.h }),
          locate,
        });
      } else {
        if (this.hideAllFloating) this.hideFixed(fixed);
        await this.stitch(sc, roi, toOut, { roots: [document], fixed, locate });
      }
      return { width: roi.w, height: roi.h };
    }

    // Conteneur défilant interne (applis web : messageries, docs, tableaux de bord…).
    // frame=true : la page autour est conservée et le conteneur « déroulé » en place.
    async captureContainer(S, { frame, roiContent, fixed }) {
      const vp = viewport();
      if (frame) {
        docScrollTo(0, 0);
      } else {
        const r = S.getBoundingClientRect();
        if (r.top < 0 || r.bottom > vp.h) {
          docScrollTo(window.scrollX, Math.max(0, window.scrollY + r.top - Math.max(0, (vp.h - r.height) / 2)));
        }
      }
      const sc = this.containerScroller(S);
      if (this.s.preloadLazy) {
        await this.preload(sc, () => Math.min(this.s.maxHeight, S.scrollHeight));
      }
      sc.scrollTo(0, 0);
      await this.settle();
      if (this.hideAllFloating) this.hideFixed(fixed);

      const w0 = sc.window();
      const contentH = Math.min(this.s.maxHeight, S.scrollHeight);
      if (S.scrollHeight > this.s.maxHeight) {
        this.warnings.push(`Contenu tronqué à ${this.s.maxHeight} px de haut (réglage « Hauteur maximale »).`);
      }
      const roi = roiContent || { x: w0.contentLeft, y: w0.offsetY, w: w0.w, h: contentH - w0.offsetY };
      roi.h = Math.max(1, Math.min(roi.h, contentH - roi.y));
      let out;
      let toOut;
      let frameMap = null;

      if (frame) {
        // Le contenu du conteneur est « déroulé » à sa place ; ce qui est sous lui descend d'autant.
        const extra = Math.max(0, roi.h - w0.h);
        const bottom = w0.y + w0.h;
        out = { width: vp.w, height: Math.round(vp.h + extra) };
        toOut = (cx, cy) => ({ x: w0.x + (cx - w0.contentLeft), y: w0.y + (cy - roi.y) });
        frameMap = (r) => ({ x: r.x, y: r.y >= bottom ? r.y + extra : r.y, w: r.w, h: r.h });
        const sx = window.scrollX;
        const sy = window.scrollY;
        const places = [{ src: { x: 0, y: 0, w: vp.w, h: Math.min(vp.h, bottom) }, dest: { x: 0, y: 0 } }];
        if (bottom < vp.h) {
          places.push({ src: { x: 0, y: bottom, w: vp.w, h: vp.h - bottom }, dest: { x: 0, y: bottom + extra } });
        }
        this.phase = 'capture';
        await this.capture({ x: sx, y: sy, w: vp.w, h: vp.h }, places);
        this.collect([document], {
          clip: { x: 0, y: 0, w: vp.w, h: vp.h },
          exclude: S,
          map: frameMap,
          locate: (el) => this.locateIn(el, S, toOut, frameMap),
        });
        if (this.s.floating === 'once') this.hideFixed(fixed);
      } else {
        out = { width: roi.w, height: roi.h };
        toOut = (cx, cy) => ({ x: cx - roi.x, y: cy - roi.y });
      }
      this.roiOut = out;
      await this.stitch(sc, roi, toOut, {
        roots: [S],
        fixed,
        frameCaptured: frame,
        locate: (el) => this.locateIn(el, S, toOut, frameMap),
      });
      return out;
    }

    locateIn(el, S, toOut, frameMap) {
      const r = el.getBoundingClientRect();
      if (composedContains(S, el)) {
        const b = S.getBoundingClientRect();
        const cx = r.left - (b.left + S.clientLeft) + S.scrollLeft;
        const cy = r.top - (b.top + S.clientTop) + S.scrollTop;
        const p = toOut(cx, cy);
        return { x: r2(p.x), y: r2(p.y) };
      }
      if (!frameMap) return null;
      const p = frameMap({ x: r.left, y: r.top, w: r.width, h: r.height });
      return { x: r2(p.x), y: r2(p.y) };
    }

    findScrollContainer() {
      const vp = viewport();
      const se = scrollEl();
      const docRange = se.scrollHeight - se.clientHeight;
      let best = null;
      let bestScore = 0;
      forEachElementDeep(document, (el) => {
        if (el === se) return;
        const range = el.scrollHeight - el.clientHeight;
        if (range < 64 || el.clientHeight < 120 || el.clientWidth < 200) return;
        const oy = getComputedStyle(el).overflowY;
        if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return;
        const r = el.getBoundingClientRect();
        const vis = intersect(fromDOMRect(r), { x: 0, y: 0, w: vp.w, h: vp.h });
        if (!vis) return;
        const area = vis.w * vis.h;
        if (area < 0.2 * vp.w * vp.h) return;
        const score = area * Math.log2(2 + range / el.clientHeight);
        if (score > bestScore) {
          bestScore = score;
          best = { el, range };
        }
      });
      if (!best) return null;
      if (docRange > 64 && docRange >= best.range * 0.5) return null;
      return best.el;
    }

    // -------------------------------------------------------------------------
    // Déroulé complet
    // -------------------------------------------------------------------------

    async run() {
      const s = this.s;
      this.saveState();
      await this.insertCss(CSS_BASE + (s.freezeAnimations ? CSS_FREEZE : ''));

      // 1) Choix interactif de la cible
      let target = null;
      if (this.scope === 'element') {
        this.phase = 'pick';
        target = await pickElement(this);
      } else if (this.scope === 'region') {
        this.phase = 'pick';
        target = await pickRegion(this);
      }
      if (s.cleanupBefore) {
        this.phase = 'pick';
        await cleanupElements(this);
      }
      this.phase = 'prepare';
      if (s.startDelay) await sleep(s.startDelay * 1000);
      this.check();
      await waitForDocument();
      this.check();

      // 2) Analyse de la page
      const vp = viewport();
      const fixed = this.scan();
      let el = target && target.el;
      if (el && (el === document.documentElement || el === document.body || el === scrollEl())) {
        this.scope = 'full';
        el = null;
      }
      if (el) this.protect.add(el);

      // 3) Choix de la stratégie
      let container = null;
      let containerOpts = null;
      if (this.scope === 'full' && s.scrollContainer) {
        container = this.findScrollContainer();
        if (container) {
          this.protect.add(container);
          containerOpts = { frame: true, roiContent: null };
        }
      } else if (el) {
        if (isScrollable(el) && el.scrollHeight - el.clientHeight > 16) {
          container = el;
          containerOpts = { frame: false, roiContent: null };
        } else {
          const S = scrollableAncestor(el);
          if (S) {
            const r = el.getBoundingClientRect();
            const b = S.getBoundingClientRect();
            const top = b.top + S.clientTop;
            const fully = r.top >= top - 1 && r.bottom <= top + S.clientHeight + 1;
            if (!fully || r.height > S.clientHeight) {
              container = S;
              this.protect.add(S);
              const cx = r.left - (b.left + S.clientLeft) + S.scrollLeft;
              const cy = r.top - top + S.scrollTop;
              containerOpts = {
                frame: false,
                roiContent: { x: cx, y: cy, w: Math.min(r.width, S.clientWidth), h: r.height },
              };
            }
          }
        }
      }

      const ratioRes = await bg({
        type: 'w2p:begin',
        jobId: this.id,
        dpr: window.devicePixelRatio || 1,
        vw: vp.w,
        vh: vp.h,
      });
      this.ratio = (ratioRes && ratioRes.ratio) || window.devicePixelRatio || 1;

      // Pour un élément choisi, aucun élément fixe ne doit le recouvrir.
      this.hideAllFloating = this.s.floating === 'hide' || this.scope === 'element';
      if (this.scope === 'element') this.hideFixed(fixed);

      let out;
      let mode;
      if (container) {
        mode = containerOpts.frame ? 'container-frame' : 'container';
        out = await this.captureContainer(container, { ...containerOpts, fixed });
      } else {
        const se = scrollEl();
        let roiFn;
        if (this.scope === 'visible') {
          roiFn = () => ({ x: window.scrollX, y: window.scrollY, w: vp.w, h: vp.h });
        } else if (this.scope === 'region') {
          const rr = target.rect;
          roiFn = () => ({ ...rr });
        } else if (el) {
          roiFn = () => {
            const r = el.getBoundingClientRect();
            return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
          };
        } else {
          roiFn = () => ({
            x: 0,
            y: 0,
            w: s.horizontalOverflow ? Math.max(vp.w, se.scrollWidth) : vp.w,
            h: Math.max(vp.h, se.scrollHeight),
          });
        }
        let method = s.captureMethod;
        if (this.scope === 'visible') method = 'direct';
        else if (method === 'auto') {
          const probe = roiFn();
          method = probe.h <= vp.h + 1 && probe.w <= vp.w + 1 ? 'direct' : 'scroll';
        }
        mode = method;
        out = await this.captureDocument(roiFn, method, fixed);
      }

      return {
        output: { width: Math.max(1, Math.round(out.width)), height: Math.max(1, Math.round(out.height)) },
        bg: pageBackground(),
        words: this.words,
        links: this.links,
        headings: this.headings,
        avoid: this.avoid,
        warnings: this.warnings,
        meta: {
          title: (document.title || '').trim(),
          url: location.href,
          lang: document.documentElement.lang || '',
          date: new Date().toISOString(),
          viewport: vp,
          dpr: window.devicePixelRatio || 1,
          scope: this.scope,
          mode,
          timings: Object.fromEntries(Object.entries(this.timings).map(([k, v]) => [k, Math.round(v)])),
        },
      };
    }

    // -------------------------------------------------------------------------
    // Mode vectoriel : préparation de la page avant l'impression Firefox
    // -------------------------------------------------------------------------

    async prepareVector() {
      const s = this.s;
      this.saveState();
      await this.insertCss(CSS_BASE + (s.freezeAnimations ? CSS_FREEZE : ''));
      if (s.cleanupBefore) {
        this.phase = 'pick';
        await cleanupElements(this);
      }
      this.phase = 'prepare';
      if (s.startDelay) await sleep(s.startDelay * 1000);
      await waitForDocument();
      const fixed = this.scan();
      if (s.preloadLazy) await this.preload(this.docScroller(), () => Math.min(s.maxHeight, scrollEl().scrollHeight));
      docScrollTo(0, 0);
      await frames(2);
      let inaccessible = 0;
      if (s.vectorEmulateScreen) inaccessible = this.emulateScreenMedia();
      await frames(1);
      if (s.floating === 'hide') this.hideFixed(fixed);
      else if (s.pageFormat !== 'single') this.absolutizeFixed(fixed);
      await frames(1);
      const vp = viewport();
      const se = scrollEl();
      return {
        width: s.horizontalOverflow ? Math.max(vp.w, se.scrollWidth) : vp.w,
        height: Math.min(s.maxHeight, Math.max(vp.h, se.scrollHeight)),
        vw: vp.w,
        vh: vp.h,
        title: document.title,
        url: location.href,
        inaccessibleSheets: inaccessible,
      };
    }

    emulateScreenMedia() {
      const seen = new Set();
      let inaccessible = 0;
      const setMedia = (list) => {
        const old = list.mediaText;
        const nu = rewriteMediaText(old);
        if (nu !== old) {
          list.mediaText = nu;
          this.restorers.push(() => {
            list.mediaText = old;
          });
        }
      };
      const visitRules = (rules) => {
        for (const rule of rules) {
          if (rule.type === 4 /* MEDIA */) setMedia(rule.media);
          else if (rule.type === 3 /* IMPORT */) {
            if (rule.media && rule.media.mediaText) setMedia(rule.media);
            visitSheet(rule.styleSheet);
            continue;
          } else if (rule.type === 6 /* PAGE */) {
            const size = rule.style.getPropertyValue('size');
            if (size) {
              const prio = rule.style.getPropertyPriority('size');
              rule.style.removeProperty('size');
              this.restorers.push(() => rule.style.setProperty('size', size, prio));
            }
          }
          let sub = null;
          try {
            sub = rule.cssRules;
          } catch (e) {
            sub = null;
          }
          if (sub && sub.length) visitRules(sub);
        }
      };
      const visitSheet = (sheet) => {
        if (!sheet || seen.has(sheet)) return;
        seen.add(sheet);
        const owner = sheet.ownerNode;
        if (owner && owner.nodeType === 1 && owner.hasAttribute('media')) {
          const old = owner.getAttribute('media');
          const nu = rewriteMediaText(old);
          if (nu !== old) {
            owner.setAttribute('media', nu);
            this.restorers.push(() => owner.setAttribute('media', old));
          }
        } else if (!owner && sheet.media && sheet.media.mediaText) {
          setMedia(sheet.media);
        }
        let rules;
        try {
          rules = sheet.cssRules;
        } catch (e) {
          inaccessible++;
          return;
        }
        visitRules(rules);
      };
      const visitRoot = (root) => {
        for (const sh of root.styleSheets || []) visitSheet(sh);
        for (const sh of root.adoptedStyleSheets || []) visitSheet(sh);
      };
      visitRoot(document);
      forEachElementDeep(document, (el) => {
        const sr = el.openOrClosedShadowRoot;
        if (sr) visitRoot(sr);
      });
      return inaccessible;
    }

    // Impression paginée : un élément fixed serait répété sur chaque page.
    absolutizeFixed(list) {
      const props = ['position', 'top', 'left', 'right', 'bottom', 'width', 'height', 'margin', 'box-sizing'];
      for (const el of list) {
        if (!el.isConnected || !el.getClientRects().length || this.isBackdrop(el)) continue;
        const r = el.getBoundingClientRect();
        const st = el.style;
        const saved = props.map((p) => [p, st.getPropertyValue(p), st.getPropertyPriority(p)]);
        this.restorers.push(() => {
          for (const [p, v, prio] of saved) {
            if (v) st.setProperty(p, v, prio);
            else st.removeProperty(p);
          }
        });
        const set = (p, v) => st.setProperty(p, v, 'important');
        set('position', 'absolute');
        set('box-sizing', 'border-box');
        set('margin', '0');
        set('right', 'auto');
        set('bottom', 'auto');
        set('width', `${r.width}px`);
        set('height', `${r.height}px`);
        set('top', `${r.top + window.scrollY}px`);
        set('left', `${r.left + window.scrollX}px`);
        const b = el.getBoundingClientRect();
        const dx = r.left - b.left;
        const dy = r.top - b.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          set('top', `${r.top + window.scrollY + dy}px`);
          set('left', `${r.left + window.scrollX + dx}px`);
        }
      }
    }
  }

  function skipSubtree(walker) {
    let n = walker.nextSibling();
    if (n) return n;
    while (walker.parentNode()) {
      n = walker.nextSibling();
      if (n) return n;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Interface dans la page : sélection d'élément, de zone, nettoyage
  // ---------------------------------------------------------------------------

  const UI_FONT = 'font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;';

  function createOverlay() {
    const old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();
    const host = document.createElement('div');
    host.id = OVERLAY_ID;
    host.style.cssText =
      'all: initial; position: fixed; inset: 0; z-index: 2147483647; contain: strict; pointer-events: none;';
    const root = host.attachShadow({ mode: 'closed' });
    (document.documentElement || document.body).appendChild(host);
    const make = (tag, css, parent = root) => {
      const el = document.createElement(tag);
      el.style.cssText = css;
      parent.appendChild(el);
      return el;
    };
    return { host, root, make };
  }

  function toolbar(ui, text, buttons) {
    const bar = ui.make(
      'div',
      'position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; ' +
        'align-items: center; gap: 10px; padding: 8px 10px 8px 14px; border-radius: 12px; ' +
        'background: rgba(22, 24, 29, 0.92); color: #f4f5f7; box-shadow: 0 8px 30px rgba(0,0,0,.35); ' +
        // La barre laisse passer la souris : on peut choisir l'élément situé dessous.
        'pointer-events: none; max-width: calc(100vw - 32px); ' +
        UI_FONT,
    );
    const label = ui.make('span', 'white-space: normal;', bar);
    label.textContent = text;
    const btns = {};
    for (const [key, txt, primary] of buttons) {
      const b = ui.make(
        'button',
        'all: unset; cursor: pointer; pointer-events: auto; padding: 5px 10px; border-radius: 8px; white-space: nowrap; ' +
          (primary ? 'background: #4c6fff; color: #fff;' : 'background: rgba(255,255,255,.12); color: #f4f5f7;') +
          UI_FONT,
        bar,
      );
      b.textContent = txt;
      btns[key] = b;
    }
    return { bar, label, btns };
  }

  // Bloque les clics de la page pendant la sélection, sauf sur notre barre d'outils.
  function guardEvents(ui, handlers) {
    const block = (e) => {
      if (e.composedPath().includes(ui.host)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (handlers[e.type]) handlers[e.type](e);
    };
    const types = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu'];
    for (const t of types) window.addEventListener(t, block, true);
    const move = (e) => handlers.mousemove && handlers.mousemove(e);
    const key = (e) => {
      if (handlers.keydown && handlers.keydown(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const scroll = () => handlers.scroll && handlers.scroll();
    window.addEventListener('mousemove', move, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scroll, true);
    return () => {
      for (const t of types) window.removeEventListener(t, block, true);
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scroll, true);
      ui.host.remove();
    };
  }

  function describe(el) {
    let s = el.localName;
    if (el.id) s += `#${el.id}`;
    else if (el.classList && el.classList.length) s += `.${[...el.classList].slice(0, 2).join('.')}`;
    const r = el.getBoundingClientRect();
    return `${s}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
  }

  function pickElement(job) {
    return new Promise((resolve, reject) => {
      const ui = createOverlay();
      const box = ui.make(
        'div',
        'position: fixed; border: 2px solid #4c6fff; background: rgba(76,111,255,.14); ' +
          'border-radius: 3px; pointer-events: none; display: none; box-sizing: border-box;',
      );
      const tag = ui.make(
        'div',
        'position: fixed; padding: 3px 7px; border-radius: 6px; background: #4c6fff; color: #fff; ' +
          'pointer-events: none; display: none; white-space: nowrap; ' +
          UI_FONT,
      );
      const tb = toolbar(ui, 'Cliquez sur l’élément à convertir  ·  ↑ parent  ↓ enfant  ·  Entrée valider  ·  Échap annuler', [
        ['ok', 'Valider', true],
        ['cancel', 'Annuler', false],
      ]);
      let cur = null;
      const chain = [];
      const draw = () => {
        if (!cur || !cur.isConnected) {
          box.style.display = tag.style.display = 'none';
          return;
        }
        const r = cur.getBoundingClientRect();
        Object.assign(box.style, {
          display: 'block',
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
        tag.textContent = describe(cur);
        tag.style.display = 'block';
        tag.style.left = `${Math.max(4, r.left)}px`;
        tag.style.top = `${r.top > 30 ? r.top - 26 : Math.min(window.innerHeight - 26, r.bottom + 4)}px`;
      };
      const finish = (el) => {
        cleanup();
        if (el) resolve({ el });
        else {
          job.cancelled = true;
          reject(new CancelledError());
        }
      };
      const cleanup = guardEvents(ui, {
        mousemove: (e) => {
          const el = deepElementFromPoint(e.clientX, e.clientY);
          if (el && el !== ui.host && el !== cur) {
            cur = el;
            chain.length = 0;
            draw();
          }
        },
        click: () => cur && finish(cur),
        scroll: draw,
        keydown: (e) => {
          if (e.key === 'Escape') finish(null);
          else if (e.key === 'Enter') cur && finish(cur);
          else if (e.key === 'ArrowUp' && cur) {
            const p = composedParent(cur);
            if (p && p !== document.documentElement) {
              chain.push(cur);
              cur = p;
              draw();
            }
          } else if (e.key === 'ArrowDown' && chain.length) {
            cur = chain.pop();
            draw();
          } else return false;
          return true;
        },
      });
      tb.btns.ok.addEventListener('click', () => cur && finish(cur));
      tb.btns.cancel.addEventListener('click', () => finish(null));
    });
  }

  function pickRegion(job) {
    return new Promise((resolve, reject) => {
      const ui = createOverlay();
      // Surface de tracé sous la barre d'outils : elle seule reçoit la souris.
      const surface = ui.make('div', 'position: fixed; inset: 0; cursor: crosshair; pointer-events: auto;');
      const dim = ui.make('div', 'position: fixed; inset: 0; background: rgba(10,12,20,.35); pointer-events: none;');
      const sel = ui.make(
        'div',
        'position: fixed; border: 2px solid #4c6fff; background: rgba(76,111,255,.10); ' +
          'box-shadow: 0 0 0 100000px rgba(10,12,20,.35); pointer-events: none; display: none; box-sizing: border-box;',
      );
      const size = ui.make(
        'div',
        'position: fixed; padding: 3px 7px; border-radius: 6px; background: #4c6fff; color: #fff; ' +
          'pointer-events: none; display: none; white-space: nowrap; ' +
          UI_FONT,
      );
      const tb = toolbar(ui, 'Tracez la zone à convertir (la molette fait défiler)  ·  Échap annuler', [
        ['cancel', 'Annuler', false],
      ]);
      let start = null;
      let last = null;
      let auto = 0;
      const rect = () => {
        const x = last.x + window.scrollX;
        const y = last.y + window.scrollY;
        return { x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) };
      };
      const draw = () => {
        if (!start) return;
        const r = rect();
        dim.style.display = 'none';
        Object.assign(sel.style, {
          display: 'block',
          left: `${r.x - window.scrollX}px`,
          top: `${r.y - window.scrollY}px`,
          width: `${r.w}px`,
          height: `${r.h}px`,
        });
        size.style.display = 'block';
        size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
        size.style.left = `${Math.max(4, r.x - window.scrollX)}px`;
        size.style.top = `${Math.max(4, r.y - window.scrollY - 26)}px`;
      };
      const onMove = (e) => {
        if (!start) return;
        last = { x: e.clientX, y: e.clientY };
        draw();
      };
      const onUp = (e) => {
        if (!start) return;
        last = { x: e.clientX, y: e.clientY };
        const r = rect();
        start = null;
        clearInterval(auto);
        if (r.w >= 8 && r.h >= 8) finish(r);
        else {
          sel.style.display = size.style.display = 'none';
          dim.style.display = 'block';
        }
      };
      const cleanup = guardEvents(ui, {
        scroll: draw,
        keydown: (e) => {
          if (e.key !== 'Escape') return false;
          finish(null);
          return true;
        },
      });
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      const finish = (r) => {
        clearInterval(auto);
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        cleanup();
        if (r) resolve({ rect: r });
        else {
          job.cancelled = true;
          reject(new CancelledError());
        }
      };
      surface.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        start = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
        last = { x: e.clientX, y: e.clientY };
        draw();
        // Défilement automatique près des bords pendant le tracé.
        clearInterval(auto);
        auto = setInterval(() => {
          if (!start || !last) return;
          const h = window.innerHeight;
          const dy = last.y < 40 ? -24 : last.y > h - 40 ? 24 : 0;
          if (dy) {
            window.scrollBy({ top: dy, behavior: 'instant' });
            draw();
          }
        }, 30);
      });
      tb.btns.cancel.addEventListener('click', () => finish(null));
    });
  }

  // Retrait d'éléments gênants (bannières, pubs, chat…) avant la capture.
  function cleanupElements(job) {
    return new Promise((resolve, reject) => {
      const ui = createOverlay();
      const box = ui.make(
        'div',
        'position: fixed; border: 2px solid #ef4444; background: rgba(239,68,68,.16); ' +
          'border-radius: 3px; pointer-events: none; display: none; box-sizing: border-box;',
      );
      const tb = toolbar(ui, 'Cliquez sur les éléments à retirer  ·  Ctrl+Z rétablir  ·  Entrée capturer  ·  Échap annuler', [
        ['undo', 'Rétablir', false],
        ['ok', 'Capturer', true],
        ['cancel', 'Annuler', false],
      ]);
      const removed = [];
      let cur = null;
      const draw = () => {
        if (!cur || !cur.isConnected || !cur.getClientRects().length) {
          box.style.display = 'none';
          return;
        }
        const r = cur.getBoundingClientRect();
        Object.assign(box.style, {
          display: 'block',
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
      };
      const update = () => {
        tb.label.textContent = removed.length
          ? `${removed.length} élément(s) retiré(s)  ·  Ctrl+Z rétablir  ·  Entrée capturer  ·  Échap annuler`
          : 'Cliquez sur les éléments à retirer  ·  Ctrl+Z rétablir  ·  Entrée capturer  ·  Échap annuler';
      };
      const undo = () => {
        const el = removed.pop();
        if (el) job.unmark(el, ATTR.removed);
        update();
      };
      const finish = (ok) => {
        cleanup();
        if (ok) resolve();
        else {
          job.cancelled = true;
          reject(new CancelledError());
        }
      };
      const cleanup = guardEvents(ui, {
        mousemove: (e) => {
          const el = deepElementFromPoint(e.clientX, e.clientY);
          if (el && el !== ui.host && el !== cur) {
            cur = el;
            draw();
          }
        },
        click: () => {
          if (!cur || cur === document.documentElement || cur === document.body) return;
          if (job.mark(cur, ATTR.removed)) removed.push(cur);
          cur = null;
          draw();
          update();
        },
        scroll: draw,
        keydown: (e) => {
          if (e.key === 'Escape') finish(false);
          else if (e.key === 'Enter') finish(true);
          else if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) undo();
          else if (e.key === 'Backspace') undo();
          else return false;
          return true;
        },
      });
      tb.btns.undo.addEventListener('click', undo);
      tb.btns.ok.addEventListener('click', () => finish(true));
      tb.btns.cancel.addEventListener('click', () => finish(false));
    });
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async function runCapture(msg) {
    if (current) return { ok: false, error: 'Une capture est déjà en cours dans cet onglet.' };
    const job = (current = new Job(msg.jobId, msg.settings, msg.scope));
    const onKey = (e) => {
      if (e.key === 'Escape' && job.phase !== 'pick') job.cancelled = true;
    };
    window.addEventListener('keydown', onKey, true);
    try {
      const manifest = await job.run();
      return { ok: true, manifest };
    } catch (e) {
      if (e && e.cancelled) return { ok: false, cancelled: true };
      console.error('[Web2PDF Exact]', e);
      return { ok: false, error: (e && e.message) || String(e) };
    } finally {
      window.removeEventListener('keydown', onKey, true);
      try {
        await job.restore();
      } catch (e) {
        console.error('[Web2PDF Exact] restauration', e);
      }
      current = null;
    }
  }

  async function prepareVector(msg) {
    if (current) return { ok: false, error: 'Une capture est déjà en cours dans cet onglet.' };
    const job = (current = new Job(msg.jobId, msg.settings, 'full'));
    try {
      const info = await job.prepareVector();
      return { ok: true, info };
    } catch (e) {
      try {
        await job.restore();
      } catch (e2) {
        /* ignoré */
      }
      current = null;
      if (e && e.cancelled) return { ok: false, cancelled: true };
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  async function restoreVector(msg) {
    if (current && current.id === msg.jobId) {
      try {
        await current.restore();
      } finally {
        current = null;
      }
    }
    return { ok: true };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return undefined;
    switch (msg.type) {
      case 'w2p:ping':
        return Promise.resolve({ ok: true });
      case 'w2p:run':
        return runCapture(msg);
      case 'w2p:cancel':
        if (current && (!msg.jobId || current.id === msg.jobId)) current.cancelled = true;
        return Promise.resolve({ ok: true });
      case 'w2p:vector-prepare':
        return prepareVector(msg);
      case 'w2p:vector-restore':
        return restoreVector(msg);
      default:
        return undefined;
    }
  });
})();
