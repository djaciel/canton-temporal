#!/usr/bin/env bash
# =============================================================================
# Two-Phase Bootstrap Orchestration (DEC-006)
#
# Orchestrates the full Canton + Keycloak auth setup:
#   Phase A: Start Canton WITHOUT auth → run bootstrap (DAR, parties, users)
#   Phase B: Restart Canton WITH auth → verify OIDC token works
#
# The chicken-and-egg problem: Canton needs users before auth is enabled,
# but auth requires users to exist. Solution: two-phase startup.
#
# Usage: cd infra && bash scripts/orchestrate.sh
# =============================================================================

set -uo pipefail

INFRA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$INFRA_DIR/docker-compose.yml"
SCRIPTS_DIR="$INFRA_DIR/scripts"
CANTON_CONFIG="$INFRA_DIR/canton/topology.conf"
CANTON_AUTH_CONFIG="$INFRA_DIR/canton/topology-auth.conf"
KC_URL="http://localhost:8080"
P1_URL="http://localhost:5013"

PASS=0
FAIL=0

step_pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

step_fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
  echo ""
  echo "=== ORCHESTRATION FAILED at: $1 ==="
  echo "=== Summary: $PASS passed, $FAIL failed ==="
  exit 1
}

echo "============================================"
echo "  Two-Phase Bootstrap Orchestration"
echo "============================================"
echo ""

# -----------------------------------------------------------------------
# Step 1: Ensure Docker Compose services are running
# We need PostgreSQL + Keycloak + Canton (with no-auth config) to be up.
# -----------------------------------------------------------------------
echo "--- Step 1: Docker Compose Check ---"
echo ""

# Tear down any existing state for a clean start
echo "  Stopping existing containers..."
docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true

echo "  Starting services (postgres, keycloak, canton without auth)..."
docker compose -f "$COMPOSE_FILE" up -d 2>&1 | tail -5

# Wait for all services to be running
echo "  Waiting for services to be healthy..."
for i in $(seq 1 30); do
  PG_OK=$(docker inspect --format='{{.State.Health.Status}}' infra-postgres-1 2>/dev/null || echo "unknown")
  KC_OK=$(docker inspect --format='{{.State.Health.Status}}' infra-keycloak-1 2>/dev/null || echo "unknown")
  CANTON_OK=$(curl -s "$P1_URL/v2/version" 2>/dev/null | jq -r '.version' 2>/dev/null || echo "")
  if [ "$PG_OK" = "healthy" ] && [ "$KC_OK" = "healthy" ] && [ -n "$CANTON_OK" ]; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    step_fail "Docker Compose services not ready after 150s (pg=$PG_OK, kc=$KC_OK, canton=$CANTON_OK)"
  fi
  sleep 5
done

step_pass "Docker Compose — all services running (Canton $CANTON_OK)"

# Wait for Canton synchronizer to be fully initialized on both participants.
# init.canton connects participants to the sync domain — this takes longer
# than /v2/version. We probe the package endpoint: if the sync domain isn't
# connected yet, Canton returns PACKAGE_SERVICE_CANNOT_AUTODETECT_SYNCHRONIZER.
echo "  Waiting for Canton synchronizer on both participants..."
for PART_URL in "$P1_URL" "http://localhost:5023"; do
  for i in $(seq 1 30); do
    PROBE=$(curl -s "$PART_URL/v2/packages" -X POST \
      -H "Content-Type: application/octet-stream" --data-binary @/dev/null 2>/dev/null)
    if ! echo "$PROBE" | grep -q "CANNOT_AUTODETECT_SYNCHRONIZER"; then
      break
    fi
    if [ "$i" -eq 30 ]; then
      step_fail "Canton synchronizer not ready on $PART_URL after 150s"
    fi
    sleep 5
  done
done
step_pass "Docker Compose — Canton synchronizer connected on both participants"
echo ""

# -----------------------------------------------------------------------
# Step 2: Phase A — Run bootstrap against Canton WITHOUT auth
# This uploads the DAR, allocates parties, provisions Keycloak,
# and creates Canton users with Keycloak UUIDs as IDs.
# -----------------------------------------------------------------------
echo "--- Step 2: Phase A — Bootstrap (no auth) ---"
echo ""

