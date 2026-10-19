'use strict';
// Écriture PDF 1.7 minimale et sans dépendance : objets, flux, police du calque
// de texte invisible (CID Identity-H + ToUnicode), chaînes et nombres.
var W2P = globalThis.W2P || (globalThis.W2P = {});

(() => {
  const encoder = new TextEncoder();

  // Nombre PDF : pas de notation exponentielle, 3 décimales au plus.
  function num(v) {
    if (!Number.isFinite(v)) return '0';
    const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
    return s === '-0' || s === '' ? '0' : s;
  }

  const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase());

  // Unités UTF-16 en hexadécimal (codes CID du calque de texte, Identity-H).
  function hexUtf16(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out += HEX[c >> 8] + HEX[c & 255];
    }
    return out;
  }

  // Chaîne de texte PDF (métadonnées, signets) : UTF-16BE avec BOM.
  function textString(str) {
    return `<FEFF${hexUtf16(String(str))}>`;
  }

  // Chaîne littérale ASCII (URI) : caractères spéciaux échappés, le reste encodé en %XX.
  function asciiString(str) {
    let out = '';
    for (const ch of String(str)) {
      const c = ch.codePointAt(0);
      if (c < 0x20 || c > 0x7e) out += encodeURIComponent(ch);
      else if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
      else out += ch;
    }
    return `(${out})`;
  }

  function pdfDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return (
      `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}'${p(a % 60)}'`
    );
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const byteLength = (part) => (part instanceof Blob ? part.size : part.byteLength);

  class PdfWriter {
    constructor() {
      this.parts = [];
      this.offset = 0;
      this.offsets = [0];
      this.nextId = 1;
      this._push(encoder.encode('%PDF-1.7\n'));
      this._push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    }

    alloc() {
      const id = this.nextId++;
      this.offsets[id] = null;
      return id;
    }

    _push(part) {
      this.parts.push(part);
      this.offset += byteLength(part);
    }

    _ascii(s) {
      this._push(encoder.encode(s));
    }

    object(id, body) {
      this.offsets[id] = this.offset;
      this._ascii(`${id} 0 obj\n${body}\nendobj\n`);
    }

    // data : Uint8Array ou Blob (ex. JPEG tel quel).
    stream(id, dict, data) {
      this.offsets[id] = this.offset;
      this._ascii(`${id} 0 obj\n<<${dict}/Length ${byteLength(data)}>>\nstream\n`);
      this._push(data);
      this._ascii('\nendstream\nendobj\n');
    }

    finish(rootId, infoId) {
      for (let id = 1; id < this.nextId; id++) {
        if (this.offsets[id] == null) this.object(id, 'null');
      }
      const xrefAt = this.offset;
      const lines = [`xref\n0 ${this.nextId}\n0000000000 65535 f \n`];
      for (let id = 1; id < this.nextId; id++) {
        lines.push(`${String(this.offsets[id]).padStart(10, '0')} 00000 n \n`);
      }
      const rnd = crypto.getRandomValues(new Uint8Array(16));
      const fileId = Array.from(rnd, (b) => HEX[b]).join('');
      lines.push(
        `trailer\n<</Size ${this.nextId}/Root ${rootId} 0 R/Info ${infoId} 0 R/ID[<${fileId}><${fileId}>]>>\n` +
          `startxref\n${xrefAt}\n%%EOF\n`,
      );
      this._ascii(lines.join(''));
      return new Blob(this.parts, { type: 'application/pdf' });
    }
  }

  // CMap ToUnicode : chaque code 16 bits correspond à la même unité UTF-16
  // (256 plages, conformes à la contrainte « dernier octet » de la norme).
  function toUnicodeCMap() {
    const ranges = [];
    for (let hi = 0; hi < 256; hi++) ranges.push(`<${HEX[hi]}00> <${HEX[hi]}FF> <${HEX[hi]}00>`);
    const blocks = [];
    for (let i = 0; i < ranges.length; i += 100) {
      const chunk = ranges.slice(i, i + 100);
      blocks.push(`${chunk.length} beginbfrange\n${chunk.join('\n')}\nendbfrange`);
    }
    return (
      '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
      '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
      `${blocks.join('\n')}\n` +
      'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'
    );
  }

  // Police du calque de texte : glyphes vides, chasse fixe de 0,5 em.
  async function writeTextLayerFont(w) {
    const fileId = w.alloc();
    const descId = w.alloc();
    const mapId = w.alloc();
    const uniId = w.alloc();
    const cidId = w.alloc();
    const fontId = w.alloc();
    const ttf = base64ToBytes(W2P.GLYPHLESS_TTF_B64);
    w.stream(fileId, `/Filter/FlateDecode/Length1 ${ttf.length}`, await deflate(ttf));
    w.object(
      descId,
      `<</Type/FontDescriptor/FontName/GlyphLessFont/Flags 5/FontBBox[0 0 500 1000]/ItalicAngle 0` +
        `/Ascent 1000/Descent -1/CapHeight 1000/StemV 80/FontFile2 ${fileId} 0 R>>`,
    );
    const cidToGid = new Uint8Array(131072);
    for (let i = 1; i < cidToGid.length; i += 2) cidToGid[i] = 1;
    w.stream(mapId, '/Filter/FlateDecode', await deflate(cidToGid));
    w.stream(uniId, '/Filter/FlateDecode', await deflate(encoder.encode(toUnicodeCMap())));
    w.object(
      cidId,
      `<</Type/Font/Subtype/CIDFontType2/BaseFont/GlyphLessFont` +
        `/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>` +
        `/FontDescriptor ${descId} 0 R/DW 500/CIDToGIDMap ${mapId} 0 R>>`,
    );
    w.object(
      fontId,
      `<</Type/Font/Subtype/Type0/BaseFont/GlyphLessFont/Encoding/Identity-H` +
        `/DescendantFonts[${cidId} 0 R]/ToUnicode ${uniId} 0 R>>`,
    );
    return fontId;
  }

  W2P.pdf = {
    PdfWriter,
    num,
    hexUtf16,
    textString,
    asciiString,
    pdfDate,
    deflate,
    encoder,
    writeTextLayerFont,
  };
})();
