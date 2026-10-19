'use strict';
// Réglages : schéma, valeurs par défaut, validation et stockage.
// Partagé par le background, la popup et la page d'options.
var W2P = globalThis.W2P || (globalThis.W2P = {});

(() => {
  const SCHEMA = {
    // Moteur : « exact » (rendu Gecko capturé au pixel près) ou « vector » (moteur d'impression).
    engine: { type: 'enum', values: ['exact', 'vector'], def: 'exact' },
    scope: { type: 'enum', values: ['full', 'visible', 'element', 'region'], def: 'full' },

    // Capture
    captureMethod: { type: 'enum', values: ['auto', 'scroll', 'direct'], def: 'auto' },
    preloadLazy: { type: 'bool', def: true },
    settleDelay: { type: 'int', min: 0, max: 5000, def: 400 },
    startDelay: { type: 'int', min: 0, max: 60, def: 0 },
    freezeAnimations: { type: 'bool', def: true },
    floating: { type: 'enum', values: ['once', 'hide'], def: 'once' },
    scrollContainer: { type: 'bool', def: true },
    horizontalOverflow: { type: 'bool', def: false },
    maxHeight: { type: 'int', min: 1000, max: 500000, def: 150000 },
    cleanupBefore: { type: 'bool', def: false },

    // Qualité
    pixelRatio: { type: 'num', min: 0, max: 6, def: 0 },
    imageFormat: { type: 'enum', values: ['auto', 'jpeg', 'lossless'], def: 'auto' },
    jpegQuality: { type: 'int', min: 50, max: 100, def: 92 },

    // Mise en page
    pageFormat: {
      type: 'enum',
      values: ['single', 'a4', 'a3', 'a5', 'letter', 'legal', 'tabloid', 'screen', 'custom'],
      def: 'single',
    },
    orientation: { type: 'enum', values: ['portrait', 'landscape'], def: 'portrait' },
    customWidthMm: { type: 'num', min: 20, max: 5000, def: 210 },
    customHeightMm: { type: 'num', min: 20, max: 5000, def: 297 },
    marginTop: { type: 'num', min: 0, max: 100, def: 0 },
    marginRight: { type: 'num', min: 0, max: 100, def: 0 },
    marginBottom: { type: 'num', min: 0, max: 100, def: 0 },
    marginLeft: { type: 'num', min: 0, max: 100, def: 0 },
    marginColor: { type: 'enum', values: ['page', 'white'], def: 'page' },
    fit: { type: 'enum', values: ['width', 'actual'], def: 'width' },
    smartBreaks: { type: 'bool', def: true },
    limitPageSize: { type: 'bool', def: true },
    headerFooter: { type: 'bool', def: false },

    // Contenu du PDF
    textLayer: { type: 'bool', def: true },
    links: { type: 'bool', def: true },
    bookmarks: { type: 'bool', def: true },

    // Fichier
    filenameTemplate: { type: 'string', max: 240, def: '{title}' },
    saveAs: { type: 'bool', def: false },
    afterAction: { type: 'enum', values: ['download', 'download-open', 'open'], def: 'download' },
    notify: { type: 'bool', def: true },

    // Mode vectoriel
    vectorEmulateScreen: { type: 'bool', def: true },
    vectorFitWidth: { type: 'bool', def: true },
  };

  const DEFAULTS = Object.freeze(
    Object.fromEntries(Object.entries(SCHEMA).map(([k, d]) => [k, d.def])),
  );

  // Formats papier en millimètres (portrait).
  const PAPER_SIZES = Object.freeze({
    a3: [297, 420],
    a4: [210, 297],
    a5: [148, 210],
    letter: [215.9, 279.4],
    legal: [215.9, 355.6],
    tabloid: [279.4, 431.8],
  });

  function normalize(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    for (const [key, def] of Object.entries(SCHEMA)) {
      let v = src[key];
      switch (def.type) {
        case 'bool':
          v = typeof v === 'boolean' ? v : def.def;
          break;
        case 'enum':
          v = def.values.includes(v) ? v : def.def;
          break;
        case 'int':
        case 'num': {
          let n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
          if (typeof n !== 'number' || !Number.isFinite(n)) n = def.def;
          n = Math.min(def.max, Math.max(def.min, n));
          v = def.type === 'int' ? Math.round(n) : n;
          break;
        }
        case 'string':
          v = typeof v === 'string' ? v.slice(0, def.max) : def.def;
          break;
      }
      out[key] = v;
    }
    return out;
  }

  async function load() {
    const { settings } = await browser.storage.local.get('settings');
    return normalize(settings);
  }

  async function save(patch) {
    const next = normalize({ ...(await load()), ...patch });
    await browser.storage.local.set({ settings: next });
    return next;
  }

  async function reset() {
    await browser.storage.local.set({ settings: { ...DEFAULTS } });
    return { ...DEFAULTS };
  }

  W2P.SETTINGS_SCHEMA = SCHEMA;
  W2P.DEFAULTS = DEFAULTS;
  W2P.PAPER_SIZES = PAPER_SIZES;
  W2P.normalizeSettings = normalize;
  W2P.loadSettings = load;
  W2P.saveSettings = save;
  W2P.resetSettings = reset;
})();
