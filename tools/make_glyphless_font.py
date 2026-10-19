"""Génère la police « GlyphLess » (glyphes vides, chasse fixe 500/1000)
utilisée pour le calque de texte invisible du PDF, et l'écrit en base64
dans lib/glyphless-font.js. Usage : python3 tools/make_glyphless_font.py"""
import base64, io, pathlib
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder([".notdef", "blank"])
fb.setupCharacterMap({0x20: "blank"})
empty = TTGlyphPen(None).glyph()
fb.setupGlyf({".notdef": empty, "blank": empty})
fb.setupHorizontalMetrics({".notdef": (500, 0), "blank": (500, 0)})
# Descendante non nulle : sinon CoreGraphics (macOS) rejette la police et le texte
# devient introuvable dans Aperçu/PDFKit.
fb.setupHorizontalHeader(ascent=1000, descent=-1)
fb.setupNameTable({"familyName": "GlyphLessFont", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=1000, sTypoDescender=-1, sTypoLineGap=0,
            usWinAscent=1000, usWinDescent=1, fsType=0)
fb.setupPost()
buf = io.BytesIO()
fb.save(buf)
data = buf.getvalue()
root = pathlib.Path(__file__).resolve().parent.parent
out = root / "lib" / "glyphless-font.js"
out.parent.mkdir(exist_ok=True)
out.write_text(
    "'use strict';\n"
    "// Police TrueType minimale (glyphes vides, chasse 500/1000) pour le calque\n"
    "// de texte invisible. Générée par tools/make_glyphless_font.py.\n"
    "var W2P = globalThis.W2P || (globalThis.W2P = {});\n"
    f"W2P.GLYPHLESS_TTF_B64 = '{base64.b64encode(data).decode()}';\n"
)
print(len(data), "octets ->", out)
