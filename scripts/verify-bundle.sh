#!/usr/bin/env bash
#
# Real bundle-install smoke test.
#
# `check:bundle` proves the *metadata* is bundle-shaped. This proves the thing
# users actually do: pack the tarball, install it into a throwaway profile with
# `dsh plugin add`, and watch the host boot with the plugin active — without
# anyone editing `cordis.patch.yml` by hand.
#
# Everything runs against a temporary `DSH_HOME`; the real profiles are never
# touched, and no Figma token is read (activation does not need one).
#
# Usage:
#   bash scripts/verify-bundle.sh
#   DSH="npx --yes @deepseek-ai/dsh@0.2.1-rc.2" bash scripts/verify-bundle.sh
#
# The `DSH` override is how the same tarball is smoke-tested on another host
# version; it may contain arguments (it is word-split on purpose).
#
# Requires: pnpm on PATH for the plugin manager, and registry access for the
# profile's base bundles.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_NAME="bundle-smoke"
ACTIVATION='[figma-mcp-dsh] active — registered figma_capabilities, figma_call'
TMP="$(mktemp -d)"
PID=""

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- pick a host
if [ -n "${DSH:-}" ]; then
  # shellcheck disable=SC2206  # deliberate: the override carries arguments
  DSH_CMD=(${DSH})
elif command -v dsh >/dev/null 2>&1; then
  DSH_CMD=("$(command -v dsh)")
elif [ -x "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" ]; then
  DSH_CMD=("/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh")
else
  DSH_CMD=(npx --yes @deepseek-ai/dsh@0.2.1-rc.2)
fi

echo "==> host: ${DSH_CMD[*]}"
if ! "${DSH_CMD[@]}" --version >"$TMP/host-version.txt" 2>&1; then
  echo "FAIL: cannot run the host: ${DSH_CMD[*]}" >&2
  sed 's/^/  | /' "$TMP/host-version.txt" >&2
  exit 1
fi
HOST_VERSION="$(tail -1 "$TMP/host-version.txt")"
echo "    version: $HOST_VERSION"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "FAIL: the plugin manager needs pnpm on PATH (install it: npm i -g pnpm)" >&2
  exit 1
fi

# -------------------------------------------------------------------- pack it
echo "==> packing"
( cd "$REPO_ROOT" && npm pack --pack-destination "$TMP" >"$TMP/pack.log" 2>&1 )
TARBALL="$(find "$TMP" -maxdepth 1 -name '*.tgz' | head -1)"
if [ ! -f "$TARBALL" ]; then
  echo "FAIL: npm pack produced no tarball" >&2
  sed 's/^/  | /' "$TMP/pack.log" >&2
  exit 1
fi
echo "    $(basename "$TARBALL")"

# ------------------------------------------------------- throwaway DSH home
echo "==> preparing a temporary DSH_HOME"
DSH_HOME="$TMP/home"
export DSH_HOME
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
mkdir -p "$DSH_HOME/profiles"

if [ -d "$HOME/.dsh/profiles/desktop" ]; then
  cp -R "$HOME/.dsh/profiles/desktop" "$PROFILE_DIR"
  rm -rf "$PROFILE_DIR/node_modules" "$PROFILE_DIR/pnpm-lock.yaml"
  echo "    copied ~/.dsh/profiles/desktop (node_modules dropped)"
else
  mkdir -p "$PROFILE_DIR"
  cat >"$PROFILE_DIR/package.json" <<'JSON'
{
  "name": "dsh-profile-bundle-smoke",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
JSON
  cat >"$PROFILE_DIR/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
YAML
  : >"$PROFILE_DIR/cordis.yml"
  : >"$PROFILE_DIR/cordis.patch.yml"
  echo "    wrote a minimal profile"
fi

# The whole point is the automatic mount: a copied profile that already inserts
# the plugin would prove nothing.
if grep -qE "^[[:space:]]*-[[:space:]]+id:[[:space:]]*figma[[:space:]]*$" "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null; then
  echo "FAIL: the copied profile already has a figma row; the auto-mount would be untested" >&2
  exit 1
fi

# ------------------------------------------------------------------- install
echo "==> dsh plugin add <tarball>"
if ! "${DSH_CMD[@]}" plugin --profile "$PROFILE_NAME" add "$TARBALL" >"$TMP/install.log" 2>&1; then
  echo "FAIL: 'dsh plugin add' failed" >&2
  sed 's/^/  | /' "$TMP/install.log" >&2
  if grep -qi "pnpm" "$TMP/install.log"; then
    echo "hint: the plugin manager shells out to pnpm; install it: npm i -g pnpm" >&2
  fi
  exit 1
fi

node --input-type=module -e "
import { readFileSync } from 'node:fs'
const manifest = JSON.parse(readFileSync(process.argv[1], 'utf8'))
const bundles = manifest?.dsh?.profile?.bundles
if (!Array.isArray(bundles) || !bundles.includes('figma-mcp-dsh')) {
  console.error('FAIL: figma-mcp-dsh was not selected into dsh.profile.bundles: ' + JSON.stringify(bundles))
  process.exit(1)
}
console.log('  ✅ dsh.profile.bundles contains figma-mcp-dsh')
" "$PROFILE_DIR/package.json"

if grep -qE "^[[:space:]]*-[[:space:]]+id:[[:space:]]*figma[[:space:]]*$" "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null; then
  echo "FAIL: a hand-written figma row appeared in cordis.patch.yml; the mount was not automatic" >&2
  exit 1
fi
echo "  ✅ cordis.patch.yml still has no hand-written figma row"

# ---------------------------------------------------------------------- boot
echo "==> booting the profile (waiting up to 45s for activation)"
LOG="$TMP/boot.log"
"${DSH_CMD[@]}" --profile "$PROFILE_NAME" --no-open --port 0 >"$LOG" 2>&1 &
PID=$!

FOUND=0
for _ in $(seq 1 45); do
  if grep -qF "$ACTIVATION" "$LOG" 2>/dev/null; then
    FOUND=1
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    break # the host died; fall through to the failure path with its log
  fi
  sleep 1
done

if [ "$FOUND" -ne 1 ]; then
  echo "FAIL: no activation line within 45s" >&2
  tail -40 "$LOG" | sed 's/^/  | /' >&2
  exit 1
fi
grep -F "$ACTIVATION" "$LOG" | head -1 | sed 's/^/    /'

if grep -qE "ERR_MODULE_NOT_FOUND|Cannot find package|Failed to load" "$LOG"; then
  echo "FAIL: the host logged a load error" >&2
  grep -E "ERR_MODULE_NOT_FOUND|Cannot find package|Failed to load" "$LOG" | head -5 | sed 's/^/  | /' >&2
  exit 1
fi
echo "  ✅ both tools registered, no load errors"

echo
echo "BUNDLE INSTALL OK — figma-mcp-dsh installs as a bundle and self-mounts on $HOST_VERSION"
