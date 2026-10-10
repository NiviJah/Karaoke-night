#!/bin/sh
# The songs folder is chosen on the TV screen the first time you run it (press S on the TV to change it later).
# Optional: to force a folder from here instead, remove the "# " from the next line and edit the path.
# export SONG_DIR="/Volumes/KARAOKE"
export PORT=8080
cd "$(dirname "$0")"
node server.js
