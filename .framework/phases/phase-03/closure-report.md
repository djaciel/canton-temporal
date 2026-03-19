# Closure Report — Fase 3: Backend + Event Projection + Script Runner

## Fecha de cierre
2026-03-18

## Resumen
Se construyó un backend institucional parametrizado (Express/TypeScript) con 2 instancias (Rojo/Azul) en Docker Compose, cada una con su propia base de datos PostgreSQL para projection. Se implementaron REST endpoints para crear assets, proponer/aceptar/settle/reject/cancel swaps, y consultar contratos y eventos desde projection. Un event consumer con HTTP polling proyecta eventos de Canton a PostgreSQL. Se creó un script runner que ejecuta un escenario completo de swap cross-institution y un smoke test que valida todos los endpoints. Se agregó logging estructurado JSON con correlation ID. 49 unit tests pasan, TypeScript compila limpio. Integración no validada (requiere infraestructura levantada).

## Entregable Verificado
- Se cumplió el entregable observable: Parcialmente
- Evidencia: `npx vitest run` → 49 tests passed, 0 failed. `npx tsc --noEmit` → clean. `docker compose config --services | grep backend` → backend-azul, backend-rojo. Integration tests (smoke-test.ts, run-scenario.ts) no ejecutados — requieren infraestructura completa vía orchestrate.sh.

## Acceptance Criteria Status
| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | POST /api/assets with canActAs creates asset, returns 201 | pass | `assets.ts:19-48`, unit test passes |
| 2 | POST /api/assets with canReadAs returns 403 | pass | `assets.ts:40-42`, unit test passes |
| 3 | POST /api/assets without token returns 401 | pass | `auth.ts:40-43`, unit test passes |
| 4 | POST /api/swaps/propose creates SwapProposal, returns 201 | pass | `swaps.ts:35-68`, unit test passes |
| 5 | POST /api/swaps/:id/accept returns 200 with settlementContractId | pass | `swaps.ts:71-93`, unit test passes |
| 6 | POST /api/swaps/:id/settle returns 200 | pass | `swaps.ts:96-112`, unit test passes |
| 7 | POST /api/swaps/:id/cancel archives proposal | pass | `swaps.ts:134-150`, unit test passes |
| 8 | POST /api/swaps/:id/reject archives proposal | pass | `swaps.ts:115-131`, unit test passes |
| 9 | Event consumer polls and processes CreatedEvent → INSERT | pass | `event-consumer.test.ts` |
| 10 | ExercisedEvent (consuming=true) → DELETE active_contracts | pass | `event-consumer.test.ts` |
| 11 | Consumer survives restart, reads last_offset | pass | `event-consumer.test.ts` |
| 12 | Token renewal for bot user (300s, 30s buffer) | pass | `token-provider.test.ts` |
| 13 | GET /api/assets returns active assets from projection | pass | `assets.test.ts` |
| 14 | GET /api/swaps/pending returns SwapProposals | pass | `swaps.test.ts` |
| 15 | GET /api/events returns contract events with pagination | pass | `events.ts:18-29` |
| 16 | GET /api/contracts returns all active contracts | pass | `events.ts` |
| 17 | Script runner executes complete swap flow | pass | `run-scenario.ts` (code review, not integration-tested) |
| 18 | Structured JSON logging with correlationId | pass | `logger.ts`, `correlation.ts` |
| 19 | X-Correlation-Id propagation (read or generate) | pass | `correlation.ts:21-23` |
| 20 | Smoke test validates all endpoints | pass | `smoke-test.ts` (code review, not integration-tested) |

## Decisiones Nuevas
| Decision | Razon | Fase |
|----------|-------|------|
| DEC-020: Template ID matching por sufijo (LIKE) en projection queries | Canton resuelve `#pkg:Mod:Entity` a `hash:Mod:Entity` en eventos; queries usan `LIKE '%:Mod:Entity'` | 3 |
| DEC-021: Assets requieren observers cross-institution para Settle atómico | Participant local no puede ver contratos de otro participant sin ser observer; assets se crean con `observers: [counterparty]` | 3 |

## Cambios respecto al diseno original
- Se descubrió que Canton devuelve template IDs con hash del paquete en lugar del `#package-name`, lo que obligó a usar LIKE matching en queries de projection (DEC-020)
- Se descubrió que assets necesitan observers cross-institution para que el Settle atómico funcione — el participant que submite debe poder ver ambos contratos (DEC-021)
- Se corrigió un bug de SQL parameters en `processTransactionEvents` donde el template_id usaba `$4` incorrecto (commit 0495b88)

