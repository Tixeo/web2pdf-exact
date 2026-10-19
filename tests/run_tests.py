"""Tests de bout en bout de Web2PDF Exact dans un vrai moteur Gecko (Zen ou Firefox).

- lance le navigateur sans interface sur un profil temporaire jetable ;
- installe l'extension en module temporaire (copie + page de pilotage) ;
- ouvre des pages pièges, déclenche la conversion comme la popup ;
- vérifie les PDF avec PDFKit (pdfinfo) : pages, texte, liens, signets, rendu.

Usage : python3 tests/run_tests.py [--binary CHEMIN] [--only NOM] [--keep] [--headful]
"""

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from marionette import Marionette, MarionetteError, launch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
EXT_ID = "web2pdf-exact@extension"
EXT_UUID = "5f0e2c7a-1b3d-4e8f-9a6b-2c4d6e8f0a1b"
HARNESS = f"moz-extension://{EXT_UUID}/test-harness/harness.html"
DEFAULT_BINARY = "/Applications/Zen.app/Contents/MacOS/zen"


def build_extension(dest):
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for item in ["manifest.json", "_locales", "background", "content", "lib", "popup", "options", "icons"]:
        src = ROOT / item
        if src.is_dir():
            shutil.copytree(src, dest / item)
        else:
            shutil.copy2(src, dest / item)
    shutil.copytree(ROOT / "tests" / "harness", dest / "test-harness")


