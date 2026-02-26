# Lección: Capa de Integración TypeScript con Canton

> Este documento explica, paso a paso, cómo está construido el cliente TypeScript que se conecta a los smart contracts Daml vía la API HTTP de Canton. Es la continuación natural de `SMART_CONTRACTS_LECCION.md` — si no lo has leído, empieza por ahí.

---

## Índice

1. [¿Por qué un cliente TypeScript?](#1-por-qué-un-cliente-typescript)
2. [La arquitectura del proyecto ts-client](#2-la-arquitectura-del-proyecto-ts-client)
3. [Cómo se comunica TypeScript con Canton](#3-cómo-se-comunica-typescript-con-canton)
4. [Los tipos: TypeScript mapea a Daml](#4-los-tipos-typescript-mapea-a-daml)
5. [El `LedgerClient`: el núcleo de todo](#5-el-ledgerclient-el-núcleo-de-todo)
6. [El patrón de Roles: separación de responsabilidades](#6-el-patrón-de-roles-separación-de-responsabilidades)
7. [Autenticación: JWT en modo sandbox](#7-autenticación-jwt-en-modo-sandbox)
8. [El ambiente local: `setup.sh` y `setup-env.ts`](#8-el-ambiente-local-setupsh-y-setup-envts)
9. [Los demos: el flujo completo en acción](#9-los-demos-el-flujo-completo-en-acción)
10. [Flujo completo de punta a punta](#10-flujo-completo-de-punta-a-punta)
11. [Decisiones de diseño y lecciones aprendidas](#11-decisiones-de-diseño-y-lecciones-aprendidas)

---

## 1. ¿Por qué un cliente TypeScript?

Los smart contracts en Daml viven en el **ledger** (el registro distribuido de Canton). Por sí solos, los contratos no hacen nada: esperan que alguien externo les envíe comandos — crear un contrato, ejercer un choice, consultar el estado activo.

Canton expone una **API HTTP** para que cualquier sistema externo pueda hacer exactamente eso. TypeScript es un candidato natural para construir ese cliente porque:

- Es el lenguaje más común en backends de aplicaciones financieras modernas.
- Tiene un sistema de tipos robusto que nos ayuda a _mapear_ los tipos Daml a estructuras TypeScript en tiempo de compilación.
- Node.js tiene `fetch` nativo desde la versión 18, lo que simplifica las llamadas HTTP.

La separación es intencional: **los contratos Daml definen las reglas**, y **el cliente TypeScript orquesta quién ejecuta qué y cuándo**. Ninguno de los dos puede existir solo.

---

## 2. La arquitectura del proyecto ts-client

```
ts-client/
├── scripts/
│   └── setup.sh              # Script de shell para levantar el sandbox
├── src/
│   ├── config.ts             # Carga y valida variables de entorno
│   ├── ledger/
│   │   └── client.ts         # Cliente genérico del Canton JSON Ledger API v2
│   ├── roles/
│   │   ├── assetOwner.ts     # Acciones disponibles para Alice o Bob (dueño de activos)
│   │   ├── counterparty.ts   # Acciones disponibles para quien acepta/rechaza un swap
│   │   └── settler.ts        # Acciones disponibles para el Operador (settlement + batch)
│   ├── scripts/
│   │   ├── setup-env.ts      # Genera el archivo .env con party IDs y tokens JWT
│   │   ├── demo-swap.ts      # Demo: ciclo completo de un swap
│   │   └── demo-batch.ts     # Demo: transferencia en lote (batching)
│   └── types/
│       └── contracts.ts      # Interfaces TypeScript que mapean a los templates Daml
├── .env                      # Variables de entorno locales (generado por setup-env.ts)
├── .env.example              # Plantilla del .env
├── package.json
└── tsconfig.json
```

El proyecto sigue tres capas bien diferenciadas:

```
┌─────────────────────────────────────────────┐
│         Scripts de Demo / Negocio           │ ← orquesta el flujo completo
├─────────────────────────────────────────────┤
│         Capa de Roles                       │ ← encapsula "quién puede hacer qué"
├─────────────────────────────────────────────┤
│         LedgerClient (HTTP)                 │ ← habla con Canton
└─────────────────────────────────────────────┘
              ↕ HTTP JSON Ledger API v2
┌─────────────────────────────────────────────┐
│         Canton Sandbox                      │
│  (contratos Daml compilados como .dar)      │
└─────────────────────────────────────────────┘
```

---

## 3. Cómo se comunica TypeScript con Canton

### El JSON Ledger API v2

Canton expone una API HTTP llamada **JSON Ledger API**. En el SDK 3.x (versión usada aquí), la ruta base es `/v2/` — la antigua `/v1/` quedó obsoleta y fue eliminada.

> **Importante:** Esto es algo que generó problemas al principio del proyecto. El sandbox inicia en el puerto `7575` por defecto, pero los endpoints `/v1/*` dan `404`. Hay que usar `/v2/*`.

Los endpoints que usamos:

| Operación | Método | Endpoint |
|---|---|---|
| Crear un contrato | `POST` | `/v2/commands/submit-and-wait-for-transaction` |
| Ejercer un choice | `POST` | `/v2/commands/submit-and-wait-for-transaction` |
| Consultar contratos activos | `GET` + `POST` | `/v2/state/ledger-end` + `/v2/state/active-contracts` |
| Listar parties | `GET` | `/v2/parties` |
| Registrar una party | `POST` | `/v2/parties` |
| Health check | `GET` | `/docs/openapi` |

### El formato de los comandos: proto-transcoding

La API v2 de Canton no es un REST convencional. Internamente usa gRPC + Protocol Buffers, y la API HTTP es un _transcoding_ de ese proto. Esto tiene una consecuencia directa en la estructura del body JSON:

Los campos del comando **no van en el root** del body. Van anidados dentro de un objeto llamado `commands` (que mapea al campo `Commands commands` del mensaje proto `SubmitAndWaitRequest`):

```json
// ❌ Formato incorrecto (hace que el servidor devuelva HTTP 400):
{
  "commandId": "cmd-123",
  "actAs": ["Alice::1220..."],
  "commands": [{ "CreateCommand": { ... } }]
}

// ✅ Formato correcto (proto-transcoding):
{
  "commands": {
    "commandId": "cmd-123",
    "userId": "mi-app",
    "actAs": ["Alice::1220..."],
    "readAs": ["Alice::1220..."],
    "applicationId": "mi-app",
    "commands": [{ "CreateCommand": { ... } }]
  }
}
```

El campo exterior `commands` es el mensaje `SubmitAndWaitRequest`. El campo interior `commands` (array) es la lista de comandos individuales.

---

## 4. Los tipos: TypeScript mapea a Daml

El archivo `src/types/contracts.ts` tiene dos responsabilidades:

1. **Interfaces TypeScript** que replican los campos de cada template Daml.
2. **Tipos de envelope** que modelan lo que devuelve la API (contratos, eventos, resultados).

### Interfaces de contratos

Cada interface TypeScript corresponde directamente a un template Daml:

```typescript
// En Daml (Asset.daml):
// template Asset
//   with
//     issuer   : Party
//     owner    : Party
//     symbol   : Text
//     quantity : Decimal
//     observers: [Party]

// En TypeScript (contracts.ts):
export interface Asset {
  issuer:    string;
  owner:     string;
  symbol:    string;
  quantity:  DamlDecimal;  // string, no number
  observers: string[];
}
```

> **¿Por qué `quantity` es `string` y no `number`?**
>
> Daml representa los `Decimal` como strings JSON para evitar pérdida de precisión de punto flotante. Un `number` de JavaScript no puede representar con exactitud valores como `0.1` + `0.2`. En sistemas financieros, esto es crítico. Por eso existe el tipo `DamlDecimal = string` y la función `toDecimalString(n)`.

### Los Template IDs

Cada contrato Daml vive bajo un identificador único de template. En la API v2, el formato es:

```
#<nombre-paquete>:<Modulo>:<Template>
```

El `#` significa "resolver por nombre de paquete" (en vez de por hash de paquete). Esto es más estable cuando el contrato evoluciona:

```typescript
export const TEMPLATE_IDS = {
  ASSET:            '#asset-swap-contracts:Asset:Asset',
  SWAP_PROPOSAL:    '#asset-swap-contracts:SwapProposal:SwapProposal',
  SWAP_SETTLEMENT:  '#asset-swap-contracts:SwapProposal:SwapSettlement',
  TRANSFER_REQUEST: '#asset-swap-contracts:TransferBatch:TransferRequest',
  TRANSFER_BATCH:   '#asset-swap-contracts:TransferBatch:TransferBatch',
} as const;
```

`asset-swap-contracts` es el `name` en el `daml.yaml` del paquete de contratos.

### Tipos de envelope

La API devuelve contratos y eventos envueltos en estructuras de respuesta. Los tipos que los modelan:

```typescript
// Un contrato activo en el ledger
export interface Contract<T> {
  contractId: string;   // el ID único del contrato (ej: "00ff13...")
  payload:    T;        // los campos del contrato (tipado según el template)
  templateId: string;   // el template ID (ej: "#asset-swap-contracts:Asset:Asset")
}

// El resultado de ejercer un choice
export interface ExerciseResult<R> {
  exerciseResult: R;          // el valor de retorno del choice
  events:         LedgerEvent[]; // todos los eventos generados (creados / archivados)
}

// Un evento del ledger (union type)
export type LedgerEvent =
  | { created:  Contract<unknown> }
  | { archived: { contractId: string; templateId: string } };
```

---

## 5. El `LedgerClient`: el núcleo de todo

`src/ledger/client.ts` implementa la clase `LedgerClient`. Es un _thin wrapper_ sobre la API HTTP de Canton: no contiene lógica de negocio, solo sabe cómo hablar con el ledger.

### Instanciación: una instancia por party

Cada instancia del `LedgerClient` está **ligada a una sola party**:

```typescript
const aliceClient = new LedgerClient(
  'http://localhost:7575',  // URL de la API
  aliceToken,              // JWT de Alice
  alicePartyId,            // "Alice::1220abc..."
  'mi-app',                // userId (applicationId)
);
```

Esto refleja cómo funciona la seguridad en Daml: cada comando dice explícitamente **en nombre de quién** se ejecuta (`actAs`). Si Alice intenta ejercer un choice controlado por Bob, Daml rechaza la transacción.

### `create<T>` — Crear un contrato

```typescript
const asset = await client.create<Asset>(
  TEMPLATE_IDS.ASSET,
  { issuer: aliceId, owner: aliceId, symbol: 'TokenX', quantity: '200', observers: [] }
);
// asset.contractId → "00ff137148ce61..."
// asset.payload    → { issuer: "Alice::...", owner: "Alice::...", ... }
```

Internamente, hace `POST /v2/commands/submit-and-wait-for-transaction` y extrae el `CreatedEvent` de la respuesta:

```typescript
async create<T>(templateId: string, createArguments: T): Promise<Contract<T>> {
  const result = await this.post('/v2/commands/submit-and-wait-for-transaction', {
    commands: {
      commandId:     this.nextCommandId(),
      userId:        this.userId,
      actAs:         [this.partyId],
      readAs:        [this.partyId],
      applicationId: this.userId,
      commands: [{ CreateCommand: { templateId, createArguments } }],
    },
  });

  // La respuesta contiene la transacción con los eventos generados
  const createdEvent = result.transaction.events
    .filter(e => 'CreatedEvent' in e)[0].CreatedEvent;

  return {
    contractId: createdEvent.contractId,
    payload:    createdEvent.createArgument as T,
    templateId: createdEvent.templateId,
  };
}
```

### `exercise<A, R>` — Ejercer un choice

```typescript
const result = await client.exercise<
  { counterpartyAssetCid: string },  // A = tipo del argumento del choice
  string                             // R = tipo de retorno del choice
>(
  TEMPLATE_IDS.SWAP_PROPOSAL,
  proposalContractId,
  'Accept',
  { counterpartyAssetCid: tokenYId },
);
// result.exerciseResult → "00bb8aae..."  (el nuevo SwapSettlement)
// result.events         → [ArchivedEvent(proposal), CreatedEvent(settlement)]
```

#### El problema del endpoint tree y su solución

La API v2 tiene dos endpoints para comandos:
- `/v2/commands/submit-and-wait-for-transaction` → devuelve una transacción _plana_ con eventos.
- `/v2/commands/submit-and-wait-for-transaction-tree` → devuelve un _árbol_ de eventos con el valor de retorno del choice embebido.

El endpoint tree tiene un schema de body diferente en `dpm sandbox 3.4.x`. Para evitar ese problema, `exercise()` usa el endpoint plano y **deriva el `exerciseResult` a partir de los `CreatedEvent`s generados**:

| Contratos creados | `exerciseResult` | Cubre |
|---|---|---|
| 0 | `null` | Choices `()` — Cancel, Abort |
| 1 | `string` (el contractId) | `ContractId T` — Accept, Transfer, Merge |
| N | `string[]` | `(ContractId T, ContractId T)` o `[ContractId T]` — Settle, ExecuteTransfers |

Esta estrategia funciona para todos los choices del proyecto porque **todos retornan contract IDs**, y el ledger genera los eventos en el mismo orden que Daml los crea.

### `query<T>` — Consultar contratos activos

Consultar el estado activo del ledger requiere dos pasos:

1. **Obtener el offset actual** (`GET /v2/state/ledger-end`) — la posición del ledger en este momento.
2. **Pedir los contratos** (`POST /v2/state/active-contracts`) — los contratos vivos _hasta ese offset_.

```typescript
// Paso 1: obtener el offset
const { offset } = await fetch('/v2/state/ledger-end');

// Paso 2: filtrar por template y party
const contracts = await this.post('/v2/state/active-contracts', {
  filter: {
    filtersByParty: {
      [this.partyId]: {
        cumulative: [{
          identifierFilter: {
            TemplateFilter: {
              value: { templateId, includeCreatedEventBlob: false }
            }
          }
        }]
      }
    }
  },
  verbose: true,
  activeAtOffset: offset,
});
```

Después, se aplica un filtro en el cliente para reducir los resultados a los contratos que coincidan con los campos indicados:

```typescript
const aliceAssets = await client.query<Asset>(
  TEMPLATE_IDS.ASSET,
  { owner: alicePartyId }  // filtro aplicado en TypeScript (client-side)
);
```

> **Nota:** El filtro de campos (ej: `{ owner: alicePartyId }`) se evalúa en TypeScript después de recibir todos los contratos del template. Para contratos muy voluminosos, un filtro server-side sería más eficiente, pero en el sandbox local esto es suficiente.

---

## 6. El patrón de Roles: separación de responsabilidades

En vez de exponer el `LedgerClient` directamente, el proyecto define **clases de rol** que encapsulan _qué puede hacer cada tipo de participante_. Esto tiene tres ventajas:

1. **Claridad**: leer `alice.proposeSwap(...)` es más claro que leer `aliceClient.create(TEMPLATE_IDS.SWAP_PROPOSAL, { ... })`.
2. **Seguridad**: si accidentalmente intentas llamar a `settler.proposeSwap()`, TypeScript te dice que ese método no existe.
3. **Mantenibilidad**: si el template Daml cambia, solo hay que actualizar la clase de rol correspondiente.

### `AssetOwner` — El dueño de activos

Representa lo que puede hacer Alice o Bob como dueños de sus propios tokens:

```typescript
class AssetOwner {
  async createAsset(params)           // Emitir (mint) un nuevo activo
  async splitAsset(contractId, qty)   // Dividir en dos (patrón UTXO)
  async mergeAssets(primary, other)   // Fusionar dos en uno (patrón UTXO)
  async discloseAsset(cid, observer)  // Dar visibilidad a otra party
  async proposeSwap(params)           // Proponer un intercambio
  async cancelProposal(cid)           // Cancelar una propuesta pendiente
  async authorizeTransfer(params)     // Pre-autorizar al operador para una transferencia
  async cancelTransferRequest(cid)    // Cancelar una autorización de transferencia
  async queryAssets()                 // Ver todos mis activos activos
}
```

### `Counterparty` — Quien responde a una propuesta

Representa la perspectiva de quien recibe una oferta de swap (Bob cuando responde a Alice):

```typescript
class Counterparty {
  async acceptProposal(proposalCid, counterpartyAssetCid)  // Aceptar → crea SwapSettlement
  async rejectProposal(proposalCid)                        // Rechazar → archiva la propuesta
  async queryProposals()                                   // Ver propuestas dirigidas a mí
}
```

### `Settler` — El Operador

Tiene dos responsabilidades distintas:

```typescript
class Settler {
  // Settlement atómico:
  async settleSwap(settlementCid)         // Ejecutar el swap en 1 transacción
  async abortSwap(settlementCid)          // Abortar el settlement

  // Batching:
  async createTransferBatch(requestCids)  // Agrupar N TransferRequests
  async executeTransferBatch(batchCid)    // Ejecutar todos en 1 roundtrip
  async cancelTransferBatch(batchCid)     // Cancelar el lote sin ejecutar

  // Queries:
  async queryPendingSettlements()         // SwapSettlements que esperan mi firma
  async queryPendingTransferRequests()    // TransferRequests donde soy operador
}
```

### Cómo se instancian los roles

Cada rol recibe un `LedgerClient` ya configurado con el token y la party ID correspondiente:

```typescript
// Cada party tiene su propio cliente (y por tanto su propio token JWT)
const aliceClient    = new LedgerClient(baseUrl, aliceToken, alicePartyId);
const bobClient      = new LedgerClient(baseUrl, bobToken, bobPartyId);
const operatorClient = new LedgerClient(baseUrl, operatorToken, operatorPartyId);

// Los roles envuelven al cliente correspondiente
const alice              = new AssetOwner(aliceClient, alicePartyId);
const bob                = new AssetOwner(bobClient, bobPartyId);
const bobAsCounterparty  = new Counterparty(bobClient, bobPartyId);
const operator           = new Settler(operatorClient, operatorPartyId);
```

Bob es tanto `AssetOwner` (puede emitir y gestionar sus tokens) como `Counterparty` (puede responder a propuestas). El mismo `LedgerClient` de Bob se reutiliza en ambos roles — no hay duplicación de credenciales.

---

## 7. Autenticación: JWT en modo sandbox

### ¿Qué es un JWT?

Un JWT (_JSON Web Token_) es un token firmado que contiene _claims_ (afirmaciones). En Canton, el JWT le dice al ledger **quién eres** (tu identidad/userId).

En producción, los JWTs los emite una autoridad de identidad externa (OAuth2, etc.). En el sandbox de desarrollo, Canton acepta cualquier JWT bien formado porque `dpm sandbox` corre con autenticación relajada.

### El formato del token para Canton v2

```typescript
function generateDevToken(partyId: string): string {
  const displayName = partyId.split('::')[0]; // "Alice" de "Alice::1220abc..."

  const payload = {
    sub:   displayName,      // user ID — el servidor lo usa para identificar al usuario
    scope: 'daml_ledger_api', // indica que el token es para el Ledger API
    aud:   [],               // audiences (vacío en sandbox)
    iss:   null,             // issuer (null en sandbox)
  };

  return jwt.sign(payload, DEV_JWT_SECRET, { algorithm: 'HS256' });
}
```

El campo `sub` (subject) es el `userId`. En sandbox, el servidor acepta cualquier `sub` válido. Lo importante es que sea consistente con el `userId` que enviamos en los comandos.

### Por qué el userId también va en el body

Aunque el token JWT ya contiene el `sub`, la API v2 requiere que también se especifique `userId` explícitamente en el body del comando. Esto permite que el servidor valide que el token y el comando son consistentes:

```json
{
  "commands": {
    "userId":  "Alice",      // debe coincidir con el sub del JWT
    "actAs":   ["Alice::1220..."],
    "readAs":  ["Alice::1220..."],
    ...
  }
}
```

> **Lección aprendida:** Omitir el `userId` en el body genera un error `HTTP 400: The submitted request is missing a user-id`. Incluso si el JWT tiene un `sub` válido, la API v2 requiere el campo explícito.

### Cómo se envía el token

El token se incluye en cada request como header HTTP estándar:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

En el `LedgerClient`:

```typescript
private get authHeaders(): Record<string, string> {
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${this.token}`,
  };
}
```

---

## 8. El ambiente local: `setup.sh` y `setup-env.ts`

Antes de poder correr los demos, hay que:
1. Levantar el sandbox (el ledger local).
2. Registrar las parties (Alice, Bob, Operator).
3. Generar los tokens JWT y guardarlos en el `.env`.

Esto está dividido en dos scripts que se ejecutan en orden.

### `scripts/setup.sh` — Levantar el sandbox

El script de shell hace cuatro cosas:

```bash
# 1. Compila los contratos Daml a .dar
dpm build

# 2. Inicia el sandbox con la API HTTP en el puerto 7575
dpm sandbox \
  --json-api-port 7575 \
  --ledger-api-port 6865 \
  --dar asset-swap-contracts-0.1.0.dar &

# 3. Espera a que la API esté lista (health check en /docs/openapi)
until curl -s /docs/openapi > /dev/null; do sleep 2; done

# 4. Registra las parties vía HTTP
curl -X POST /v2/parties -d '{"partyIdHint": "Alice", "identityProviderId": ""}'
curl -X POST /v2/parties -d '{"partyIdHint": "Bob",   "identityProviderId": ""}'
curl -X POST /v2/parties -d '{"partyIdHint": "Operator", "identityProviderId": ""}'
```

#### ¿Por qué `dpm` y no `daml`?

En el SDK 3.4+, el CLI `daml` fue deprecado. El reemplazo es `dpm` (_Digital Asset Package Manager_). `daml start` mostraba advertencias de deprecación y tenía comportamientos distintos (como detener el sandbox automáticamente después de 2 minutos). `dpm sandbox` es el comando oficial y estable.

#### ¿Por qué el health check es en `/docs/openapi`?

El endpoint `/docs/openapi` devuelve la especificación OpenAPI del API sin requerir autenticación. Otros endpoints como `/v2/parties` o `/v2/state/ledger-end` requieren un token JWT. Usar `/docs/openapi` simplifica el health check.

#### ¿Por qué el `.dar` y no el multi-package?

`dpm sandbox` puede levantar el ledger solo con el `.dar` del paquete de contratos de negocio (`asset-swap-contracts`), sin necesidad de compilar ni ejecutar el paquete de scripts (`asset-swap-scripts`). Esto es más limpio: los scripts Daml son solo para pruebas unitarias, no para el sandbox de integración.

### `src/scripts/setup-env.ts` — Generar el `.env`

Este script TypeScript hace tres cosas:

**Paso 1: Descubrir o crear las parties**

```typescript
// Intenta obtener Alice, Bob y Operator del ledger
const response = await fetch('/v2/parties');
const parties  = parsePartyMap(response);

// Si no existen, las crea automáticamente
if (!parties.has('Alice')) {
  const partyId = await allocateParty('Alice');
  // POST /v2/parties { partyIdHint: "Alice" }
}
```

Los party IDs en Canton son del formato `DisplayName::hash` — por ejemplo, `Alice::1220f1ad80b...`. El hash es único por sandbox y cambia en cada reinicio. Por eso no se pueden hardcodear.

**Paso 2: Generar los tokens JWT**

Para cada party, genera un token HS256 con el `sub` igual al display name:

```typescript
const token = jwt.sign(
  { sub: 'Alice', scope: 'daml_ledger_api', aud: [], iss: null },
  'canton-dev-insecure-secret-do-not-use-in-production',
  { algorithm: 'HS256' }
);
```

**Paso 3: Escribir el `.env`**

```
LEDGER_JSON_API_URL=http://localhost:7575

ALICE_PARTY=Alice::1220f1ad80bda06e78b0c19668831445245d0424ae5b9756f7b229ec6f0bdf3d1674
ALICE_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

BOB_PARTY=Bob::1220f1ad80bda06e78b0c19668831445245d0424ae5b9756f7b229ec6f0bdf3d1674
BOB_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

OPERATOR_PARTY=Operator::1220f1ad80bda06e78b0c19668831445245d0424ae5b9756f7b229ec6f0bdf3d1674
OPERATOR_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### `src/config.ts` — Cargar la configuración

`loadConfig()` lee el `.env` y valida que todas las variables requeridas estén presentes. Si alguna falta, lanza un error claro antes de que el demo falle con un mensaje críptico:

```typescript
export function loadConfig() {
  return {
    ledger: {
      baseUrl: optional('LEDGER_JSON_API_URL', 'http://localhost:7575'),
    },
    parties: {
      alice: {
        id:    required('ALICE_PARTY'),   // lanza Error si no existe
        token: required('ALICE_TOKEN'),
      },
      // ...
    },
  } as const;
}
```

---

## 9. Los demos: el flujo completo en acción

### `demo-swap.ts` — Asset Swap de 4 pasos

```
Step 1 — Issue assets
Step 2 — Alice proposes a swap
Step 3 — Bob accepts the proposal
Step 4 — Operator settles (atomic 2-leg transfer)
Verification — Final balances
```

Veamos cada paso con el código real:

#### Step 1: Emitir activos

```typescript
const tokenX = await alice.createAsset({
  symbol:    'TokenX',
  quantity:  200,
  observers: [bobPartyId, operatorPartyId],  // deben poder ver el contrato
});

const tokenY = await bob.createAsset({
  symbol:    'TokenY',
  quantity:  100,
  observers: [alicePartyId, operatorPartyId],
});
```

Los observers son importantes: cuando Alice proponga el swap, Bob y el Operador necesitan poder _ver_ el `Asset` que Alice está ofreciendo.

#### Step 2: Alice propone

```typescript
const proposal = await alice.proposeSwap({
  counterparty:      bobPartyId,
  settler:           operatorPartyId,
  offeredAssetCid:   tokenX.contractId,  // el ContractId del TokenX
  offeredSymbol:     'TokenX',
  offeredQuantity:   200,
  requestedSymbol:   'TokenY',
  requestedQuantity: 100,
});
```

Esto crea un contrato `SwapProposal` en el ledger. El contrato referencia al `TokenX` por su `contractId`, no copia su contenido.

#### Step 3: Bob acepta

```typescript
const acceptResult = await bobAsCounterparty.acceptProposal(
  proposal.contractId,
  tokenY.contractId,   // Bob ofrece su TokenY a cambio
);

const settlementContractId = acceptResult.exerciseResult;
```

`exerciseResult` contiene el ID del nuevo `SwapSettlement` creado. Este contrato es el que el Operador necesita para liquidar.

#### Step 4: El Operador liquida

```typescript
const settleResult = await operator.settleSwap(settlementContractId);

const [newTokenXId, newTokenYId] = settleResult.exerciseResult;
```

Una sola llamada HTTP, una sola transacción Daml: el `TokenX` de Alice pasa a Bob y el `TokenY` de Bob pasa a Alice. Si algo falla a mitad, **ambas** transferencias se revierten.

#### Verificación

```typescript
const [aliceAssets, bobAssets] = await Promise.all([
  alice.queryAssets(),
  bob.queryAssets(),
]);

// Alice: 200.0 TokenY  (recibió el TokenY de Bob)
// Bob:   100.0 TokenX  (recibió el TokenX de Alice)
```

### `demo-batch.ts` — Transferencia en Lote

Este demo muestra el patrón de batching: transferir 3 activos de Alice a Bob en **1 roundtrip al ledger** en lugar de 3:

```
Step 1 — Alice emite 3 activos (TokenA, TokenB, TokenC)
Step 2 — Alice crea 3 TransferRequests (pre-autoriza al Operador)
Step 3 — Operador crea un TransferBatch (agrupa las 3 requests)
Step 4 — Operador ejecuta el batch (1 transacción, 3 transfers)
```

#### Step 2: Pre-autorización de transferencias

```typescript
const reqA = await alice.authorizeTransfer({
  operator: operatorPartyId,   // el Operador puede ejecutar esto
  newOwner: bobPartyId,        // hacia Bob
  assetCid: tokenA.contractId,
});
```

Cada `TransferRequest` es un contrato creado por el dueño del activo (Alice) que dice: _"Operador: estás autorizado a transferir este asset a Bob"_. El Operador es solo un observador en este punto — aún no ha hecho nada.

#### Step 3: Crear el batch

```typescript
const batch = await operator.createTransferBatch([
  reqA.contractId,
  reqB.contractId,
  reqC.contractId,
]);
```

El `TransferBatch` es otro contrato que agrupa las referencias a las `TransferRequest`s. Aún no ejecuta nada.

#### Step 4: Ejecutar

```typescript
const batchResult = await operator.executeTransferBatch(batch.contractId);
const newAssetIds = batchResult.exerciseResult; // [idA, idB, idC]
```

**Una llamada HTTP, una transacción Daml, 3 transferencias**. El choice `ExecuteTransfers` recorre la lista de requests, llama a `Transfer` en cada asset, y devuelve la lista de nuevos contract IDs. Si cualquier transfer falla (por ejemplo, el asset ya fue consumido), toda la transacción hace rollback.

---

## 10. Flujo completo de punta a punta

Este diagrama muestra todo el recorrido desde la terminal del desarrollador hasta el ledger:

```
╔══════════════╗   pnpm demo:swap
║  Terminal    ║ ─────────────────────────────────────────────┐
╚══════════════╝                                              ↓
                                                   ╔══════════════════╗
                                                   ║  demo-swap.ts    ║
                                                   ║                  ║
                                                   ║  loadConfig()    ║ ← lee .env
                                                   ║  new LedgerClient║ ← token + partyId
                                                   ║  new AssetOwner  ║
                                                   ║  new Counterparty║
                                                   ║  new Settler     ║
                                                   ╚═════════┬════════╝
                                                             │
                                              alice.createAsset(...)
                                                             │
                                                   ╔═════════▼════════╗
                                                   ║  AssetOwner      ║
                                                   ║                  ║
                                                   ║  client.create(  ║
                                                   ║    ASSET,        ║
                                                   ║    { ... }       ║
                                                   ║  )               ║
                                                   ╚═════════┬════════╝
                                                             │
                                           POST /v2/commands/submit-and-wait-for-transaction
                                           Authorization: Bearer <alice_jwt>
                                           Body: { commands: { actAs: [aliceId], ... } }
                                                             │
                                                   ╔═════════▼════════╗
                                                   ║  Canton Sandbox  ║
                                                   ║  :7575           ║
                                                   ║                  ║
                                                   ║  Verifica JWT    ║
                                                   ║  Verifica actAs  ║
                                                   ║  Ejecuta en Daml ║
                                                   ║  → Asset creado  ║
                                                   ╚═════════┬════════╝
                                                             │
                                           200 OK { transaction: { events: [CreatedEvent] } }
                                                             │
                                                   ╔═════════▼════════╗
                                                   ║  LedgerClient    ║
                                                   ║                  ║
                                                   ║  Extrae          ║
                                                   ║  contractId      ║
                                                   ║  del CreatedEvent║
                                                   ╚═════════┬════════╝
                                                             │
                                              Contract<Asset> { contractId, payload }
                                                             │
                                                   ╔═════════▼════════╗
                                                   ║  demo-swap.ts    ║
                                                   ║                  ║
                                                   ║  ✓ Alice's       ║
                                                   ║  TokenX → 00ff.. ║
                                                   ╚══════════════════╝
```

---

## 11. Decisiones de diseño y lecciones aprendidas

### ¿Por qué el proyecto está dividido en dos carpetas?

```
canton-temporal-ai/
├── daml-contracts/   ← contratos Daml (compilados con dpm)
└── ts-client/        ← cliente TypeScript (ejecutado con Node.js)
```

Podrían vivir en el mismo repo, pero separados en directorios distintos por una razón fundamental: **son lenguajes, herramientas y runtimes completamente distintos**.

- `daml-contracts` usa el compilador Daml, `dpm build`, y genera archivos `.dar`.
- `ts-client` usa Node.js, `pnpm`, TypeScript, y se conecta al ledger por HTTP.

Si estuvieran mezclados, tendríamos conflictos de herramientas de build y confusion de responsabilidades. La separación también refleja la realidad de un equipo: los ingenieros de smart contracts y los de backend rara vez son los mismos.

### ¿Por qué `pnpm` y no `npm`?

`pnpm` es un gestor de paquetes más eficiente que `npm`: usa un store centralizado con hard links en vez de copiar `node_modules` en cada proyecto. En un monorepo o en una máquina con múltiples proyectos, el ahorro de disco y tiempo de instalación es significativo.

### ¿Por qué no hardcodear las credenciales?

Los party IDs de Canton contienen un hash que se genera cuando la party es registrada en el ledger. Ese hash **cambia cada vez que el sandbox se reinicia** porque es una instancia nueva del ledger. Por eso no se pueden hardcodear en el código ni en archivos de configuración versionados.

La solución: `setup-env.ts` consulta los party IDs del ledger activo y genera el `.env` dinámicamente en cada sesión.

### La solución al endpoint tree

El endpoint `/v2/commands/submit-and-wait-for-transaction-tree` existe para retornar el `exerciseResult` (el valor de retorno del choice Daml). En teoría es el endpoint correcto para `exercise()`. En la práctica, en `dpm sandbox 3.4.x`, ese endpoint tiene un schema diferente que causaba `HTTP 400`.

La solución pragmática: usar el endpoint plano para todo y derivar el `exerciseResult` de los `CreatedEvent`s. Esto funciona porque todos los choices del proyecto retornan `ContractId`s, y el ledger genera los eventos en orden de ejecución Daml.

### El orden de los eventos es determinístico

En Daml, cuando un choice ejecuta múltiples subchoices en secuencia, los eventos en la transacción aparecen en ese mismo orden. Esto es una garantía del runtime de Daml y nos permite reconstruir el valor de retorno de choices que retornan tuplas:

```daml
-- Daml: retorna (primero, segundo)
choice Settle : (ContractId Asset, ContractId Asset)
  do
    primero  <- exercise offeredAssetCid Transfer with newOwner = counterparty
    segundo  <- exercise counterpartyAssetCid Transfer with newOwner = proposer
    return (primero, segundo)
```

```typescript
// TypeScript: el array de eventos refleja ese orden
const [primeroCid, segundoCid] = settleResult.exerciseResult;
```

### Conclusión

El patrón que emerge de este proyecto es claro:

```
Daml define el QUÉ y el QUIÉN.   (los contratos y sus permisos)
TypeScript define el CUÁNDO y CÓMO.  (la orquestación y la UI)
Canton garantiza el CUMPLIMIENTO.    (rechaza lo que Daml no permite)
```

Cada capa tiene su lugar. Los contratos Daml no saben nada de HTTP. El cliente TypeScript no replica las reglas de negocio — solo dice "ejecuta este choice con estos argumentos". Canton se encarga del resto.
