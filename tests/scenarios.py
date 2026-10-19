"""Scénarios de test : ouvrir une page piège, convertir comme la popup, vérifier le PDF."""

import json
import time

import numpy as np
from PIL import Image

from run_tests import color_present, magenta_ratio

ENTER = chr(0xE007)  # touche Entrée au sens de WebDriver
ARROW_UP = chr(0xE013)


def _ok(r, name, res):
    good = bool(res and res.get("ok") and res.get("path"))
    r.check(name, "conversion réussie", good, "" if good else json.dumps(res, ensure_ascii=False)[:400])
    return good


def _save(out, res, d=None):
    (out / "result.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    if d is not None:
        (out / "pdfinfo.json").write_text(json.dumps(d, ensure_ascii=False, indent=1))


def _actions(m, *seqs):
    m.cmd("WebDriver:PerformActions", {"actions": list(seqs)})
    m.cmd("WebDriver:ReleaseActions")


def _mouse(steps):
    return {"type": "pointer", "id": "souris", "parameters": {"pointerType": "mouse"}, "actions": steps}


def _click(x, y):
    return _mouse(
        [
            {"type": "pointerMove", "x": int(x), "y": int(y), "origin": "viewport", "duration": 50},
            {"type": "pointerDown", "button": 0},
            {"type": "pointerUp", "button": 0},
        ]
    )


def _key(value):
    return {"type": "key", "id": "clavier", "actions": [{"type": "keyDown", "value": value}, {"type": "keyUp", "value": value}]}


def _rect(m, selector):
    return m.js(
        "const r = document.querySelector(arguments[0]).getBoundingClientRect();"
        "return [r.left, r.top, r.width, r.height];",
        [selector],
    )


def article_single(s, r, out, info):
    """Article piège en page unique : fidélité, texte, liens, signets"""
    name = "article_single"
    url = s.open("article.html")
    time.sleep(1.0)
    s.screenshot(out / "reference.png")
    res = s.convert(url, "full", {"pageFormat": "single", "engine": "exact"})
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 144)
    _save(out, res, d)
    r.check(name, "une seule page", d["pageCount"] == 1, f"{d['pageCount']} pages")
    p = d["pages"][0]
    text = p["text"]
    r.check(name, "bas de page capturé", "FIN DE LA PAGE" in text)
    r.check(name, "accents intacts", "à â ç é è ê ë î ï ô ù û ü ÿ œ æ" in text)
    r.check(name, "en-tête fixe présent une seule fois", text.count("EN-TÊTE FIXE") == 1, f"{text.count('EN-TÊTE FIXE')} fois")
    r.check(name, "encadrés « révélés au défilement » visibles", all(f"Révélé au défilement n°{i}" in text for i in (1, 2, 3)))
    r.check(name, "texte de l'iframe sélectionnable", "Contenu de l’iframe" in text)
    r.check(name, "écritures non latines", "这是一个测试句子" in text and "Καλημέρα" in text and "🚗" in text)
    urls = [lk.get("url", "") for lk in p["links"]]
    r.check(name, "lien externe cliquable", any("example.org/ressource" in u for u in urls))
    r.check(name, "lien interne (ancre) actif", any("destPage" in lk for lk in p["links"]))
    labels = [o["label"] for o in d["outline"]]
    r.check(name, "signets depuis les titres", "Conclusion" in labels and len(labels) >= 8, f"{len(labels)} signets")
    png = p.get("png")
    r.check(name, "aucune zone non peinte", magenta_ratio(png) < 1e-5)
    r.check(name, "image native différée chargée (orange)", color_present(png, (255, 136, 0)))
    r.check(name, "image JS différée chargée (verte)", color_present(png, (34, 170, 85)))
    r.check(name, "durée raisonnable", res.get("elapsed", 0) < 30000, f"{res.get('elapsed', 0) / 1000:.1f} s")


def _cut_lines(d, margin_top, margin_bottom):
    """Lignes de texte qui débordent du cadre d'une page (coupées entre deux pages)."""
    cut = []
    for i, p in enumerate(d["pages"]):
        for x, y, w, h, t in p["lines"]:
            if not t.strip() or h <= 0:
                continue
            if y < margin_bottom - 0.5 or y + h > p["h"] - margin_top + 0.5:
                cut.append((i + 1, round(y, 1), round(h, 1), t[:40]))
    return cut


