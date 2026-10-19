'use strict';
// Encodage des tuiles d'image pour le PDF : JPEG (DCTDecode) ou sans perte
// (FlateDecode avec prédicteurs PNG), et choix automatique selon le contenu.
var W2P = globalThis.W2P || (globalThis.W2P = {});

(() => {
  // Toile de dessin : <canvas> quand un document est disponible (page de fond),
  // sinon OffscreenCanvas. Le <canvas> donne accès à l'encodeur PNG natif en RVB.
  function makeCanvas(w, h) {
    let canvas;
    if (typeof document !== 'undefined' && document.createElement) {
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
    } else {
      canvas = new OffscreenCanvas(w, h);
    }
    return { canvas, ctx: canvas.getContext('2d', { alpha: false }) };
  }

  function toBlob(canvas, type, quality) {
    if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encodage impossible'))), type, quality),
    );
  }

  // PNG natif de Gecko sans canal alpha : son flux IDAT (zlib + filtres PNG par ligne)
  // est exactement ce qu'attend un PDF en FlateDecode avec /Predictor 15.
  async function nativePngStream(canvas) {
    if (typeof canvas.toBlob !== 'function') return null;
    const blob = await toBlob(canvas, 'image/png', '-moz-parse-options:transparency=none');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // IHDR : profondeur 8 bits, type de couleur 2 (RVB), pas d'entrelacement.
    if (bytes.length < 33 || bytes[24] !== 8 || bytes[25] !== 2 || bytes[28] !== 0) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parts = [];
    let total = 0;
    let pos = 8;
    while (pos + 8 <= bytes.length) {
      const len = view.getUint32(pos);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      if (type === 'IDAT') {
        parts.push(bytes.subarray(pos + 8, pos + 8 + len));
        total += len;
      } else if (type === 'IEND') break;
      pos += 12 + len;
    }
    if (!total) return null;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  // Repli en JavaScript : filtre PNG adaptatif (Sub / Up / Paeth, heuristique de la
  // somme minimale) appliqué à `rows` lignes RGBA. `prev` est la ligne RGB brute
  // précédente (zéros pour la première) ; la fonction renvoie la dernière ligne brute.
  function filterRows(rgba, w, rows, prev, out) {
    const stride = w * 3;
    let cur = new Uint8Array(stride);
    const sub = new Uint8Array(stride);
    const up = new Uint8Array(stride);
    const paeth = new Uint8Array(stride);
    let o = 0;
    for (let y = 0; y < rows; y++) {
      let si = y * w * 4;
      for (let di = 0; di < stride; di += 3, si += 4) {
        cur[di] = rgba[si];
        cur[di + 1] = rgba[si + 1];
        cur[di + 2] = rgba[si + 2];
      }
      let sSub = 0;
      let sUp = 0;
      let sPaeth = 0;
      for (let i = 0; i < stride; i++) {
        const x = cur[i];
        const a = i >= 3 ? cur[i - 3] : 0;
        const b = prev[i];
        const c = i >= 3 ? prev[i - 3] : 0;
        let d = (x - a) & 255;
        sub[i] = d;
        sSub += d < 128 ? d : 256 - d;
        d = (x - b) & 255;
        up[i] = d;
        sUp += d < 128 ? d : 256 - d;
        const p = a + b - c;
        const pa = p > a ? p - a : a - p;
        const pb = p > b ? p - b : b - p;
        const pc = p > c ? p - c : c - p;
        d = (x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
        paeth[i] = d;
        sPaeth += d < 128 ? d : 256 - d;
      }
      let type = 1;
      let best = sub;
      if (sUp < sSub && sUp <= sPaeth) {
        type = 2;
        best = up;
      } else if (sPaeth < sSub && sPaeth < sUp) {
        type = 4;
        best = paeth;
      }
      out[o++] = type;
      out.set(best, o);
      o += stride;
      const t = prev;
      prev = cur;
      cur = t;
    }
    return prev;
  }

  // Compression sans perte en JavaScript, par bandes (mémoire bornée).
  async function flateEncode(ctx, w, h) {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    const result = new Response(cs.readable).arrayBuffer();
    let prev = new Uint8Array(w * 3);
    const band = Math.max(1, Math.min(h, Math.floor(4e6 / Math.max(1, w))));
    for (let y = 0; y < h; y += band) {
      const rows = Math.min(band, h - y);
      const rgba = ctx.getImageData(0, y, w, rows).data;
      const out = new Uint8Array((w * 3 + 1) * rows);
      prev = filterRows(rgba, w, rows, prev.slice(), out);
      await writer.write(out);
    }
    await writer.close();
    return new Uint8Array(await result);
  }

  async function losslessStream(canvas, ctx) {
    return (await nativePngStream(canvas).catch(() => null)) || flateEncode(ctx, canvas.width, canvas.height);
  }

  // Sur quelques bandes d'échantillon : JPEG ou sans perte, lequel est le plus adapté ?
  async function pickFormat(canvas, quality) {
    const w = canvas.width;
    const h = canvas.height;
    const stripH = Math.min(h, 96);
    const n = Math.max(1, Math.min(3, Math.floor(h / stripH)));
    const { canvas: sample, ctx } = makeCanvas(w, stripH * n);
    for (let i = 0; i < n; i++) {
      const sy = n === 1 ? 0 : Math.floor(((h - stripH) * i) / (n - 1));
      ctx.drawImage(canvas, 0, sy, w, stripH, 0, i * stripH, w, stripH);
    }
    const jpeg = await toBlob(sample, 'image/jpeg', quality);
    const flate = await losslessStream(sample, ctx);
    // À taille comparable, le sans-perte est préféré (texte parfaitement net).
    return flate.byteLength <= jpeg.size * 1.15 ? 'lossless' : 'jpeg';
  }

  // Renvoie { filter, parms, data, w, h } prêt pour un XObject image.
  async function encodeCanvas(canvas, ctx, settings) {
    const w = canvas.width;
    const h = canvas.height;
    const quality = settings.jpegQuality / 100;
    let format = settings.imageFormat;
    if (format === 'auto') format = await pickFormat(canvas, quality);
    if (format === 'jpeg') {
      const data = await toBlob(canvas, 'image/jpeg', quality);
      return { filter: 'DCTDecode', parms: '', data, w, h };
    }
    return {
      filter: 'FlateDecode',
      parms: `/DecodeParms<</Predictor 15/Colors 3/BitsPerComponent 8/Columns ${w}>>`,
      data: await losslessStream(canvas, ctx),
      w,
      h,
    };
  }

  W2P.image = { makeCanvas, filterRows, flateEncode, encodeCanvas, losslessStream };
})();
