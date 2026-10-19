# addons.mozilla.org submission kit — Web2PDF Exact 1.1.0

Everything needed to fill in the submission form at <https://addons.mozilla.org/developers/addon/submit/distribution>. Copy each block into the matching field.

## Before you start

1. Build the package: `sh tools/build.sh` → `dist/web2pdf-exact-1.1.0.xpi`.
2. Sign in to addons.mozilla.org with your Mozilla account (free; create one if needed).
3. Choose **On this site** to get a public listing (recommended), or **On your own** to only get a signed file to distribute yourself.

## Form fields

| Field | Value |
| --- | --- |
| Name | Web2PDF Exact |
| Add-on URL (slug) | `web2pdf-exact` |
| Categories | Photos, Music & Videos · Download Management |
| Tags | pdf, screenshot, save page, full page, print |
| Support website | https://github.com/Tixeo/web2pdf-exact/issues |
| Homepage | https://github.com/Tixeo/web2pdf-exact |
| License | MIT License |
| Privacy policy | Not needed: the extension collects no data (declared in the manifest with `data_collection_permissions: none`). |
| Source code | Not needed: the code is neither minified, bundled nor transpiled. |
| Screenshots | `store/screenshots/1-popup.png` … `4-settings.png` (1280 × 800) |
| Icon | `icons/icon-128.png` |

### Summary — English (max. 250 characters)

> Save the page you are looking at as a PDF that is identical to the screen: native browser rendering, no reload, selectable and searchable text, clickable links, bookmarks, smart page breaks.

### Summary — French

> Enregistrez la page affichée en PDF identique à l’écran : rendu natif du navigateur, sans rechargement, texte sélectionnable et cherchable, liens cliquables, signets, coupures de page intelligentes.

### Description — English

```
Web2PDF Exact turns the page you are viewing into a PDF that looks exactly like it does on your screen.

Most "page to PDF" tools redraw the page with a JavaScript library, or run it through the print engine, which changes the layout. Others reload the address on a server and end up with a loading screen or an anti-bot check. Web2PDF Exact does neither: Firefox's own rendering engine draws your tab, in its current state, and that rendering goes into the PDF.

What you get
• A pixel-perfect copy: fonts, gradients, shadows, canvas, SVG, videos and iframes as on screen.
• Selectable, copyable and searchable text (an invisible text layer aligned with the image), including accents, Chinese, Arabic and emoji.
• Clickable links, internal anchors included, and bookmarks generated from the page's headings.
• Smart page breaks: in A4 or Letter, a break never cuts through a line of text or an image.

It works where other tools fail
• Very long pages (tested on 60,000 px), lazy-loaded images, reveal-on-scroll animations.
• Web apps whose content scrolls inside a panel (chats, documents, dashboards): the panel is unrolled.
• Virtualised lists, zoomed pages, strict Content-Security-Policy sites.
• Logged-in pages, filled-in forms, open menus: nothing is reloaded.

Flexible
• Right-click a page → "Convert page to PDF", or use the toolbar popup.
• Areas: whole page, visible area, an element picked with the mouse, or a region you draw.
• Formats: single page with no breaks, A4, A3, A5, Letter, Legal, Tabloid, screen-sized pages or custom; orientation, margins, margin colour, header and footer.
• Sharpness from ×1 to ×4, automatic or forced JPEG / lossless compression.
• File name template with variables and subfolders, optional "Save as" dialog, notification when done.
• Remove distracting elements (cookie banners, chat bubbles, ads) before capturing.
• Optional vector engine based on Firefox printing, with screen styles forced, for very light files.

Private by design: everything happens in your browser. No server, no third-party library, no data collected.

Interface in English and French.
```

### Description — French

