# Roadmap

## Objetivo Final

Un repositorio ejecutable que demuestra la arquitectura completa de una solución Canton multi-institution: infraestructura distribuida, auth OIDC productivo, event streaming con projection, y orquestación con Temporal. Cada capa documentada como lección.

## Fases

### Fase 1: Infraestructura Canton — COMPLETADA

- **Objetivo:** Levantar la infraestructura Canton multi-node con Docker Compose y validar que funciona con un test manual
- **Entregable:** `docker compose up` levanta Canton (2 participants + sequencer + mediator) + PostgreSQL. Bootstrap script crea sync domain, conecta participants, sube DAR, aloca parties, crea users. Un script de smoke test ejecuta un contrato cross-participant.
- **Estado:** completada (2026-03-18)
- **Validacion:** PASS — 14/14 acceptance criteria, 14/14 validation commands, smoke test 6/6
- **Commit:** 0a75b94 — 12 files, 971 insertions
- **Closure:** `.framework/phases/phase-01/closure-report.md`

### Fase 2: Auth OIDC con Keycloak — COMPLETADA

- **Objetivo:** Agregar Keycloak como identity provider y configurar Canton para validar tokens OIDC vía JWKS. Implementar two-phase bootstrap que orqueste el arranque sin auth → provisioning → reinicio con auth.
- **Entregable:** Keycloak levanta con realm configurado. Canton valida tokens. Two-phase bootstrap funciona end-to-end. Smoke test con auth: token válido + canActAs → contrato creado, token inválido → 401, token válido + canReadAs → 403.
- **Estado:** completada (2026-03-18)
- **Validacion:** PASS — 9/9 acceptance criteria, 11/11 smoke test checks, all validation commands pass
- **Commits:** 4e09454..dafc108 — 5 commits, 12 files
- **Closure:** `.framework/phases/phase-02/closure-report.md`

### Fase 3: Backend + Event Projection + Script Runner — COMPLETADA

- **Objetivo:** Backend institucional parametrizado con REST API, event consumer, projection a PostgreSQL, y script runner de escenarios. El backend actua como proxy autenticado — reenvia tokens OIDC del cliente a Canton.
- **Entregable:** Dos backends (Rojo/Azul) en Docker Compose. REST endpoints para assets y swaps (CRUD completo). Event consumer proyectando a PostgreSQL. Script runner ejecutando escenario completo de swap. Logging estructurado con correlation ID.
- **Estado:** completada (2026-03-18)
- **Validacion:** PASS (conditional) — 49 unit tests, 20/20 acceptance criteria pass. Integration tests pendientes de infraestructura.
- **Commits:** e0ab99b..0495b88 — 11 commits (T-01 a T-10 + bug fix), 32 files
- **Closure:** `.framework/phases/phase-03/closure-report.md`
- **Decisiones nuevas:** DEC-020 (template ID LIKE matching), DEC-021 (observers cross-institution para Settle)

### Fase 4: Temporal Orchestration — DEFINIDA

- **Objetivo:** Agregar Temporal como capa de orquestación para el flujo de swap, reemplazando las llamadas directas del script runner con un workflow durable que maneja propose → wait for accept → settle con compensación y observabilidad.
- **Entregable:** Temporal server en Docker Compose. Workflow de swap que orquesta el ciclo completo. Worker que ejecuta actividades contra los backends REST API. Script runner adaptado para iniciar workflows via Temporal. Dashboard de Temporal mostrando estado de workflows.
- **Estimación:** 2-3 días
- **Estado:** pendiente
- **Dependencias:** Fase 3 (completada — backends, event consumer, projection)
- **Pregunta clave de diseño:** ¿Debe Temporal orquestar todo el flujo de swap (propose → wait for accept → settle) como un solo workflow, o separar en workflows independientes por etapa? ¿Cómo detecta el workflow que la contraparte aceptó — polling del event consumer, signal externo desde el backend, o query directa a Canton?
- **Contexto de Fase 3:**
  - `backend/src/services/ledger-client.ts` — Canton API wrapper; activities pueden llamar estos métodos
  - `backend/src/services/event-consumer.ts` — Polling pattern reutilizable como Temporal activity
  - `backend/src/services/token-provider.ts` — Bot token management para Temporal workers
  - `backend/scripts/run-scenario.ts` — Referencia directa del flujo que el workflow debe orquestar
  - `ts-client/` — Código Temporal existente del setup inicial (posible reutilización)
  - Template IDs usan LIKE matching (DEC-020) — activities deben usar el mismo patrón
  - Bot user (bot-rojo) tiene canActAs y se usa como settler (DEC-021)
  - Integration tests de Fase 3 deben ejecutarse ANTES de comenzar Fase 4 (TD-004)
- **Tareas (high-level):**
  - Agregar Temporal server + UI a Docker Compose
  - Definir workflow de swap con actividades (propose, waitForAccept, settle)
  - Implementar actividades que llaman a los backends REST API o directamente a Canton
  - Mecanismo de detección de Accept (signal, polling, o query)
  - Compensación: si settle falla, workflow puede reintentar o cancelar
  - Adaptar script runner para iniciar workflows via Temporal client
  - Documentar lecciones de Capa 4 (orquestación, durabilidad, observabilidad)
- → Se detallará con spec completo via pbs-phase-planning
