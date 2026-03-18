#!/usr/bin/env bash
# =============================================================================
# T-02 Validation: Keycloak Provisioning Script (keycloak-setup.ts)
#
# This script validates that keycloak-setup.ts correctly provisions Keycloak
# with the full OIDC configuration needed for Canton JWT auth:
#   - Realm "canton" with short-lived tokens (300s)
#   - Client scope "daml_ledger_api" with audience mappers per participant
#     and the oidc-sub-mapper required by Keycloak 26 for `sub` in access tokens
#   - Public client "ledger-api" with password grant enabled
#   - 6 institutional users (trader/supervisor/bot × rojo/azul)
#
# Prerequisites: Keycloak running on localhost:8080 (from docker-compose)
# =============================================================================

set -uo pipefail

PASS=0
FAIL=0
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
KC_URL="http://localhost:8080"

pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

echo "=== T-02 Validation: Keycloak Provisioning ==="
echo ""

# ---------------------------------------------------------------------------
# Pre-check: Verify the script file exists before attempting to run it
# ---------------------------------------------------------------------------
echo "[Pre] Script exists"
if [ -f "$SCRIPTS_DIR/keycloak-setup.ts" ]; then pass "keycloak-setup.ts exists"; else fail "keycloak-setup.ts exists"; fi

# ---------------------------------------------------------------------------
# Execute the provisioning script and capture its output for later assertions.
# This is the "first run" — it should create all Keycloak resources from scratch.
# ---------------------------------------------------------------------------
echo ""
echo "[Exec] Running keycloak-setup.ts..."
FIRST_RUN_OUTPUT=$(cd "$SCRIPTS_DIR" && npx tsx keycloak-setup.ts 2>&1)
FIRST_RUN_EXIT=$?
echo "$FIRST_RUN_OUTPUT"
echo ""

if [ "$FIRST_RUN_EXIT" -eq 0 ]; then pass "Script exits successfully"; else fail "Script exits successfully"; fi

# The script must print UUID mappings (e.g. "trader-rojo → 99fcdd0d-...")
if echo "$FIRST_RUN_OUTPUT" | grep -qE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'; then
  pass "Output contains UUID mappings"
else
  fail "Output contains UUID mappings"
fi

# ---------------------------------------------------------------------------
# Obtain an admin token to query the Keycloak Admin REST API directly.
# All subsequent checks use this token to verify the provisioned resources.
# ---------------------------------------------------------------------------
ADMIN_TOKEN=$(curl -s -X POST "$KC_URL/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" \
  -d "username=admin" \
  -d "password=admin" | jq -r '.access_token')

if [ -z "$ADMIN_TOKEN" ] || [ "$ADMIN_TOKEN" = "null" ]; then
  echo "ERROR: Could not get admin token, aborting remaining checks"
  echo "=== Summary: $PASS passed, $FAIL failed ==="
  exit 1
fi

AUTH="Authorization: Bearer $ADMIN_TOKEN"

# ---------------------------------------------------------------------------
# AC1: Realm "canton" must exist with accessTokenLifespan=300.
# Canton rejects tokens with lifetime > 300s, so Keycloak must match.
# ---------------------------------------------------------------------------
echo "[AC1] Realm canton with accessTokenLifespan=300"
REALM_DATA=$(curl -s -H "$AUTH" "$KC_URL/admin/realms/canton")
if echo "$REALM_DATA" | jq -e '.realm == "canton"' >/dev/null 2>&1; then pass "Realm canton exists"; else fail "Realm canton exists"; fi
if echo "$REALM_DATA" | jq -e '.accessTokenLifespan == 300' >/dev/null 2>&1; then pass "accessTokenLifespan is 300"; else fail "accessTokenLifespan is 300"; fi

# ---------------------------------------------------------------------------
# AC2: Client scope "daml_ledger_api" must exist with three protocol mappers:
#   1. Audience mapper for participant1 (adds participant1 audience to token)
#   2. Audience mapper for participant2 (adds participant2 audience to token)
#   3. oidc-sub-mapper (ensures `sub` claim appears in access tokens — required
#      by Keycloak 26 which omits it by default in lightweight token format)
# ---------------------------------------------------------------------------
echo ""
echo "[AC2] Client scope daml_ledger_api with mappers"
SCOPES=$(curl -s -H "$AUTH" "$KC_URL/admin/realms/canton/client-scopes")
SCOPE_ID=$(echo "$SCOPES" | jq -r '.[] | select(.name == "daml_ledger_api") | .id')
if [ -n "$SCOPE_ID" ]; then
  pass "Client scope daml_ledger_api exists"

  # Fetch all mappers attached to this scope and validate each type
  MAPPERS=$(curl -s -H "$AUTH" "$KC_URL/admin/realms/canton/client-scopes/$SCOPE_ID/protocol-mappers/models")
  AUD_COUNT=$(echo "$MAPPERS" | jq '[.[] | select(.protocolMapper == "oidc-audience-mapper")] | length')
  if [ "$AUD_COUNT" -ge 1 ]; then pass "Audience mapper for participant1 exists"; else fail "Audience mapper for participant1 exists"; fi
  if [ "$AUD_COUNT" -ge 2 ]; then pass "Audience mapper for participant2 exists"; else fail "Audience mapper for participant2 exists"; fi
  if echo "$MAPPERS" | jq -e '.[] | select(.protocolMapper == "oidc-sub-mapper")' >/dev/null 2>&1; then
    pass "oidc-sub-mapper exists"
  else
    fail "oidc-sub-mapper exists"
  fi
else
  fail "Client scope daml_ledger_api exists"
fi

