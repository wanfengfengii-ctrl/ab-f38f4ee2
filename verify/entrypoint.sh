#!/bin/sh
# One-shot verification entrypoint: unit tests, build check, live HTTP smoke.
# Exits non-zero (failing the compose service) if anything fails.
set -eu

echo "==> [verify] running unit tests"
python -m pytest -q tests

echo "==> [verify] running build check and HTTP smoke"
exec python verify/run.py