BOOTSTRAP_OUTPUT=$(cd "$SCRIPTS_DIR" && npx tsx bootstrap.ts 2>&1)
BOOTSTRAP_EXIT=$?

if [ "$BOOTSTRAP_EXIT" -ne 0 ]; then
  echo "$BOOTSTRAP_OUTPUT"
  step_fail "Phase A bootstrap failed (exit code $BOOTSTRAP_EXIT)"
fi

step_pass "Phase A — bootstrap completed (DAR, parties, Keycloak, Canton users)"
echo ""

# -----------------------------------------------------------------------
# Step 3: Config swap — Replace Canton config with auth-enabled version
# and restart the Canton service. PostgreSQL data persists across restarts
# so all users/parties/DARs remain intact.
# -----------------------------------------------------------------------
echo "--- Step 3: Canton Restart with Auth Config ---"
echo ""

# Backup original config and swap in auth config
echo "  Swapping topology.conf → topology-auth.conf..."
cp "$CANTON_CONFIG" "$CANTON_CONFIG.bak"
cp "$CANTON_AUTH_CONFIG" "$CANTON_CONFIG"

# Restart only the Canton service (not postgres/keycloak)
echo "  Restarting Canton service..."
docker compose -f "$COMPOSE_FILE" restart canton 2>&1 | tail -3

# Restore original config file on host (Canton already loaded the auth config)
# We restore immediately so the repo stays clean
cp "$CANTON_CONFIG.bak" "$CANTON_CONFIG"
rm -f "$CANTON_CONFIG.bak"

step_pass "Canton config swapped to topology-auth.conf and service restarted"
echo ""

# -----------------------------------------------------------------------
# Step 4: Wait for Canton with auth to be ready
# Poll /v2/version — this endpoint does NOT require authentication.
# -----------------------------------------------------------------------
echo "--- Step 4: Wait for Canton with Auth ---"
echo ""

echo "  Polling /v2/version..."
for i in $(seq 1 30); do
  CANTON_VER=$(curl -s "$P1_URL/v2/version" 2>/dev/null | jq -r '.version' 2>/dev/null || echo "")
  if [ -n "$CANTON_VER" ]; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    step_fail "Canton with auth not ready after 150s"
  fi
  sleep 5
done

step_pass "Canton with auth ready (version $CANTON_VER)"
echo ""

# -----------------------------------------------------------------------
# Step 5: Auth verification — Get a Keycloak token and make an
# authenticated request to Canton. This proves the full OIDC flow works:
# Keycloak issues token → Canton validates via JWKS → request succeeds.
# -----------------------------------------------------------------------
echo "--- Step 5: Auth Verification ---"
echo ""

# Get OIDC token for trader-rojo via password grant
echo "  Obtaining OIDC token for trader-rojo..."
TOKEN_RESP=$(curl -s -X POST "$KC_URL/realms/canton/protocol/openid-connect/token" \
  -d "grant_type=password" \
  -d "client_id=ledger-api" \
  -d "username=trader-rojo" \
  -d "password=trader123" \
  -d "scope=daml_ledger_api")
ACCESS_TOKEN=$(echo "$TOKEN_RESP" | jq -r '.access_token')

if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
  step_fail "Auth verification — could not obtain Keycloak token"
fi

step_pass "Auth verification — Keycloak token obtained"

# Make authenticated request to Canton (query version with token)
echo "  Making authenticated request to Canton..."
AUTH_RESP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$P1_URL/v2/parties")

if [ "$AUTH_RESP_CODE" = "200" ]; then
  step_pass "Auth verification — Canton accepted OIDC token (HTTP $AUTH_RESP_CODE)"
else
  step_fail "Auth verification — Canton rejected OIDC token (HTTP $AUTH_RESP_CODE)"
fi

echo ""
echo "============================================"
echo "  Orchestration Complete"
echo "============================================"
echo ""
echo "  Phase A: Bootstrap (no auth)     — PASS"
echo "  Canton restart with auth         — PASS"
echo "  Auth verification (OIDC token)   — PASS"
echo ""
echo "=== Summary: $PASS passed, $FAIL failed ==="