def article_a4_smart(s, r, out, info):
    """Article en A4 : coupures intelligentes (aucune ligne tranchée)"""
    name = "article_a4_smart"
    url = s.open("article.html")
    time.sleep(0.8)
    res = s.convert(url, "full", {"pageFormat": "a4", "orientation": "portrait", "smartBreaks": True})
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 72)
    _save(out, res, d)
    r.check(name, "plusieurs pages A4", d["pageCount"] >= 3 and abs(d["pages"][0]["w"] - 595.28) < 1, f"{d['pageCount']} pages de {d['pages'][0]['w']:.1f} pt")
    cut = _cut_lines(d, 0, 0)
    r.check(name, "aucune ligne de texte coupée", not cut, str(cut[:3]))
    res2 = s.convert(url, "full", {"pageFormat": "a4", "orientation": "portrait", "smartBreaks": False})
    if res2 and res2.get("ok"):
        d2 = info(res2["path"], 72)
        cut2 = _cut_lines(d2, 0, 0)
        r.check(name, "témoin sans coupures intelligentes : lignes coupées", len(cut2) > 0, f"{len(cut2)} ligne(s) coupée(s)")
    all_text = "".join(p["text"] for p in d["pages"])
    r.check(name, "tout le texte présent", "FIN DE LA PAGE" in all_text and "Le grand test" in all_text)
    links_internal = [lk for p in d["pages"] for lk in p["links"] if "destPage" in lk]
    r.check(name, "ancre interne vers une autre page", any(lk["destPage"] > 0 for lk in links_internal))


def app_container(s, r, out, info):
    """Application web à conteneur défilant (messagerie) : contenu déroulé"""
    name = "app_container"
    url = s.open("app.html")
    time.sleep(0.8)
    res = s.convert(url, "full", {"pageFormat": "single"})
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 72)
    _save(out, res, d)
    text = d["pages"][0]["text"]
    r.check(name, "premier et dernier message présents", "Message n°1 " in text and "Message n°120 " in text)
    missing = [n for n in range(1, 121) if f"Message n°{n} " not in text]
    r.check(name, "les 120 messages présents", not missing, f"manquants : {missing[:10]}")
    r.check(name, "séparateurs de jour présents une seule fois", all(text.count(f"Jour {i}") == 1 for i in range(1, 5)))
    r.check(name, "barre latérale et en-tête conservés", "Équipe produit" in text and "Messagerie Démo" in text)
    size = res.get("size") or {}
    r.check(name, "hauteur déroulée bien supérieure à l'écran", size.get("height", 0) > 4000, str(size))
    png = d["pages"][0]["png"]
    r.check(name, "aucune zone non peinte", magenta_ratio(png) < 1e-5)


def dynamic_state(s, r, out, info):
    """Contenu modifié par JavaScript et formulaire rempli : état réel capturé"""
    name = "dynamic_state"
    url = s.open("dynamic.html")
    time.sleep(1.2)
    el = s.m.cmd("WebDriver:FindElement", {"using": "css selector", "value": "#field"})["value"]
    eid = list(el.values())[0]
    s.m.cmd("WebDriver:ElementSendKeys", {"id": eid, "text": "Valeur saisie à la main"})
    res = s.convert(url, "full", {"pageFormat": "single"})
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 144)
    _save(out, res, d)
    text = d["pages"][0]["text"]
    r.check(name, "état généré par JS présent", "État généré par JavaScript : 42 éléments prêts" in text)
    r.check(name, "ancien texte de chargement absent", "Chargement en cours" not in text)
    r.check(name, "titre à jour dans le nom du fichier", "Contenu dynamique (prêt)" in res.get("filename", ""), res.get("filename"))
    # La valeur saisie est dans l'image : on vérifie que la zone du champ n'est pas vide.
    png = Image.open(d["pages"][0]["png"]).convert("L")
    a = np.asarray(png)
    r.check(name, "image non vide", a.std() > 10)