```
Web2PDF Exact convertit la page affichée en un PDF identique à ce que vous voyez à l’écran.

La plupart des outils « page vers PDF » redessinent la page avec une bibliothèque JavaScript ou la font passer par le moteur d’impression, ce qui change la mise en page. D’autres rechargent l’adresse sur un serveur et récupèrent une page de chargement ou une vérification anti-robot. Web2PDF Exact ne fait ni l’un ni l’autre : le moteur de rendu de Firefox dessine votre onglet, dans son état actuel, et ce rendu est placé dans le PDF.

Ce que vous obtenez
• Une copie au pixel près : polices, dégradés, ombres, canvas, SVG, vidéos et iframes comme à l’écran.
• Du texte sélectionnable, copiable et cherchable (calque invisible aligné sur l’image), accents, chinois, arabe et emoji compris.
• Des liens cliquables, ancres internes comprises, et des signets générés à partir des titres.
• Des coupures de page intelligentes : en A4 ou en Lettre, une coupure ne tranche jamais une ligne de texte ou une image.

Ça marche là où les autres échouent
• Pages très longues (testé sur 60 000 px), images chargées au défilement, animations d’apparition.
• Applications web dont le contenu défile dans un panneau (messageries, documents, tableaux de bord) : le panneau est déroulé.
• Listes virtualisées, pages zoomées, sites à politique de sécurité stricte.
• Pages connectées, formulaires remplis, menus ouverts : rien n’est rechargé.

Souple
• Clic droit sur la page → « Convertir la page en PDF », ou la popup de la barre d’outils.
• Zones : page entière, zone visible, élément choisi à la souris ou zone tracée.
• Formats : page unique sans coupure, A4, A3, A5, Lettre, Légal, Tabloïd, pages de la taille de l’écran ou personnalisé ; orientation, marges, couleur des marges, en-tête et pied de page.
• Netteté de ×1 à ×4, compression automatique, JPEG ou sans perte.
• Modèle de nom de fichier avec variables et sous-dossiers, fenêtre « Enregistrer sous » au choix, notification à la fin.
• Retrait des éléments gênants (bandeaux de cookies, bulles de chat, publicités) avant la capture.
• Moteur vectoriel optionnel, basé sur l’impression de Firefox avec les styles d’écran forcés, pour des fichiers très légers.

Respect de la vie privée : tout se passe dans votre navigateur. Aucun serveur, aucune bibliothèque tierce, aucune donnée collectée.

Interface en français et en anglais.
```

## Notes to reviewer

Paste this into **Notes to Reviewer** on the version page.

```
Web2PDF Exact captures the current tab with the native tabs.captureTab API and assembles the PDF locally. No remote code, no network request, no data collection, no minified or generated code (the only generated file is lib/glyphless-font.js, a 624-byte font produced by tools/make_glyphless_font.py, and _locales/*/messages.json, produced by tools/messages.py).

Permissions:
- <all_urls>: required by tabs.captureTab, and to inject the capture script (content/agent.js) into the page the user asks to convert. The script is injected only when the user starts a conversion (popup, context menu, keyboard shortcut); there are no persistent content scripts.
- activeTab: the page being converted.
- scripting: injects content/agent.js and temporary capture styles (insertCSS/removeCSS with USER origin), all removed after the capture.
- downloads, downloads.open: save the generated PDF and open it when the user clicks the result or the notification.
- menus: "Convert page to PDF" on the page context menu and the toolbar-icon menu.
- notifications: "PDF created" / error notification (can be turned off in the settings).
- storage: user settings (storage.local only).

How to test: open any web page, right-click it and choose "Convert page to PDF" (or click the toolbar icon, then "Convert to PDF"). The PDF is saved to the download folder.

Automated tests (not part of the package): tests/run_tests.py drives a headless Gecko browser and checks the generated PDFs.
```

## Release notes — 1.1.0

```
• Interface in English and French.
• Right-click a page → "Convert page to PDF" in one click; every mode is also available by right-clicking the toolbar icon. Optional full submenu, including "This element…" which starts from the element you right-clicked.
• Faster captures: adaptive waiting between slices and native PNG encoding (up to 2× faster on long pages).
• Slice boundaries now fall between blocks, so elements revealed on scroll are always captured whole.
• Copied text keeps single spaces and line breaks in every PDF viewer.
• Capture pauses automatically when you switch tabs and resumes when you come back.
• Declares that no data is collected (Firefox data-collection consent).
```

## After submission

- Validation runs immediately; warnings do not block the submission.
- Listed add-ons may get a manual review; you receive an email with the outcome.
- To publish an update: bump `version` in `manifest.json`, run `sh tools/build.sh`, then upload the new `.xpi` from the add-on’s page on addons.mozilla.org.
