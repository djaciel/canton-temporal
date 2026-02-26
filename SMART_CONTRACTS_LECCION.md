# Lección: Arquitectura de Smart Contracts con Daml

> Este documento explica, paso a paso, cómo están diseñados los smart contracts del proyecto Asset Swap. Está escrito como repaso de lo aprendido, con énfasis en el _por qué_ de cada decisión.

---

## Índice

1. [¿Qué es un smart contract en Daml?](#1-qué-es-un-smart-contract-en-daml)
2. [Conceptos clave antes de empezar](#2-conceptos-clave-antes-de-empezar)
3. [El contrato `Asset`](#3-el-contrato-asset)
4. [El patrón Propose-Accept: `SwapProposal`](#4-el-patrón-propose-accept-swapproposal)
5. [El settlement atómico: `SwapSettlement`](#5-el-settlement-atómico-swapsettlement)
6. [Flujo completo: de la propuesta al intercambio](#6-flujo-completo-de-la-propuesta-al-intercambio)
7. [El patrón UTXO: Split y Merge](#7-el-patrón-utxo-split-y-merge)
8. [El patrón de Batching: `TransferRequest` y `TransferBatch`](#8-el-patrón-de-batching-transferrequest-y-transferbatch)
9. [Decisión de diseño importante: ¿quién firma qué?](#9-decisión-de-diseño-importante-quién-firma-qué)
10. [Los tests: qué verificamos y por qué](#10-los-tests-qué-verificamos-y-por-qué)
11. [Por qué el proyecto está dividido en dos paquetes](#11-por-qué-el-proyecto-está-dividido-en-dos-paquetes)

---

## 1. ¿Qué es un smart contract en Daml?

Un smart contract en Daml es simplemente un **acuerdo digital entre partes** que vive en el ledger (el registro distribuido). Tiene tres responsabilidades:

1. **Guardar datos** (los campos del contrato).
2. **Definir quién puede ver esos datos** (observers).
3. **Definir qué acciones se pueden hacer con él y quién las puede ejecutar** (choices).

Lo más importante: **el ledger garantiza que las reglas se cumplen**. No es posible hacer algo que el contrato no permite, sin importar lo que intente el código externo.

En Daml, un contrato se define con la palabra clave `template`:

```daml
template NombreDelContrato
  with
    campo1 : Tipo
    campo2 : Tipo
  where
    signatory ...  -- quién firmó este contrato
    observer  ...  -- quién puede verlo
    -- aquí van las acciones posibles (choices)
```

---

## 2. Conceptos clave antes de empezar

Antes de ver el código, hay cuatro conceptos que se repiten en todo Daml. Entenderlos bien hace que todo lo demás sea claro.

### Signatory (firmante)

El signatory es la(s) parte(s) que **deben autorizar la creación del contrato**. Al firmar, están aceptando las obligaciones que el contrato implica. Nadie puede crear un contrato en tu nombre sin tu firma.

> Analogía: el firmante en un contrato legal. Sin su firma, el documento no vale.

### Observer (observador)

Un observer puede **ver el contrato** en el ledger pero no tiene ninguna obligación ni puede hacer acciones por sí solo. Se usa para dar visibilidad a partes interesadas.

> Analogía: un testigo en una notaría. Ve lo que pasa pero no firma.

### Controller (quien controla una acción)

Dentro de cada `choice` (acción), el `controller` define **quién puede ejecutar esa acción**. Solo esa parte puede invocar la choice.

> Analogía: la persona que tiene la llave para abrir una caja fuerte específica.

### ContractId (identificador de contrato)

Cada contrato vive en el ledger con un identificador único, el `ContractId`. Cuando un contrato referencia a otro, lo hace a través de su `ContractId`. Es como un puntero o una foreign key en una base de datos.

---

## 3. El contrato `Asset`

El `Asset` es el bloque fundamental del sistema. Representa **un activo tokenizado**: puede ser una moneda, un token, un bono, cualquier cosa con valor.

```daml
template Asset
  with
    issuer   : Party    -- quien emitió el activo
    owner    : Party    -- quien lo posee actualmente
    symbol   : Text     -- nombre del token (ej: "TokenX")
    quantity : Decimal  -- cantidad
    observers : [Party] -- partes que pueden verlo
  where
    signatory issuer
    observer owner :: observers

    ensure quantity > 0.0
```

### ¿Qué hace cada parte?

- `issuer` es quien **emitió** el activo. Es el único signatory.
- `owner` es quien **lo tiene** actualmente. Puede ejecutar acciones sobre él.
- `ensure quantity > 0.0` es una **invariante**: el ledger rechazará cualquier intento de crear un Asset con cantidad cero o negativa. Es validación automática e inmutable.

### Las acciones disponibles (choices)

| Choice | Controller | Qué hace |
|--------|------------|----------|
| `Transfer` | `owner` | Transfiere el activo a otro dueño |
| `Split` | `owner` | Divide el activo en dos (patrón UTXO) |
| `Merge` | `owner` | Une dos activos del mismo símbolo en uno |
| `Disclose` | `owner` | Agrega un observador para dar visibilidad |

### Cómo funciona `Transfer`

```daml
choice Transfer : ContractId Asset
  with
    newOwner : Party
  controller owner
  do
    create this with owner = newOwner
```

- El contrato actual se **consume** (desaparece del ledger).
- Se **crea uno nuevo** idéntico pero con `owner = newOwner`.
- Esto garantiza que no hay doble gasto: el contrato original deja de existir.

> Nota: En Daml, todas las choices son consumibles por defecto. Cuando se ejecuta una choice, el contrato original se archiva y si la choice crea nuevos contratos, esos son los nuevos activos vivos en el ledger.

---

## 4. El patrón Propose-Accept: `SwapProposal`

Para que dos partes intercambien activos, no basta con que una parte decida transferir. La otra parte también tiene que **consentir**. Este patrón se llama **Propose-Accept** y es uno de los patrones de diseño más comunes en Daml.

```
Alice ──[propone swap]──► SwapProposal ──[Bob acepta]──► SwapSettlement
```

El contrato `SwapProposal` modela la oferta:

```daml
template SwapProposal
  with
    proposer          : Party
    counterparty      : Party
    settler           : Party
    offeredAssetCid   : ContractId Asset  -- el activo que ofrece el proposer
    offeredSymbol     : Text
    offeredQuantity   : Decimal
    requestedSymbol   : Text              -- lo que pide a cambio
    requestedQuantity : Decimal
  where
    signatory proposer        -- solo Alice firma al crear la propuesta
    observer counterparty, settler
```

### ¿Por qué solo el proposer es signatory?

Porque en este momento **solo Alice está comprometida**. Bob aún no ha aceptado nada. Al crear el `SwapProposal`, Alice está diciendo: "yo me comprometo a ofrecer esto". Bob solo puede ver la propuesta (es observer).

### Las tres respuestas posibles

**1. Accept** — Bob acepta y compromete su activo:

```daml
choice Accept : ContractId SwapSettlement
  with
    counterpartyAssetCid : ContractId Asset
  controller counterparty   -- solo Bob puede aceptar
  do
    -- Validaciones antes de aceptar
    pledged <- fetch counterpartyAssetCid
    assertMsg "El símbolo debe coincidir" (pledged.symbol == requestedSymbol)
    assertMsg "La cantidad debe ser suficiente" (pledged.quantity >= requestedQuantity)
    assertMsg "El activo debe ser de Bob" (pledged.owner == counterparty)

    create SwapSettlement with ...
```

Nótese que antes de aceptar, el ledger **valida automáticamente** que el activo que Bob ofrece es realmente el correcto. Si no cumple las condiciones, la transacción falla completa.

**2. Reject** — Bob rechaza:

```daml
choice Reject : ()
  controller counterparty
  do return ()
```

Simple: el contrato se archiva y no pasa nada más.

**3. Cancel** — Alice se arrepiente:

```daml
choice Cancel : ()
  controller proposer
  do return ()
```

Solo Alice puede cancelar su propia propuesta. Bob no puede cancelar la propuesta de Alice.

---

## 5. El settlement atómico: `SwapSettlement`

Cuando Bob acepta, se crea un `SwapSettlement`. Este contrato representa **un acuerdo listo para ejecutarse**. Ambas partes ya dijeron que sí.

```daml
template SwapSettlement
  with
    proposer             : Party
    counterparty         : Party
    settler              : Party
    offeredAssetCid      : ContractId Asset
    counterpartyAssetCid : ContractId Asset
    ...
  where
    signatory proposer, counterparty  -- ahora AMBOS firman
    observer settler
```

### La diferencia clave con `SwapProposal`

| | `SwapProposal` | `SwapSettlement` |
|--|----------------|-----------------|
| Signatories | Solo Alice | Alice Y Bob |
| Estado | Pendiente de respuesta | Listo para ejecutar |
| Quién lo crea | Alice | El ledger, al ejecutar `Accept` |

Ahora que ambos firmaron, el `settler` (el Operator) puede ejecutar el intercambio.

### El intercambio atómico: `Settle`

```daml
choice Settle : (ContractId Asset, ContractId Asset)
  controller settler
  do
    -- Leg 1: el activo de Alice va a Bob
    newAssetForCounterparty <- exercise offeredAssetCid Transfer
      with newOwner = counterparty

    -- Leg 2: el activo de Bob va a Alice
    newAssetForProposer <- exercise counterpartyAssetCid Transfer
      with newOwner = proposer

    return (newAssetForCounterparty, newAssetForProposer)
```

La palabra clave aquí es **atómico**: las dos transferencias ocurren dentro de **una sola transacción** en el ledger. Esto significa:

- O las dos transferencias se completan → el swap sucede.
- O algo falla → **ninguna** de las dos ocurre.

No existe el riesgo de que Alice entregue su activo pero Bob no entregue el suyo.

### También existe `Abort`

Si el Operator detecta algún problema (compliance, fraude, error técnico), puede abortar:

```daml
choice Abort : ()
  controller settler
  do return ()
```

Los activos quedan intactos en manos de sus dueños originales.

---

## 6. Flujo completo: de la propuesta al intercambio

Veamos el flujo completo paso a paso con Alice, Bob y Operator:

```
Estado inicial:
  Alice tiene: Asset(symbol="TokenX", quantity=200, owner=Alice)
  Bob tiene:   Asset(symbol="TokenY", quantity=100, owner=Bob)

Paso 1 — Alice crea una propuesta:
  submit alice do
    createCmd SwapProposal with
      offeredAssetCid = tokenX
      requestedSymbol = "TokenY"
      requestedQuantity = 100.0
      settler = operator

  Ledger: SwapProposal(proposer=Alice, counterparty=Bob) ← vive aquí

Paso 2 — Bob acepta, comprometiendo su TokenY:
  submit bob do
    exerciseCmd proposalCid Accept with
      counterpartyAssetCid = tokenY

  Ledger: SwapProposal se archiva.
          SwapSettlement(proposer=Alice, counterparty=Bob) ← nuevo contrato

Paso 3 — Operator ejecuta el settlement:
  submit operator do
    exerciseCmd settlementCid Settle

  Dentro de Settle sucede (en UNA sola transacción):
    - TokenX(owner=Alice) se archiva
    - TokenX(owner=Bob)   se crea    ← Bob recibe el TokenX de Alice
    - TokenY(owner=Bob)  se archiva
    - TokenY(owner=Alice) se crea    ← Alice recibe el TokenY de Bob

Estado final:
  Alice tiene: Asset(symbol="TokenY", quantity=100, owner=Alice)
  Bob tiene:   Asset(symbol="TokenX", quantity=200, owner=Bob)
```

---

## 7. El patrón UTXO: Split y Merge

UTXO son las siglas de **Unspent Transaction Output**. Es el modelo que usa Bitcoin y que Daml también emplea para manejar activos divisibles.

La idea es simple: **no modificas un activo, lo consumes y creas nuevos**.

### Split: dividir un activo

Imagina que Alice tiene 500 TokenX pero solo quiere intercambiar 200. No puede "modificar" su contrato para cambiar la cantidad (los contratos son inmutables una vez creados). Lo que hace es **consumirlo y crear dos nuevos**:

```daml
choice Split : (ContractId Asset, ContractId Asset)
  with
    splitQuantity : Decimal
  controller owner
  do
    first  <- create this with quantity = splitQuantity         -- 200 TokenX
    second <- create this with quantity = quantity - splitQuantity -- 300 TokenX
    return (first, second)
```

```
Antes:  [500 TokenX] (Alice)

Después:  [200 TokenX] (Alice)   ← para el swap
          [300 TokenX] (Alice)   ← Alice los conserva
```

El contrato original de 500 se archiva. Aparecen dos nuevos. No hay dinero creado de la nada: 200 + 300 = 500.

### Merge: unir activos

El proceso inverso: Alice tiene dos contratos de TokenX (por ejemplo, los recibió en momentos distintos) y quiere consolidarlos en uno:

```daml
choice Merge : ContractId Asset
  with
    otherCid : ContractId Asset
  controller owner
  do
    other <- fetch otherCid
    -- validaciones: mismo issuer, mismo símbolo, mismo dueño
    archive otherCid
    create this with quantity = quantity + other.quantity
```

```
Antes:  [300 TokenX] (Alice)
        [200 TokenX] (Alice)

Después: [500 TokenX] (Alice)
```

---

## 8. El patrón de Batching: `TransferRequest` y `TransferBatch`

Hasta aquí hemos visto cómo funciona un swap individual. Pero en un sistema real con muchos usuarios simultáneos, ejecutar cada transferencia por separado se vuelve lento y costoso.

Esta sección introduce dos nuevos contratos que resuelven ese problema: **`TransferRequest`** y **`TransferBatch`**.

### El problema de rendimiento

Cada vez que el Operator ejecuta un `Settle`, está haciendo **una transacción en el ledger**. Una transacción tarda aproximadamente 1 segundo en confirmarse (el tiempo de un "roundtrip" al ledger). Si hay 10 swaps pendientes:

```
Sin batching:
  Settle(swap 1)  → 1 tx → ~1 segundo
  Settle(swap 2)  → 1 tx → ~1 segundo
  ...
  Settle(swap 10) → 1 tx → ~1 segundo
  Total: 10 transacciones, ~10 segundos
```

La solución es agrupar múltiples transferencias en **una sola transacción**. En lugar de 10 roundtrips, pagamos el costo de 1.

```
Con batching:
  TransferBatch([transfer1, transfer2, ..., transfer10]) → 1 tx → ~1 segundo
  Total: 1 transacción, ~1 segundo
```

> Analogía: es como la diferencia entre hacer 10 viajes separados al supermercado para comprar un artículo cada vez, versus ir una sola vez con una lista de 10 artículos.

### Separación de conceptos (muy importante)

Antes de ver el código, es crucial entender **por qué** el batching vive en contratos separados al settlement:

| Contrato | Rol | Quién lo firma | Nivel |
|----------|-----|----------------|-------|
| `SwapSettlement` | El acuerdo de negocio — "Alice y Bob quieren intercambiar" | Alice + Bob | Negocio |
| `TransferRequest` | La autorización de ejecución — "Alice le da permiso al Operator para mover su activo" | Alice (o Bob) | Ejecución |
| `TransferBatch` | La optimización de rendimiento — "Operator mueve N activos en 1 sola tx" | Operator | Performance |

El `SwapSettlement` representa el **acuerdo**. El `TransferBatch` representa la **ejecución optimizada**. Son cosas distintas y separarlas hace que cada contrato tenga una única responsabilidad.

### El contrato `TransferRequest`

```daml
template TransferRequest
  with
    operator : Party            -- quien ejecutará la transferencia
    owner    : Party            -- el dueño actual del activo (quien autoriza)
    newOwner : Party            -- el destinatario
    assetCid : ContractId Asset -- el activo a transferir
  where
    signatory owner       -- ← el dueño firma, pre-autorizando al operator
    observer operator, newOwner
```

La idea central: **el dueño firma este contrato en el momento de crearlo**, dando permiso al Operator para ejecutar la transferencia después. No ahora — después, posiblemente como parte de un batch.

```daml
    choice ExecuteTransfer : ContractId Asset
      controller operator       -- el operator ejecuta cuando quiera
      do
        exercise assetCid Transfer with newOwner
```

Y si el dueño cambia de opinión antes de que el Operator ejecute:

```daml
    choice CancelTransfer : ()
      controller owner
      do return ()
```

#### La cadena de autorización (el detalle técnico más importante)

¿Por qué el Operator puede ejercer `Asset.Transfer` si ese choice tiene `controller owner`?

Aquí está la clave — la autoridad se **propaga** a través de los contratos:

```
Operator ejerce ExecuteTransfer (controller=operator)
    │
    │ ← Estamos dentro del contexto de TransferRequest,
    │   que tiene signatory=owner (Alice)
    │   Esto pone a Alice en el contexto de autoridad actual
    ▼
exercise assetCid Transfer with newOwner
    │
    │ ← Asset.Transfer tiene controller=owner (Alice)
    │   Alice SÍ está en el contexto de autoridad (viene de arriba)
    ▼
✅ Autorizado
```

En palabras simples: cuando Alice firmó el `TransferRequest`, dejó su "firma en escrow". El Operator puede "usar" esa firma dentro del contexto de `ExecuteTransfer`. Esto es el **modelo de autoridad delegada** de Daml.

### El contrato `TransferBatch`

```daml
template TransferBatch
  with
    operator : Party
    requests : [ContractId TransferRequest]  -- lista de transferencias a ejecutar
  where
    signatory operator

    ensure length requests > 0  -- no tiene sentido un batch vacío

    choice ExecuteTransfers : [ContractId Asset]
      controller operator
      do
        mapA (\reqCid -> exercise reqCid ExecuteTransfer) requests
```

`mapA` es la función que ejecuta `ExecuteTransfer` en **cada** `TransferRequest` de la lista, dentro de la misma transacción. Es como un `Promise.all` en JavaScript, pero en el ledger.

También tiene una opción para cancelar sin ejecutar:

```daml
    choice CancelBatch : ()
      controller operator
      do return ()
```

Esto es útil si el Operator detecta un problema después de crear el batch pero antes de ejecutarlo (por ejemplo, un asset ya fue consumido).

### El flujo completo con batching

```
Paso 1 — El dueño pre-autoriza:
  submit alice do
    createCmd TransferRequest with
      operator = operator
      owner    = alice
      newOwner = bob
      assetCid = tokenXCid

  submit bob do
    createCmd TransferRequest with
      operator = operator
      owner    = bob
      newOwner = charlie
      assetCid = tokenYCid

Paso 2 — El Operator agrupa las solicitudes:
  submit operator do
    createCmd TransferBatch with
      operator = operator
      requests = [reqAliceCid, reqBobCid]

Paso 3 — El Operator ejecuta todo en 1 sola transacción:
  submit operator do
    exerciseCmd batchCid ExecuteTransfers

  Dentro de ExecuteTransfers (en 1 sola tx):
    reqAliceCid.ExecuteTransfer → TokenX(owner=Alice) archivado
                                  TokenX(owner=Bob)   creado
    reqBobCid.ExecuteTransfer  → TokenY(owner=Bob)   archivado
                                  TokenY(owner=Charlie) creado

Estado final: 2 transfers en 1 roundtrip al ledger.
```

### La garantía de atomicidad del batch

Exactamente igual que en el settlement individual, el batch también es **atómico**. Si cualquier transferencia en el batch falla, **ninguna** se ejecuta.

Ejemplo: si el asset de Bob ya fue transferido antes de que el batch ejecute (una condición de carrera):

```
TransferBatch.ExecuteTransfers:
  ✅ ExecuteTransfer(reqAlice) → OK, TokenX transferido a Bob
  ❌ ExecuteTransfer(reqBob)   → FALLA, el asset ya fue consumido

Resultado: ROLLBACK completo.
  - El TokenX de Alice sigue siendo de Alice (no se transfirió)
  - El ledger queda exactamente igual que antes del batch
```

El sistema externo (el bot de Temporal) es responsable de detectar este fallo y manejar el reintento, por ejemplo ejecutando cada transfer individualmente como fallback.

> **Regla de oro**: El ledger de Daml garantiza atomicidad a nivel de transacción. El Operator no tiene que escribir ningún código de rollback — si algo falla, el ledger revierte todo automáticamente.

### ¿Cuándo usar `Settle` directamente vs. `TransferBatch`?

| | `SwapSettlement.Settle` | `TransferBatch` |
|--|------------------------|-----------------|
| Cuándo usarlo | Para 1 swap aislado o en desarrollo | Para alto volumen de transferencias |
| Ledger roundtrips | 1 por swap | 1 para N transferencias |
| Granularidad de fallo | Falla solo ese swap | Falla todo el batch |
| Caso de uso | Tests, escenarios de baja frecuencia | Producción con bots y alta concurrencia |

---

## 9. Decisión de diseño importante: ¿quién firma qué?

Esta es una de las decisiones de diseño más interesantes del proyecto, y merece su propia sección porque toca el corazón del modelo de autorización de Daml.

### El problema

En el contrato `Asset`, la primera intuición sería hacer que **tanto el issuer como el owner sean signatories**:

```daml
-- ❌ Primera intuición (NO lo que usamos)
signatory issuer, owner
```

Esto tiene sentido conceptualmente: ambas partes están involucradas. Pero genera un problema cuando el Operator ejecuta el `Settle`.

Cuando Settle llama a `Transfer` para dar el TokenX de Alice a Bob, Daml necesita crear un nuevo contrato con `owner = Bob`. Si Bob fuera signatory, el ledger pediría la firma de Bob en ese momento. Pero Bob ya no está en la transacción activa, él firmó el `SwapSettlement` antes.

El resultado: la transacción fallaría con un error de autorización.

### La solución (el patrón de Daml Finance)

La solución es hacer que **solo el issuer sea signatory** y el owner sea únicamente un observer + controller:

```daml
-- ✅ Lo que usamos (patrón Daml Finance)
signatory issuer
observer owner :: observers
```

Esto funciona porque:

1. Cuando Settle ejecuta, está en el contexto de `SwapSettlement` (firmado por Alice Y Bob).
2. Al llamar `Transfer` en el TokenX de Alice, la autoridad de Alice (como issuer) ya está disponible en el contexto.
3. El nuevo Asset solo necesita la firma del `issuer` (Alice), que ya está disponible.
4. No se necesita la firma de Bob como nuevo owner.

### ¿Qué se pierde con esto?

El owner no tiene "obligaciones" formales. En un sistema real más complejo, se podría usar interfaces y cuentas (el modelo completo de Daml Finance) para manejar esto. Para nuestro proyecto, esta decisión es correcta y está inspirada directamente en cómo Daml Finance implementa sus `Holding` (tenencias).

> Conclusión: **El modelo de autorización de Daml es estricto y explícito**. Cada decisión de "quién firma qué" tiene consecuencias concretas en qué operaciones son posibles. Entender esto es fundamental para diseñar contratos correctos.

---

## 10. Los tests: qué verificamos y por qué

Los tests están escritos usando **Daml Script**, que es el framework de testing nativo de Daml. Cada script es un escenario que simula transacciones reales en un ledger virtual.

```bash
daml test   # corre todos los tests
```

### Anatomía de un test

```daml
test_happyPathSwap : Script ()
test_happyPathSwap = do
  -- 1. Preparar: crear partes y activos
  (alice, bob, operator) <- allocateParties
  tokenXCid <- issueAsset alice "TokenX" 200.0 [bob, operator]
  tokenYCid <- issueAsset bob   "TokenY" 100.0 [alice, operator]

  -- 2. Actuar: ejecutar el flujo
  proposalCid   <- submit alice do createCmd SwapProposal with ...
  settlementCid <- submit bob do exerciseCmd proposalCid Accept with ...
  (xCid, yCid)  <- submit operator do exerciseCmd settlementCid Settle

  -- 3. Verificar: el estado final es correcto
  Some assetX <- queryContractId bob   xCid
  assertMsg "TokenX debe pertenecer a Bob" (assetX.owner == bob)
```

Cada test sigue el patrón **Arrange → Act → Assert**.

### Los 14 tests y qué cubren

| # | Test | Tipo | Qué verifica |
|---|------|------|--------------|
| 1 | `test_happyPathSwap` | Happy path | El flujo completo funciona y los activos cambian de dueño |
| 2 | `test_rejectProposal` | Alternativa | Bob puede rechazar; la propuesta desaparece |
| 3 | `test_cancelProposal` | Alternativa | Alice puede cancelar antes de que Bob responda |
| 4 | `test_abortSettlement` | Alternativa | El Operator puede abortar un settlement pendiente |
| 5 | `test_splitAndSwap` | UTXO | Alice puede dividir un activo y solo intercambiar parte |
| 6 | `test_mergeAssets` | UTXO | Dos activos del mismo símbolo se pueden unir |
| 7 | `test_unauthorizedAccept` | Autorización | Eve no puede aceptar una propuesta dirigida a Bob |
| 8 | `test_unauthorizedSettle` | Autorización | Alice no puede ejecutar el Settle (solo el Operator) |
| 9 | `test_unauthorizedCancel` | Autorización | Bob no puede cancelar la propuesta de Alice |
| 10 | `test_zeroQuantityAsset` | Invariante | No se puede crear un activo con cantidad 0 |
| 11 | `test_invalidSplit` | Invariante | No se puede dividir más de lo que se tiene |
| 12 | `test_disclose` | Visibilidad | El dueño puede agregar observers a su activo |
| 13 | `test_batchTransfers` | Batching | N transferencias en 1 sola transacción; todos los activos llegan a sus destinatarios |
| 14 | `test_batchPartialFailure` | Batching | Si una transferencia del batch falla, el ledger hace rollback completo — ningún activo se mueve |

### ¿Por qué son importantes los tests de autorización?

Los tests 7, 8 y 9 son especialmente importantes. Verifican que **nadie puede hacer algo que no le corresponde**. En Daml, el ledger rechaza estas operaciones automáticamente, pero es buena práctica escribir tests que confirmen este comportamiento usando `submitMustFail`:

```daml
-- Esto DEBE fallar. Si llega a pasar, el test falla.
submitMustFail eve do
  exerciseCmd proposalCid Accept with ...
```

Esto es equivalente a las pruebas negativas en cualquier sistema: no solo verificas que lo correcto funciona, sino que lo incorrecto **no** funciona.

### `allocateParties` y `issueAsset`: helpers reutilizables

En lugar de repetir el setup en cada test, se extrajo la lógica común a funciones helper:

```daml
allocateParties : Script (Party, Party, Party)
allocateParties = do
  alice    <- allocateParty "Alice"
  bob      <- allocateParty "Bob"
  operator <- allocateParty "Operator"
  return (alice, bob, operator)

issueAsset : Party -> Text -> Decimal -> [Party] -> Script (ContractId Asset)
issueAsset owner symbol qty obs =
  submit owner do
    createCmd Asset with
      issuer = owner, owner = owner, symbol = symbol
      quantity = qty, observers = obs
```

Este es el mismo principio que en cualquier lenguaje: no repitas código, extrae abstracciones.

---

## 11. Por qué el proyecto está dividido en dos paquetes

Esta es una decisión de arquitectura que viene de una recomendación explícita del compilador de Daml. Entenderla te ayudará a estructurar proyectos reales.

### El problema de mezclar todo

Si pones los contratos y los tests en el mismo paquete, el `daml.yaml` necesita `daml-script` como dependencia:

```yaml
# ❌ Un solo paquete (lo que se intentó primero)
dependencies:
  - daml-prim
  - daml-stdlib
  - daml-script   # ← necesario para los tests
```

El compilador advierte:

> *"This package defines templates and depends on daml-script. Uploading this package to a ledger will also upload daml-script, which will bloat the package store on your participant."*

Cuando deploys tus contratos al ledger de un participant node en producción, el ledger recibe el DAR (el archivo compilado). Si ese DAR incluye `daml-script`, estás subiendo al ledger código de testing que nunca debería estar ahí. Es como deployar tu suite de Jest al servidor de producción.

### La solución: dos paquetes

```
daml-contracts/
├── multi-package.yaml           ← orquestador
│
├── contracts/                   ← Paquete 1: contratos puros
│   ├── daml.yaml                (sin daml-script)
│   └── daml/
│       ├── Asset.daml
│       ├── SwapProposal.daml
│       └── TransferBatch.daml
│
└── scripts/                     ← Paquete 2: tests y setup
    ├── daml.yaml                (con daml-script + depende del DAR de contracts)
    └── daml/
        ├── Setup.daml
        └── Tests.daml
```

### ¿Cómo se relacionan?

El paquete `scripts` declara como dependencia el DAR compilado de `contracts`:

```yaml
# scripts/daml.yaml
dependencies:
  - daml-prim
  - daml-stdlib
  - daml-script
  - ../contracts/.daml/dist/asset-swap-contracts-0.1.0.dar  ← importa los contratos
```

Esto significa que los tests pueden usar `Asset` y `SwapProposal` tal como si fueran suyos, pero el código de los contratos vive en un paquete separado y limpio.

### El `multi-package.yaml`

Este archivo le dice a Daml que hay múltiples paquetes relacionados y cuál es el orden de compilación:

```yaml
packages:
  - contracts   # se compila primero
  - scripts     # se compila segundo (depende del DAR de contracts)
```

Con esto, un solo comando construye todo:

```bash
daml build --all   # compila contracts, luego scripts, en orden
```

### Resumen: qué va a cada lugar en producción

| Artefacto | Sube al ledger en producción | Cuándo se usa |
|-----------|------------------------------|---------------|
| `asset-swap-contracts-0.1.0.dar` | ✅ Sí | Siempre; es el código que vive en el ledger |
| `asset-swap-scripts-0.1.0.dar` | ❌ No | Solo en desarrollo y CI/CD para correr tests |

---

## Recapitulación final

```
┌─────────────────────────────────────────────────────────┐
│  Asset                                                  │
│  ┌─────────────────────────────────────────────────┐   │
│  │  signatory: issuer                              │   │
│  │  observer:  owner, observers[]                  │   │
│  │                                                 │   │
│  │  choices: Transfer / Split / Merge / Disclose   │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
     │ referenciado por              │ referenciado por
     ▼                               ▼
┌───────────────────────┐   ┌─────────────────────────────────────────┐
│  SwapProposal         │   │  TransferRequest                        │
│  ─────────────────    │   │  ─────────────────────────────────────  │
│  signatory: proposer  │   │  signatory: owner  ← firma en "escrow" │
│  observer:            │   │  observer:  operator, newOwner          │
│    counterparty       │   │                                         │
│    settler            │   │  choices: ExecuteTransfer → operator    │
│                       │   │           CancelTransfer  → owner       │
│  choices: Accept →    │   └─────────────────────────────────────────┘
│    SwapSettlement     │            │ agrupados en
│  Reject / Cancel      │            ▼
└───────────────────────┘   ┌─────────────────────────────────────────┐
     │ al aceptar, crea      │  TransferBatch                          │
     ▼                       │  ─────────────────────────────────────  │
┌───────────────────────┐   │  signatory: operator                    │
│  SwapSettlement       │   │                                         │
│  ─────────────────    │   │  choices: ExecuteTransfers →            │
│  signatory:           │   │    N transfers en 1 sola tx             │
│    proposer           │   │  CancelBatch → descarta el batch        │
│    counterparty       │   └─────────────────────────────────────────┘
│  observer: settler    │
│                       │   ┌─ Flujo de rendimiento ──────────────────┐
│  choices: Settle →    │   │                                         │
│    2 legs atómicos    │   │  Sin batching:  N swaps = N roundtrips  │
│  Abort → sin cambios  │   │  Con batching:  N swaps = 1 roundtrip   │
└───────────────────────┘   └─────────────────────────────────────────┘
```

Los cuatro patrones fundamentales implementados:

1. **Propose-Accept** — para obtener consentimiento de múltiples partes antes de comprometer recursos. Sin la firma de la contraparte, no hay acuerdo.

2. **Settlement atómico** — para garantizar que un intercambio de múltiples legs es todo-o-nada. No existe el riesgo de que solo una parte entregue su activo.

3. **UTXO (Split/Merge)** — para trabajar con cantidades parciales de un activo sin modificar contratos existentes. Los contratos son inmutables; se consumen y se crean nuevos.

4. **Batching** — para agrupar N transferencias en una sola transacción del ledger. El dueño pre-autoriza con `TransferRequest`; el Operator agrupa y ejecuta con `TransferBatch`. El ledger garantiza que el batch es atómico: todos los transfers, o ninguno.

Estos patrones no son inventados para este proyecto — son los mismos que usa Daml Finance, el framework oficial de Digital Asset para sistemas financieros en producción.
