#!/usr/bin/env bash
# =============================================================================
# T-03 Validation: Two-phase bootstrap (Keycloak UUIDs as Canton user IDs)
#
# This script validates that bootstrap.ts has been updated to:
#   1. Phase A: Upload DAR + allocate parties (same as Phase 1)
#   2. Keycloak provisioning: call setupKeycloak() to get username → UUID map
#   3. Create Canton users using Keycloak UUIDs as user IDs (DEC-010)
#
# The key change from Phase 1 is that Canton user IDs are now Keycloak UUIDs
# (e.g. "99fcdd0d-e947-4ae7-9f70-884d3fbe2ae9") instead of plain strings
# (e.g. "trader-rojo"). This ensures the JWT `sub` claim maps correctly.
#
# Prerequisites:
#   - Docker Compose running (postgres, keycloak, canton without auth)
#   - Keycloak accessible on localhost:8080
#   - Canton accessible on localhost:5013 and localhost:5023
# =============================================================================

set -uo pipefail

PASS=0
FAIL=0
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
P1_URL="http://localhost:5013"
P2_URL="http://localhost:5023"

pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

echo "=== T-03 Validation: Two-Phase Bootstrap ==="
echo ""

# ---------------------------------------------------------------------------
# Execute bootstrap.ts — this should run Phase A (DAR, parties) and then
# call setupKeycloak() to provision Keycloak and create Canton users with UUIDs.
# ---------------------------------------------------------------------------
echo "[Exec] Running bootstrap.ts..."
BOOTSTRAP_OUTPUT=$(cd "$SCRIPTS_DIR" && npx tsx bootstrap.ts 2>&1)
BOOTSTRAP_EXIT=$?
echo "$BOOTSTRAP_OUTPUT"
echo ""

if [ "$BOOTSTRAP_EXIT" -eq 0 ]; then pass "bootstrap.ts exits successfully"; else fail "bootstrap.ts exits successfully"; fi

# ---------------------------------------------------------------------------
# AC1: Phase A — DAR upload and party allocation must still work as before.
# These are the foundational operations that don't require auth.
# ---------------------------------------------------------------------------
echo "[AC1] Phase A: DAR upload and party allocation"
if echo "$BOOTSTRAP_OUTPUT" | grep -qi "DAR uploaded"; then pass "DAR uploaded"; else fail "DAR uploaded"; fi
if echo "$BOOTSTRAP_OUTPUT" | grep -q "BancoRojo"; then pass "BancoRojo party allocated"; else fail "BancoRojo party allocated"; fi
if echo "$BOOTSTRAP_OUTPUT" | grep -q "BancoAzul"; then pass "BancoAzul party allocated"; else fail "BancoAzul party allocated"; fi

# ---------------------------------------------------------------------------
# AC2: Keycloak provisioning — bootstrap must call setupKeycloak() and obtain
# the username → UUID mapping. We verify this by checking the output contains
# Keycloak-related messages and UUID values.
# ---------------------------------------------------------------------------
echo ""
echo "[AC2] Keycloak provisioning executed"
if echo "$BOOTSTRAP_OUTPUT" | grep -qi "Keycloak"; then pass "Keycloak provisioning ran"; else fail "Keycloak provisioning ran"; fi
if echo "$BOOTSTRAP_OUTPUT" | grep -qE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'; then
  pass "UUIDs present in output"
else
  fail "UUIDs present in output"
fi

# ---------------------------------------------------------------------------
# AC3: Canton users must be created with Keycloak UUIDs as IDs (DEC-010).
# Query the Canton Ledger API to verify user IDs are UUIDs, not plain strings.
# ---------------------------------------------------------------------------
echo ""
echo "[AC3] Canton users have UUID-based IDs"
P1_USERS=$(curl -s "$P1_URL/v2/users" | jq -r '.users[].id')
P2_USERS=$(curl -s "$P2_URL/v2/users" | jq -r '.users[].id')

echo "  Participant1 user IDs: $P1_USERS"
echo "  Participant2 user IDs: $P2_USERS"

# Count how many user IDs on participant1 are UUIDs (expect 3: trader, supervisor, bot)
P1_UUID_COUNT=$(echo "$P1_USERS" | grep -cE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || true)
P2_UUID_COUNT=$(echo "$P2_USERS" | grep -cE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || true)

