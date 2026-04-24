#!/usr/bin/env bash
# verify-build.sh — F25 reproducible-build helper.
#
# Computes SHA-256 hashes of the shipped Claude Meter assets in your local
# checkout, in the same order the GitHub Action does. Pipe / diff this against
# the artifact `build-hashes.txt` from the matching commit on GitHub Actions:
#
#   gh run download <run-id> -n build-hashes-<sha>
#   diff <(./scripts/verify-build.sh --plain) build-hashes.txt
#
# Exits 0 on a clean checkout where every listed file exists and is readable.
# Exits 2 on missing files. Exits 3 if no SHA-256 tool is available.

set -euo pipefail

PLAIN=0
if [ "${1:-}" = "--plain" ]; then PLAIN=1; fi

# Resolve repo root regardless of caller cwd.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FILES=(
  "index.html"
  "src/vendor/chart.umd.min.js"
  "src/vendor/chart.umd.min.js.sha256"
)

# Verify every file exists.
missing=0
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "missing: $f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "verify-build: refusing to hash with missing files" >&2
  exit 2
fi

# Pick a SHA-256 implementation that emits the same `<hash>  <path>` format
# `sha256sum` does. Both `sha256sum` (GNU coreutils) and `shasum -a 256`
# (BSD / macOS) qualify.
hash_cmd=""
if command -v sha256sum >/dev/null 2>&1; then
  hash_cmd="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  hash_cmd="shasum -a 256"
else
  echo "verify-build: need sha256sum or shasum on PATH" >&2
  exit 3
fi

if [ "$PLAIN" -eq 0 ]; then
  echo "# Reproducible-build manifest (local)"
  echo "# repo root: $ROOT"
  if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
    echo "# commit:    $(git rev-parse HEAD)"
    echo "# branch:    $(git rev-parse --abbrev-ref HEAD)"
  fi
  echo "# date:      $(date -u +%FT%TZ)"
  echo
fi

# shellcheck disable=SC2086
$hash_cmd "${FILES[@]}"
