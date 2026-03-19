# Decision Log

| # | Fecha | Decisión | Contexto | Fase |
|---|-------|----------|----------|------|
| DEC-001 | 2026-03-17 | Single-process multi-node Canton | Spike S1 validó approach | 1 |
| DEC-002 | 2026-03-17 | Event projection manual (no PQS) | PQS es Enterprise-only | 3 |
| DEC-003 | 2026-03-17 | HTTP polling, no WebSocket ni gRPC | Spike S2 confirmó: no hay WebSocket en Canton 3.4.x | 3 |
| DEC-004 | 2026-03-17 | Backend parametrizado (1 codebase, 2 instancias) | Brainstorming consensus | 3 |
| DEC-005 | 2026-03-18 | Auth OIDC productivo con Canton JWKS | Spike S3 validó flujo completo | 2 |
| DEC-006 | 2026-03-18 | Two-phase bootstrap (sin auth → con auth) | Spike S3 descubrió chicken-and-egg | 1-2 |
| DEC-007 | 2026-03-17 | TypeScript/Express sobre Java/Spring | Experiencia existente, iteración rápida | All |
| DEC-008 | 2026-03-17 | Contratos Daml existentes sin cambios | Son agnósticos a topología de participants | All |
| DEC-009 | 2026-03-17 | Temporal como última capa (Fase 4) | Primero el flujo sin orquestación debe funcionar | 4 |
| DEC-010 | 2026-03-18 | Keycloak user UUID como Canton user ID | Spike S3: sub=UUID, no username | 2 |
| DEC-011 | 2026-03-18 | DAR upload via HTTP octet-stream, no multipart | Canton 3.4.11 acepta binary body directo | 1 |
| DEC-012 | 2026-03-18 | Canton HTTP API usa /v2/*, no /api/v2/* | API real no tiene prefijo /api | 1 |
| DEC-013 | 2026-03-18 | Party allocation via POST /v2/parties | Canton 3.4.11 usa endpoint base, no /v2/parties/allocate | 1 |
| DEC-014 | 2026-03-18 | Script externo (orchestrate.sh) para two-phase bootstrap | Mas flexible que servicios Docker separados | 2 |
| DEC-015 | 2026-03-18 | Config swap via file copy + restart | Copia topology-auth.conf, reinicia Canton, restaura original | 2 |
| DEC-016 | 2026-03-18 | Party resolution via /v2/users/{id} con auth habilitado | /v2/parties requiere admin rights con auth; users pueden leer su propio record | 2 |
| DEC-017 | 2026-03-18 | Event polling requiere token OIDC con auth habilitado | Spike S4: /v2/updates/flats y /v2/state/ledger-end retornan 401 sin token | 2 |
| DEC-018 | 2026-03-18 | User creation solo posible en Phase A (sin auth) | Spike S4: Canton retorna 403 al crear users con auth habilitado | 2 |
| DEC-019 | 2026-03-18 | Visibilidad cross-party restringida por Canton | Spike S4: filtrar por party sin permisos retorna 403. Un consumer por participant. | 2 |
| DEC-020 | 2026-03-18 | Template ID matching por sufijo (LIKE) en projection queries | Canton resuelve #pkg:Mod:Entity a hash:Mod:Entity en eventos; queries usan LIKE '%:Mod:Entity' | 3 |
| DEC-021 | 2026-03-18 | Assets requieren observers cross-institution para Settle atómico | Participant local no puede ver contratos de otro participant sin ser observer; assets se crean con observers: [counterparty] | 3 |

## Detailed Entries

### DEC-001: Single-process multi-node Canton en Docker

- **Contexto:** Necesitamos 2 participant nodes + sequencer + mediator para simular multi-institution real. El brainstorming identificó esto como riesgo #1.
- **Decisión:** Un solo proceso Canton con 4 nodos lógicos, cada uno con su propia DB PostgreSQL. Imagen Docker custom desde binarios (`canton-open-source-3.4.11.tar.gz` sobre `eclipse-temurin:17-jre`).
- **Razón:** No existen imágenes Docker oficiales. Single-process es más simple que contenedores separados por nodo y es el approach documentado por Canton. Spike S1 confirmó cross-participant visibility y atomic swaps.
- **Alternativas descartadas:** Contenedores separados por nodo (complejidad de networking innecesaria), `dpm sandbox` (oculta complejidad multi-node).
- **Consecuencias:** Requiere 5 databases PostgreSQL (sequencer, sequencer_driver, mediator, participant1, participant2). Bootstrap script necesita `tty: true` en Docker Compose.
- **Reversible:** Sí — se puede migrar a contenedores separados si se necesita aislamiento real.

### DEC-002: Event projection manual reemplaza PQS

- **Contexto:** PQS (Participant Query Store) permite queries SQL sobre contratos activos, pero requiere licencia Enterprise.
- **Decisión:** Construir event consumer con HTTP polling en `/v2/updates/flats` cada 2 segundos. Proyectar eventos a tablas PostgreSQL (`contract_events`, `active_contracts`, `consumer_state`).
- **Razón:** PQS confirmado Enterprise-only. El approach manual es mejor para aprendizaje — se entiende cada paso del pipeline. Spike S2 validó con 11 eventos procesados, offset tracking, y reconexión sin pérdida.
- **Alternativas descartadas:** PQS Enterprise (costo), gRPC streaming (innecesario dado que JSON API cubre todo).
- **Consecuencias:** Archives son `ExercisedEvent` con `consuming=true` (no hay `ArchivedEvent`). Offsets son integers. Polling agrega 0-2s latencia.
- **Reversible:** Sí — si PQS se abre en el futuro, se puede adoptar.

### DEC-003: HTTP polling exclusivo, sin WebSocket ni gRPC

- **Contexto:** Se asumía que `/v2/updates/flats` era WebSocket. Spike S2 descubrió que es HTTP POST estándar.
- **Decisión:** Usar HTTP polling con `fetch` nativo cada 2 segundos. Sin librería WebSocket ni gRPC.
- **Razón:** Canton 3.4.x HTTP Ledger API no soporta WebSocket. El endpoint retorna JSON array inmediatamente. `streamIdleTimeoutMs` no tiene efecto. Polling se integra naturalmente con Temporal (una actividad puede poll + checkpoint).
- **Alternativas descartadas:** WebSocket (no existe), gRPC streaming (complejidad innecesaria).
- **Consecuencias:** Latencia de 0-2s para event consumption. Simplifica el código (sin reconnection logic para WebSocket).
- **Reversible:** Sí — si versiones futuras de Canton agregan WebSocket, se puede migrar.

### DEC-005: Auth OIDC productivo — Canton valida tokens directamente

- **Contexto:** Se busca replicar el approach de producción, no simplificarlo por ser educativo. Spike S3 validó el flujo completo.
- **Decisión:** Canton participant nodes validan tokens OIDC vía JWKS de Keycloak. Backend reenvía el token del usuario al Ledger API. Canton enforce permisos canActAs/canReadAs.
- **Razón:** En producción, Canton es el enforcement point, no solo el backend. Spike S3 confirmó: token válido + canActAs → 200, token válido + canReadAs → 403, token inválido → 401.
- **Alternativas descartadas:** Backend como único gateway de auth (no realista, pierde la lección de seguridad de Canton).
- **Consecuencias:** Token lifetime ≤5min (Canton rechaza tokens largos). User IDs en Canton = UUID de Keycloak (no username). `oidc-sub-mapper` necesario en Keycloak 26. Two-phase bootstrap necesario.
- **Reversible:** Parcialmente — cambiar a backend-only auth es posible pero pierde el valor educativo.

### DEC-006: Two-phase bootstrap

- **Contexto:** Spike S3 descubrió: con auth habilitado, el Ledger API requiere token para crear users, pero no puedes obtener token sin un user existente.
- **Decisión:** Phase A: Canton arranca sin auth → bootstrap crea parties, users, upload DAR. Phase B: Canton reinicia con auth habilitado. PostgreSQL persiste datos entre reinicios.
- **Razón:** No hay otra forma de resolver el chicken-and-egg problem. El Admin API (gRPC) no protege con JWT, pero user management solo está en Ledger API.
- **Alternativas descartadas:** Init container con admin API (user mgmt no disponible vía admin API).
- **Consecuencias:** Docker Compose necesita orquestar el reinicio. El bootstrap script es más complejo.
- **Reversible:** No — es un requisito arquitectural de Canton con auth.

### DEC-010: Keycloak user UUID como Canton user ID

- **Contexto:** Spike S3 descubrió que el claim `sub` en Keycloak 26 es un UUID interno, no el username.
- **Decisión:** Canton user IDs serán los UUIDs de Keycloak. El backend mantiene un mapeo username → UUID para lookups.
- **Razón:** Canton mapea `sub` del token al user ID. No hay forma de cambiar esto sin custom protocol mappers que podrían romper el flujo OIDC estándar.
- **Alternativas descartadas:** Custom mapper para cambiar `sub` a username (frágil, no estándar).
- **Consecuencias:** El bootstrap debe crear users en Keycloak primero (obtener UUID), luego crear el Canton user con ese UUID.
- **Reversible:** No — determinado por la implementación de Canton.

### DEC-011: DAR upload via HTTP octet-stream

- **Contexto:** El spec de Fase 1 asumía que el DAR upload usaba multipart form data.
- **Decisión:** Usar `Content-Type: application/octet-stream` con el binary body directo.
- **Razón:** Canton 3.4.11 `POST /v2/packages` acepta octet-stream, no multipart. Descubierto durante implementación.
- **Reversible:** N/A — es la API de Canton.

### DEC-012: Canton HTTP API usa /v2/*, no /api/v2/*

- **Contexto:** El spec mencionaba `/api/v2/version` como endpoint de health check.
- **Decisión:** Todos los endpoints usan `/v2/*` sin prefijo `/api`.
- **Razón:** Canton 3.4.11 HTTP JSON API no tiene el prefijo `/api`. Confirmado: `/api/v2/version` retorna 404, `/v2/version` retorna 200.
- **Reversible:** N/A — es la API de Canton.

### DEC-013: Party allocation via POST /v2/parties

- **Contexto:** El spec mencionaba `POST /v2/parties/allocate` como endpoint.
- **Decisión:** Usar `POST /v2/parties` con body `{partyIdHint, displayName}`.
- **Razón:** Canton 3.4.11 usa el endpoint base para allocation. No existe `/v2/parties/allocate`.
- **Reversible:** N/A — es la API de Canton.

### DEC-014: Script externo (orchestrate.sh) para two-phase bootstrap

- **Contexto:** Fase 2 requeria orquestar: Canton sin auth → bootstrap → Canton con auth. Opciones: script externo, dos servicios Docker, o un solo servicio con entrypoint inteligente.
- **Decisión:** Shell script (`orchestrate.sh`) que controla Docker Compose, ejecuta bootstrap, hace config swap, y reinicia Canton.
- **Razón:** Un script externo es mas flexible y debuggable que logic dentro de Docker. Permite ejecutar cada paso manualmente si es necesario.
- **Alternativas descartadas:** Dos servicios Canton separados (complejidad de networking), entrypoint inteligente (oculta la logica).
- **Reversible:** Si — se puede migrar a Docker entrypoint si se necesita automatizacion total.

### DEC-015: Config swap via file copy + restart

- **Contexto:** Canton necesita arrancar con auth config despues del bootstrap. El archivo topology.conf esta montado via Docker bind mount.
- **Decisión:** Copiar topology-auth.conf sobre topology.conf, reiniciar el servicio Canton, y restaurar el archivo original inmediatamente.
- **Razón:** Canton lee la config al arrancar. La restauracion inmediata mantiene el repo limpio (topology.conf sin auth es el default para Phase A).
- **Consecuencias:** Si Canton se reinicia despues del orchestrate, usara la config sin auth (el default). Hay que volver a correr orchestrate.sh.
- **Reversible:** Si — se puede cambiar a Docker Compose override files o volumes nombrados.

### DEC-016: Party resolution via /v2/users/{id} con auth habilitado

- **Contexto:** Con auth habilitado, `GET /v2/parties` requiere admin rights (retorna PERMISSION_DENIED para users normales).
- **Decisión:** Usar `GET /v2/users/{userId}` para obtener el `primaryParty` de cada user. Cada user puede leer su propio record.
- **Razón:** No se quiere otorgar admin rights a users normales. El endpoint de users es suficiente para resolver la party de cada user.
- **Consecuencias:** El backend debe cachear el mapeo userId → primaryParty para evitar queries repetitivas.
- **Reversible:** Si — si se crea un admin service user, podria usar /v2/parties.

### DEC-017: Event polling requiere token OIDC con auth habilitado

- **Contexto:** Spike S2 probó event polling sin auth. Se desconocía si `/v2/updates/flats` requería token cuando Canton tiene `auth-services` habilitado.
- **Decisión:** El event consumer debe autenticarse con token OIDC. `canReadAs` es suficiente para polling — no necesita `canActAs`.
- **Razón:** Spike S4 confirmó: sin token → 401, con token canReadAs → 200. Canton aplica auth uniformemente a todos los endpoints HTTP (excepto `/v2/version`).
- **Consecuencias:** El event consumer necesita su propio Keycloak user + Canton user con `canReadAs`. Debe renovar tokens cada <300s.
- **Reversible:** No — es el comportamiento de Canton con auth.

### DEC-018: User creation solo posible en Phase A (sin auth)

- **Contexto:** Spike S4 intentó crear un Canton user con auth habilitado usando el token de trader-rojo.
- **Decisión:** Todos los users (incluyendo service users para event consumers) deben crearse durante Phase A del bootstrap (Canton sin auth).
- **Razón:** Canton retorna 403 al intentar crear users via `/v2/users` con un token de user normal. No hay un rol "admin" configurable via OIDC. Sin token → 401.
- **Consecuencias:** Si Fase 3 necesita users adicionales (event consumer), deben agregarse a `bootstrap.ts` y `keycloak-setup.ts`.
- **Reversible:** No — es una restricción de Canton con auth.

### DEC-019: Visibilidad cross-party restringida por Canton

- **Contexto:** Spike S4 probó si un user puede filtrar eventos de parties sobre las que no tiene permisos.
- **Decisión:** Cada event consumer solo puede observar parties para las que tiene `canReadAs`. Un consumer por participant, con `canReadAs` de la party local.
- **Razón:** Canton retorna 403 cuando un user filtra por una party sin permisos. El aislamiento es estricto.
- **Alternativa viable:** Reusar bot-rojo/bot-azul existentes (ya tienen `canActAs` que incluye lectura) como service users para el event consumer, evitando crear users nuevos.
- **Reversible:** No — es enforcement de Canton.

### DEC-020: Template ID matching por sufijo (LIKE) en projection queries

- **Contexto:** El backend usa `#asset-swap-contracts:Asset:Asset` como template ID para crear contratos (Canton resuelve el `#package-name`). Pero los eventos de Canton devuelven el template ID resuelto: `a3df4d9b...bc4:Asset:Asset` (hash completo del paquete).
- **Decisión:** Las queries de projection usan `LIKE '%:Module:Entity'` en vez de `= templateId`. La función `templateSuffix()` extrae los últimos dos segmentos (`:Module:Entity`).
- **Razón:** El event consumer almacena el template ID tal cual viene de Canton (con hash). Las queries desde los endpoints REST usan el formato `#pkg:Mod:Entity`. Un exact match siempre falla.
- **Consecuencias:** Queries usan LIKE en vez de `=`, lo cual es ligeramente menos eficiente pero correcto. Si hay colisiones de sufijo (improbable), se puede agregar un índice o normalizar al almacenar.
- **Reversible:** Sí — se podría normalizar el template ID al almacenar eventos (strip hash, keep Module:Entity).
- **Fase:** 3

### DEC-021: Assets requieren observers cross-institution para Settle atómico

- **Contexto:** El Settle del SwapSettlement ejecuta `exercise offeredAssetCid Transfer` y `exercise counterpartyAssetCid Transfer` en una sola transacción Daml. Canton necesita que el participant que submite pueda ver ambos contratos.
- **Decisión:** Al crear assets para swap, se incluye la contraparte como observer: `observers: [counterpartyParty]`. Esto hace que el asset sea visible en ambos participants via el sync domain.
- **Razón:** Sin observers, participant1 no puede ver el asset creado en participant2, y Canton retorna `CONTRACT_NOT_FOUND` al intentar Settle. Confirmado en integration test.
- **Consecuencias:** El frontend/caller debe conocer la party de la contraparte antes de crear el asset. Los scripts `run-scenario.ts` y `smoke-test.ts` primero resuelven parties y luego crean assets con observers.
- **Reversible:** No — es un requisito del modelo UTXO de Daml con multi-participant.
- **Fase:** 3