def huge_page(s, r, out, info):
    """Page très longue (60 000 px) en page unique : tuiles et limite de taille"""
    name = "huge_page"
    url = s.open("huge.html")
    time.sleep(0.8)
    res = s.convert(url, "full", {"pageFormat": "single", "preloadLazy": False, "settleDelay": 0})
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 18)
    _save(out, res, d)
    p = d["pages"][0]
    r.check(name, "page unique ≤ 200 pouces (Acrobat)", p["h"] <= 14400.5, f"{p['w']:.0f} × {p['h']:.0f} pt")
    r.check(name, "première et dernière bande", "Bande 0" in p["text"] and "Bande 59" in p["text"])
    a = np.asarray(Image.open(p["png"]).convert("RGB")).astype(int)
    r.check(name, "aucune zone non peinte", magenta_ratio(p["png"]) < 1e-5)
    rows = a[:, a.shape[1] // 2, :]
    changes = int((np.abs(np.diff(rows, axis=0)).sum(axis=1) > 60).sum())
    r.check(name, "60 bandes distinctes rendues", changes >= 55, f"{changes} transitions")
    r.check(name, "durée raisonnable", res.get("elapsed", 0) < 90000, f"{res.get('elapsed', 0) / 1000:.1f} s")


def visible_area(s, r, out, info):
    """Zone visible : exactement l'écran, à la position de défilement courante"""
    name = "visible_area"
    url = s.open("article.html")
    time.sleep(0.8)
    s.m.js("window.scrollTo({top: 2600, behavior: 'instant'})")
    time.sleep(0.6)
    vp = s.m.js("return [document.documentElement.clientWidth, document.documentElement.clientHeight, window.scrollY]")
    res = s.convert(url, "visible", {"pageFormat": "single"})
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 72)
    _save(out, res, d)
    p = d["pages"][0]
    r.check(name, "taille = fenêtre", abs(p["w"] - vp[0] * 0.75) < 1 and abs(p["h"] - vp[1] * 0.75) < 1, f"{p['w']}×{p['h']} pt pour {vp}")
    r.check(name, "pas le haut de page", "Le grand test" not in p["text"])
    after = s.m.js("return window.scrollY")
    r.check(name, "position de défilement inchangée", abs(after - vp[2]) < 2, f"{after} vs {vp[2]}")


def element_pick(s, r, out, info):
    """Choisir un élément à la souris (tableau) : seul l'élément est converti"""
    name = "element_pick"
    url = s.open("article.html")
    time.sleep(0.8)
    s.m.js("document.querySelector('table').scrollIntoView({block: 'center', behavior: 'instant'})")
    time.sleep(0.5)
    x, y, w, h = _rect(s.m, "table")

    def pick(m):
        # Survol d'une cellule, puis ↑ trois fois (td → tr → tbody → table) et Entrée.
        _actions(m, _mouse([{"type": "pointerMove", "x": int(x + w / 2), "y": int(y + h / 2), "origin": "viewport", "duration": 50}]))
        time.sleep(0.3)
        for _ in range(3):
            _actions(m, _key(ARROW_UP))
            time.sleep(0.15)
        _actions(m, _key(ENTER))

    res = s.convert(url, "element", {"pageFormat": "single"}, interact=pick)
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 144)
    _save(out, res, d)
    p = d["pages"][0]
    r.check(name, "contenu du tableau présent", "Juillet" in p["text"] and "15 850" in p["text"])
    r.check(name, "rien d'autre", "Le grand test" not in p["text"] and "Conclusion" not in p["text"])
    r.check(name, "taille de l'élément", abs(p["w"] - w * 0.75) < 3 and abs(p["h"] - h * 0.75) < 3, f"{p['w']}×{p['h']} pt pour {w:.0f}×{h:.0f} px")
    r.check(name, "en-tête fixe non superposé", "EN-TÊTE" not in p["text"])


