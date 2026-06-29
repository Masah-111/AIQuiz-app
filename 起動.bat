:<<'BATCH'
@echo off
chcp 65001 >nul
title AIQuiz Launcher
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
if errorlevel 1 ( echo. & echo Failed to launch. Press any key to close. & pause >nul )
exit /b
BATCH
# ===========================================================================
#  AIQuiz launcher (cross-OS polyglot: one file for Windows / macOS / Linux)
#   - Windows : double-click this file (.bat) -> runs server.ps1 (PowerShell)
#   - macOS   : rename a copy to "kido.command" and double-click,
#               OR run in Terminal:   bash "kido.bat"
#   - Linux   : run in a terminal:    bash "kido.bat"
#  The section below (macOS/Linux) serves this folder over http://localhost
#  using whatever is installed (python3 -> python -> ruby -> php),
#  then opens the app in your default browser. Keep the window open while using.
# ===========================================================================
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

cd "$(dirname "$0")" || exit 1
HTML="$(ls -1 *.html 2>/dev/null | head -n1)"

PORT=8000
for i in $(seq 1 50); do
  if ! (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then break; fi
  PORT=$((PORT + 1))
done

URLPATH=""
START=()
if command -v python3 >/dev/null 2>&1; then
  [ -n "$HTML" ] && URLPATH="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$HTML")"
  START=(python3 -m http.server "$PORT")
elif command -v python >/dev/null 2>&1 && python -c 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)' 2>/dev/null; then
  [ -n "$HTML" ] && URLPATH="$(python -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$HTML")"
  START=(python -m http.server "$PORT")
elif command -v ruby >/dev/null 2>&1; then
  [ -n "$HTML" ] && URLPATH="$(ruby -ruri -e 'print URI.encode_www_form_component(ARGV[0]).gsub("+", "%20")' "$HTML")"
  START=(ruby -run -e httpd . -p "$PORT")
elif command -v php >/dev/null 2>&1; then
  [ -n "$HTML" ] && URLPATH="$(php -r 'echo rawurlencode($argv[1]);' "$HTML")"
  START=(php -S "localhost:$PORT")
else
  echo ""
  echo "  No local server runtime found (need python3, ruby, or php)."
  echo "  Tip: open the .html directly and use the in-app Connection Test."
  echo ""
  read -r -p "  Press Enter to close..."
  exit 1
fi

URL="http://localhost:$PORT/$URLPATH"

if command -v open >/dev/null 2>&1; then
  OPEN="open"
elif command -v xdg-open >/dev/null 2>&1; then
  OPEN="xdg-open"
else
  OPEN=""
fi

echo ""
echo "  ===================================================="
echo "   AIQuiz is now running on a local server"
echo "   URL: $URL"
echo "  ===================================================="
echo ""
echo "  * Keep this window OPEN while you use the app."
echo "  * Close this window (or press Ctrl+C) to stop."
echo ""

"${START[@]}" &
SRV=$!
sleep 1
if [ -n "$OPEN" ]; then
  "$OPEN" "$URL" >/dev/null 2>&1
else
  echo "  Open this URL in your browser manually: $URL"
fi
wait "$SRV"