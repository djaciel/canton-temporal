// =============================================================================
// Canton OIDC Smoke Test (Phase 2)
//
// Validates the full OIDC authentication flow against Canton with Keycloak:
//   1. Obtains JWT tokens from Keycloak via password grant
//   2. Uses tokens to interact with Canton Ledger API v2
//   3. Verifies authorization rules (canActAs vs canReadAs)
//   4. Verifies rejection of invalid/missing tokens (401/403)
//
// Prerequisites:
//   - Canton running with auth enabled (topology-auth.conf)
//   - Keycloak running with realm "canton" provisioned (keycloak-setup.ts)
//   - Bootstrap completed (bootstrap.ts — DAR, parties, users)
//
// Usage: cd infra/scripts && npx tsx smoke-test.ts
// =============================================================================

// -- Canton participant endpoints (HTTP JSON API v2) --
const PARTICIPANT1_URL = "http://localhost:5013";
const PARTICIPANT2_URL = "http://localhost:5023";

// -- Keycloak OIDC configuration --
const KC_URL = "http://localhost:8080";
const KC_REALM = "canton";
const KC_CLIENT_ID = "ledger-api";        // Public client configured in Keycloak
const KC_SCOPE = "daml_ledger_api";       // Client scope with audience mappers

// -- Daml template for the Asset contract --
const TEMPLATE_ID = "#asset-swap-contracts:Asset:Asset";

// =============================================================================
// OIDC Helpers
// =============================================================================

/**
 * Obtains an OIDC access token from Keycloak using the Resource Owner Password
 * Credentials grant (direct access grant). The returned JWT contains:
 *   - sub: Keycloak user UUID (used as Canton user ID)
 *   - aud: audience values for both participants
 *   - scope: includes "daml_ledger_api"
 */
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
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get OIDC token for '${username}': ${res.status} ${body}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Decodes the payload section of a JWT token (without signature verification).
 * Used to extract the `sub` claim (Keycloak UUID) which serves as the Canton
 * user ID — Canton requires userId in command submissions to match the token's sub.
 */
function decodeJwtPayload(token: string): { sub: string; aud: string | string[]; scope: string } {
  const payload = token.split(".")[1];
  const decoded = Buffer.from(payload, "base64url").toString("utf-8");
  return JSON.parse(decoded);
}

// =============================================================================
// Canton Ledger API v2 Helpers
//
// All endpoints require `Authorization: Bearer <oidc-token>` when Canton
// is running with auth enabled. The token's `sub` claim must match a
// Canton user ID (which is the Keycloak UUID, per DEC-010).
// =============================================================================

/**
 * Resolves a user's primary party by querying their Canton user record.
 * With auth enabled, /v2/parties requires admin rights, so we use
 * /v2/users/{userId} instead — each user can read their own record.
 */
async function getUserPrimaryParty(participantUrl: string, token: string, userId: string): Promise<string> {
  const res = await fetch(`${participantUrl}/v2/users/${userId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to get user ${userId}: ${res.status}`);
  const data = (await res.json()) as {
    user: { primaryParty: string };
  };
  if (!data.user.primaryParty) throw new Error(`User ${userId} has no primaryParty`);
  return data.user.primaryParty;
}

/**
 * Gets the current ledger end offset. Required by the active contracts
 * query to specify the snapshot point (activeAtOffset).
 */
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

/**
 * Creates an Asset contract on the ledger via submit-and-wait.
 * The userId must match the token's `sub` claim (Keycloak UUID).
 * The actAs party must match the user's canActAs permission.
 */
async function createAsset(
  participantUrl: string,
  token: string,
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
      Authorization: `Bearer ${token}`,
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

/**
 * Queries the Active Contract Set (ACS) for contracts matching the given
 * template, filtered by party. Returns contracts visible to that party
 * at the current ledger end offset.
 */
async function queryActiveContracts(
  participantUrl: string,
  token: string,
  partyId: string,
  templateId: string
): Promise<ActiveContract[]> {
  const offset = await getLedgerEnd(participantUrl, token);

  const res = await fetch(`${participantUrl}/v2/state/active-contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
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

  // Canton returns a stream of entries; each may contain a JsActiveContract
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

/**
 * Sends a raw command submission and returns the HTTP status code + body.
 * Unlike createAsset(), this does NOT throw on non-200 responses — used
 * by auth tests to verify that Canton returns the expected 401/403 codes.
 *
 * @param authHeader - Full Authorization header value, or null to omit it
 */
async function submitCommandRaw(
  participantUrl: string,
  authHeader: string | null,
  userId: string,
  actAs: string[],
  command: Record<string, unknown>
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  const res = await fetch(`${participantUrl}/v2/commands/submit-and-wait-for-transaction`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      commands: {
        commandId: `smoke-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        userId,
        actAs,
        readAs: actAs,
        applicationId: "smoke-test",
        commands: [command],
      },
    }),
  });

  const body = await res.text();
  return { status: res.status, body };
}