def region_drag(s, r, out, info):
    """Tracer une zone à la souris (autour du graphique canvas)"""
    name = "region_drag"
    url = s.open("article.html")
    time.sleep(0.8)
    s.m.js("document.getElementById('chart').scrollIntoView({block: 'center', behavior: 'instant'})")
    time.sleep(0.5)
    x, y, w, h = _rect(s.m, "#chart")

    def drag(m):
        _actions(
            m,
            _mouse(
                [
                    {"type": "pointerMove", "x": int(x - 10), "y": int(y - 10), "origin": "viewport", "duration": 50},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pointerMove", "x": int(x + w + 10), "y": int(y + h + 10), "origin": "viewport", "duration": 300},
                    {"type": "pointerUp", "button": 0},
                ]
            ),
        )

    res = s.convert(url, "region", {"pageFormat": "single"}, interact=drag)
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 144)
    _save(out, res, d)
    p = d["pages"][0]
    ew, eh = (int(x + w + 10) - int(x - 10)), (int(y + h + 10) - int(y - 10))
    r.check(name, "taille de la zone tracée", abs(p["w"] - ew * 0.75) < 3 and abs(p["h"] - eh * 0.75) < 3, f"{p['w']}×{p['h']} pt pour {ew}×{eh} px")
    r.check(name, "barres du graphique (canvas) visibles", color_present(p["png"], (11, 122, 117)) and color_present(p["png"], (229, 72, 77)))


def dark_a4_margins(s, r, out, info):
    """Thème sombre en A4 avec marges : marges couleur de page, CSS d'impression ignoré"""
    name = "dark_a4_margins"
    url = s.open("dark.html")
    time.sleep(0.8)
    res = s.convert(
        url,
        "full",
        {"pageFormat": "a4", "marginTop": 10, "marginRight": 10, "marginBottom": 10, "marginLeft": 10, "marginColor": "page"},
    )
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 72)
    _save(out, res, d)
    a = np.asarray(Image.open(d["pages"][0]["png"]).convert("RGB")).astype(int)
    corner = a[5, 5]
    r.check(name, "marges sombres comme la page", (np.abs(corner - np.array([18, 20, 26])).sum() < 20), str(corner))
    all_text = "".join(p["text"] for p in d["pages"])
    r.check(name, "contenu présent malgré @media print { display:none }", "Chapitre 24" in all_text)
    r.check(name, "plusieurs pages", d["pageCount"] >= 2, f"{d['pageCount']} pages")
    r.check(name, "aucune ligne coupée", not _cut_lines(d, 28.35, 28.35))


def header_footer(s, r, out, info):
    """En-tête et pied de page (titre, adresse, date, numéro)"""
    name = "header_footer"
    url = s.open("article.html")
    time.sleep(0.8)
    res = s.convert(url, "full", {"pageFormat": "a4", "headerFooter": True})
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 144)
    _save(out, res, d)
    a = np.asarray(Image.open(d["pages"][0]["png"]).convert("L")).astype(int)
    top_band = a[: int(12 / 25.4 * 144), :]
    r.check(name, "texte dessiné dans la marge haute", (top_band < 160).mean() > 0.002)
    bottom = a[-int(12 / 25.4 * 144):, :]
    r.check(name, "texte dessiné dans la marge basse", (bottom < 160).mean() > 0.002)
    r.check(name, "pas de ligne coupée sous l'en-tête", not _cut_lines(d, 34.0, 34.0))


def image_formats(s, r, out, info):
    """Formats d'image : JPEG et sans perte produisent des PDF valides"""
    name = "image_formats"
    url = s.open("article.html")
    time.sleep(0.8)
    sizes = {}
    for fmt in ("jpeg", "lossless"):
        res = s.convert(url, "full", {"pageFormat": "single", "imageFormat": fmt, "pixelRatio": 1})
        if not _ok(r, name, res):
            return _save(out, res)
        d = info(res["path"], 72)
        sizes[fmt] = res["bytes"]
        r.check(name, f"{fmt} : texte et rendu", "FIN DE LA PAGE" in d["pages"][0]["text"] and magenta_ratio(d["pages"][0]["png"]) < 1e-5)
    r.check(name, "tailles cohérentes", all(v > 50_000 for v in sizes.values()), str(sizes))


def cleanup_elements(s, r, out, info):
    """Retirer des éléments avant capture (bulle de chat et en-tête fixe)"""
    name = "cleanup_elements"
    url = s.open("article.html")
    time.sleep(0.8)
    cx, cy, cw, ch = _rect(s.m, ".chat")
    hx, hy, hw, hh = _rect(s.m, "header.site")

    def clean(m):
        _actions(m, _click(cx + cw / 2, cy + ch / 2))
        time.sleep(0.3)
        _actions(m, _click(hx + hw / 2, hy + hh / 2))
        time.sleep(0.3)
        _actions(m, _key(ENTER))

    res = s.convert(url, "full", {"pageFormat": "single", "cleanupBefore": True}, interact=clean)
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 72)
    _save(out, res, d)
    p = d["pages"][0]
    r.check(name, "en-tête retiré", "EN-TÊTE FIXE" not in p["text"])
    r.check(name, "bulle de chat retirée", "CHAT" not in p["text"])
    visible = s.m.js("return getComputedStyle(document.querySelector('.chat')).display")
    r.check(name, "éléments rétablis sur la page après capture", visible != "none", visible)


