/**
 * setup-env.ts — Generate the .env file for the ts-client
 * ─────────────────────────────────────────────────────────────────────────────
 * Prerequisites:
 *   The Canton sandbox must be running.
 *   Start it with: ./scripts/setup.sh
 *
 * What this script does:
 *   1. Calls GET /v2/parties on the JSON Ledger API to discover Alice, Bob,
 *      and Operator. If they do not exist yet, creates them automatically
 *      via POST /v2/parties (works in the insecure sandbox without auth).
 *   2. Generates JWT tokens for each party (Canton JSON Ledger API v2 format).
 *   3. Writes everything to ts-client/.env.
 *
 * Run with:
 *   pnpm setup:env
 *
 * About hardcoding credentials:
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  Party IDs change on every fresh sandbox restart.                   │
 *   │  Re-run this script after each sandbox restart.                     │
 *   └──────────────────────────────────────────────────────────────────────┘
 */

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';

// ─── Configuration ────────────────────────────────────────────────────────────

const JSON_API_URL = process.env.LEDGER_JSON_API_URL ?? 'http://localhost:7575';

/**
 * The Canton sandbox in dev mode (started by `daml start`) does not verify
 * JWT signatures. Any HS256 key works for local development.
 *
 * DO NOT use this key in production.
 */
const DEV_JWT_SECRET = 'canton-dev-insecure-secret-do-not-use-in-production';

/** Party display names we expect from Setup.daml's allocatePartyByHint calls. */
const EXPECTED_PARTIES = ['Alice', 'Bob', 'Operator'] as const;
type PartyName = (typeof EXPECTED_PARTIES)[number];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Command failed: ${cmd}\n${stderr || message}`);
  }
}

/** Shape of GET /v2/parties response. */
interface PartiesResponse {
  partyDetails?: Array<{ party: string; isLocal?: boolean }>;
}

/** Shape of POST /v2/parties response. */
interface AllocatePartyResponse {
  partyDetails?: { party: string };
}

/**
 * Call GET /v2/parties and return the raw response.
 * Throws if the sandbox is not reachable or the response is not valid JSON.
 */
function fetchParties(): PartiesResponse {
  let output: string;
  try {
    output = run(`curl -s --connect-timeout 5 ${JSON_API_URL}/v2/parties`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot reach the sandbox at ${JSON_API_URL}.\n` +
        `Start it with: ./scripts/setup.sh\n\nDetails: ${msg}`,
    );
  }

  if (!output) {
    throw new Error(
      `Empty response from ${JSON_API_URL}/v2/parties.\n` +
        `The sandbox may not be running. Start it with: ./scripts/setup.sh`,
    );
  }

  try {
    return JSON.parse(output) as PartiesResponse;
  } catch {
    throw new Error(
      `Unexpected response from ${JSON_API_URL}/v2/parties:\n${output.slice(0, 300)}\n\n` +
        `Is the sandbox running? Start it with: ./scripts/setup.sh`,
    );
  }
}

/**
 * Parse the GET /v2/parties response into a map of display name → full party ID.
 * Returns all parties found (not filtered to EXPECTED_PARTIES).
 */
function parsePartyMap(response: PartiesResponse): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of response.partyDetails ?? []) {
    if (p.party.includes('::')) {
      const displayName = p.party.split('::')[0];
      map.set(displayName, p.party);
    }
  }
  return map;
}

/**
 * Allocate a party via POST /v2/parties and return its full Canton ID.
 * Works in the insecure sandbox (dpm sandbox / daml start in dev mode)
 * without an Authorization header.
 */
function allocateParty(hint: PartyName): string {
  const body = JSON.stringify({ partyIdHint: hint, identityProviderId: '' });
  const output = run(
    `curl -s -X POST ${JSON_API_URL}/v2/parties ` +
      `-H "Content-Type: application/json" ` +
      `-d '${body}'`,
  );

  let parsed: AllocatePartyResponse;
  try {
    parsed = JSON.parse(output) as AllocatePartyResponse;
  } catch {
    throw new Error(
      `Failed to allocate party "${hint}".\n` +
        `Response: ${output.slice(0, 300)}`,
    );
  }

  const partyId = parsed.partyDetails?.party;
  if (!partyId) {
    throw new Error(
      `Allocating party "${hint}" succeeded but returned no party ID.\n` +
        `Response: ${output.slice(0, 300)}`,
    );
  }

  return partyId;
}

/**
 * Return party IDs for Alice, Bob, and Operator.
 * If any are missing, attempt to create them automatically via the HTTP API.
 */