if [ "$P1_UUID_COUNT" -ge 3 ]; then pass "Participant1 has 3+ UUID-based users"; else fail "Participant1 has 3+ UUID-based users (got $P1_UUID_COUNT)"; fi
if [ "$P2_UUID_COUNT" -ge 3 ]; then pass "Participant2 has 3+ UUID-based users"; else fail "Participant2 has 3+ UUID-based users (got $P2_UUID_COUNT)"; fi

# Verify NO plain-string user IDs like "trader-rojo" exist (they should be UUIDs now)
if echo "$P1_USERS" | grep -q "trader-rojo"; then fail "Participant1 still has plain 'trader-rojo' ID"; else pass "No plain string IDs on participant1"; fi
if echo "$P2_USERS" | grep -q "trader-azul"; then fail "Participant2 still has plain 'trader-azul' ID"; else pass "No plain string IDs on participant2"; fi

# ---------------------------------------------------------------------------
# AC4: Users must have the correct permissions — traders and bots with
# canActAs, supervisors with canReadAs. Query rights for each user.
# ---------------------------------------------------------------------------
echo ""
echo "[AC4] Users have correct permissions"

# Helper: check if a Canton user has canActAs or canReadAs rights
check_rights() {
  local url="$1" user_id="$2" expected_right="$3" label="$4"
  local rights
  rights=$(curl -s "$url/v2/users/$user_id/rights" 2>/dev/null)
  if echo "$rights" | jq -e ".rights[] | .kind.$expected_right" >/dev/null 2>&1; then
    pass "$label has $expected_right"
  else
    fail "$label has $expected_right"
  fi
}

# We need to map usernames to UUIDs to check rights.
# Get UUIDs from Keycloak admin API.
KC_URL="http://localhost:8080"
KC_TOKEN=$(curl -s -X POST "$KC_URL/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" | jq -r '.access_token')

check_user_rights() {
  local username="$1" part_url="$2" expected="$3"
  local uuid
  uuid=$(curl -s -H "Authorization: Bearer $KC_TOKEN" "$KC_URL/admin/realms/canton/users?username=$username&exact=true" | jq -r '.[0].id')
  if [ -n "$uuid" ] && [ "$uuid" != "null" ]; then
    check_rights "$part_url" "$uuid" "$expected" "$username ($uuid)"
  else
    fail "$username UUID lookup from Keycloak"
  fi
}

check_user_rights "trader-rojo" "$P1_URL" "CanActAs"
check_user_rights "supervisor-rojo" "$P1_URL" "CanReadAs"
check_user_rights "bot-rojo" "$P1_URL" "CanActAs"
check_user_rights "trader-azul" "$P2_URL" "CanActAs"
check_user_rights "supervisor-azul" "$P2_URL" "CanReadAs"
check_user_rights "bot-azul" "$P2_URL" "CanActAs"

# ---------------------------------------------------------------------------
# AC5: Idempotency — running bootstrap.ts a second time must not fail.
# Users that already exist should be skipped gracefully.
# ---------------------------------------------------------------------------
echo ""
echo "[AC5] Idempotency — second run does not fail"
SECOND_RUN_OUTPUT=$(cd "$SCRIPTS_DIR" && npx tsx bootstrap.ts 2>&1)
SECOND_RUN_EXIT=$?
if [ "$SECOND_RUN_EXIT" -eq 0 ]; then pass "Second run exits successfully"; else fail "Second run exits successfully"; fi

# ---------------------------------------------------------------------------
# AC6: The script prints the username → UUID mapping for verification.
# This is important for operators to confirm the mapping is correct.
# ---------------------------------------------------------------------------
echo ""
echo "[AC6] Script prints username → UUID mapping"
if echo "$BOOTSTRAP_OUTPUT" | grep -q "trader-rojo"; then pass "Mapping shows trader-rojo"; else fail "Mapping shows trader-rojo"; fi
if echo "$BOOTSTRAP_OUTPUT" | grep -q "supervisor-azul"; then pass "Mapping shows supervisor-azul"; else fail "Mapping shows supervisor-azul"; fi

echo ""
echo "=== Summary: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
