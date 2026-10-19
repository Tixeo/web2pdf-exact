"""Reconstitue l'image d'une page de PDF Web2PDF à partir de ses tuiles (pixels
d'origine, sans rééchantillonnage) : JPEG tel quel, Flate+prédicteur via un PNG."""
import re
import struct
import zlib
from io import BytesIO

from PIL import Image


def _png(w, h, idat):
    def chunk(t, data):
        c = zlib.crc32(t + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + t + data + struct.pack(">I", c)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def page_images(path):
    data = open(path, "rb").read()
    objs = {int(m.group(1)): m.start() for m in re.finditer(rb"(\d+) 0 obj\n", data)}
    out = []
    for num, at in sorted(objs.items()):
        head = data[at: at + 600]
        if b"/Subtype/Image" not in head:
            continue
        w = int(re.search(rb"/Width (\d+)", head).group(1))
        h = int(re.search(rb"/Height (\d+)", head).group(1))
        n = int(re.search(rb"/Length (\d+)", head).group(1))
        start = data.index(b"stream\n", at) + 7
        raw = data[start: start + n]
        if b"/DCTDecode" in head:
            im = Image.open(BytesIO(raw)).convert("RGB")
        else:
            im = Image.open(BytesIO(_png(w, h, raw))).convert("RGB")
        out.append((num, im))
    return out


def stitched(path):
    """Empile les tuiles (ordre d'écriture) en retirant le pixel de recouvrement."""
    tiles = [im for _, im in page_images(path)]
    tiles = [t for t in tiles if t.width == max(x.width for x in tiles)]
    H = sum(t.height for t in tiles) - (len(tiles) - 1)
    canvas = Image.new("RGB", (tiles[0].width, H))
    y = 0
    for t in tiles:
        canvas.paste(t, (0, y))
        y += t.height - 1
    return canvas
