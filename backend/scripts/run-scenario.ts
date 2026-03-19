// =============================================================================
// Swap Scenario Runner (Phase 3 T-08)
//
// Executes a complete cross-institution asset swap via the backend REST APIs:
//   1. Obtains OIDC tokens for trader-rojo, trader-azul, bot-rojo
//   2. Creates Asset TokenX via backend-rojo
//   3. Creates Asset TokenY via backend-azul
//   4. Proposes swap TokenX for TokenY via backend-rojo
//   5. Waits for projection, queries pending swaps on backend-azul
//   6. Accepts swap via backend-azul
//   7. Settles swap via backend-rojo (bot-rojo as settler)
//   8. Waits for projection, queries assets on both backends
//   9. Queries events for the full history
//  10. Prints summary
//
// Prerequisites:
//   - Full infrastructure running (orchestrate.sh + backends)
//   - Keycloak provisioned, bootstrap completed
//
// Usage: cd backend/scripts && npx tsx run-scenario.ts
// =============================================================================

// -- Backend endpoints --
const BACKEND_ROJO = "http://localhost:3001";
const BACKEND_AZUL = "http://localhost:3002";

// -- Keycloak OIDC configuration --
const KC_URL = "http://localhost:8080";
const KC_REALM = "canton";
const KC_CLIENT_ID = "ledger-api";
const KC_SCOPE = "daml_ledger_api";

// -- Credentials --
const CREDENTIALS = {
  "trader-rojo": "trader123",
  "trader-azul": "trader123",
  "bot-rojo": "bot123",
} as const;

// =============================================================================
// Helpers
// =============================================================================

