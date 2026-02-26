import { config as dotenvConfig } from 'dotenv';
import path from 'path';

// Load .env from the ts-client root (one level up from src/)
dotenvConfig({ path: path.join(__dirname, '..', '.env') });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `Copy .env.example to .env and fill in the values.`,
    );
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

// ─── Config object ────────────────────────────────────────────────────────────

/**
 * Loads and validates environment configuration.
 *
 * Call this function at the top of each script — it throws early with a
 * helpful message if any required variable is missing.
 *
 * Required env vars:
 *   ALICE_PARTY, ALICE_TOKEN
 *   BOB_PARTY,   BOB_TOKEN
 *   OPERATOR_PARTY, OPERATOR_TOKEN
 *
 * Optional:
 *   LEDGER_JSON_API_URL (default: http://localhost:7575)
 */
export function loadConfig() {
  return {
    ledger: {
      baseUrl: optional('LEDGER_JSON_API_URL', 'http://localhost:7575'),
    },
    parties: {
      alice: {
        id:    required('ALICE_PARTY'),
        token: required('ALICE_TOKEN'),
      },
      bob: {
        id:    required('BOB_PARTY'),
        token: required('BOB_TOKEN'),
      },
      operator: {
        id:    required('OPERATOR_PARTY'),
        token: required('OPERATOR_TOKEN'),
      },
    },
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
