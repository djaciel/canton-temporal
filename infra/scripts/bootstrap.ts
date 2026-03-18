import { readFileSync } from "fs";
import { resolve } from "path";
import { setupKeycloak } from "./keycloak-setup";

const PARTICIPANT1_URL = "http://localhost:5013";
const PARTICIPANT2_URL = "http://localhost:5023";
const DAR_PATH = resolve(
  __dirname,
  "../../daml-contracts/contracts/.daml/dist/asset-swap-contracts-0.1.0.dar"
);

// --- API helpers ---

async function uploadDar(participantUrl: string, darPath: string): Promise<void> {
  const darBuffer = readFileSync(darPath);
  const res = await fetch(`${participantUrl}/v2/packages`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: darBuffer,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DAR upload failed on ${participantUrl}: ${res.status} ${body}`);
  }
}

async function allocateParty(
  participantUrl: string,
  partyIdHint: string,
  displayName: string
): Promise<string> {
  const res = await fetch(`${participantUrl}/v2/parties`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ partyIdHint, displayName }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Party already exists — fetch it
    if (body.includes("already exists") || body.includes("PARTY_ALREADY_EXISTS")) {
      return await getPartyId(participantUrl, partyIdHint);
    }
    throw new Error(`Party allocation failed on ${participantUrl}: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { partyDetails: { party: string } };
  return data.partyDetails.party;
}

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

interface Right {
  kind: { CanActAs: { value: { party: string } } } | { CanReadAs: { value: { party: string } } };
}

function canActAs(party: string): Right {
  return { kind: { CanActAs: { value: { party } } } };
}

function canReadAs(party: string): Right {
  return { kind: { CanReadAs: { value: { party } } } };
}

async function createUser(
  participantUrl: string,
  id: string,
  primaryParty: string,
  rights: Right[]
): Promise<void> {
  const res = await fetch(`${participantUrl}/v2/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user: { id, primaryParty, isDeactivated: false, identityProviderId: "" },
      rights,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // User already exists — idempotent
    if (body.includes("USER_ALREADY_EXISTS")) {
      console.log(`  User ${id} already exists, skipping`);
      return;
    }
    throw new Error(`User creation failed on ${participantUrl}: ${res.status} ${body}`);
  }
}

// --- Main bootstrap ---

async function main() {
  console.log("=== Canton Bootstrap Script (Two-Phase) ===\n");

  // --- Phase A: Canton provisioning (no auth required) ---

  // Step 1: Wait for Canton to be ready
  console.log("--- Phase A: Canton Provisioning ---\n");
  console.log("1. Waiting for Canton participants...");
  for (const url of [PARTICIPANT1_URL, PARTICIPANT2_URL]) {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${url}/v2/version`);
        if (res.ok) break;
      } catch {
        // not ready yet
      }
      if (i === 59) throw new Error(`Timeout waiting for ${url}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.log("  Both participants are ready\n");

  // Step 2: Upload DAR to both participants
  console.log("2. Uploading DAR to both participants...");
  try {
    readFileSync(DAR_PATH);
  } catch {
    throw new Error(`DAR file not found at ${DAR_PATH}`);
  }
  await uploadDar(PARTICIPANT1_URL, DAR_PATH);
  console.log("  DAR uploaded to participant1");
  await uploadDar(PARTICIPANT2_URL, DAR_PATH);
  console.log("  DAR uploaded to participant2\n");

  // Step 3: Allocate parties
  console.log("3. Allocating parties...");
  const bancoRojo = await allocateParty(PARTICIPANT1_URL, "BancoRojo", "BancoRojo");
  console.log(`  BancoRojo allocated on participant1: ${bancoRojo}`);
  const bancoAzul = await allocateParty(PARTICIPANT2_URL, "BancoAzul", "BancoAzul");
  console.log(`  BancoAzul allocated on participant2: ${bancoAzul}\n`);

  // --- Keycloak provisioning: create realm, client, scope, users ---

  console.log("--- Keycloak Provisioning ---\n");
  const userMap = await setupKeycloak();
  console.log("");

  // --- Create Canton users with Keycloak UUIDs as IDs (DEC-010) ---

  console.log("--- Canton User Creation (UUID-based) ---\n");

  // Participant1 users (BancoRojo): trader, supervisor, bot
  console.log("4. Creating users on participant1 (UUIDs from Keycloak)...");
  await createUser(PARTICIPANT1_URL, userMap["trader-rojo"], bancoRojo, [canActAs(bancoRojo)]);
  console.log(`  trader-rojo (${userMap["trader-rojo"]}) created (canActAs BancoRojo)`);
  await createUser(PARTICIPANT1_URL, userMap["supervisor-rojo"], bancoRojo, [canReadAs(bancoRojo)]);
  console.log(`  supervisor-rojo (${userMap["supervisor-rojo"]}) created (canReadAs BancoRojo)`);
  await createUser(PARTICIPANT1_URL, userMap["bot-rojo"], bancoRojo, [canActAs(bancoRojo)]);
  console.log(`  bot-rojo (${userMap["bot-rojo"]}) created (canActAs BancoRojo)\n`);

  // Participant2 users (BancoAzul): trader, supervisor, bot
  console.log("5. Creating users on participant2 (UUIDs from Keycloak)...");
  await createUser(PARTICIPANT2_URL, userMap["trader-azul"], bancoAzul, [canActAs(bancoAzul)]);
  console.log(`  trader-azul (${userMap["trader-azul"]}) created (canActAs BancoAzul)`);
  await createUser(PARTICIPANT2_URL, userMap["supervisor-azul"], bancoAzul, [canReadAs(bancoAzul)]);
  console.log(`  supervisor-azul (${userMap["supervisor-azul"]}) created (canReadAs BancoAzul)`);
  await createUser(PARTICIPANT2_URL, userMap["bot-azul"], bancoAzul, [canActAs(bancoAzul)]);
  console.log(`  bot-azul (${userMap["bot-azul"]}) created (canActAs BancoAzul)\n`);

  // --- Verification ---

  console.log("--- Verification ---\n");
  console.log("Username → UUID Mapping:");
  for (const [username, uuid] of Object.entries(userMap)) {
    console.log(`  ${username} → ${uuid}`);
  }

  console.log("\n=== Bootstrap completed successfully ===");
}

main().catch((err) => {
  console.error(`\nBOOTSTRAP FAILED: ${err.message}`);
  process.exit(1);
});
