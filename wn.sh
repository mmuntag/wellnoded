#!/usr/bin/env bash
# Start a wellnoded server on ~/Nextcloud/2026_wellnoded.md. Extra args are passed through.
exec python3 "$(dirname "$(readlink -f "$0")")/server.py" --file "$HOME/Nextcloud/2026_wellnoded.md" "$@"
