#!/bin/zsh
# Double-click this file in Finder to start ForgeLink.
# Keep the Terminal window open while you use the app.
cd "$(dirname "$0")"
echo "Starting ForgeLink at http://localhost:3000 ..."
echo "Keep this window open. Press Ctrl+C to stop the server."
sleep 1
open "http://localhost:3000"
exec node server.js
