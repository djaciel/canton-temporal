const PARTICIPANT1_URL = "http://localhost:5013";
const PARTICIPANT2_URL = "http://localhost:5023";

const TEMPLATE_ID = "#asset-swap-contracts:Asset:Asset";

// --- API helpers ---

async function getPartyId(participantUrl: string, partyIdHint: string): Promise<string> {
  const res = await fetch(`${participantUrl}/v2/parties`);
  const data = (await res.json()) as {
    partyDetails: { party: string; isLocal: boolean }[];
  };
  const match = data.partyDetails.find(
    (p) => p.party.startsWith(partyIdHint) && p.isLocal
  );
  if (!match) throw new Error(`Party ${partyIdHint} not found on ${participantUrl}`);
  return match.party;
}

async function getLedgerEnd(participantUrl: string, token: string): Promise<number> {
  const res = await fetch(`${participantUrl}/v2/state/ledger-end`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(`Failed to get ledger-end: ${res.status}`);
  const data = (await res.json()) as { offset: number };
  return data.offset;
}

async function createAsset(
  participantUrl: string,
  userId: string,
  issuer: string,
  owner: string,
  symbol: string,
  quantity: string,
  observers: string[]
): Promise<string> {
  const res = await fetch(`${participantUrl}/v2/commands/submit-and-wait-for-transaction`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userId}`,
    },
    body: JSON.stringify({
      commands: {
        commandId: `smoke-${Date.now()}`,
        userId,
        actAs: [owner],
        readAs: [owner],
        applicationId: "smoke-test",
        commands: [
          {
            CreateCommand: {
              templateId: TEMPLATE_ID,
              createArguments: { issuer, owner, symbol, quantity, observers },
            },
          },
        ],
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Create command failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    transaction: {
      events: Array<{ CreatedEvent?: { contractId: string } }>;
    };
  };
  const created = data.transaction.events.find((e) => e.CreatedEvent);
  if (!created?.CreatedEvent) throw new Error("No CreatedEvent in response");
  return created.CreatedEvent.contractId;
}

interface ActiveContract {
  contractId: string;
  templateId: string;
  payload: Record<string, unknown>;
}

async function queryActiveContracts(
  participantUrl: string,
  userId: string,
  partyId: string,
  templateId: string
): Promise<ActiveContract[]> {
  const offset = await getLedgerEnd(participantUrl, userId);

  const res = await fetch(`${participantUrl}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userId}`,
    },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [partyId]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId,
                      includeCreatedEventBlob: false,
                    },
                  },
                },
              },
            ],
          },
        },
      },
      verbose: true,
      activeAtOffset: offset,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Active contracts query failed: ${res.status} ${body}`);
  }

  const items = (await res.json()) as Array<{
    contractEntry?: {
      JsActiveContract?: {
        createdEvent: { contractId: string; templateId: string; createArgument: Record<string, unknown> };
      };
    };
  }>;

  return items
    .filter((item) => item.contractEntry?.JsActiveContract != null)
    .map((item) => {
      const ev = item.contractEntry!.JsActiveContract!.createdEvent;
      return {
        contractId: ev.contractId,
        templateId: ev.templateId,
        payload: ev.createArgument,
      };
    });
}

// --- Test runner ---

let passed = 0;
let failed = 0;

function pass(name: string) {
  passed++;
  console.log(`  PASS: ${name}`);
}

function fail(name: string, reason: string) {
  failed++;
  console.log(`  FAIL: ${name} — ${reason}`);
}

// --- Main smoke test ---

async function main() {
  console.log("=== Canton Smoke Test ===\n");

  // Step 1: Verify participants are ready
  console.log("1. Checking participants...");
  for (const url of [PARTICIPANT1_URL, PARTICIPANT2_URL]) {
    const res = await fetch(`${url}/v2/version`);
    if (!res.ok) throw new Error(`${url} not ready`);
  }
  pass("Both participants responding");
  console.log();

  // Step 2: Get party IDs
  console.log("2. Resolving parties...");
  const bancoRojo = await getPartyId(PARTICIPANT1_URL, "BancoRojo");
  const bancoAzul = await getPartyId(PARTICIPANT2_URL, "BancoAzul");
  pass(`BancoRojo resolved: ${bancoRojo.substring(0, 20)}...`);
  pass(`BancoAzul resolved: ${bancoAzul.substring(0, 20)}...`);
  console.log();

  // Step 3: Create Asset on participant1 as trader-rojo
  console.log("3. Creating Asset on participant1 as trader-rojo...");
  let contractId: string;
  try {
    contractId = await createAsset(
      PARTICIPANT1_URL,
      "trader-rojo",
      bancoRojo,
      bancoRojo,
      "TokenX",
      "100.0",
      [bancoAzul]
    );
    pass(`Asset created with contractId: ${contractId.substring(0, 30)}...`);
  } catch (err) {
    fail("Asset creation", (err as Error).message);
    printSummary();
    return;
  }
  console.log();

  // Step 4: Query active contracts on participant1
  console.log("4. Querying active contracts on participant1...");
  try {
    const p1Contracts = await queryActiveContracts(
      PARTICIPANT1_URL,
      "trader-rojo",
      bancoRojo,
      TEMPLATE_ID
    );
    const found = p1Contracts.find((c) => c.contractId === contractId);
    if (found) {
      pass("Asset visible on participant1");
    } else {
      fail("Asset visibility on participant1", `Contract ${contractId} not found in ${p1Contracts.length} contracts`);
    }
  } catch (err) {
    fail("Query participant1", (err as Error).message);
  }
  console.log();

  // Step 5: Query active contracts on participant2 as BancoAzul (cross-participant)
  console.log("5. Querying active contracts on participant2 (cross-participant)...");
  try {
    // Wait briefly for cross-participant sync
    await new Promise((r) => setTimeout(r, 2000));

    const p2Contracts = await queryActiveContracts(
      PARTICIPANT2_URL,
      "trader-azul",
      bancoAzul,
      TEMPLATE_ID
    );
    const found = p2Contracts.find((c) => c.contractId === contractId);
    if (found) {
      pass("Asset visible on participant2 (cross-participant visibility confirmed)");
    } else {
      fail("Cross-participant visibility", `Contract ${contractId} not found on participant2 (${p2Contracts.length} contracts found)`);
    }
  } catch (err) {
    fail("Query participant2", (err as Error).message);
  }

  console.log();
  printSummary();
}

function printSummary() {
  console.log("=== Summary ===");
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Result: ${failed === 0 ? "ALL PASSED" : "SOME FAILED"}`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nSMOKE TEST CRASHED: ${err.message}`);
  process.exit(1);
});
