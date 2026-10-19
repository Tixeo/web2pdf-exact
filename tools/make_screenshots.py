"""Génère les captures d'écran de la fiche addons.mozilla.org (1280 × 800) dans
store/screenshots/, en pilotant Zen (ou Firefox) sans interface sur un profil jetable.
Usage : python3 tools/make_screenshots.py [--binary CHEMIN]"""

import argparse
import base64
import io
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from run_tests import Session  # noqa: E402

W, H = 1280, 800


def shot(s, full=False):
    data = s.m.cmd("WebDriver:TakeScreenshot", {"full": full, "hash": False})["value"]
    return Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB")


def fit(im):
    """Mise à l'échelle sur 1280 de large, puis recadrage ou complément à 800 de haut."""
    im = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)
    if im.height >= H:
        return im.crop((0, 0, W, H))
    out = Image.new("RGB", (W, H), im.getpixel((0, im.height - 1)))
    out.paste(im, (0, 0))
    return out


def with_shadow(base, card, x, y, radius=18):
    mask = Image.new("L", card.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, card.width - 1, card.height - 1], radius, fill=255)
    shadow = Image.new("RGBA", (card.width + 80, card.height + 80), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([40, 48, card.width + 40, card.height + 48], radius, fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    base = base.convert("RGBA")
    base.alpha_composite(shadow, (x - 40, y - 40))
    base.paste(card, (x, y), mask)
    return base.convert("RGB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", default="/Applications/Zen.app/Contents/MacOS/zen")
    args = ap.parse_args()
    out = ROOT / "store" / "screenshots"
    out.mkdir(parents=True, exist_ok=True)
    s = Session(Path(tempfile.mkdtemp(prefix="w2p-shots-")), args.binary, port=2840, http_port=8770)
    try:
        s.m.cmd("WebDriver:SetWindowRect", {"width": 1520, "height": 1000})
        url = s.open("demo.html")
        time.sleep(1.5)
        page = fit(shot(s))

        # 1. La popup ouverte au-dessus de la page.
        handle = s.open_extension_tab(f"moz-extension://{s.ext_uuid}/popup/popup.html")
        s.m.switch(handle, focus=True)
        time.sleep(0.8)
        size = s.m.js("const r = document.body.getBoundingClientRect(); return [r.width, r.height, devicePixelRatio];")
        popup = shot(s).crop((0, 0, round(size[0] * size[2]), round(size[1] * size[2])))
        popup = popup.resize((round(popup.width * 0.5), round(popup.height * 0.5)), Image.LANCZOS)
        s.m.cmd("WebDriver:CloseWindow")
        s.m.switch(s.target, focus=True)
        with_shadow(page, popup, W - popup.width - 40, 24).save(out / "1-popup.png")

        # 2. Le sélecteur d'élément dans la page.
        s.m.js("document.querySelector('table').scrollIntoView({block: 'center', behavior: 'instant'})")
        time.sleep(0.4)
        rect = s.m.js("const r = document.querySelector('table').getBoundingClientRect(); return [r.left, r.top, r.width, r.height];")
        s.m.switch(s.harness, focus=False)
        s.m.js("window.postMessage(arguments[0], '*')", [{"type": "w2p-test", "url": url, "scope": "element", "overrides": {}}])
        s.m.switch(s.target, focus=False)
        time.sleep(1.5)
        s.m.cmd("WebDriver:PerformActions", {"actions": [{"type": "pointer", "id": "m", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "x": int(rect[0] + rect[2] / 2), "y": int(rect[1] + rect[3] / 2), "origin": "viewport"}]}]})
        for _ in range(3):
            s.m.cmd("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "k", "actions": [
                {"type": "keyDown", "value": chr(0xE013)}, {"type": "keyUp", "value": chr(0xE013)}]}]})
            time.sleep(0.2)
        time.sleep(0.4)
        fit(shot(s)).save(out / "2-element-picker.png")
        s.m.cmd("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "k", "actions": [
            {"type": "keyDown", "value": chr(0xE00C)}, {"type": "keyUp", "value": chr(0xE00C)}]}]})
        s.m.cmd("WebDriver:ReleaseActions")
        time.sleep(1.5)

        # 3. Le PDF obtenu, ouvert dans le lecteur intégré, à côté de la page d'origine.
        s.open("demo.html")
        time.sleep(1.0)
        res = s.convert(url, "full", {"pageFormat": "single"})
        s.m.navigate(Path(res["path"]).as_uri())
        time.sleep(3.0)
        viewer = fit(shot(s))
        canvas = Image.new("RGB", (W, H), (236, 238, 243))
        d = ImageDraw.Draw(canvas)
        half = (W // 2 - 30, round((W // 2 - 30) * H / W))
        canvas.paste(page.resize(half, Image.LANCZOS), (20, 150))
        canvas.paste(viewer.resize(half, Image.LANCZOS), (W // 2 + 10, 150))
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 26)
        small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 19)
        d.text((20, 40), "The PDF is the page, pixel for pixel", fill=(22, 24, 29), font=font)
        d.text((20, 118), "Web page", fill=(80, 86, 100), font=small)
        d.text((W // 2 + 10, 118), "PDF in Firefox's viewer (selectable text, links, bookmarks)", fill=(80, 86, 100), font=small)
        canvas.save(out / "3-page-and-pdf.png")

        # 4. La page d'options.
        handle = s.open_extension_tab(f"moz-extension://{s.ext_uuid}/options/options.html")
        s.m.switch(handle, focus=True)
        time.sleep(1.0)
        fit(shot(s)).save(out / "4-settings.png")
        s.m.cmd("WebDriver:CloseWindow")
    finally:
        s.close()
    for p in sorted(out.glob("*.png")):
        print(p.relative_to(ROOT), Image.open(p).size)


if __name__ == "__main__":
    main()
