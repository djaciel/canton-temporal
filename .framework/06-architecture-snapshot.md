# Architecture Snapshot

Last updated: 2026-03-18 (Phase 3 closure)

## Current State

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Docker Compose (infra/)                            │
│                                                                      │
│  ┌──────────────┐  ┌─────────────────────────────────┐              │
│  │ PostgreSQL 16 │  │     Canton 3.4.11 Process       │              │
│  │               │  │                                 │              │
│  │ - sequencer   │◄►│  sequencer1  (5001/5002)       │              │
│  │ - seq_driver  │  │  mediator1   (5202)            │              │
│  │ - mediator    │  │  participant1 (5011/5012/5013) │◄─ JWKS ──┐  │
│  │ - participant1│  │  participant2 (5021/5022/5023) │◄─ JWKS ──┤  │
│  │ - participant2│  │                                 │          │  │
│  │ - keycloak    │  └──────────┬───────────┬──────────┘          │  │
│  │ - backend_rojo│             │           │                     │  │
│  │ - backend_azul│             │           │                     │  │
│  └──────┬───────┘         ┌────┘           └────┐               │  │
│         │                 │                     │               │  │
│  ┌──────┴────────────┐  ┌┴────────────────┐  ┌─┴──────────────┐│  │
│  │ backend-rojo:3001 │──┤  participant1   │  │ backend-azul   ││  │
│  │                   │  │  (5013)         │  │ :3002          ││  │
│  │  - REST API       │  └────────────────┘  │                 ││  │
│  │  - Auth (JWKS)    │                       │  - REST API    ││  │
│  │  - Event Consumer │                       │  - Auth (JWKS) ││  │
│  │  - Projection     │                       │  - Event Cons. ││  │
│  │    (backend_rojo) │                       │  - Projection  ││  │
│  └───────────────────┘                       │    (backend_azul)│  │
│                                              └─┬──────────────┘│  │
│                                                │  participant2 │  │
│                                                │  (5023)       │  │
│                                                └───────────────┘  │
│                     ┌─────────────────────────────────┐           │
│                     │   Keycloak 26.0 (8080)          │───────────┘
│                     │   Realm: canton                 │
│                     │   Client: ledger-api (public)   │
│                     │   Scope: daml_ledger_api        │
│                     │   Users: 6 (trader/supervisor/  │
│                     │          bot × rojo/azul)       │
│                     └─────────────────────────────────┘
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

