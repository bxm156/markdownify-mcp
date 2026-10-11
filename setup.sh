#!/bin/bash
# Run by preinstall.js on macOS and Linux: creates the project's .venv with
# the pinned markitdown. Any failing step stops the script with a non-zero
# exit, which fails `bun install` instead of leaving a half-built .venv.
set -euo pipefail

echo 'prepare Unix preinstall'
echo 'Installing Python dependencies for OCR...'
python3 -m venv .venv
.venv/bin/pip install "markitdown[all]==0.1.5"
echo 'Finished installing Python dependencies'
