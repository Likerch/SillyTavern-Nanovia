#!/usr/bin/env sh
# Installs the Nanovia server plugin into a SillyTavern folder (Linux/macOS, also a Docker host).
# Usage: ./scripts/install-server.sh /path/to/SillyTavern        (or the folder that holds the mounted plugins/)
# Then set enableServerPlugins: true in config.yaml (or env SILLYTAVERN_ENABLESERVERPLUGINS=true) and restart SillyTavern.
set -eu

ST_DIR="${1:?usage: install-server.sh <SillyTavern dir>}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/server"
TARGET="$ST_DIR/plugins/nanovia"

if [ ! -d "$ST_DIR/plugins" ] && [ ! -f "$ST_DIR/server.js" ]; then
    echo "Not a SillyTavern folder (no plugins/ or server.js): $ST_DIR" >&2
    exit 1
fi
if [ ! -f "$SRC/index.js" ]; then
    echo "server/index.js is missing: run 'npm run build:server' first" >&2
    exit 1
fi
if [ -d "$TARGET/.git" ]; then
    echo "$TARGET is a git checkout; update it with git instead." >&2
    exit 1
fi

mkdir -p "$TARGET"
# Keep the installed config.json (port, upstream) and data/ (usage log); copy only the two files the plugin needs.
find "$TARGET" -mindepth 1 -maxdepth 1 ! -name config.json ! -name data -exec rm -rf {} +
cp "$SRC/index.js" "$SRC/package.json" "$TARGET/"

echo "Nanovia plugin installed to $TARGET"
echo "Make sure enableServerPlugins: true is set in config.yaml (or env SILLYTAVERN_ENABLESERVERPLUGINS=true), then restart SillyTavern."
echo "The proxy port (default 8787) is local to the machine or container; do not publish it."