def restore_state(s, r, out, info):
    """Après capture, la page est rendue intacte (défilement, sélection, styles)"""
    name = "restore_state"
    url = s.open("article.html")
    time.sleep(0.8)
    s.m.js(
        "window.scrollTo({top: 1500, behavior: 'instant'});"
        "const rg = document.createRange(); rg.selectNodeContents(document.getElementById('intro'));"
        "getSelection().removeAllRanges(); getSelection().addRange(rg);"
    )
    time.sleep(0.4)
    before = s.m.js("return [window.scrollY, getSelection().toString().length]")
    res = s.convert(url, "full", {"pageFormat": "single"})
    _ok(r, name, res)
    time.sleep(0.5)
    after = s.m.js(
        "return [window.scrollY, getSelection().toString().length,"
        " document.querySelectorAll('[data-w2p-hide],[data-w2p-unstick],[data-w2p-cv],[data-w2p-removed]').length,"
        " getComputedStyle(document.querySelector('.reveal')).transitionDuration,"
        " getComputedStyle(document.documentElement).scrollBehavior,"
        " document.getElementById('__web2pdf_exact_overlay__') === null]"
    )
    r.check(name, "position de défilement rétablie", abs(after[0] - before[0]) < 2, f"{before[0]} → {after[0]}")
    r.check(name, "sélection rétablie", after[1] == before[1] and before[1] > 0, f"{before[1]} → {after[1]}")
    r.check(name, "aucun attribut résiduel", after[2] == 0, str(after[2]))
    r.check(name, "styles de la page rétablis", "0.8s" in after[3] and after[4] == "smooth", f"{after[3]} / {after[4]}")
    r.check(name, "aucune interface résiduelle", after[5] is True)


def vector_mode(s, r, out, info):
    """Moteur vectoriel : styles d'écran forcés, A4, page restaurée ensuite"""
    name = "vector_mode"
    target = out / "vectoriel.pdf"
    s.mock_file_picker(target)
    url = s.open("dark.html")
    time.sleep(0.8)
    probe = "const rules = document.styleSheets[0].cssRules; return [rules.length, rules[rules.length - 1].media.mediaText];"
    before = s.m.js(probe)
    res = s.convert(url, "full", {"engine": "vector", "pageFormat": "a4"}, timeout=120)
    _save(out, res)
    good = bool(res and res.get("ok") and res.get("vector")) and target.exists()
    r.check(name, "PDF vectoriel enregistré", good, json.dumps(res, ensure_ascii=False)[:300])
    if good:
        d = info(target, 72)
        _save(out, res, d)
        all_text = "".join(p["text"] for p in d["pages"])
        r.check(name, "format A4", abs(d["pages"][0]["w"] - 595.28) < 2, f"{d['pages'][0]['w']:.1f} pt")
        r.check(name, "styles d'écran forcés (@media print neutralisé)", "Chapitre 24" in all_text, f"{len(all_text)} caractères")
    after = s.m.js(probe)
    r.check(name, "règles @media print rétablies", before == after, f"{before} → {after}")


def popup_and_options(s, r, out, info):
    """Interface : popup et page d'options s'affichent correctement"""
    name = "popup_and_options"
    for page, file in (("popup/popup.html", "popup.png"), ("options/options.html", "options.png")):
        handle = s.open_extension_tab(f"moz-extension://{s.ext_uuid}/{page}")
        s.m.switch(handle, focus=True)
        time.sleep(0.8)
        if page.startswith("options"):
            s.m.cmd("WebDriver:SetWindowRect", {"width": 1440, "height": 1000})
        s.screenshot(out / file)
        errors = s.m.js("return document.querySelectorAll('[data-key], [name]').length")
        r.check(name, f"{page} affichée", errors > 5, f"{errors} contrôles")
        credit = s.m.js("return document.querySelector('.credit') && document.querySelector('.credit').textContent")
        r.check(name, f"{page} : mention Wheeloh visible", credit == "Conçu avec l’aide des ressources de Wheeloh", credit)
        s.m.cmd("WebDriver:CloseWindow")
        s.m.switch(s.target, focus=True)