class Session:
    def __init__(self, work, binary, headless=True, port=2829, http_port=8765, dpr=2.0):
        self.work = work
        self.ext_uuid = EXT_UUID
        self.dl = work / "downloads"
        self.dl.mkdir(parents=True, exist_ok=True)
        self.http = f"http://127.0.0.1:{http_port}"
        self.server = subprocess.Popen(
            [sys.executable, "-I", str(ROOT / "tests" / "serve.py"), str(http_port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        prefs = {
            "marionette.port": port,
            "browser.shell.checkDefaultBrowser": False,
            "browser.startup.homepage_override.mstone": "ignore",
            "browser.startup.page": 0,
            "browser.download.folderList": 2,
            "browser.download.dir": str(self.dl),
            "browser.download.useDownloadDir": True,
            "browser.download.always_ask_before_handling_new_types": False,
            "browser.download.start_downloads_in_tmp_dir": False,
            "browser.download.panel.shown": True,
            "extensions.webextensions.uuids": json.dumps({EXT_ID: EXT_UUID}),
            "xpinstall.signatures.required": False,
            "datareporting.policy.dataSubmissionEnabled": False,
            "toolkit.telemetry.reportingpolicy.firstRun": False,
            "app.update.disabledForTesting": True,
            "layout.css.devPixelsPerPx": str(dpr),
            "browser.tabs.warnOnClose": False,
            "extensions.autoDisableScopes": 0,
            "browser.aboutwelcome.enabled": False,
            "zen.welcome-screen.seen": True,
            # Les messages de console (dont les erreurs de l'extension) vont dans browser.log.
            "devtools.console.stdout.chrome": True,
            "devtools.console.stdout.content": True,
        }
        self.proc = launch(binary, str(work / "profile"), port, prefs, headless, str(work / "browser.log"))
        try:
            self._setup(port)
        except BaseException:
            self.close()
            raise

    def _setup(self, port):
        self.m = Marionette(port)
        self.m.cmd("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {"acceptInsecureCerts": True}}})
        self.m.cmd("WebDriver:SetWindowRect", {"width": 1440, "height": 1000})
        ext = self.work / "ext"
        build_extension(ext)
        self.m.cmd("Addon:Install", {"path": str(ext), "temporary": True})
        # Onglet cible : un onglet normal (l'onglet vide initial de Zen est masqué aux extensions).
        self.target = self.m.new_tab()
        self.m.switch(self.target, focus=True)
        self.harness = self.open_extension_tab(HARNESS)
        self.m.switch(self.target, focus=True)

    def open_extension_tab(self, url):
        # Marionette refuse de naviguer vers moz-extension:// : on ouvre l'onglet
        # depuis l'interface du navigateur (contexte privilégié), puis on le repère.
        before = set(self.m.handles())
        self.m.cmd("Marionette:SetContext", {"value": "chrome"})
        try:
            self.m.js(
                "gBrowser.addTab(arguments[0], {"
                " triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });",
                [url],
            )
        finally:
            self.m.cmd("Marionette:SetContext", {"value": "content"})
        deadline = time.time() + 20
        while True:
            new = set(self.m.handles()) - before
            if new:
                handle = new.pop()
                break
            if time.time() > deadline:
                raise RuntimeError("onglet de pilotage introuvable")
            time.sleep(0.2)
        self.m.switch(handle, focus=False)
        for _ in range(100):
            try:
                if self.m.js("return location.href") == url and self.m.js("return document.readyState") == "complete":
                    break
            except Exception:
                pass
            time.sleep(0.1)
        return handle

    def mock_file_picker(self, path):
        """Remplace la boîte « Enregistrer sous » (impossible à piloter sans interface)
        par un sélecteur qui répond aussitôt avec `path`. Instance de test uniquement."""
        self.m.cmd("Marionette:SetContext", {"value": "chrome"})
        try:
            self.m.js(
                """
                const target = arguments[0];
                const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
                const factory = {
                  createInstance(iid) {
                    const picker = {
                      QueryInterface: ChromeUtils.generateQI(["nsIFilePicker"]),
                      init() {}, appendFilter() {}, appendFilters() {}, appendRawFilter() {},
                      defaultExtension: "", defaultString: "", filterIndex: 0, addToRecentDocs: false,
                      okButtonLabel: "", displayDirectory: null, displaySpecialDirectory: "",
                      get file() {
                        const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
                        f.initWithPath(target);
                        return f;
                      },
                      get fileURL() { return Services.io.newFileURI(this.file); },
                      open(cb) {
                        Services.tm.dispatchToMainThread(() => (typeof cb === "function" ? cb(0) : cb.done(0)));
                      },
                    };
                    return picker.QueryInterface(iid);
                  },
                };
                registrar.registerFactory(Services.uuid.generateUUID(), "W2P test picker",
                  "@mozilla.org/filepicker;1", factory);
                return true;
                """,
                [str(path)],
            )
        finally:
            self.m.cmd("Marionette:SetContext", {"value": "content"})

    def close(self):
        try:
            if getattr(self, "m", None):
                self.m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        try:
            self.proc.wait(timeout=20)
        except Exception:
            self.proc.kill()
        self.server.terminate()

    def open(self, page):
        url = f"{self.http}/{page}"
        self.m.switch(self.target, focus=True)
        self.m.navigate(url)
        return url

    def screenshot(self, path):
        data = self.m.cmd("WebDriver:TakeScreenshot", {"full": True, "hash": False, "scroll": False})["value"]
        Path(path).write_bytes(base64.b64decode(data))
        return path

    def convert(self, url, scope="full", overrides=None, interact=None, timeout=240, zoom=None):
        self.m.switch(self.harness, focus=False)
        self.m.js(
            "document.body.dataset.state='posting'; window.postMessage(arguments[0], '*');",
            [{"type": "w2p-test", "url": url, "scope": scope, "overrides": overrides or {}, "zoom": zoom}],
        )
        if interact:
            time.sleep(1.5)
            self.m.switch(self.target, focus=False)
            interact(self.m)
            self.m.switch(self.harness, focus=False)
        deadline = time.time() + timeout
        while time.time() < deadline:
            state = self.m.js("return document.body.dataset.state")
            if state == "done":
                raw = self.m.js("return document.body.dataset.result")
                self.m.switch(self.target, focus=False)
                return json.loads(raw) if raw else None
            time.sleep(0.5)
        self.m.switch(self.target, focus=False)
        raise TimeoutError("la conversion n'a pas abouti à temps")


def pdfinfo(pdf, out_dir, dpi, binary):
    out_dir.mkdir(parents=True, exist_ok=True)
    res = subprocess.run([binary, str(pdf), str(out_dir), str(dpi)], capture_output=True, text=True, timeout=300)
    if res.returncode != 0:
        raise RuntimeError(res.stdout + res.stderr)
    return json.loads(res.stdout)


def magenta_ratio(png):
    a = np.asarray(Image.open(png).convert("RGB")).astype(int)
    mask = (a[:, :, 0] > 240) & (a[:, :, 1] < 20) & (a[:, :, 2] > 240)
    return float(mask.mean())


def color_present(png, rgb, tol=40, min_ratio=0.002):
    a = np.asarray(Image.open(png).convert("RGB")).astype(int)
    d = np.abs(a - np.array(rgb)).sum(axis=2)
    return float((d < tol).mean()) >= min_ratio


class Report:
    def __init__(self):
        self.rows = []

    def check(self, case, label, ok, detail=""):
        self.rows.append((case, label, bool(ok), detail))
        mark = "OK " if ok else "ÉCHEC"
        print(f"  [{mark}] {label}" + (f" — {detail}" if detail else ""), flush=True)
        return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", default=os.environ.get("W2P_BROWSER", DEFAULT_BINARY))
    ap.add_argument("--pdfinfo", default=os.environ.get("W2P_PDFINFO", ""))
    ap.add_argument("--work", default="")
    ap.add_argument("--only", default="")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--headful", action="store_true")
    ap.add_argument("--real", action="store_true", help="sites réels (réseau requis)")
    args = ap.parse_args()

    work = Path(args.work or tempfile.mkdtemp(prefix="w2p-tests-"))
    work.mkdir(parents=True, exist_ok=True)
    tool = args.pdfinfo
    if not tool:
        tool = str(work / "pdfinfo")
        subprocess.run(["swiftc", "-O", str(ROOT / "tests" / "pdfinfo.swift"), "-o", tool], check=True)

    import scenarios  # noqa: E402  (tests/scenarios.py)

    report = Report()
    s = Session(work, args.binary, headless=not args.headful)
    try:
        for case in scenarios.REAL_CASES if args.real else scenarios.CASES:
            if args.only and args.only not in case.__name__:
                continue
            print(f"\n=== {case.__doc__.strip().splitlines()[0]} ({case.__name__})", flush=True)
            out = work / case.__name__
            out.mkdir(exist_ok=True)
            try:
                case(s, report, out, lambda pdf, dpi=72: pdfinfo(pdf, out / "render", dpi, tool))
            except Exception as e:  # noqa: BLE001
                report.check(case.__name__, "exécution du scénario", False, f"{type(e).__name__}: {e}")
    finally:
        if not args.keep:
            s.close()
    # Contrôles transversaux : structure de chaque PDF produit, erreurs JavaScript.
    from pdfcheck import check as pdf_check
    # vectoriel.pdf vient du moteur d'impression de Firefox, pas de notre écrivain PDF.
    pdfs = sorted(p for p in work.rglob("*.pdf") if "profile" not in p.parts and p.name != "vectoriel.pdf")
    broken = [(p.name, errs) for p in pdfs for errs in [pdf_check(p)] if errs]
    report.check("global", f"structure PDF valide ({len(pdfs)} fichiers)", not broken, str(broken[:2]))
    log = (work / "browser.log").read_text(errors="replace") if (work / "browser.log").exists() else ""
    ext_errors = [
        line for line in log.splitlines()
        if (EXT_UUID in line or "[Web2PDF Exact]" in line) and ("Error" in line or "error" in line)
    ]
    report.check("global", "aucune erreur JavaScript de l'extension", not ext_errors, "\n".join(ext_errors[:5]))
    failed = [r for r in report.rows if not r[2]]
    print(f"\n{len(report.rows) - len(failed)}/{len(report.rows)} vérifications réussies. Résultats : {work}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
