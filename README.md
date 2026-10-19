# Web2PDF Exact

A **Firefox** and **Zen** extension that turns the page you are looking at into a PDF that is **identical to what you see on screen**.

The browser’s own rendering engine (Gecko) draws the page, and that rendering goes into the PDF as is. Nothing is reloaded or re-interpreted: the capture starts from your tab, with your session, in the exact state the page is in.

The interface is available in English and French (it follows the browser’s language).

## Why another “page to PDF” extension?

| Common problem | Usual cause | What Web2PDF Exact does |
| --- | --- | --- |
| The CSS is not reproduced correctly | The page is redrawn by a JavaScript library (html2canvas, jsPDF…) or sent through the print engine, which applies `@media print` styles and a different width | Gecko itself draws the page through the browser’s native capture API. Fonts, gradients, shadows, canvas, SVG, videos and iframes come out exactly as on screen. |
| Settings are too rigid | A4 only, fixed margins, fixed file name | About forty settings: area, format (single page, A4, A3, Letter, screen, custom), orientation, margins, sharpness up to ×4, compression, page breaks, header and footer, file-name template with subfolders… |
| The conversion fails | Very long pages, web apps, content loaded on scroll | Tiled capture (tested on 60,000 px pages), unrolling of scrolling panels (chat apps, Notion…), virtualised lists, lazy-loaded images, reveal-on-scroll animations, zoomed pages, automatic pause if you switch tabs. |
| The PDF shows a loading screen or an anti-bot page | The service reloads the URL on a server, which gets the Cloudflare check or a login screen | Nothing is reloaded: the capture happens in your tab, logged in, after your clicks, with filled-in fields and open menus. |

## Installation

### From addons.mozilla.org

Once published, install it from its addons.mozilla.org page like any other add-on (this works in Zen too).

### From source (Zen and Firefox Developer Edition / Nightly)

Unsigned extensions can be installed permanently once a setting is changed. This was verified on Zen 1.23.3b (Firefox 158): refused by default, installed permanently once the setting is changed.

1. Build the package: `sh tools/build.sh` (it is written to `dist/`).
2. Open `about:config`, search for `xpinstall.signatures.required` and set it to **false**.
3. Open `about:addons`, click the gear icon, then **Install Add-on From File…**, and pick `dist/web2pdf-exact-<version>.xpi`.
4. Pin the icon to the toolbar from the extensions menu.

Firefox 140 or later is required.

Other options:
- **Without changing that setting**: `about:debugging` → *This Firefox* → *Load Temporary Add-on…* → pick `manifest.json`. The extension is removed when the browser restarts.
- **Firefox release** (which requires a signature): sign the extension for self-distribution with your AMO API keys, for example `npx web-ext sign --channel=unlisted --api-key=… --api-secret=…`.

## Usage

- **Right-click the page** → **Convert page to PDF**: one click, with your default settings.
- **Toolbar icon** or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>: choose the area, the format and the sharpness, then **Convert to PDF** (or <kbd>Enter</kbd>). These choices are remembered.
- **Right-click the toolbar icon**: every mode (whole page, visible area, element, drawn area, vector, settings).
- **Direct keyboard shortcuts**, without the popup: assign them in `about:addons` → gear icon → *Manage Extension Shortcuts*.
- <kbd>Esc</kbd> stops a capture, and the page goes back exactly to its original state (scroll position, selection, styles).

In the settings, the page’s right-click menu can also show the full submenu, including **This element…**, which starts the element picker on the element you right-clicked.

Areas:
- **Whole page**: the entire page. For a web app whose content scrolls inside a panel, that panel is “unrolled”.
- **Visible**: exactly what is displayed, at the current scroll position.
- **Element**: hover, then click. <kbd>↑</kbd> selects the parent, <kbd>↓</kbd> goes back to the child, <kbd>Enter</kbd> confirms. A scrolling panel is captured in full.
- **Region**: draw a rectangle with the mouse. The mouse wheel and the screen edges scroll the page while drawing.
- **Remove elements before capturing** (option): click whatever is in the way (cookie banner, chat bubble, ad), <kbd>Ctrl</kbd>+<kbd>Z</kbd> to restore, <kbd>Enter</kbd> to capture. Nothing is deleted from the page: everything comes back after the capture.

## What the PDF contains

