'use strict';
// Assemblage du PDF à partir des captures (tranches PNG) et du relevé de l'agent :
// pages, tuiles d'image, calque de texte invisible, liens, signets, en-têtes.
var W2P = globalThis.W2P || (globalThis.W2P = {});

(() => {
  const { PdfWriter, num, hexUtf16, textString, asciiString, pdfDate, deflate, encoder, writeTextLayerFont } =
    W2P.pdf;

  const MAX_TILE_PX = 16e6;

  // Quelques images décodées gardées en mémoire (les tranches sont lues dans l'ordre).
  class BitmapCache {
    constructor(images, size = 6) {
      this.images = images;
      this.size = size;
      this.map = new Map();
    }
    async get(id) {
      let bmp = this.map.get(id);
      if (bmp) {
        this.map.delete(id);
        this.map.set(id, bmp);
        return bmp;
      }
      bmp = await createImageBitmap(this.images[id].blob);
      this.map.set(id, bmp);
      while (this.map.size > this.size) {
        const [key, old] = this.map.entries().next().value;
        old.close();
        this.map.delete(key);
      }
      return bmp;
    }
    clear() {
      for (const bmp of this.map.values()) bmp.close();
      this.map.clear();
    }
  }

  // Dessine la portion de sortie [px0, py0, pw, ph] (pixels) à partir des placements.
  async function renderTile(job, cache, tile, ratio, bg) {
    const { canvas, ctx } = W2P.image.makeCanvas(tile.pw, tile.ph);
    ctx.fillStyle = `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`;
    ctx.fillRect(0, 0, tile.pw, tile.ph);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (const p of job.placements) {
      const dx0 = Math.round(p.dest.x * ratio);
      const dy0 = Math.round(p.dest.y * ratio);
      const dx1 = Math.round((p.dest.x + p.src.w) * ratio);
      const dy1 = Math.round((p.dest.y + p.src.h) * ratio);
      const ix0 = Math.max(dx0, tile.px0);
      const iy0 = Math.max(dy0, tile.py0);
      const ix1 = Math.min(dx1, tile.px0 + tile.pw);
      const iy1 = Math.min(dy1, tile.py0 + tile.ph);
      if (ix1 <= ix0 || iy1 <= iy0) continue;
      const im = job.images[p.imgId];
      const sx = im.pw / im.rect.width;
      const sy = im.ph / im.rect.height;
      const fx = (dx1 - dx0) / p.src.w;
      const fy = (dy1 - dy0) / p.src.h;
      const bmp = await cache.get(p.imgId);
      ctx.drawImage(
        bmp,
        (p.src.x + (ix0 - dx0) / fx) * sx,
        (p.src.y + (iy0 - dy0) / fy) * sy,
        ((ix1 - ix0) / fx) * sx,
        ((iy1 - iy0) / fy) * sy,
        ix0 - tile.px0,
        iy0 - tile.py0,
        ix1 - ix0,
        iy1 - iy0,
      );
    }
    return { canvas, ctx };
  }

  // Tuiles d'une page (une seule en général ; plusieurs pour une très longue page).
  // Chaque tuile déborde d'un pixel sur la suivante pour éviter les liserés entre images.
  function pageTiles(pg, W, ratio) {
    const pw = Math.max(1, Math.round(W * ratio));
    const py0 = Math.round(pg.y0 * ratio);
    const py1 = Math.max(py0 + 1, Math.round(pg.y1 * ratio));
    const maxH = Math.max(64, Math.floor(Math.min(8192, MAX_TILE_PX / pw)));
    const tiles = [];
    for (let y = py0; y < py1; y += maxH) {
      const h = Math.min(maxH, py1 - y);
      const overlap = y + h < py1 ? 1 : 0;
      tiles.push({ px0: 0, py0: y, pw, ph: h + overlap });
    }
    return tiles;
  }

  const luminance = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

  function fit(ctx, text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
      else hi = mid - 1;
    }
    return lo ? `${text.slice(0, lo)}…` : '';
  }

  // Bandeau d'en-tête ou de pied de page rendu en image (toutes écritures supportées).
  async function headerBand(wPt, hPt, left, right, color) {
    const S = 4;
    const cw = Math.max(1, Math.ceil(wPt * S));
    const ch = Math.max(1, Math.ceil(hPt * S));
    const { canvas: c, ctx } = W2P.image.makeCanvas(cw, ch);
    ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = luminance(color) < 0.5 ? '#c9ccd3' : '#5b6170';
    ctx.font = `${7.5 * S}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = 'middle';
    const gap = 12 * S;
    const r = fit(ctx, right, cw * 0.45);
    const rw = ctx.measureText(r).width;
    const l = fit(ctx, left, cw - rw - gap);
    ctx.textAlign = 'left';
    ctx.fillText(l, 0, ch / 2);
    ctx.textAlign = 'right';
    ctx.fillText(r, cw, ch / 2);
    const data = await W2P.image.losslessStream(c, ctx);
    return {
      filter: 'FlateDecode',
      parms: `/DecodeParms<</Predictor 15/Colors 3/BitsPerComponent 8/Columns ${cw}>>`,
      data,
      w: cw,
      h: ch,
    };
  }

  function imageDict(enc) {
    return (
      `/Type/XObject/Subtype/Image/Width ${enc.w}/Height ${enc.h}` +
      `/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/${enc.filter}${enc.parms}`
    );
  }

  function writeOutline(w, items) {
    if (!items.length) return null;
    const rootId = w.alloc();
    const nodes = items.map((h) => ({ ...h, id: w.alloc(), children: [] }));
    const top = [];
    const stack = [];
    for (const n of nodes) {
      while (stack.length && stack[stack.length - 1].level >= n.level) stack.pop();
      if (stack.length) stack[stack.length - 1].children.push(n);
      else top.push(n);
      stack.push(n);
    }
    const count = (n) => n.children.reduce((acc, c) => acc + 1 + count(c), 0);
    const writeList = (list, parentId) => {
      list.forEach((n, i) => {
        let d = `<</Title ${textString(n.text)}/Parent ${parentId} 0 R`;
        if (i > 0) d += `/Prev ${list[i - 1].id} 0 R`;
        if (i < list.length - 1) d += `/Next ${list[i + 1].id} 0 R`;
        if (n.children.length) {
          d += `/First ${n.children[0].id} 0 R/Last ${n.children[n.children.length - 1].id} 0 R/Count ${count(n)}`;
        }
        d += `/Dest[${n.dest}]>>`;
        w.object(n.id, d);
        writeList(n.children, n.id);
      });
    };
    writeList(top, rootId);
    const total = top.reduce((acc, n) => acc + 1 + count(n), 0);
    w.object(rootId, `<</Type/Outlines/First ${top[0].id} 0 R/Last ${top[top.length - 1].id} 0 R/Count ${total}>>`);
    return rootId;
  }

  // Construit le PDF. onProgress(fait, total).
  async function buildPdf(job, man, onProgress) {
    const s = job.settings;
    const ratio = job.ratio;
    const W = man.output.width;
    const H = man.output.height;
    const bg = man.bg || [255, 255, 255];
    const marginColor = s.marginColor === 'page' ? bg : [255, 255, 255];
    const avoid = s.smartBreaks ? man.avoid : [];
    const plan = W2P.layout.planPages(man.output, s, avoid, (man.meta.viewport || {}).h || 800);
    const k = plan.k;
    const pages = plan.pages;

    const w = new PdfWriter();
    const catalogId = w.alloc();
    const pagesId = w.alloc();
    const infoId = w.alloc();
    const pageIds = pages.map(() => w.alloc());
    const fontId = s.textLayer && man.words.length ? await writeTextLayerFont(w) : null;

    const pageIndexOf = (y) => {
      for (let i = 0; i < pages.length; i++) if (y < pages[i].y1) return i;
      return pages.length - 1;
    };
    const destFor = (x, y) => {
      const i = pageIndexOf(Math.max(0, y));
      const pg = pages[i];
      const top = pg.pageH - pg.top - (Math.max(pg.y0, y) - pg.y0) * k;
      return `${pageIds[i]} 0 R/XYZ ${num(Math.max(0, pg.x + x * k))} ${num(Math.min(pg.pageH, top))} null`;
    };

    // Répartition du texte et des liens par page.
    const wordsByPage = pages.map(() => []);
    if (fontId) {
      for (const wd of man.words) {
        const cy = wd[1] + wd[3] / 2;
        const cx = wd[0] + wd[2] / 2;
        if (cy < 0 || cy >= H || cx < 0 || cx > W) continue;
        wordsByPage[pageIndexOf(cy)].push(wd);
      }
    }

    // En-tête : titre et adresse ; pied : date et numéro de page.
    let headerImg = null;
    const { mT, mR, mB, mL } = plan.margins;
    const hfDate = new Date(man.meta.date || Date.now());
    if (s.headerFooter) {
      const bandH = Math.min(mT, 10) || 10;
      const enc = await headerBand(pages[0].pageW - mL - mR, bandH, man.meta.title || '', man.meta.url || '', marginColor);
      headerImg = { id: w.alloc(), enc, h: bandH };
      w.stream(headerImg.id, imageDict(enc), enc.data);
    }

    const cache = new BitmapCache(job.images);
    const totalTiles = pages.reduce((n, pg) => n + pageTiles(pg, W, ratio).length, 0);
    let doneTiles = 0;

    try {
      for (let i = 0; i < pages.length; i++) {
        if (job.cancelled) throw Object.assign(new Error('Capture annulée'), { cancelled: true });
        const pg = pages[i];
        const ops = [];
        const xobjects = [];
        ops.push(`${marginColor.map((c) => num(c / 255)).join(' ')} rg 0 0 ${num(pg.pageW)} ${num(pg.pageH)} re f`);

        for (const tile of pageTiles(pg, W, ratio)) {
          const { canvas, ctx } = await renderTile(job, cache, tile, ratio, bg);
          const enc = await W2P.image.encodeCanvas(canvas, ctx, s);
          const imgId = w.alloc();
          w.stream(imgId, imageDict(enc), enc.data);
          const name = `/Im${xobjects.length}`;
          xobjects.push(`${name} ${imgId} 0 R`);
          const wPt = W * k;
          const hPt = (tile.ph / ratio) * k;
          const topPt = pg.top + (tile.py0 / ratio - pg.y0) * k;
          ops.push(`q ${num(wPt)} 0 0 ${num(hPt)} ${num(pg.x)} ${num(pg.pageH - topPt - hPt)} cm ${name} Do Q`);
          doneTiles++;
          if (onProgress) onProgress(doneTiles, totalTiles);
        }

        if (headerImg) {
          const hfW = pg.pageW - mL - mR;
          const yHeader = pg.pageH - (mT + headerImg.h) / 2;
          ops.push(`q ${num(hfW)} 0 0 ${num(headerImg.h)} ${num(mL)} ${num(yHeader)} cm /Hd Do Q`);
          xobjects.push(`/Hd ${headerImg.id} 0 R`);
          const left = hfDate.toLocaleString(W2P.i18n.lang(), { dateStyle: 'short', timeStyle: 'short' });
          const enc = await headerBand(hfW, headerImg.h, left, `${i + 1} / ${pages.length}`, marginColor);
          const footId = w.alloc();
          w.stream(footId, imageDict(enc), enc.data);
          xobjects.push(`/Ft ${footId} 0 R`);
          const yFooter = (mB - headerImg.h) / 2;
          ops.push(`q ${num(hfW)} 0 0 ${num(headerImg.h)} ${num(mL)} ${num(yFooter)} cm /Ft Do Q`);
        }

        // Calque de texte invisible (mode de rendu 3) : sélection, copie et recherche.
        // Comme dans les PDF d'OCR, l'espace qui suit un mot s'étire jusqu'au mot suivant
        // de la même ligne : les lecteurs n'ajoutent pas d'espace en double à la copie.
        const words = wordsByPage[i];
        if (words.length) {
          const parts = ['BT 3 Tr /F1 1 Tf'];
          for (let j = 0; j < words.length; j++) {
            const [x, y, ww, wh, text, space] = words[j];
            if (!text || ww <= 0 || wh <= 0) continue;
            let str = text;
            let runW = ww;
            const next = words[j + 1];
            if (next) {
              // Espace si le DOM en contient une, ou si l'écart vaut au moins une espace
              // (cas d'un mot en fin de lien suivi d'un autre nœud de texte).
              const gap = next[0] - (x + ww);
              const sameLine = Math.abs(next[1] - y) < wh * 0.5 && Math.abs(next[3] - wh) < wh * 0.35;
              if (sameLine && gap > -1 && gap < wh * 2 && (space || gap > wh * 0.12)) {
                str = `${text} `;
                runW = Math.max(ww, next[0] - x);
              }
            }
            const a = (runW * k) / (str.length * 0.5);
            const fs = wh * k;
            const px = pg.x + x * k;
            const py = pg.pageH - pg.top - (y + wh - pg.y0) * k;
            parts.push(`${num(a)} 0 0 ${num(fs)} ${num(px)} ${num(py)} Tm <${hexUtf16(str)}>Tj`);
          }
          parts.push('ET');
          ops.push(parts.join('\n'));
        }

        const contentId = w.alloc();
        w.stream(contentId, '/Filter/FlateDecode', await deflate(encoder.encode(ops.join('\n'))));

        // Liens cliquables (externes et ancres internes).
        const annots = [];
        if (s.links) {
          for (const l of man.links) {
            const y0 = Math.max(l.y, pg.y0);
            const y1 = Math.min(l.y + l.h, pg.y1);
            if (y1 - y0 < 1) continue;
            const x0 = Math.max(0, l.x);
            const x1 = Math.min(W, l.x + l.w);
            if (x1 - x0 < 1) continue;
            const rect = [
              pg.x + x0 * k,
              pg.pageH - pg.top - (y1 - pg.y0) * k,
              pg.x + x1 * k,
              pg.pageH - pg.top - (y0 - pg.y0) * k,
            ];
            let action;
            if (l.target) action = `/Dest[${destFor(l.target.x, l.target.y)}]`;
            else if (l.url) action = `/A<</S/URI/URI${asciiString(l.url)}>>`;
            else continue;
            const id = w.alloc();
            w.object(id, `<</Type/Annot/Subtype/Link/Rect[${rect.map(num).join(' ')}]/Border[0 0 0]${action}>>`);
            annots.push(`${id} 0 R`);
          }
        }

        const resources =
          `<</XObject<<${xobjects.join('')}>>` + (fontId && words.length ? `/Font<</F1 ${fontId} 0 R>>` : '') + '>>';
        w.object(
          pageIds[i],
          `<</Type/Page/Parent ${pagesId} 0 R/MediaBox[0 0 ${num(pg.pageW)} ${num(pg.pageH)}]` +
            `/Resources${resources}/Contents ${contentId} 0 R` +
            (annots.length ? `/Annots[${annots.join(' ')}]` : '') +
            '>>',
        );
      }
    } finally {
      cache.clear();
    }

    // Signets à partir des titres de la page.
    let outlineId = null;
    if (s.bookmarks && man.headings.length) {
      const seen = new Set();
      const items = [];
      for (const h of [...man.headings].sort((a, b) => a.y - b.y)) {
        if (h.y < 0 || h.y >= H) continue;
        const key = `${h.text}|${Math.round(h.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ level: h.level, text: h.text, dest: destFor(Math.max(0, h.x || 0), h.y) });
      }
      outlineId = writeOutline(w, items);
    }

    w.object(pagesId, `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pageIds.length}>>`);
    const now = new Date(man.meta.date || Date.now());
    w.object(
      infoId,
      `<</Title ${textString(man.meta.title || man.meta.url || W2P.t('pdfUntitled'))}` +
        `/Subject ${textString(man.meta.url || '')}` +
        `/Creator ${textString(`Web2PDF Exact ${browser.runtime.getManifest().version}`)}` +
        `/Producer ${textString(W2P.t('pdfProducer'))}` +
        `/CreationDate (${pdfDate(now)})/ModDate (${pdfDate(now)})>>`,
    );
    w.object(
      catalogId,
      `<</Type/Catalog/Pages ${pagesId} 0 R` +
        (outlineId ? `/Outlines ${outlineId} 0 R` : '') +
        '/ViewerPreferences<</DisplayDocTitle true>>' +
        (man.meta.lang ? `/Lang ${textString(man.meta.lang)}` : '') +
        '>>',
    );
    return { blob: w.finish(catalogId, infoId), pages: pages.length };
  }

  W2P.buildPdf = buildPdf;
})();