# ---------------------------------------------------------------------------
# AC3: Client "ledger-api" must be a public client (no client secret) with
# direct access grants enabled (allows password grant for CLI/script use).
# ---------------------------------------------------------------------------
echo ""
echo "[AC3] Client ledger-api (public, directAccessGrants)"
CLIENTS=$(curl -s -H "$AUTH" "$KC_URL/admin/realms/canton/clients")
CLIENT_DATA=$(echo "$CLIENTS" | jq '.[] | select(.clientId == "ledger-api")')
if echo "$CLIENT_DATA" | jq -e '.clientId == "ledger-api"' >/dev/null 2>&1; then pass "Client ledger-api exists"; else fail "Client ledger-api exists"; fi
if echo "$CLIENT_DATA" | jq -e '.publicClient == true' >/dev/null 2>&1; then pass "Client is public"; else fail "Client is public"; fi
if echo "$CLIENT_DATA" | jq -e '.directAccessGrantsEnabled == true' >/dev/null 2>&1; then pass "directAccessGrantsEnabled"; else fail "directAccessGrantsEnabled"; fi

# ---------------------------------------------------------------------------
# AC4: All 6 institutional users must exist with required profile fields.
# Keycloak 26 requires email, firstName, lastName, and emailVerified=true
# for the password grant to work — without these, login fails with
# "Account is not fully set up".
# ---------------------------------------------------------------------------
echo ""
echo "[AC4] 6 users created with correct fields"
USERS_DATA=$(curl -s -H "$AUTH" "$KC_URL/admin/realms/canton/users?max=50")
for USERNAME in trader-rojo supervisor-rojo bot-rojo trader-azul supervisor-azul bot-azul; do
  USER_DATA=$(echo "$USERS_DATA" | jq ".[] | select(.username == \"$USERNAME\")")
  if echo "$USER_DATA" | jq -e '.username' >/dev/null 2>&1; then pass "User $USERNAME exists"; else fail "User $USERNAME exists"; fi
  if echo "$USER_DATA" | jq -e '.email != null and .email != ""' >/dev/null 2>&1; then pass "User $USERNAME has email"; else fail "User $USERNAME has email"; fi
  if echo "$USER_DATA" | jq -e '.emailVerified == true' >/dev/null 2>&1; then pass "User $USERNAME emailVerified=true"; else fail "User $USERNAME emailVerified=true"; fi
done

# ---------------------------------------------------------------------------
# AC5: Idempotency — running the script a second time must not fail.
# Resources that already exist (409 Conflict) should be skipped gracefully.
# ---------------------------------------------------------------------------
echo ""
echo "[AC5] Idempotency — second run does not fail"
SECOND_RUN_OUTPUT=$(cd "$SCRIPTS_DIR" && npx tsx keycloak-setup.ts 2>&1)
SECOND_RUN_EXIT=$?
if [ "$SECOND_RUN_EXIT" -eq 0 ]; then pass "Second run exits successfully"; else fail "Second run exits successfully"; fi

# ---------------------------------------------------------------------------
# AC6: The script must print a username → UUID mapping for all 6 users.
# This map is consumed by bootstrap.ts (T-03) to create Canton users
# with Keycloak UUIDs as their IDs (DEC-010).
# ---------------------------------------------------------------------------
echo ""
echo "[AC6] Script returns username → UUID map"
for USERNAME in trader-rojo supervisor-rojo bot-rojo trader-azul supervisor-azul bot-azul; do
  if echo "$FIRST_RUN_OUTPUT" | grep -q "$USERNAME"; then pass "Output has $USERNAME"; else fail "Output has $USERNAME"; fi
done

# ---------------------------------------------------------------------------
# AC7: End-to-end token verification — obtain a real OIDC token via password
# grant and verify the JWT claims that Canton will validate:
#   - sub: must be a UUID (Keycloak user ID, not username)
#   - aud: must include participant audience values
#   - scope: must include daml_ledger_api
# ---------------------------------------------------------------------------
echo ""
echo "[AC7] Token claims verification"
TOKEN_RESP=$(curl -s -X POST "$KC_URL/realms/canton/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=ledger-api&username=trader-rojo&password=trader123&scope=daml_ledger_api")
ACCESS_TOKEN=$(echo "$TOKEN_RESP" | jq -r '.access_token')
if [ "$ACCESS_TOKEN" != "null" ] && [ -n "$ACCESS_TOKEN" ]; then
  pass "Password grant returns access_token"

  # Decode the JWT payload (base64url → base64 with proper padding)
  PAYLOAD=$(echo "$ACCESS_TOKEN" | cut -d'.' -f2 | tr '_-' '/+')
  PAD=$((4 - ${#PAYLOAD} % 4))
  [ "$PAD" -lt 4 ] && PAYLOAD="${PAYLOAD}$(printf '=%.0s' $(seq 1 $PAD))"
  CLAIMS=$(echo "$PAYLOAD" | base64 -d 2>/dev/null)

  if echo "$CLAIMS" | jq -e '.sub' 2>/dev/null | grep -qE '[0-9a-f]{8}-[0-9a-f]{4}'; then pass "Token sub is a UUID"; else fail "Token sub is a UUID"; fi
  if echo "$CLAIMS" | jq -e '.aud' 2>/dev/null | grep -q "daml.com/jwt/aud/participant"; then pass "Token aud includes participant audience"; else fail "Token aud includes participant audience"; fi
  if echo "$CLAIMS" | jq -r '.scope' 2>/dev/null | grep -q "daml_ledger_api"; then pass "Token scope includes daml_ledger_api"; else fail "Token scope includes daml_ledger_api"; fi
else
  fail "Password grant returns access_token"
fi

echo ""
echo "=== Summary: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
