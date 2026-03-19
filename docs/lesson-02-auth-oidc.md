# Lesson 02: OIDC Authentication with Keycloak + Canton

## What Problem Does This Solve?

In Lesson 01, Canton accepted any request — no authentication, no authorization. Any HTTP client could create contracts, read data, or impersonate users by passing a bare user ID as the `Authorization` header.

In a real multi-institution setup, each participant node must verify **who** is making a request (authentication) and **what** they're allowed to do (authorization). Canton supports this natively via OIDC tokens validated through JWKS.

## The OIDC Flow

OIDC (OpenID Connect) is a standard protocol built on top of OAuth 2.0. In this project:

- **Keycloak** acts as the Identity Provider (IdP) — it issues JWT tokens
- **Canton** acts as the Resource Server — it validates tokens via JWKS and enforces permissions

```
┌──────────┐         ┌──────────────┐         ┌─────────────────┐
│  Client   │         │   Keycloak    │         │ Canton Participant│
│ (script)  │         │   (IdP)       │         │  (Resource Server)│
└─────┬─────┘         └──────┬───────┘         └────────┬────────┘
      │                      │                          │
      │  1. POST /token      │                          │
      │  (username+password)  │                          │
      │─────────────────────→│                          │
      │                      │                          │
      │  2. JWT access_token │                          │
      │  (sub=UUID, aud, scope)                         │
      │←─────────────────────│                          │
      │                      │                          │
      │  3. POST /v2/commands │                          │
      │  Authorization: Bearer <JWT>                    │
      │────────────────────────────────────────────────→│
      │                      │                          │
      │                      │  4. GET /certs (JWKS)    │
      │                      │←─────────────────────────│
      │                      │                          │
      │                      │  5. Public keys          │
      │                      │─────────────────────────→│
      │                      │                          │
      │                      │         6. Canton validates:
      │                      │         - Signature (JWKS)
      │                      │         - Audience match
      │                      │         - Scope match
      │                      │         - Lifetime ≤ 300s
      │                      │         - sub → Canton user
      │                      │         - User permissions
      │                      │                          │
      │  7. HTTP 200 (success) or 401/403 (rejected)    │
      │←────────────────────────────────────────────────│
```

**Step by step:**

1. The client sends credentials (username + password) to Keycloak's token endpoint using the `password` grant type
2. Keycloak returns a signed JWT token with claims: `sub` (user UUID), `aud` (audience), `scope` (permissions scope)
3. The client sends a request to Canton with the JWT in the `Authorization: Bearer` header
4. Canton fetches Keycloak's public keys via the JWKS endpoint (cached briefly)
5. Canton validates the token signature, audience, scope, lifetime, and maps `sub` to a Canton user
6. If all checks pass and the user has the required permissions (`canActAs`/`canReadAs`), the request is processed

## Keycloak Configuration

Keycloak is configured programmatically via the Admin REST API (see `keycloak-setup.ts`). The key components:

### Realm: `canton`

A single realm hosts users for both institutions (BancoRojo and BancoAzul). The realm sets `accessTokenLifespan: 300` (5 minutes) — Canton rejects tokens with longer lifetimes.

### Client Scope: `daml_ledger_api`

This scope bundles the protocol mappers that Canton requires:

| Mapper | Type | Purpose |
|--------|------|---------|
| `audience-participant1` | `oidc-audience-mapper` | Adds `https://daml.com/jwt/aud/participant/participant1` to the `aud` claim |
| `audience-participant2` | `oidc-audience-mapper` | Adds `https://daml.com/jwt/aud/participant/participant2` to the `aud` claim |
| `sub-mapper` | `oidc-sub-mapper` | Ensures `sub` claim appears in the access token |

### Client: `ledger-api`

A **public** client (no client secret) with `directAccessGrantsEnabled: true` — this allows the password grant type used for machine-to-machine and testing flows. The `daml_ledger_api` scope is assigned as a default scope.

### Users

Six users are created, each with `email`, `firstName`, `lastName`, and `emailVerified: true`:

| Username | Institution | Role | Password |
|----------|-------------|------|----------|
| `trader-rojo` | Banco Rojo | Trader (canActAs) | `trader123` |
| `supervisor-rojo` | Banco Rojo | Supervisor (canReadAs) | `supervisor123` |
| `bot-rojo` | Banco Rojo | Automation (canActAs) | `bot123` |
| `trader-azul` | Banco Azul | Trader (canActAs) | `trader123` |
| `supervisor-azul` | Banco Azul | Supervisor (canReadAs) | `supervisor123` |
| `bot-azul` | Banco Azul | Automation (canActAs) | `bot123` |

## The UUID Mapping: sub → Canton User ID

This is the critical link between Keycloak and Canton:

```
Keycloak user "trader-rojo"
  → Keycloak assigns UUID: 992a4b31-7e70-4070-a48b-608c2ae96790
  → Canton user created with id: "992a4b31-7e70-4070-a48b-608c2ae96790"
  → JWT token sub claim: "992a4b31-7e70-4070-a48b-608c2ae96790"
  → Canton matches sub → user → permissions → allows/denies request
```

Canton uses the `sub` claim of the JWT to look up the user in its internal database. If the `sub` doesn't match any Canton user ID, the request fails with HTTP 401 ("UserNotFound").

The bootstrap creates users in Keycloak first (to obtain their UUIDs), then creates matching Canton users with those UUIDs as IDs. This is why the user ID is no longer a human-readable string like `"trader-rojo"` — it's a UUID like `"992a4b31-7e70-4070-a48b-608c2ae96790"`.

## Canton Auth Configuration (HOCON)

Each participant needs an `auth-services` block in its `ledger-api` configuration:

```hocon
participants {
  participant1 {
    ledger-api {
      address = "0.0.0.0"
      port = 5011
      auth-services = [{
        type = jwt-jwks
        url = "http://keycloak:8080/realms/canton/protocol/openid-connect/certs"
        target-audience = "https://daml.com/jwt/aud/participant/participant1"
        target-scope = "daml_ledger_api"
      }]
    }
  }
}
```

Key fields:
- **`type = jwt-jwks`** — Tells Canton to validate JWT tokens using public keys from a JWKS endpoint
- **`url`** — The JWKS endpoint URL (uses Docker hostname `keycloak`, not `localhost`)
- **`target-audience`** — The audience value that must appear in the token's `aud` claim. Each participant has its own audience.
- **`target-scope`** — The scope that must appear in the token's `scope` claim

## The Two-Phase Bootstrap

### The Chicken-and-Egg Problem

When Canton has auth enabled:
- The Ledger API (which hosts user management) requires a valid JWT token
- But you can't get a valid JWT token without a matching Canton user
- And you can't create a Canton user without accessing the Ledger API

### The Solution: Two-Phase Startup

```
Phase A (Canton WITHOUT auth)          Phase B (Canton WITH auth)
┌─────────────────────────────┐       ┌─────────────────────────────┐
│ 1. Start Canton (no auth)   │       │ 5. Restart Canton with      │
│ 2. Upload DAR               │       │    topology-auth.conf       │
│ 3. Allocate parties         │  ──→  │ 6. Verify auth works:       │
│ 4. Create Keycloak users    │       │    - Get token from Keycloak│
│    + Canton users (UUIDs)   │       │    - Make authenticated req │
│                             │       │    - Expect HTTP 200        │
└─────────────────────────────┘       └─────────────────────────────┘
```

PostgreSQL persists all data between restarts, so users, parties, and DARs created in Phase A survive into Phase B.

The orchestration script (`orchestrate.sh`) automates this:
1. Start Docker Compose with `topology.conf` (no auth)
2. Run `bootstrap.ts` (DAR + parties + Keycloak + Canton users)
3. Swap config to `topology-auth.conf` and restart Canton
4. Wait for Canton to be ready
5. Verify OIDC token flow works end-to-end

## Canton's Authorization Model

Canton enforces two types of permissions:

| Permission | Allows | HTTP Response |
|------------|--------|---------------|
| `canActAs` | Submit commands (create/exercise contracts) | 200 on success |
| `canReadAs` | Query active contracts, read ledger state | 200 on read, **403 on write** |

Error responses from Canton:

| Scenario | HTTP Code | Canton Message |
|----------|-----------|----------------|
| Valid token + canActAs | 200 | Success |
| Valid token + canReadAs (read) | 200 | Success |
| Valid token + canReadAs (write) | 403 | "Claims do not authorize to act as party '...'" |
| Invalid/garbage token | 401 | "The command is missing a (valid) JWT token" |
| No token (no Authorization header) | 401 | "The command is missing a (valid) JWT token" |
| Token lifetime too long | 401 | "token lifetime too long" |
| UUID not matching any Canton user | 401 | "UserNotFound" |

## Important Gotchas

### 1. `oidc-sub-mapper` is required in Keycloak 26

Keycloak 26 uses a "lightweight" access token format by default that **omits the `sub` claim**. Without `sub`, Canton cannot map the token to a user. You must add an `oidc-sub-mapper` protocol mapper to the client scope with `access.token.claim: true`.

### 2. Token lifetime must be ≤ 300 seconds

Canton has a maximum token lifetime check. Keycloak's default 1-hour tokens are rejected with "token lifetime too long". Set `accessTokenLifespan: 300` in the realm configuration.

### 3. Each participant has its own audience

The `target-audience` in Canton must match the audience in the token. Each participant expects a different audience:
- participant1: `https://daml.com/jwt/aud/participant/participant1`
- participant2: `https://daml.com/jwt/aud/participant/participant2`

The Keycloak client scope includes audience mappers for both participants, so a single token works against either participant.

### 4. Keycloak 26 requires extra user fields

When creating users via the Admin REST API, Keycloak 26 requires `email`, `firstName`, `lastName`, and `emailVerified: true`. Without these, the password grant fails with "Account is not fully set up".

### 5. Docker networking for JWKS

Canton runs inside Docker and accesses Keycloak via hostname `keycloak` (e.g., `http://keycloak:8080/realms/canton/...`). Tokens are obtained from `http://localhost:8080/...` outside Docker. Canton does **not** validate the `iss` claim against the JWKS URL — it only uses JWKS for signature verification.

### 6. `/v2/parties` requires admin rights with auth enabled

When auth is enabled, the `/v2/parties` endpoint returns HTTP 403 for non-admin users. To resolve party IDs, use `/v2/users/{userId}` and read the `primaryParty` field instead — each authenticated user can read their own record.

## How to Verify Everything Works

```bash
# Run the full two-phase orchestration
cd infra && bash scripts/orchestrate.sh

# Run the OIDC smoke test (requires Canton with auth enabled)
cd infra/scripts && npx tsx smoke-test.ts

# Expected output: 11 checks, ALL PASSED
# Checks include: token acquisition, asset creation with OIDC,
# cross-participant visibility, canReadAs queries,
# 403 on unauthorized writes, 401 on invalid/missing tokens
```

## File Structure (Phase 2 additions)

```
infra/
├── canton/
│   ├── topology.conf              # Config WITHOUT auth (Phase A)
│   └── topology-auth.conf         # Config WITH auth (Phase B) — adds auth-services
├── scripts/
│   ├── keycloak-setup.ts          # Keycloak provisioning (realm, client, scope, users)
│   ├── bootstrap.ts               # Updated: Keycloak users + UUID-based Canton users
│   ├── orchestrate.sh             # Two-phase bootstrap orchestration
│   └── smoke-test.ts              # Updated: OIDC tokens + auth tests (401/403)
├── docker-compose.yml             # Updated: added Keycloak service
└── init-db.sql                    # Updated: added keycloak database
```

## JWT Token Example

A decoded access token from Keycloak looks like:

```json
{
  "exp": 1773818831,
  "iat": 1773818531,
  "jti": "508b0fba-15a4-493a-9a58-f26a0b99ae4b",
  "iss": "http://localhost:8080/realms/canton",
  "aud": [
    "https://daml.com/jwt/aud/participant/participant1",
    "https://daml.com/jwt/aud/participant/participant2"
  ],
  "sub": "992a4b31-7e70-4070-a48b-608c2ae96790",
  "typ": "Bearer",
  "azp": "ledger-api",
  "scope": "openid daml_ledger_api"
}
```

The fields Canton cares about:
- **`sub`** — Must match a Canton user ID (the Keycloak UUID)
- **`aud`** — Must include the participant's `target-audience`
- **`scope`** — Must include the participant's `target-scope` (`daml_ledger_api`)
- **`exp` / `iat`** — Token lifetime (`exp - iat`) must be ≤ 300 seconds
