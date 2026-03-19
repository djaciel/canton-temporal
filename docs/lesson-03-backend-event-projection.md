# Lesson 03: Backend Services + Event Projection

## What Problem Does This Solve?

In Lessons 01 and 02, all interaction with Canton was through direct API calls — scripts hitting the Canton HTTP JSON API with raw commands. This works for bootstrapping and testing, but a real application needs:

- **REST API** — A clean interface for frontend clients, hiding Canton's command structure
- **Event projection** — A queryable read model in PostgreSQL, since Canton's ACS queries require party-specific filters and offsets
- **Auth forwarding** — The backend validates the user's OIDC token and forwards it to Canton, acting as an authenticated proxy

## Parametrized Backend (One Codebase, Two Instances)

The backend is a single Express/TypeScript codebase that runs as two independent instances:

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│  backend-rojo (port 3001)    │     │  backend-azul (port 3002)    │
│  INSTITUTION_NAME=BancoRojo  │     │  INSTITUTION_NAME=BancoAzul  │
│  PARTICIPANT_URL=:5013       │     │  PARTICIPANT_URL=:5023       │
│  DB: backend_rojo            │     │  DB: backend_azul            │
│  BOT: bot-rojo               │     │  BOT: bot-azul               │
└──────────────┬──────────────┘     └──────────────┬──────────────┘
               │                                    │
        ┌──────▼──────┐                      ┌──────▼──────┐
        │ participant1 │                      │ participant2 │
        └─────────────┘                      └─────────────┘
```

Environment variables control which participant and database each instance uses. No code changes are needed — the same Docker image runs with different env vars.

## Auth Middleware Pattern (JWKS + Forward)

The backend does NOT generate its own tokens for user operations. Instead it:

1. **Validates** the incoming JWT locally via Keycloak's JWKS endpoint (signature, expiry)
2. **Extracts** the `sub` claim (Keycloak UUID = Canton user ID)
3. **Resolves** the user's `primaryParty` via Canton's `/v2/users/{userId}` (cached in-memory)
4. **Forwards** the original token to Canton in every API call

```
Client                  Backend                    Canton
  │                       │                          │
  │  Authorization:       │                          │
  │  Bearer <JWT>         │                          │
  │──────────────────────→│                          │
  │                       │                          │
  │                       │ 1. Verify JWT (JWKS)     │
  │                       │ 2. Extract sub → userId  │
  │                       │ 3. Resolve primaryParty  │
  │                       │    (cached)              │
  │                       │                          │
  │                       │  Authorization:          │
  │                       │  Bearer <same JWT>       │
  │                       │─────────────────────────→│
  │                       │                          │
  │                       │  Canton validates token  │
  │                       │  + checks permissions    │
  │                       │←─────────────────────────│
  │                       │                          │
  │  HTTP 201 / 200       │                          │
  │←──────────────────────│                          │
```

This means Canton's authorization model (canActAs/canReadAs) is enforced at the ledger level — the backend cannot bypass it.

## Event Consumer Pattern

Canton doesn't have a push notification system in version 3.4.x. Instead, the backend polls for updates:

```
┌──────────────┐        ┌──────────────┐        ┌──────────────┐
│ Event Consumer│       │   Canton      │        │  PostgreSQL   │
│ (poll loop)   │       │  Participant  │        │  (projection) │
└──────┬───────┘       └──────┬───────┘        └──────┬───────┘
       │                      │                        │
       │  Every 2 seconds:    │                        │
       │                      │                        │
       │  POST /v2/updates/   │                        │
       │  flats               │                        │
       │  {beginExclusive:    │                        │
       │   lastOffset}        │                        │
       │─────────────────────→│                        │
       │                      │                        │
       │  Transaction[]       │                        │
       │←─────────────────────│                        │
       │                      │                        │
       │  For each event:                              │
       │  CreatedEvent →──────────────────────────────→│ INSERT active_contracts
       │                                               │ INSERT contract_events
       │  ExercisedEvent ─────────────────────────────→│ DELETE active_contracts
       │  (consuming)                                  │ INSERT contract_events
       │                                               │
       │  UPDATE consumer_state (offset) ─────────────→│
       │                                               │
```

### Key design decisions:

- **Bot user authentication** — The consumer uses a bot user (bot-rojo/bot-azul) to authenticate with Canton. The `TokenProvider` handles automatic renewal before the 300s token lifetime expires.
- **Offset tracking** — The last processed offset is stored in `consumer_state`. On restart, the consumer reads this and resumes without missing events.
- **Atomic batches** — All events from a single Canton transaction are processed in a single SQL transaction, ensuring consistency.
- **One consumer per participant** — Each backend instance only consumes events from its own participant (DEC-019).

## Projection Schema

Three tables make up the projection:

```sql
-- Immutable event log
contract_events (
  id              SERIAL PRIMARY KEY,
  event_type      VARCHAR(20),        -- 'created' or 'exercised'
  contract_id     VARCHAR(500),
  template_id     VARCHAR(500),       -- e.g., '#asset-swap-contracts:Asset:Asset'
  choice          VARCHAR(200),       -- e.g., 'Accept', 'Settle' (for exercised)
  consuming       BOOLEAN,
  payload         JSONB,              -- contract arguments
  offset_value    BIGINT,
  effective_at    TIMESTAMPTZ
)

