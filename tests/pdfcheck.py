"""Validation structurelle stricte d'un PDF produit par Web2PDF : en-tête, table
xref (décalages exacts), longueurs des flux, trailer et fin de fichier."""
import re
import sys


def check(path):
    data = open(path, "rb").read()
    errors = []
    if not data.startswith(b"%PDF-1.7\n"):
        errors.append("en-tête %PDF-1.7 absent")
    if not data.rstrip().endswith(b"%%EOF"):
        errors.append("%%EOF final absent")
    m = re.search(rb"startxref\n(\d+)\n%%EOF\s*$", data)
    if not m:
        return errors + ["startxref introuvable"]
    xref_at = int(m.group(1))
    if not data[xref_at:].startswith(b"xref\n"):
        return errors + [f"startxref ({xref_at}) ne pointe pas sur la table xref"]
    head = re.match(rb"xref\n0 (\d+)\n", data[xref_at:])
    count = int(head.group(1))
    pos = xref_at + head.end()
    for i in range(count):
        entry = data[pos + 20 * i: pos + 20 * (i + 1)]
        if len(entry) != 20 or not re.match(rb"\d{10} \d{5} [nf] \n", entry):
            errors.append(f"entrée xref {i} mal formée : {entry!r}")
            continue
        off, kind = int(entry[:10]), entry[17:18]
        if i == 0 or kind == b"f":
            continue
        if not data[off:].startswith(f"{i} 0 obj\n".encode()):
            errors.append(f"objet {i} : décalage {off} incorrect")
    trailer = data[pos + 20 * count:]
    if not trailer.startswith(b"trailer\n"):
        errors.append("trailer absent après la table xref")
    sm = re.search(rb"/Size (\d+)", trailer)
    if not sm or int(sm.group(1)) != count:
        errors.append("/Size du trailer incohérent")
    for sm in re.finditer(rb"/Length (\d+)>>\nstream\n", data):
        n = int(sm.group(1))
        end = sm.end() + n
        if data[end: end + 10] != b"\nendstream":
            errors.append(f"flux à {sm.start()} : /Length {n} incorrect")
            break
    return errors


if __name__ == "__main__":
    bad = 0
    for p in sys.argv[1:]:
        errs = check(p)
        bad += bool(errs)
        print(("OK   " if not errs else "ERR  ") + p + ("" if not errs else " : " + "; ".join(errs[:3])))
    sys.exit(1 if bad else 0)