CASES = [
    article_single,
    article_a4_smart,
    app_container,
    dynamic_state,
    huge_page,
    visible_area,
    element_pick,
    region_drag,
    dark_a4_margins,
    header_footer,
    image_formats,
    cleanup_elements,
    restore_state,
    vector_mode,
    popup_and_options,
]


# --- Sites réels (réseau requis) : python3 tests/run_tests.py --real ---------------

REAL_SITES = [
    ("wikipedia", "https://fr.wikipedia.org/wiki/Mozilla_Firefox"),
    ("mdn", "https://developer.mozilla.org/fr/docs/Web/CSS/position"),
    ("github", "https://github.com/mozilla/pdf.js"),
    ("lemonde", "https://www.lemonde.fr/"),
    ("hackernews", "https://news.ycombinator.com/"),
    ("apple", "https://www.apple.com/fr/"),
]


def real_sites(s, r, out, info):
    """Sites réels : conversion pleine page sans erreur, texte et rendu complets"""
    for key, url in REAL_SITES:
        name = f"réel:{key}"
        try:
            s.m.switch(s.target, focus=True)
            s.m.navigate(url)
        except Exception as e:  # noqa: BLE001
            r.check(name, "chargement de la page", False, str(e)[:200])
            continue
        time.sleep(3)
        current = s.m.js("return location.href")
        res = s.convert(current, "full", {"pageFormat": "single"}, timeout=300)
        sub = out / key
        sub.mkdir(exist_ok=True)
        if not (res and res.get("ok") and res.get("path")):
            r.check(name, "conversion réussie", False, json.dumps(res, ensure_ascii=False)[:300])
            continue
        d = pdfinfo_cached = info(res["path"], 36)
        (sub / "result.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
        p = d["pages"][0]
        png = p["png"]
        Image.open(png).save(sub / "apercu.png")
        size = res.get("size") or {}
        r.check(
            name,
            "conversion réussie",
            True,
            f"{size.get('width')}×{size.get('height')} px, {res['bytes'] / 1e6:.1f} Mo, {res.get('elapsed', 0) / 1000:.1f} s {res.get('timings')}",
        )
        r.check(name, "texte sélectionnable", len(p["text"]) > 300, f"{len(p['text'])} caractères")
        r.check(name, "aucune zone non peinte", magenta_ratio(png) < 1e-5)
        del pdfinfo_cached


REAL_CASES = [real_sites]


def seams_scroll_vs_direct(s, r, out, info):
    """Sans raccord : défilement par tranches et rendu direct donnent les mêmes pixels"""
    from pdfimages import stitched

    name = "seams_scroll_vs_direct"
    url = s.open("static.html")
    time.sleep(0.8)
    imgs = {}
    for method in ("scroll", "direct"):
        res = s.convert(url, "full", {"pageFormat": "single", "captureMethod": method, "imageFormat": "lossless"})
        if not _ok(r, name, res):
            return _save(out, res)
        imgs[method] = stitched(res["path"])
        imgs[method].save(out / f"{method}.png")
    a = np.asarray(imgs["scroll"]).astype(int)
    b = np.asarray(imgs["direct"]).astype(int)
    r.check(name, "mêmes dimensions", a.shape == b.shape, f"{a.shape} / {b.shape}")
    if a.shape == b.shape:
        diff = np.abs(a - b).max(axis=2)
        # Tolérance : quelques pixels d'anticrénelage (bords arrondis, dégradés) peuvent
        # varier selon l'origine du rendu ; un raccord, lui, décale des rangées entières.
        bad = np.where((diff > 24).mean(axis=1) > 0.02)[0]
        noisy = int((diff > 24).any(axis=1).sum())
        r.check(name, "aucun raccord entre tranches", len(bad) == 0, f"{len(bad)} rangée(s) décalée(s), {noisy} rangée(s) avec bruit d'anticrénelage sur {a.shape[0]}")


CASES.append(seams_scroll_vs_direct)


def page_zoom(s, r, out, info):
    """Page zoomée à 150 % : mise en page zoomée, netteté conservée"""
    name = "page_zoom"
    url = s.open("article.html")
    time.sleep(0.8)
    res = s.convert(url, "full", {"pageFormat": "single"}, zoom=1.5)
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 72)
    _save(out, res, d)
    p = d["pages"][0]
    size = res.get("size") or {}
    r.check(name, "largeur CSS réduite par le zoom", 780 <= size.get("width", 0) <= 820, str(size))
    from pdfimages import page_images
    tiles = page_images(res["path"])
    tw = max(im.width for _, im in tiles)
    r.check(name, "résolution = écran × zoom (×3)", abs(tw - size.get("width", 0) * 3) <= 3, f"{tw} px pour {size.get('width')} px CSS")
    r.check(name, "texte complet", "FIN DE LA PAGE" in p["text"] and "Conclusion" in p["text"])
    r.check(name, "aucune zone non peinte", magenta_ratio(p["png"]) < 1e-5)