function ensureParties(): Map<PartyName, string> {
  const response = fetchParties();
  const allParties = parsePartyMap(response);

  const ids = new Map<PartyName, string>();

  for (const name of EXPECTED_PARTIES) {
    if (allParties.has(name)) {
      ids.set(name, allParties.get(name)!);
    }
  }

  const missing = EXPECTED_PARTIES.filter((n) => !ids.has(n));

  if (missing.length === 0) {
    return ids;
  }

  // Show what IS in the ledger (helpful for debugging)
  if (allParties.size > 0) {
    console.log('\n   Parties currently on the ledger:');
    for (const [name, id] of allParties) {
      console.log(`      • ${name} → ${id}`);
    }
  }

  console.log(`\n⚠️  Parties not found: ${missing.join(', ')}. Allocating them now...`);

  for (const name of missing as PartyName[]) {
    process.stdout.write(`   Allocating ${name}... `);
    const partyId = allocateParty(name);
    ids.set(name, partyId);
    console.log(`✓ ${partyId}`);
  }

  return ids;
}

/**
 * Generate a JWT token for the given party using the Canton JSON Ledger API v2 format.
 *
 * The Canton sandbox (dev mode) does not verify JWT signatures, so any HS256
 * secret is accepted. This token will NOT work against a production Canton
 * participant with proper auth configured.
 *
 * Token format:
 *   sub   — "actAs-<partyId>" grants the bearer the right to act as that party
 *   scope — identifies the target service (Canton sandbox accepts any value)
 *
 * Reference:
 *   https://docs.digitalasset.com/build/3.4/explanations/json-api/index.html#access-tokens
 */
function generateDevToken(partyId: string): string {
  // sub is the user ID — in sandbox mode any string works.
  // We use the party's display name (e.g. "Alice") so the server can
  // auto-derive a userId from the token when not explicitly provided in requests.
  const displayName = partyId.split('::')[0];
  const payload = {
    sub:   displayName,
    scope: 'daml_ledger_api',
    aud:   [] as string[],
    iss:   null as null,
  };

  return jwt.sign(payload, DEV_JWT_SECRET, { algorithm: 'HS256' });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║         Canton Asset Swap — Setup Env            ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // ── Step 1: discover (or allocate) party IDs ──────────────────────────────
  console.log('🔍 Querying parties from the Canton JSON Ledger API...');
  console.log(`   (${JSON_API_URL}/v2/parties)`);

  let partyIds: Map<PartyName, string>;
  try {
    partyIds = ensureParties();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('\n❌ Could not reach or query the sandbox.');
    console.error('   Start it with:  ./scripts/setup.sh\n');
    console.error('Details:', msg);
    process.exit(1);
  }

  console.log('');
  for (const [name, id] of partyIds) {
    console.log(`   ✓ ${name.padEnd(10)} → ${id}`);
  }

  // ── Step 2: generate dev tokens ────────────────────────────────────────────
  console.log('\n🔑 Generating dev tokens (HS256, Canton JSON Ledger API v2 format)...');
  console.log('   Note: these tokens are for the local sandbox only.');

  const envLines: string[] = [
    `# Generated by setup-env.ts on ${new Date().toISOString()}`,
    `# Re-run \`pnpm setup:env\` after restarting the sandbox.`,
    `# Tokens use Canton JSON Ledger API v2 format and only work with the local sandbox.`,
    '',
    `LEDGER_JSON_API_URL=${JSON_API_URL}`,
    '',
  ];

  for (const name of EXPECTED_PARTIES) {
    const partyId = partyIds.get(name)!;
    const token   = generateDevToken(partyId);

    console.log(`   ✓ ${name}`);

    const prefix = name.toUpperCase();
    envLines.push(`${prefix}_PARTY=${partyId}`);
    envLines.push(`${prefix}_TOKEN=${token}`);
    envLines.push('');
  }

  // ── Step 3: write .env ────────────────────────────────────────────────────
  // The .env file lives at ts-client/.env (two levels up from src/scripts/)
  const envPath = path.resolve(__dirname, '..', '..', '.env');
  writeFileSync(envPath, envLines.join('\n'), 'utf-8');

  console.log(`\n✅ Written to: ${envPath}`);
  console.log('\n─────────────────────────────────────────────────────');
  console.log(' Ready! Run a demo:');
  console.log('');
  console.log('   pnpm demo:swap    # full swap lifecycle');
  console.log('   pnpm demo:batch   # batch transfer pattern');
  console.log('─────────────────────────────────────────────────────\n');
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('\n❌ Unexpected error:', msg);
  process.exit(1);
});
