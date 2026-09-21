#!/usr/bin/env bash
# Build the frontend and package dist/ as build.zip, ready to upload to
# cPanel. Run from anywhere:  ./frontend/build-and-zip.sh
#
# The zip holds the files at the TOP level (index.html, assets/, .htaccess
# -- not a dist/ folder), so extracting it inside the document root puts
# everything exactly where the web server expects it.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Building (tsc -b && vite build)"
npm run build

echo "==> Packaging dist/ -> build.zip"
find dist -name '.DS_Store' -delete 2>/dev/null || true
rm -f build.zip
( cd dist && zip -r -q -X ../build.zip . )

echo
echo "==> Result"
ls -lh build.zip
unzip -l build.zip

js_count=$(ls dist/assets/*.js 2>/dev/null | wc -l | tr -d ' ')
echo
if [ "$js_count" -ge 2 ]; then
  echo "OK: $js_count JS files -- ExcelJS is split into its own chunk."
else
  echo "NOTE: only $js_count JS file -- ExcelJS was NOT split out."
fi

if unzip -l build.zip | grep -q '\.htaccess'; then
  echo "OK: .htaccess is in the zip (hidden in cPanel File Manager -- enable Show Hidden Files)."
else
  echo "WARNING: .htaccess missing -- sub-page refreshes will 404."
fi