CASES.append(page_zoom)


def tab_switch_pause(s, r, out, info):
    """On quitte l'onglet pendant la capture : pause, puis reprise au retour"""
    name = "tab_switch_pause"
    url = s.open("article.html")
    time.sleep(0.8)

    def leave_and_come_back(m):
        time.sleep(1.0)
        m.switch(s.harness, focus=True)  # l'onglet capturé passe en arrière-plan
        time.sleep(3.0)
        m.switch(s.target, focus=True)

    res = s.convert(url, "full", {"pageFormat": "single"}, interact=leave_and_come_back)
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 72)
    _save(out, res, d)
    text = d["pages"][0]["text"]
    r.check(name, "capture complète après reprise", "FIN DE LA PAGE" in text and "Révélé au défilement n°3" in text)
    r.check(name, "aucune zone non peinte", magenta_ratio(d["pages"][0]["png"]) < 1e-5)


CASES.append(tab_switch_pause)


def copy_text_quality(s, r, out, info):
    """Copier-coller propre : espaces simples dans Aperçu (PDFKit) et dans le lecteur de Zen (pdf.js)"""
    import re
    from pathlib import Path

    name = "copy_text_quality"
    url = s.open("article.html")
    time.sleep(0.8)
    res = s.convert(url, "full", {"pageFormat": "single"})
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 36)
    _save(out, res, d)
    kit = d["pages"][0]["text"]
    phrase = "Un lien externe vers example.org et un lien interne vers la conclusion doivent rester cliquables"
    r.check(name, "PDFKit : phrase exacte, espaces simples", phrase in kit)
    s.m.switch(s.target, focus=True)
    s.m.navigate(Path(res["path"]).as_uri())
    copied = None
    for _ in range(60):
        time.sleep(0.5)
        copied = s.m.js(
            """return (async () => {
              const app = window.PDFViewerApplication;
              if (!app || !app.pdfDocument) return null;
              const page = await app.pdfDocument.getPage(1);
              const tc = await page.getTextContent();
              return tc.items.map((i) => i.str + (i.hasEOL ? '\\n' : '')).join('');
            })()"""
        )
        if copied:
            break
    (out / "pdfjs.txt").write_text(copied or "")
    copied = copied or ""
    r.check(name, "pdf.js : phrase exacte, espaces simples", phrase in copied.replace("\n", " "))
    doubles = [m.group(0) for m in re.finditer(r"\S+ {2,}\S+", copied)]
    r.check(name, "pdf.js : aucun double espace", not doubles, str(doubles[:5]))
    r.check(name, "pdf.js : en-tête lisible", "EN-TÊTE FIXE · Magazine Démo" in copied)


CASES.append(copy_text_quality)