// =============================================================================
// Test Runner — simple PASS/FAIL counter with summary
// =============================================================================

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

// =============================================================================
// Main Smoke Test
//
// Checks 1-6: Functional tests (same as Phase 1 but with OIDC tokens)
// Checks 7-10: Auth-specific tests (canReadAs, 403, 401)
// =============================================================================

async function main() {
  console.log("=== Canton OIDC Smoke Test ===\n");

  // ---------- Check 1: Participants are alive ----------
  // /v2/version does NOT require authentication
  console.log("1. Checking participants...");
  for (const url of [PARTICIPANT1_URL, PARTICIPANT2_URL]) {
    const res = await fetch(`${url}/v2/version`);
    if (!res.ok) throw new Error(`${url} not ready`);
  }
  pass("Both participants responding");
  console.log();

  // ---------- Check 2: Keycloak issues valid OIDC tokens ----------
  // Verifies password grant works and token contains expected claims
  console.log("2. Obtaining OIDC token for trader-rojo...");
  let traderRojoToken: string;
  let traderRojoUserId: string;
  try {
    traderRojoToken = await getOidcToken("trader-rojo", "trader123");
    const claims = decodeJwtPayload(traderRojoToken);
    traderRojoUserId = claims.sub;
    pass(`OIDC token obtained (sub=${traderRojoUserId.substring(0, 8)}..., aud=${JSON.stringify(claims.aud)}, scope=${claims.scope})`);
  } catch (err) {
    fail("OIDC token for trader-rojo", (err as Error).message);
    printSummary();
    return;
  }
  console.log();

  // ---------- Check 3: Resolve party IDs ----------
  // Each user's primaryParty maps to BancoRojo or BancoAzul (with crypto suffix)
  console.log("3. Resolving parties...");
  const traderAzulToken = await getOidcToken("trader-azul", "trader123");
  const traderAzulUserId = decodeJwtPayload(traderAzulToken).sub;
  const bancoRojo = await getUserPrimaryParty(PARTICIPANT1_URL, traderRojoToken, traderRojoUserId);
  const bancoAzul = await getUserPrimaryParty(PARTICIPANT2_URL, traderAzulToken, traderAzulUserId);
  pass(`BancoRojo resolved: ${bancoRojo.substring(0, 20)}...`);
  pass(`BancoAzul resolved: ${bancoAzul.substring(0, 20)}...`);
  console.log();

  // ---------- Check 4: Create Asset with OIDC token → HTTP 200 ----------
  // trader-rojo has canActAs for BancoRojo — should succeed
  console.log("4. Creating Asset on participant1 with OIDC token (trader-rojo)...");
  let contractId: string;
  try {
    contractId = await createAsset(
      PARTICIPANT1_URL,
      traderRojoToken,
      traderRojoUserId,
      bancoRojo,
      bancoRojo,
      "TokenX",
      "100.0",
      [bancoAzul]
    );
    pass(`Asset created with contractId: ${contractId.substring(0, 30)}...`);
  } catch (err) {
    fail("Asset creation with OIDC token", (err as Error).message);
    printSummary();
    return;
  }
  console.log();

  // ---------- Check 5: Asset visible on participant1 ----------
  // Query ACS as trader-rojo — the creator should see their own contract
  console.log("5. Querying active contracts on participant1 (trader-rojo)...");
  try {
    const p1Contracts = await queryActiveContracts(
      PARTICIPANT1_URL,
      traderRojoToken,
      bancoRojo,
      TEMPLATE_ID
    );
    const found = p1Contracts.find((c) => c.contractId === contractId);
    if (found) {
      pass("Asset visible on participant1 with OIDC token");
    } else {
      fail("Asset visibility on participant1", `Contract ${contractId} not found in ${p1Contracts.length} contracts`);
    }
  } catch (err) {
    fail("Query participant1", (err as Error).message);
  }
  console.log();

  // ---------- Check 6: Cross-participant visibility ----------
  // BancoAzul is an observer on the Asset, so trader-azul on participant2
  // should see it after the sync domain propagates the contract
  console.log("6. Querying active contracts on participant2 (trader-azul, cross-participant)...");
  try {
    // Wait briefly for cross-participant sync via the synchronizer
    await new Promise((r) => setTimeout(r, 2000));

    const p2Contracts = await queryActiveContracts(
      PARTICIPANT2_URL,
      traderAzulToken,
      bancoAzul,
      TEMPLATE_ID
    );
    const found = p2Contracts.find((c) => c.contractId === contractId);
    if (found) {
      pass("Asset visible on participant2 (cross-participant visibility with OIDC)");
    } else {
      fail("Cross-participant visibility", `Contract ${contractId} not found on participant2 (${p2Contracts.length} contracts found)`);
    }
  } catch (err) {
    fail("Query participant2", (err as Error).message);
  }
  console.log();

  // ---------- Check 7: canReadAs user can query ACS → HTTP 200 ----------
  // supervisor-rojo has canReadAs (not canActAs) — read operations should work
  console.log("7. Querying ACS as supervisor-rojo (canReadAs)...");
  try {
    const supervisorToken = await getOidcToken("supervisor-rojo", "supervisor123");
    const p1Contracts = await queryActiveContracts(
      PARTICIPANT1_URL,
      supervisorToken,
      bancoRojo,
      TEMPLATE_ID
    );
    if (p1Contracts.length > 0) {
      pass("supervisor-rojo (canReadAs) can query ACS — HTTP 200");
    } else {
      fail("supervisor-rojo ACS query", "No contracts returned");
    }
  } catch (err) {
    fail("supervisor-rojo ACS query", (err as Error).message);
  }
  console.log();

  // ---------- Check 8: canReadAs user cannot create → HTTP 403 ----------
  // supervisor-rojo only has canReadAs — write operations must be rejected
  // Canton returns: "Claims do not authorize to act as party '...'"
  console.log("8. Attempting CreateCommand as supervisor-rojo (canReadAs only)...");
  try {
    const supervisorToken = await getOidcToken("supervisor-rojo", "supervisor123");
    const supervisorUserId = decodeJwtPayload(supervisorToken).sub;
    const result = await submitCommandRaw(
      PARTICIPANT1_URL,
      `Bearer ${supervisorToken}`,
      supervisorUserId,
      [bancoRojo],
      {
        CreateCommand: {
          templateId: TEMPLATE_ID,
          createArguments: {
            issuer: bancoRojo,
            owner: bancoRojo,
            symbol: "Forbidden",
            quantity: "1.0",
            observers: [],
          },
        },
      }
    );
    if (result.status === 403) {
      pass(`supervisor-rojo CreateCommand rejected — HTTP 403`);
    } else {
      fail("supervisor-rojo CreateCommand", `Expected HTTP 403 but got ${result.status}`);
    }
  } catch (err) {
    fail("supervisor-rojo CreateCommand", (err as Error).message);
  }
  console.log();

  // ---------- Check 9: Invalid (garbage) token → HTTP 401 ----------
  // Canton should reject tokens it cannot verify via JWKS
  // Canton returns: "The command is missing a (valid) JWT token"
  console.log("9. Sending request with invalid (garbage) token...");
  try {
    const result = await submitCommandRaw(
      PARTICIPANT1_URL,
      "Bearer invalid-garbage-token-12345",
      "nonexistent-user",
      [bancoRojo],
      {
        CreateCommand: {
          templateId: TEMPLATE_ID,
          createArguments: {
            issuer: bancoRojo,
            owner: bancoRojo,
            symbol: "Invalid",
            quantity: "1.0",
            observers: [],
          },
        },
      }
    );
    if (result.status === 401) {
      pass(`Invalid token rejected — HTTP 401`);
    } else {
      fail("Invalid token", `Expected HTTP 401 but got ${result.status}`);
    }
  } catch (err) {
    fail("Invalid token", (err as Error).message);
  }
  console.log();

  // ---------- Check 10: No token at all → HTTP 401 ----------
  // Requests without the Authorization header must be rejected
  console.log("10. Sending request without Authorization header...");
  try {
    const result = await submitCommandRaw(
      PARTICIPANT1_URL,
      null,
      "nonexistent-user",
      [bancoRojo],
      {
        CreateCommand: {
          templateId: TEMPLATE_ID,
          createArguments: {
            issuer: bancoRojo,
            owner: bancoRojo,
            symbol: "NoAuth",
            quantity: "1.0",
            observers: [],
          },
        },
      }
    );
    if (result.status === 401) {
      pass(`No token rejected — HTTP 401`);
    } else {
      fail("No token", `Expected HTTP 401 but got ${result.status}`);
    }
  } catch (err) {
    fail("No token", (err as Error).message);
  }

  console.log();
  printSummary();
}

// =============================================================================
// Summary
// =============================================================================

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