-- Materialized active contracts (insert on create, delete on archive)
active_contracts (
  contract_id     VARCHAR(500) PRIMARY KEY,
  template_id     VARCHAR(500),
  payload         JSONB,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
)

-- Offset tracking for consumer restart
consumer_state (
  id              VARCHAR(50) PRIMARY KEY,  -- 'main'
  last_offset     BIGINT,
  updated_at      TIMESTAMPTZ
)
```

The REST endpoints read from these tables directly — no Canton API calls needed for queries.

## REST API Endpoints

| Method | Path | Auth | Source | Description |
|--------|------|------|--------|-------------|
| GET | `/health` | No | — | Health check |
| POST | `/api/assets` | canActAs | Canton | Create asset |
| GET | `/api/assets` | Yes | Projection | List active assets |
| POST | `/api/swaps/propose` | canActAs | Canton | Create SwapProposal |
| POST | `/api/swaps/:id/accept` | canActAs | Canton | Exercise Accept |
| POST | `/api/swaps/:id/settle` | canActAs | Canton | Exercise Settle |
| POST | `/api/swaps/:id/reject` | canActAs | Canton | Exercise Reject |
| POST | `/api/swaps/:id/cancel` | canActAs | Canton | Exercise Cancel |
| GET | `/api/swaps/pending` | Yes | Projection | List active SwapProposals |
| GET | `/api/swaps/settlements` | Yes | Projection | List active SwapSettlements |
| GET | `/api/events` | Yes | Projection | Paginated event history |
| GET | `/api/contracts` | Yes | Projection | All active contracts |

Write endpoints (POST) forward the user's token to Canton. Read endpoints (GET) query the local PostgreSQL projection.

## Important Gotchas

### 1. Token refresh for the event consumer

The bot token has a 300-second lifetime. The `TokenProvider` renews it 30 seconds before expiry. If renewal fails, the consumer logs the error and retries on the next polling cycle — it never crashes.

### 2. Party resolution caching

The auth middleware caches `userId → primaryParty` mappings in-memory. This avoids an HTTP call to Canton on every request. The cache lives for the lifetime of the process — if party assignments change (they shouldn't in normal operation), the backend needs a restart.

### 3. Consuming vs non-consuming exercise events

An `ExercisedEvent` with `consuming=true` means the contract is archived — it must be deleted from `active_contracts`. Non-consuming exercises (e.g., read-only choices) only get logged to `contract_events` without deleting the contract.

### 4. Projection is eventually consistent

There's a 2-4 second delay between a Canton transaction and the data appearing in the projection. The script runner accounts for this with `sleep(4000)` between mutations and queries. Clients should be aware of this delay.

### 5. Correlation ID for cross-institution tracing

Every HTTP request gets a correlation ID (from `X-Correlation-Id` header or auto-generated UUID). This ID appears in structured JSON logs and the response header, enabling tracing of a single operation across both backends. The event consumer generates its own correlation ID per polling cycle.

### 6. Error propagation from Canton

The backend translates Canton HTTP errors:
- Canton 403 → Backend 403 (insufficient permissions)
- Canton 401 → Backend 401 (token issue)
- Canton 5xx → Backend 502 (ledger unavailable)
- Canton unreachable → Backend 503 (service unavailable)

## How to Verify Everything Works

```bash
# Start full infrastructure
cd infra && bash scripts/orchestrate.sh

# Start backends (if not in Docker Compose)
cd backend && INSTITUTION_NAME=BancoRojo PARTICIPANT_URL=http://localhost:5013 \
  DB_URL=postgresql://canton:canton@localhost:5432/backend_rojo \
  BOT_USERNAME=bot-rojo BOT_PASSWORD=bot123 PORT=3001 npx tsx src/index.ts

# Run smoke test (validates all endpoints + auth + correlation ID)
cd backend/scripts && npx tsx smoke-test.ts

# Run full swap scenario (end-to-end integration test)
cd backend/scripts && npx tsx run-scenario.ts
```

## File Structure (Phase 3 additions)

```
backend/
├── Dockerfile
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # Server startup + event consumer init
│   ├── app.ts                      # Express app, middleware, route registration
│   ├── config.ts                   # Environment variables
│   ├── middleware/
│   │   ├── auth.ts                 # OIDC token validation via JWKS + party resolution
│   │   └── correlation.ts          # X-Correlation-Id middleware
│   ├── routes/
│   │   ├── assets.ts               # POST/GET /api/assets
│   │   ├── swaps.ts                # POST /api/swaps/* + GET pending/settlements
│   │   └── events.ts               # GET /api/events + GET /api/contracts
│   ├── services/
│   │   ├── ledger-client.ts        # Canton JSON API v2 wrapper (token forwarding)
│   │   ├── token-provider.ts       # Bot OIDC token with auto-renewal
│   │   └── event-consumer.ts       # HTTP polling loop + projection pipeline
│   ├── db/
│   │   ├── pool.ts                 # PostgreSQL connection pool
│   │   └── queries.ts              # SQL functions for projection + queries
│   └── utils/
│       └── logger.ts               # Structured JSON logger
└── scripts/
    ├── package.json
    ├── tsconfig.json
    ├── run-scenario.ts             # Full swap scenario runner
    └── smoke-test.ts               # Endpoint validation smoke test
```