def late_reveal(s, r, out, info):
    """Apparitions tardives (aux 2/3 visibles) à cheval sur les tranches : toutes capturées"""
    name = "late_reveal"
    url = s.open("reveal.html")
    time.sleep(0.8)
    res = s.convert(url, "full", {"pageFormat": "single"})
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 36)
    _save(out, res, d)
    text = d["pages"][0]["text"]
    missing = [i for i in range(1, 25) if f"Apparition tardive {i}" not in text]
    r.check(name, "les 24 blocs dans le calque de texte", not missing, f"manquants : {missing}")
    a = np.asarray(Image.open(d["pages"][0]["png"]).convert("RGB")).astype(int)
    col = a[:, a.shape[1] // 2, :]
    sat = col.max(axis=1) - col.min(axis=1)
    blocks = int(((sat[1:] > 60) & (sat[:-1] <= 60)).sum())
    r.check(name, "les 24 blocs visibles dans l'image", blocks >= 24, f"{blocks} blocs colorés détectés")


def virtual_list(s, r, out, info):
    """Liste virtualisée (seules les lignes à l'écran existent) : 300 lignes, texte synchrone"""
    name = "virtual_list"
    url = s.open("virtual.html")
    time.sleep(0.8)
    res = s.convert(url, "full", {"pageFormat": "single"})
    if not _ok(r, name, res):
        return _save(out, res)
    d = info(res["path"], 36)
    _save(out, res, d)
    text = d["pages"][0]["text"]
    missing = [i for i in range(1, 301) if f"Ligne virtuelle {i} sur 300" not in text]
    r.check(name, "les 300 lignes dans le calque de texte", not missing, f"{len(missing)} manquantes, ex. {missing[:8]}")
    counts = [text.count(f"Ligne virtuelle {i} sur 300") for i in (1, 150, 300)]
    r.check(name, "aucune ligne en double", counts == [1, 1, 1], str(counts))
    lines = d["pages"][0]["lines"]
    ys = {}
    for x, y, w, h, t in lines:
        if t.startswith("Ligne virtuelle "):
            n = int(t.split()[2])
            ys[n] = y
    ordered = all(ys[a] > ys[b] for a, b in zip(range(1, 300), range(2, 301)) if a in ys and b in ys)
    r.check(name, "texte aligné sur l'image (ordre et pas de 56 px)", ordered and abs((ys.get(1, 0) - ys.get(2, 0)) - 42) < 1.5, f"écart {ys.get(1, 0) - ys.get(2, 0):.1f} pt")


CASES.extend([late_reveal, virtual_list])


def open_in_tab(s, r, out, info):
    """Après conversion : le PDF s'ouvre dans un onglet (lecteur intégré)"""
    name = "open_in_tab"
    url = s.open("dynamic.html")
    time.sleep(1.0)
    before = set(s.m.handles())
    res = s.convert(url, "full", {"pageFormat": "single", "afterAction": "open"})
    ok = bool(res and res.get("ok") and res.get("blobUrl") and res.get("downloadId") is None)
    r.check(name, "conversion sans téléchargement", ok, json.dumps(res, ensure_ascii=False)[:200])
    new = [h for h in s.m.handles() if h not in before]
    pages = None
    for h in new:
        s.m.switch(h, focus=False)
        for _ in range(40):
            time.sleep(0.25)
            pages = s.m.js("return window.PDFViewerApplication && window.PDFViewerApplication.pdfDocument ? window.PDFViewerApplication.pdfDocument.numPages : null")
            if pages:
                break
        s.m.cmd("WebDriver:CloseWindow")
    s.m.switch(s.target, focus=True)
    r.check(name, "onglet ouvert sur le PDF (lecteur de Zen)", bool(new) and pages == 1, f"{len(new)} onglet(s), pages={pages}")


def cancel_escape(s, r, out, info):
    """Échap pendant la capture : arrêt propre, aucun PDF, page rendue intacte"""
    name = "cancel_escape"
    url = s.open("huge.html")
    time.sleep(0.8)
    s.m.js("window.scrollTo({top: 3000, behavior: 'instant'})")
    time.sleep(0.3)

    def press_escape(m):
        time.sleep(1.0)
        _actions(m, _key(chr(0xE00C)))

    res = s.convert(url, "full", {"pageFormat": "single"}, interact=press_escape)
    r.check(name, "tâche annulée", bool(res and res.get("cancelled")), json.dumps(res, ensure_ascii=False)[:200])
    time.sleep(0.5)
    state = s.m.js(
        "return [window.scrollY, document.querySelectorAll('[data-w2p-hide],[data-w2p-unstick],[data-w2p-cv]').length,"
        " getComputedStyle(document.documentElement).scrollBehavior]"
    )
    r.check(name, "page restaurée", abs(state[0] - 3000) < 2 and state[1] == 0, str(state))


CASES.extend([open_in_tab, cancel_escape])