async function getOidcToken(username: string, password: string): Promise<string> {
  const res = await fetch(
    `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: KC_CLIENT_ID,
        username,
        password,
        scope: KC_SCOPE,
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get OIDC token for '${username}': ${res.status} ${body}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function apiCall(
  baseUrl: string,
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { status: res.status, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================================================
// Scenario
// =============================================================================

async function main() {
  console.log("=== Swap Scenario Runner ===\n");

  // ---------- Step 1: Obtain OIDC tokens ----------
  console.log("1. Obtaining OIDC tokens...");

  let tokenRojo: string;
  let tokenAzul: string;
  let tokenBot: string;

  try {
    tokenRojo = await getOidcToken("trader-rojo", CREDENTIALS["trader-rojo"]);
    console.log("  trader-rojo: token obtained");

    tokenAzul = await getOidcToken("trader-azul", CREDENTIALS["trader-azul"]);
    console.log("  trader-azul: token obtained");

    tokenBot = await getOidcToken("bot-rojo", CREDENTIALS["bot-rojo"]);
    console.log("  bot-rojo: token obtained");
  } catch (err) {
    console.error(`  FAILED: ${(err as Error).message}`);
    console.error("\nIs the infrastructure running? (orchestrate.sh + backends)");
    process.exit(1);
  }

  // Verify backends are alive
  for (const [name, url] of [["backend-rojo", BACKEND_ROJO], ["backend-azul", BACKEND_AZUL]]) {
    try {
      const res = await fetch(`${url}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`  ${name}: healthy`);
    } catch (err) {
      console.error(`  FAILED: ${name} not available at ${url} — ${(err as Error).message}`);
      process.exit(1);
    }
  }
  console.log();

  // ---------- Step 2: Create Asset TokenX via backend-rojo ----------
  console.log("2. Creating Asset TokenX via backend-rojo...");
  const createX = await apiCall(BACKEND_ROJO, "POST", "/api/assets", tokenRojo, {
    symbol: "TokenX",
    quantity: "100",
    observers: [],
  });
  if (createX.status !== 201) {
    console.error(`  FAILED: Expected 201, got ${createX.status}`, createX.data);
    process.exit(1);
  }
  const tokenXCid = createX.data.contractId as string;
  console.log(`  TokenX created: ${tokenXCid.substring(0, 40)}...`);
  console.log();

  // ---------- Step 3: Create Asset TokenY via backend-azul ----------
  console.log("3. Creating Asset TokenY via backend-azul...");
  const createY = await apiCall(BACKEND_AZUL, "POST", "/api/assets", tokenAzul, {
    symbol: "TokenY",
    quantity: "50",
    observers: [],
  });
  if (createY.status !== 201) {
    console.error(`  FAILED: Expected 201, got ${createY.status}`, createY.data);
    process.exit(1);
  }
  const tokenYCid = createY.data.contractId as string;
  console.log(`  TokenY created: ${tokenYCid.substring(0, 40)}...`);
  console.log();

  // ---------- Step 4: Propose swap via backend-rojo ----------
  // We need the party IDs for counterparty and settler. These are resolved
  // by the backend from the token, but for the proposal we need the
  // counterparty's party ID. We get it from the assets query on backend-azul.
  console.log("4. Resolving party IDs from assets...");
  await sleep(4000); // Wait for projection to catch up

  const azulAssets = await apiCall(BACKEND_AZUL, "GET", "/api/assets", tokenAzul);
  const azulAsset = (azulAssets.data as unknown as Array<{ payload: { owner: string } }>)
    .find((a) => a.payload?.owner);
  if (!azulAsset) {
    console.error("  FAILED: Could not find BancoAzul asset to resolve party ID");
    return process.exit(1);
  }
  const bancoAzulParty = azulAsset.payload.owner;

  const rojoAssets = await apiCall(BACKEND_ROJO, "GET", "/api/assets", tokenRojo);
  const rojoAsset = (rojoAssets.data as unknown as Array<{ payload: { owner: string } }>)
    .find((a) => a.payload?.owner);
  if (!rojoAsset) {
    console.error("  FAILED: Could not find BancoRojo asset to resolve party ID");
    return process.exit(1);
  }
  const bancoRojoParty = rojoAsset.payload.owner;

  // Bot party — resolve from bot-rojo's assets query (bot has canActAs which includes read)
  // The bot's party is the same as BancoRojo's party (bot-rojo acts as BancoRojo)
  const botParty = bancoRojoParty;

  console.log(`  BancoRojo party: ${bancoRojoParty.substring(0, 30)}...`);
  console.log(`  BancoAzul party: ${bancoAzulParty.substring(0, 30)}...`);
  console.log(`  Settler (bot-rojo) party: ${botParty.substring(0, 30)}...`);
  console.log();

  console.log("5. Proposing swap: TokenX for TokenY via backend-rojo...");
  const propose = await apiCall(BACKEND_ROJO, "POST", "/api/swaps/propose", tokenRojo, {
    offeredAssetCid: tokenXCid,
    offeredSymbol: "TokenX",
    offeredQuantity: "100",
    requestedSymbol: "TokenY",
    requestedQuantity: "50",
    counterpartyParty: bancoAzulParty,
    settlerParty: botParty,
  });
  if (propose.status !== 201) {
    console.error(`  FAILED: Expected 201, got ${propose.status}`, propose.data);
    process.exit(1);
  }
  const proposalCid = propose.data.contractId as string;
  console.log(`  SwapProposal created: ${proposalCid.substring(0, 40)}...`);
  console.log();

  // ---------- Step 5: Wait for projection, query pending swaps ----------
  console.log("6. Waiting 4s for projection, querying pending swaps on backend-azul...");
  await sleep(4000);

  const pending = await apiCall(BACKEND_AZUL, "GET", "/api/swaps/pending", tokenAzul);
  const pendingSwaps = pending.data as unknown as Array<{ contract_id: string }>;
  console.log(`  Pending swaps on backend-azul: ${pendingSwaps.length}`);
  const foundProposal = pendingSwaps.find((s) => s.contract_id === proposalCid);
  if (foundProposal) {
    console.log(`  SwapProposal found in pending swaps`);
  } else {
    console.log(`  WARNING: SwapProposal not found in pending swaps (may need more time)`);
  }
  console.log();

  // ---------- Step 6: Accept swap via backend-azul ----------
  console.log("7. Accepting swap via backend-azul...");
  const accept = await apiCall(BACKEND_AZUL, "POST", `/api/swaps/${proposalCid}/accept`, tokenAzul, {
    counterpartyAssetCid: tokenYCid,
  });
  if (accept.status !== 200) {
    console.error(`  FAILED: Expected 200, got ${accept.status}`, accept.data);
    process.exit(1);
  }
  const settlementCid = accept.data.settlementContractId as string;
  console.log(`  Swap accepted. SwapSettlement: ${settlementCid ? settlementCid.substring(0, 40) + '...' : 'N/A'}`);
  console.log();

  // ---------- Step 7: Settle swap via backend-rojo (bot-rojo) ----------
  console.log("8. Settling swap via backend-rojo (bot-rojo as settler)...");
  const settle = await apiCall(BACKEND_ROJO, "POST", `/api/swaps/${settlementCid}/settle`, tokenBot, {});
  if (settle.status !== 200) {
    console.error(`  FAILED: Expected 200, got ${settle.status}`, settle.data);
    process.exit(1);
  }
  console.log(`  Swap settled successfully`);
  console.log();

  // ---------- Step 8: Wait for projection, query final state ----------
  console.log("9. Waiting 4s for projection, querying final asset state...");
  await sleep(4000);

  const finalRojo = await apiCall(BACKEND_ROJO, "GET", "/api/assets", tokenRojo);
  const finalAzul = await apiCall(BACKEND_AZUL, "GET", "/api/assets", tokenAzul);

  console.log(`  Assets on backend-rojo: ${(finalRojo.data as unknown as unknown[]).length}`);
  for (const asset of finalRojo.data as unknown as Array<{ payload: { symbol: string; owner: string; quantity: string } }>) {
    console.log(`    - ${asset.payload.symbol}: quantity=${asset.payload.quantity}, owner=${asset.payload.owner.substring(0, 25)}...`);
  }

  console.log(`  Assets on backend-azul: ${(finalAzul.data as unknown as unknown[]).length}`);
  for (const asset of finalAzul.data as unknown as Array<{ payload: { symbol: string; owner: string; quantity: string } }>) {
    console.log(`    - ${asset.payload.symbol}: quantity=${asset.payload.quantity}, owner=${asset.payload.owner.substring(0, 25)}...`);
  }
  console.log();

  // ---------- Step 9: Query events ----------
  console.log("10. Querying event history...");
  const events = await apiCall(BACKEND_ROJO, "GET", "/api/events?limit=20", tokenRojo);
  const eventList = events.data as unknown as Array<{ event_type: string; template_id: string; contract_id: string }>;
  console.log(`  Total events: ${eventList.length}`);
  for (const event of eventList.slice(0, 10)) {
    const templateShort = event.template_id.split(":").pop() ?? event.template_id;
    console.log(`    [${event.event_type}] ${templateShort} — ${event.contract_id.substring(0, 30)}...`);
  }
  if (eventList.length > 10) {
    console.log(`    ... and ${eventList.length - 10} more`);
  }
  console.log();

  // ---------- Step 10: Summary ----------
  console.log("=== Scenario Complete ===");
  console.log("  TokenX (100) created by BancoRojo → swapped to BancoAzul");
  console.log("  TokenY (50) created by BancoAzul → swapped to BancoRojo");
  console.log("  Full swap lifecycle: propose → accept → settle");
  console.log("  All steps completed successfully.");
}

main().catch((err) => {
  console.error(`\nSCENARIO FAILED: ${err.message}`);
  process.exit(1);
});