- **The rendered image**, at your screen’s resolution (×2 on a Retina display, ×3 with a 150 % page zoom) or higher if you choose so.
- **An invisible text layer** aligned with the image: selecting, copying and searching all work, including accents, Chinese, Arabic and emoji. Copied text keeps its spaces and line breaks in macOS Preview and in Firefox’s PDF viewer.
- **Clickable links**, external and internal (a `#section` anchor jumps to the right place in the PDF).
- **Bookmarks** generated from the page’s headings.
- **Metadata**: page title, source address and capture date.

Page breaks are **smart**: in paged formats (A4…), a break never cuts through a line of text or an image. The **Single page** format (the default) has no breaks at all: the PDF *is* the page, in one piece.

## How the capture stays faithful

1. Deferred content is preloaded: a first pass scrolls through the page to trigger lazy-loaded images and content.
2. The page is then captured slice by slice, each slice drawn by Gecko. Slice boundaries fall between two blocks, and the bottom of the screen (where reveal animations fire late) is taken from the next slice instead.
3. Fixed elements (sticky header, chat bubble) appear once at the top instead of being repeated on every slice. Sticky elements go back to their natural position.
4. Transitions and animations finish instantly, without blocking the page’s scripts (carousels included).
5. Text and links are recorded when their slice is captured, which keeps them in sync with the image, even on virtualised lists.

On a static page, the slice-by-slice capture and the one-piece rendering give the same pixels: out of 96 million, 410 differ, through anti-aliasing on rounded corners. It is not visible.

## Vector engine (option)

For a very light PDF with vector text, the **Vector** engine uses the browser’s PDF printing. It forces screen styles (the page’s `@media print` rules are neutralised), lays the page out at screen width and then shrinks it to fit the paper, and avoids repeating fixed elements. Limits that come with printing: sections one screen tall (`100vh`) take the paper’s height, and style sheets hosted on another domain cannot be adapted. A dialog asks where to save the file.

## Known limits

- Internal browser pages (`about:`, `addons.mozilla.org`, the built-in PDF viewer…) are off-limits to every extension. Reader view can only be converted with the vector engine.
- Text inside an iframe from **another** domain appears in the image, but not in the text layer.
- Sites that fake scrolling with CSS transforms (old Locomotive Scroll) are only captured over the visible part.
- Parallax effects and `background-attachment: fixed` backgrounds depend on scrolling. For those pages, the **Direct rendering** method (settings → Capture) draws the whole page in one piece.

## Privacy

No data leaves the browser: no server, no third-party library, no telemetry. The manifest declares that the extension collects no data.

## Tests

`tests/` contains an end-to-end suite that drives a real headless Gecko browser (Zen by default, or Firefox with `--binary`) on a **throwaway profile**. Your own profile is never touched.

```bash
python3 tests/run_tests.py            # local trap pages (~10 min)
python3 tests/run_tests.py --real     # a few real websites (network required)
python3 tests/run_tests.py --only app # a single scenario
```

The PDFs are checked independently with PDFKit (macOS) and pdf.js (Firefox’s viewer): page count and size, extracted text, links, bookmarks, unpainted areas, cut lines and the file’s internal structure. The suite also compares slice seams pixel by pixel, and covers the right-click menu, strict Content-Security-Policy sites, tab switching and cancellation.

## Code layout

| File | Role |
| --- | --- |
| `content/agent.js` | Injected into the tab: page preparation, scrolling, slice cuts, text, link and heading collection, pickers (element, region, clean-up), restoration. |
| `background/background.js` | Orchestration: jobs, native captures (`tabs.captureTab`), CSS injected with user origin, progress, downloads, menus, shortcuts, vector engine. |
| `background/build.js` | PDF assembly: tiles, text layer, links, bookmarks, header and footer. |
| `lib/pdf.js` | Dependency-free PDF 1.7 writer and invisible Unicode font (CID Identity-H + ToUnicode). |
| `lib/image.js` | JPEG or lossless encoding (PNG predictors + Deflate), with automatic choice. |
| `lib/layout.js` | Formats, margins and smart page breaks. |
| `lib/settings.js`, `lib/filename.js`, `lib/i18n.js` | Settings, file names (same rules as Gecko’s validator), translations. |
| `_locales/` | Interface text in English and French, generated by `tools/messages.py`. |
| `popup/`, `options/` | Interface. |
| `store/` | Submission material for addons.mozilla.org. |
| `tools/` | Package build, translation and invisible-font generation. |

## License

[MIT](LICENSE).

---

<sub>Designed with the help of Wheeloh resources</sub>
