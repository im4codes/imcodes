#!/bin/sh
# pipe-writer.sh — helper for tmux pipe-pane
# Receives exactly one argument: the FIFO path to write to.
# Path is validated by the daemon against a strict character whitelist
# before this script is invoked. Do not modify the argument handling.
exec cat > "$1"
