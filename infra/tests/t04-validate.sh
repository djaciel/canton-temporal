#!/usr/bin/env bash
# =============================================================================
# T-04 Validation: Two-phase bootstrap orchestration script
#
# This validates that orchestrate.sh correctly orchestrates the full flow:
#   1. Docker Compose services running
#   2. Phase A bootstrap (DAR, parties, Keycloak, Canton users) without auth
#   3. Canton restart with auth config (topology-auth.conf)
#   4. Auth verification (Keycloak token → Canton request → HTTP 200)
#
# NOTE: This test validates the STRUCTURE of orchestrate.sh and its output.
# The actual end-to-end run is orchestrate.sh itself.
#
# Prerequisites: Docker available
# =============================================================================

set -uo pipefail

PASS=0
FAIL=0
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"

pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

echo "=== T-04 Validation: Orchestration Script ==="
echo ""

# ---------------------------------------------------------------------------
# Pre-check: Script file exists and is executable
# ---------------------------------------------------------------------------
echo "[Pre] Script exists and is executable"
if [ -f "$SCRIPTS_DIR/orchestrate.sh" ]; then pass "orchestrate.sh exists"; else fail "orchestrate.sh exists"; fi
if [ -x "$SCRIPTS_DIR/orchestrate.sh" ]; then pass "orchestrate.sh is executable"; else fail "orchestrate.sh is executable"; fi

# ---------------------------------------------------------------------------
# Structural checks: Script contains the expected phases
# ---------------------------------------------------------------------------
echo ""
echo "[Structure] Script contains expected phases"
SCRIPT_CONTENT=$(cat "$SCRIPTS_DIR/orchestrate.sh" 2>/dev/null || echo "")
if echo "$SCRIPT_CONTENT" | grep -q "docker compose"; then pass "Uses docker compose"; else fail "Uses docker compose"; fi
if echo "$SCRIPT_CONTENT" | grep -q "bootstrap.ts"; then pass "Calls bootstrap.ts"; else fail "Calls bootstrap.ts"; fi
if echo "$SCRIPT_CONTENT" | grep -q "topology-auth"; then pass "References topology-auth config"; else fail "References topology-auth config"; fi
if echo "$SCRIPT_CONTENT" | grep -q "v2/version"; then pass "Polls /v2/version for readiness"; else fail "Polls /v2/version for readiness"; fi
if echo "$SCRIPT_CONTENT" | grep -q "token"; then pass "Obtains token for verification"; else fail "Obtains token for verification"; fi
if echo "$SCRIPT_CONTENT" | grep -qi "PASS\|FAIL"; then pass "Prints PASS/FAIL output"; else fail "Prints PASS/FAIL output"; fi
if echo "$SCRIPT_CONTENT" | grep -q "exit 1"; then pass "Exits with code 1 on failure"; else fail "Exits with code 1 on failure"; fi

# ---------------------------------------------------------------------------
# End-to-end run: Execute orchestrate.sh and validate output
# This is the real integration test — runs the full two-phase bootstrap.
# ---------------------------------------------------------------------------
echo ""
echo "[E2E] Running orchestrate.sh end-to-end..."
E2E_OUTPUT=$(cd "$SCRIPTS_DIR/.." && bash scripts/orchestrate.sh 2>&1)
E2E_EXIT=$?
echo "$E2E_OUTPUT"
echo ""

# AC1: Script verifies Docker Compose is running
if echo "$E2E_OUTPUT" | grep -qi "docker.*running\|services.*up\|compose.*ok\|Docker Compose"; then
  pass "Docker Compose check present in output"
else
  fail "Docker Compose check present in output"
fi

# AC2: Phase A bootstrap executed
if echo "$E2E_OUTPUT" | grep -qi "Phase A\|bootstrap"; then pass "Phase A bootstrap executed"; else fail "Phase A bootstrap executed"; fi

# AC3: Config swap and Canton restart
if echo "$E2E_OUTPUT" | grep -qi "auth.*config\|topology-auth\|restart\|Canton.*auth"; then
  pass "Config swap / Canton restart in output"
else
  fail "Config swap / Canton restart in output"
fi

# AC4: Canton with auth is ready (version endpoint responds)
if echo "$E2E_OUTPUT" | grep -qi "Canton.*ready\|version\|auth.*ready"; then
  pass "Canton with auth reported ready"
else
  fail "Canton with auth reported ready"
fi

# AC5: Auth verification passed (token → Canton → 200)
if echo "$E2E_OUTPUT" | grep -qi "auth.*verif\|token.*ok\|PASS.*auth\|verification.*PASS"; then
  pass "Auth verification present in output"
else
  fail "Auth verification present in output"
fi

# AC6: Clear PASS/FAIL output
if echo "$E2E_OUTPUT" | grep -q "PASS"; then pass "PASS labels in output"; else fail "PASS labels in output"; fi

# AC7: Script exits successfully
if [ "$E2E_EXIT" -eq 0 ]; then pass "orchestrate.sh exits with code 0"; else fail "orchestrate.sh exits with code 0 (got $E2E_EXIT)"; fi

# AC post: Canton is running with auth config
if docker compose -f "$(dirname "$SCRIPTS_DIR")/docker-compose.yml" ps 2>/dev/null | grep -q "canton"; then
  pass "Canton container still running"
else
  fail "Canton container still running"
fi

# AC post: Canton responds to version (no auth needed for /v2/version)
CANTON_VER=$(curl -s http://localhost:5013/v2/version 2>/dev/null | jq -r '.version' 2>/dev/null || echo "")
if [ -n "$CANTON_VER" ]; then pass "Canton /v2/version responds ($CANTON_VER)"; else fail "Canton /v2/version responds"; fi

echo ""
echo "=== Summary: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
