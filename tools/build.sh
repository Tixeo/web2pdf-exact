#!/bin/sh
# Construit dist/web2pdf-exact-<version>.xpi (archive installable dans Zen / Firefox).
# Usage : sh tools/build.sh
set -eu
cd "$(dirname "$0")/.."
version=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
out="dist/web2pdf-exact-$version.xpi"
mkdir -p dist
rm -f "$out"
zip -q -r -X -9 "$out" manifest.json _locales background content lib popup options icons -x '*.DS_Store'
echo "$out ($(du -h "$out" | cut -f1))"
