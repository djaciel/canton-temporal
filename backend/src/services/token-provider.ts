// =============================================================================
// Token Provider — Keycloak OIDC password grant with auto-refresh
//
// Used by the event consumer to authenticate as the bot user (bot-rojo/bot-azul)
// against Canton's Ledger API. Canton requires OIDC tokens for all endpoints
// when auth is enabled (DEC-017). Token lifetime is 300s, so we refresh 30s
// before expiry to avoid 401 errors mid-polling.
//
// Usage:
//   const provider = new TokenProvider('bot-rojo', 'bot123');
//   const token = await provider.getToken(); // cached until near-expiry
// =============================================================================

import { config } from '../config.js';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export class TokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  // Refresh 30s before actual expiry to prevent race conditions
  private refreshBuffer = 30_000;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly keycloakUrl: string = config.keycloakUrl,
    private readonly realm: string = config.keycloakRealm,
  ) {}

  /** Returns a valid token, refreshing automatically if near expiry. */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) {
      return this.token;
    }
    return this.refresh();
  }

  /** Acquires a fresh token via Keycloak's Resource Owner Password Grant. */
  private async refresh(): Promise<string> {
    const url = `${this.keycloakUrl}/realms/${this.realm}/protocol/openid-connect/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'ledger-api',
        username: this.username,
        password: this.password,
        scope: 'daml_ledger_api',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token acquisition failed for '${this.username}': ${res.status} ${body}`);
    }

    const data = (await res.json()) as TokenResponse;
    this.token = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000 - this.refreshBuffer;
    return this.token;
  }
}
