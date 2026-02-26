#!/usr/bin/env bash
# =============================================================================
# setup.sh — Build contracts and start the Canton sandbox (DPM-native)
#
# Usage:
#   ./scripts/setup.sh
#
# What this does:
#   1. Builds the Daml contracts with `dpm build`
#   2. Starts the Canton sandbox using `dpm sandbox` with the JSON Ledger
#      API v2 enabled on http://localhost:7575
#   3. Allocates parties Alice, Bob, and Operator via the HTTP API
#      (no Setup.daml needed — parties are created with a simple POST)
#   4. Prints instructions for the next step
#
# Prerequisites:
#   - dpm installed (https://docs.digitalasset.com/build/3.4/dpm/dpm.html)
#
# Once the sandbox is running, open a second terminal and run:
#   cd ts-client && pnpm setup:env
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(realpath "$SCRIPT_DIR/../../daml-contracts/contracts")"
DAR_FILE="$CONTRACTS_DIR/.daml/dist/asset-swap-contracts-0.1.0.dar"

JSON_API_URL="${LEDGER_JSON_API_URL:-http://localhost:7575}"
LEDGER_PORT="${LEDGER_PORT:-6865}"
POLL_INTERVAL=2

# ─── Pre-flight checks ───────────────────────────────────────────────────────

if ! command -v dpm &> /dev/null; then
  echo "❌  'dpm' not found."
  echo "    Install it from: https://docs.digitalasset.com/build/3.4/dpm/dpm.html"
  exit 1
fi

if [ ! -d "$CONTRACTS_DIR" ]; then
  echo "❌  Contracts directory not found: $CONTRACTS_DIR"
  exit 1
fi

# ─── Banner ──────────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════╗"
echo "║      Canton Asset Swap — Sandbox Setup           ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Build contracts ─────────────────────────────────────────────────

echo "▶  Building Daml contracts..."
echo "   (source: $CONTRACTS_DIR)"
echo ""

cd "$CONTRACTS_DIR"
dpm build

echo ""
echo "✅  Build complete → $DAR_FILE"
echo ""

# ─── Step 2: Start the Canton sandbox ────────────────────────────────────────

echo "▶  Starting Canton sandbox..."
echo "   JSON Ledger API v2: $JSON_API_URL"
echo "   gRPC Ledger API:    localhost:$LEDGER_PORT"
echo ""

dpm sandbox \
  --json-api-port 7575 \
  --ledger-api-port "$LEDGER_PORT" \
  --dar "$DAR_FILE" &
SANDBOX_PID=$!

echo "   Sandbox PID: $SANDBOX_PID"
echo ""

# ─── Step 3: Wait for the JSON API ───────────────────────────────────────────

echo "⏳  Waiting for the JSON Ledger API..."
echo "   (health check: $JSON_API_URL/docs/openapi — no auth required)"
echo ""

# /docs/openapi is always accessible without authentication in sandbox mode
until curl -s --connect-timeout 2 "$JSON_API_URL/docs/openapi" > /dev/null 2>&1; do
  if ! kill -0 "$SANDBOX_PID" 2>/dev/null; then
    echo ""
    echo "❌  Sandbox process exited unexpectedly (PID $SANDBOX_PID)."
    echo "    Check the output above for errors."
    exit 1
  fi
  sleep "$POLL_INTERVAL"
  printf "."
done

echo ""
echo ""
echo "✅  Canton sandbox is ready!"
echo ""

# ─── Step 4: Allocate parties via HTTP API ───────────────────────────────────

echo "▶  Allocating parties via the JSON Ledger API v2..."
echo "   (POST $JSON_API_URL/v2/parties)"
echo ""

allocate_party() {
  local hint="$1"
  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "$JSON_API_URL/v2/parties" \
    -H "Content-Type: application/json" \
    -d "{\"partyIdHint\": \"$hint\", \"identityProviderId\": \"\"}")

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | head -1)

  if [ "$http_code" != "200" ]; then
    echo "   ⚠️  Allocating $hint returned HTTP $http_code (party may already exist)"
  else
    local party_id
    # Extract the party field from the JSON response (simple grep)
    party_id=$(echo "$body" | grep -o '"party":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo "   ✓ $hint → $party_id"
  fi
}

allocate_party "Alice"
allocate_party "Bob"
allocate_party "Operator"

echo ""

# ─── Done ────────────────────────────────────────────────────────────────────

echo "─────────────────────────────────────────────────────"
echo " Next step: generate .env with party IDs and tokens"
echo ""
echo "   Open a new terminal and run:"
echo "   cd $(realpath "$SCRIPT_DIR/..")"
echo "   pnpm setup:env"
echo "─────────────────────────────────────────────────────"
echo ""
echo "   (This terminal must stay open — sandbox runs in the foreground)"
echo "   Press Ctrl+C to stop the sandbox."
echo ""

# Keep alive — forward signals so sandbox shuts down cleanly on Ctrl+C
trap 'kill "$SANDBOX_PID" 2>/dev/null; exit 0' INT TERM
wait "$SANDBOX_PID"