External scripts (host machine):
  infra/scripts/orchestrate.sh    → Docker Compose + bootstrap + config swap
  infra/scripts/bootstrap.ts      → HTTP → Keycloak Admin API + participant1/2 (/v2/*)
  infra/scripts/keycloak-setup.ts → HTTP → Keycloak Admin API (realm, client, users)
  infra/scripts/smoke-test.ts     → HTTP → Keycloak token endpoint + participant1/2 (/v2/*)
  backend/scripts/run-scenario.ts → HTTP → backend-rojo:3001 + backend-azul:3002
  backend/scripts/smoke-test.ts   → HTTP → backend-rojo:3001 + backend-azul:3002
```

## Auth Flow

```
Client → POST /realms/canton/protocol/openid-connect/token → Keycloak
       ← JWT (sub=UUID, aud=[participant1,participant2], scope=daml_ledger_api)

Client → Authorization: Bearer <JWT> → Backend (REST API)
         Backend → JWKS → Keycloak (validates signature locally)
         Backend → /v2/users/{sub} → Canton (resolves primaryParty, cached)
         Backend → Authorization: Bearer <JWT> → Canton participant (forwards token)
         Canton → JWKS → Keycloak (validates signature)
         Canton → checks: audience match → scope match → lifetime ≤ 300s → sub → user lookup → permissions
       ← 200 (authorized) / 401 (bad token) / 403 (insufficient permissions)

Event Consumer (bot-rojo/bot-azul):
  Consumer → POST /realms/canton/protocol/openid-connect/token → Keycloak (password grant)
           ← JWT (renews every 270s, before 300s expiry)
  Consumer → POST /v2/updates/flats (polling every 2s) → Canton participant
           ← Transaction events → INSERT/DELETE projection tables
```

## Services

| Service | Image | Ports | Purpose |
|---------|-------|-------|---------|
| postgres | postgres:16 | 5432 | 8 databases (5 Canton + 1 Keycloak + 2 backend projection) |
| canton | custom (canton-open-source-3.4.11 on eclipse-temurin:17-jre) | 5001-5002, 5011-5013, 5021-5023 | Single-process, 4 logical nodes, JWKS auth |
| keycloak | quay.io/keycloak/keycloak:26.0 | 8080 | OIDC identity provider, realm "canton" |
| backend-rojo | custom (Node.js, backend/Dockerfile) | 3001 | BancoRojo backend: REST API + event consumer → participant1, projection → backend_rojo DB |
| backend-azul | custom (Node.js, backend/Dockerfile) | 3002 | BancoAzul backend: REST API + event consumer → participant2, projection → backend_azul DB |

## Data Flow

1. **Two-Phase Startup (orchestrate.sh):**
   - Phase A: PostgreSQL → Keycloak → Canton (no auth) → bootstrap.ts (DAR, parties, Keycloak users, Canton users with UUIDs)
   - Phase B: Config swap (topology.conf → topology-auth.conf) → Canton restart with auth → auth verification
   - Backends start after Canton is ready with auth
2. **Auth Flow:** Client gets OIDC token from Keycloak → sends to Backend → Backend validates via JWKS + resolves party → forwards token to Canton → Canton validates via JWKS
3. **Contract Flow:** trader-rojo (canActAs BancoRojo) → POST /api/assets → backend-rojo → Canton P1 → sync domain → BancoAzul can see on P2
4. **Authorization:** canActAs → can create/exercise (200), canReadAs → can query only (200 for reads, 403 for writes)
5. **Event Projection:** Event consumer (bot-rojo/bot-azul) polls Canton every 2s → parses CreatedEvent/ExercisedEvent → projects to PostgreSQL (active_contracts, contract_events, consumer_state)
6. **Query Flow:** GET /api/assets → reads from projection (PostgreSQL), not Canton directly

## Key APIs

Canton HTTP JSON API (with OIDC auth in Phase 2):
- `/v2/version` — health check (no auth required)
- `/v2/packages` — DAR upload (POST, octet-stream) — no auth in Phase A
- `/v2/parties` — party allocation/listing (requires admin rights with auth)
- `/v2/users` — user management (each user can read own record via `/v2/users/{id}`)
- `/v2/commands/submit-and-wait-for-transaction` — command submission (requires canActAs)
- `/v2/state/active-contracts` — contract queries (requires canReadAs, needs offset from `/v2/state/ledger-end`)

Keycloak Admin REST API:
- `/admin/realms` — realm management
- `/admin/realms/canton/client-scopes` — scope + mapper management
- `/admin/realms/canton/clients` — client management
- `/admin/realms/canton/users` — user CRUD
- `/realms/canton/protocol/openid-connect/token` — token endpoint (password grant)

## File Structure

```
infra/
├── docker-compose.yml          # PostgreSQL + Canton + Keycloak + backend-rojo + backend-azul
├── init-db.sql                 # 8 databases (5 Canton + keycloak + backend_rojo + backend_azul)
├── README.md                   # Quick start + troubleshooting
├── canton/
│   ├── Dockerfile              # Canton image from binaries
│   ├── topology.conf           # HOCON: 4 nodes, no auth (Phase A default)
│   ├── topology-auth.conf      # HOCON: 4 nodes, JWKS auth per participant
│   └── bootstrap/
│       └── init.canton         # Sync domain + participant connection
└── scripts/
    ├── package.json            # tsx, typescript
    ├── tsconfig.json
    ├── orchestrate.sh          # Two-phase bootstrap orchestration
    ├── bootstrap.ts            # DAR, parties, Keycloak setup, UUID-based users
    ├── keycloak-setup.ts       # Keycloak realm/client/scope/user provisioning
    └── smoke-test.ts           # OIDC auth + authorization test (11 checks)

backend/
├── Dockerfile                  # Node.js image for backend service
├── package.json                # Express, pg, jose, vitest, tsx
├── tsconfig.json
├── src/
│   ├── index.ts                # Express server entry point
│   ├── app.ts                  # Express app setup (routes, middleware)
│   ├── config.ts               # Environment variables (INSTITUTION_NAME, PARTICIPANT_URL, etc.)
│   ├── middleware/
│   │   ├── auth.ts             # JWKS validation, party resolution, token forwarding
│   │   └── correlation.ts      # X-Correlation-Id propagation
│   ├── routes/
│   │   ├── assets.ts           # POST/GET /api/assets
│   │   ├── swaps.ts            # POST /api/swaps/propose|accept|settle|reject|cancel, GET pending/settlements
│   │   └── events.ts           # GET /api/events, GET /api/contracts
│   ├── services/
│   │   ├── ledger-client.ts    # Canton JSON API v2 wrapper (create, exercise, query, updates)
│   │   ├── token-provider.ts   # Bot OIDC token via password grant (auto-renewal)
│   │   └── event-consumer.ts   # HTTP polling loop, projection to PostgreSQL
│   ├── db/
│   │   ├── pool.ts             # PostgreSQL connection pool
│   │   └── queries.ts          # SQL: insert/delete contracts, events, offset tracking
│   ├── utils/
│   │   └── logger.ts           # Structured JSON logging
│   └── __tests__/              # 7 test files, 49 unit tests
└── scripts/
    ├── run-scenario.ts         # Full swap flow integration test
    └── smoke-test.ts           # Endpoint-by-endpoint validation

docs/
├── lesson-01-canton-infrastructure.md
├── lesson-02-auth-oidc.md
└── lesson-03-backend-event-projection.md
```

## Projection Schema (PostgreSQL)

Each backend instance has its own database (backend_rojo, backend_azul) with:
- `active_contracts` (contract_id PK, template_id, payload JSONB, created_at)
- `contract_events` (id SERIAL PK, event_type, contract_id, template_id, choice, consuming, payload JSONB, offset_value)
- `consumer_state` (id PK, last_offset, updated_at)

## Not Yet Built (Future Phases)

- **Phase 4:** Temporal server, swap workflow orchestration
