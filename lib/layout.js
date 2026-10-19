'use strict';
// Mise en page : formats, marges, échelle et découpage en pages avec coupures
// « intelligentes » qui évitent de trancher une ligne de texte ou une image.
var W2P = globalThis.W2P || (globalThis.W2P = {});

(() => {
  const PT_PER_MM = 72 / 25.4;
  const PT_PER_PX = 0.75; // 96 px CSS = 72 pt
  const MAX_PAGE_PT = 14400; // 200 pouces : limite historique d'Acrobat

  // Coupures de page. avoid : [[haut, bas, poids], …] en px de sortie.
  function computeBreaks(total, pageH, avoid, smart) {
    const bands = [];
    if (pageH <= 0 || total <= 0) return [[0, Math.max(1, total)]];
    if (!smart || !avoid.length) {
      for (let y = 0; y < total; y += pageH) bands.push([y, Math.min(total, y + pageH)]);
      return bands;
    }
    const H = Math.ceil(total);
    // Tableau de différences : cov[y] = gêne d'une coupe entre les rangées y-1 et y.
    const cov = new Float64Array(H + 2);
    for (const [top, bottom, weight] of avoid) {
      if (!(bottom > top) || bottom - top > pageH * 0.85) continue;
      const s = Math.max(1, Math.floor(top) + 1);
      const e = Math.min(H, Math.ceil(bottom) - 1);
      if (e < s) continue;
      cov[s] += weight;
      cov[e + 1] -= weight;
    }
    for (let y = 1; y <= H + 1; y++) cov[y] += cov[y - 1];
    const back = Math.floor(pageH * 0.22);
    let y = 0;
    while (total - y > pageH + 0.5) {
      const ideal = Math.floor(y + pageH);
      let best = ideal;
      let cost = cov[ideal];
      if (cost > 1e-9) {
        const stop = Math.max(Math.ceil(y + pageH * 0.5), ideal - back);
        for (let c = ideal - 1; c >= stop; c--) {
          if (cov[c] < cost - 1e-9) {
            best = c;
            cost = cov[c];
            if (cost <= 1e-9) break;
          }
        }
      }
      bands.push([y, best]);
      y = best;
    }
    bands.push([y, total]);
    return bands;
  }

  // Calcule toutes les pages : taille en points, échelle et bande de sortie.
  // out : { width, height } en px CSS ; viewportH : hauteur d'écran de la capture.
  function planPages(out, settings, avoid, viewportH) {
    const s = settings;
    const W = Math.max(1, out.width);
    const H = Math.max(1, out.height);
    let mT = s.marginTop * PT_PER_MM;
    let mR = s.marginRight * PT_PER_MM;
    let mB = s.marginBottom * PT_PER_MM;
    let mL = s.marginLeft * PT_PER_MM;
    if (s.headerFooter) {
      mT = Math.max(mT, 12 * PT_PER_MM);
      mB = Math.max(mB, 12 * PT_PER_MM);
    }

    if (s.pageFormat === 'single') {
      let k = PT_PER_PX;
      if (s.limitPageSize) k = Math.min(k, (MAX_PAGE_PT - mT - mB) / H, (MAX_PAGE_PT - mL - mR) / W);
      k = Math.max(k, 0.01);
      return {
        k,
        pages: [{ y0: 0, y1: H, pageW: W * k + mL + mR, pageH: H * k + mT + mB, x: mL, top: mT }],
        margins: { mT, mR, mB, mL },
      };
    }

    let pageW;
    let pageH;
    let k;
    if (s.pageFormat === 'screen') {
      k = PT_PER_PX;
      pageW = W * k + mL + mR;
      pageH = Math.max(50, viewportH) * k + mT + mB;
    } else {
      let [pw, ph] =
        s.pageFormat === 'custom' ? [s.customWidthMm, s.customHeightMm] : W2P.PAPER_SIZES[s.pageFormat];
      if (s.orientation === 'landscape') [pw, ph] = [Math.max(pw, ph), Math.min(pw, ph)];
      else if (s.pageFormat !== 'custom') [pw, ph] = [Math.min(pw, ph), Math.max(pw, ph)];
      pageW = pw * PT_PER_MM;
      pageH = ph * PT_PER_MM;
      const cw = Math.max(10, pageW - mL - mR);
      k = s.fit === 'width' ? cw / W : Math.min(PT_PER_PX, cw / W);
    }
    const contentH = Math.max(10, pageH - mT - mB);
    const bandH = contentH / k;
    const x = mL + Math.max(0, (pageW - mL - mR - W * k) / 2);
    const bands = computeBreaks(H, bandH, avoid, s.smartBreaks);
    return {
      k,
      pages: bands.map(([y0, y1]) => ({ y0, y1, pageW, pageH, x, top: mT })),
      margins: { mT, mR, mB, mL },
    };
  }

  W2P.layout = { computeBreaks, planPages, PT_PER_MM, PT_PER_PX };
})();
