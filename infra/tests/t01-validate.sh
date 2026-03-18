#!/usr/bin/env bash
# T-01 Validation: Keycloak Docker + Canton auth config
# Tests structural acceptance criteria for task T-01

set -uo pipefail

PASS=0
FAIL=0
INFRA_DIR="$(cd "$(dirname "$0")/.." && pwd)"

check() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== T-01 Structural Validation ==="
echo ""

# AC5: Keycloak usa PostgreSQL como storage (database keycloak)
echo "[AC5] init-db.sql contains keycloak database"
check "init-db.sql has CREATE DATABASE keycloak" grep -q "CREATE DATABASE keycloak" "$INFRA_DIR/init-db.sql"

# AC1: docker-compose.yml has keycloak service
echo "[AC1] docker-compose.yml contains keycloak service"
check "docker-compose.yml has keycloak service" grep -q "keycloak:" "$INFRA_DIR/docker-compose.yml"
check "keycloak image is quay.io/keycloak/keycloak:26.0" grep -q "quay.io/keycloak/keycloak:26.0" "$INFRA_DIR/docker-compose.yml"
check "keycloak uses start-dev command" grep -q "start-dev" "$INFRA_DIR/docker-compose.yml"
check "keycloak exposes port 8080" grep -q "8080:8080" "$INFRA_DIR/docker-compose.yml"
check "keycloak uses PostgreSQL backend (KC_DB=postgres)" grep -q "KC_DB: postgres" "$INFRA_DIR/docker-compose.yml"

# AC3: topology-auth.conf has auth-services for both participants
echo "[AC3] topology-auth.conf contains auth-services"
check "topology-auth.conf exists" test -f "$INFRA_DIR/canton/topology-auth.conf"
check "topology-auth.conf has auth-services (count=2)" test "$(grep -c 'auth-services' "$INFRA_DIR/canton/topology-auth.conf" 2>/dev/null)" -eq 2
check "participant1 audience configured" grep -q 'https://daml.com/jwt/aud/participant/participant1' "$INFRA_DIR/canton/topology-auth.conf"
check "participant2 audience configured" grep -q 'https://daml.com/jwt/aud/participant/participant2' "$INFRA_DIR/canton/topology-auth.conf"
check "JWKS URL points to keycloak canton realm" grep -q 'keycloak:8080/realms/canton/protocol/openid-connect/certs' "$INFRA_DIR/canton/topology-auth.conf"
check "target-scope is daml_ledger_api" grep -q 'daml_ledger_api' "$INFRA_DIR/canton/topology-auth.conf"

# AC4: topology.conf still exists (backward compatible)
echo "[AC4] topology.conf unchanged (backward compatible)"
check "topology.conf still exists" test -f "$INFRA_DIR/canton/topology.conf"
check "topology.conf has NO auth-services" test "$(grep -c 'auth-services' "$INFRA_DIR/canton/topology.conf" 2>/dev/null)" -eq 0

echo ""
echo "=== Summary: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