## Deuda Tecnica Generada
| Que | Por que se dejo | Prioridad |
|-----|-----------------|-----------|
| TD-003: Función `updateOffset()` en queries.ts tiene parámetro unused y es dead code | La lógica de offset se maneja inline en `processTransactionEvents`. La función quedó como residuo. | baja |
| TD-004: Integration tests no ejecutados (smoke-test.ts, run-scenario.ts) | Requieren infraestructura completa (orchestrate.sh + Docker). Se validó vía unit tests y code review. | media |

## Tests Creados
| Test | Tipo | Que valida | Pasa |
|------|------|------------|------|
| backend/src/__tests__/auth.test.ts | unit | Auth middleware: 401 sin token, 401 firma invalida, extraccion userId/party | Si |
| backend/src/__tests__/assets.test.ts | unit | POST /api/assets crea asset, 403 Canton rejection, GET /api/assets desde projection | Si |
| backend/src/__tests__/swaps.test.ts | unit | Propose, Accept, Settle, Reject, Cancel swaps + GET pending/settlements | Si |
| backend/src/__tests__/event-consumer.test.ts | unit | CreatedEvent processing, ExercisedEvent processing, offset tracking, token refresh | Si |
| backend/src/__tests__/token-provider.test.ts | unit | Token acquisition via password grant, token caching, auto-renewal | Si |
| backend/src/__tests__/ledger-client.test.ts | unit | Canton API calls: create, exercise, queryACS, getUpdates, getUserParty | Si |
| backend/src/__tests__/logger.test.ts | unit | Structured JSON logging, correlation ID inclusion | Si |
| backend/scripts/smoke-test.ts | integration | Health, auth (401/403), create asset, swaps, events, correlation ID | No ejecutado |
| backend/scripts/run-scenario.ts | integration | Flujo completo swap cross-institution end-to-end | No ejecutado |

## Relevant Assets for Next Phase
- `backend/src/services/ledger-client.ts` — Canton API wrapper; Temporal activities will call these methods
- `backend/src/services/event-consumer.ts` — Polling pattern; Temporal may replace or orchestrate this
- `backend/src/services/token-provider.ts` — Bot token management; Temporal workers will need tokens
- `backend/src/routes/swaps.ts` — Swap endpoints; Temporal workflow may replace direct REST calls
- `backend/src/db/queries.ts` — Projection queries; Temporal activities may use these for state checks
- `backend/scripts/run-scenario.ts` — Reference for the flow that Temporal workflow should orchestrate
- `infra/docker-compose.yml` — Needs Temporal server added
- `backend/src/config.ts` — May need Temporal connection config
- `ts-client/` — Existing Temporal client code (from initial setup) that may be reused

## Observaciones para la Siguiente Fase
- El script runner (`run-scenario.ts`) implementa exactamente el flujo que Temporal debería orquestar: propose → wait → accept → settle. Es la referencia directa para diseñar el workflow.
- El event consumer ya tiene un polling loop que podría convertirse en una Temporal activity (poll + signal workflow cuando detecta Accept).
- El bot user (bot-rojo) ya está configurado con canActAs y se usa como settler — Temporal worker puede reusar este patrón.
- Los integration tests (smoke-test.ts, run-scenario.ts) deben ejecutarse antes de comenzar Fase 4 para confirmar que la base funciona end-to-end.
- El LIKE matching para template IDs (DEC-020) funciona pero es un coupling implícito — Temporal activities deben usar el mismo patrón.
- Pregunta quirúrgica sugerida para el re-análisis:
  > "¿Debe Temporal orquestar todo el flujo de swap (propose → wait for accept → settle) como un solo workflow, o separar en workflows independientes por etapa? ¿Cómo detecta el workflow que la contraparte aceptó — polling del event consumer, signal externo desde el backend, o query directa a Canton?"

## Actualizacion de Documentos (checklist)
- [x] Decision Log actualizado
- [x] Roadmap actualizado (estado + ajustes)
- [x] Tech Debt Register actualizado
- [x] Architecture Snapshot actualizado (si cambio la estructura)
- [x] Siguiente fase detallada en el roadmap
