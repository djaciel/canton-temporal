# Tech Debt Register

| # | Que | Origen | Por que se dejo | Prioridad | Estado |
|---|-----|--------|-----------------|-----------|--------|
| TD-001 | No hay DAR volume mount en Docker Compose | Fase 1 | Bootstrap script sube DAR via HTTP desde el host, que es funcional y mas flexible. Un mount seria redundante dado el workflow actual. | baja | abierto |
| TD-002 | Passwords de users hardcodeados en keycloak-setup.ts | Fase 2 | Aceptable para POC local. Deben externalizarse a env vars o config file para entornos compartidos. | baja | abierto |
| TD-003 | Función `updateOffset()` en queries.ts tiene parámetro unused y es dead code | Fase 3 | La lógica de offset se maneja inline en `processTransactionEvents`. La función quedó como residuo. | baja | abierto |
| TD-004 | Integration tests no ejecutados (smoke-test.ts, run-scenario.ts) | Fase 3 | Requieren infraestructura completa. Se validó vía unit tests y code review. Deben ejecutarse antes de Fase 4. | media | abierto |
