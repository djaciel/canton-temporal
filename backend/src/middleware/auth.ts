// =============================================================================
// Auth Middleware — OIDC token validation via Keycloak JWKS
//
// Validates the JWT signature against Keycloak's public keys, extracts the
// userId from the `sub` claim, and resolves the user's primaryParty via
// Canton's /v2/users/{id} endpoint (DEC-016). The resolved party is cached
// in-memory to avoid repeated HTTP calls.
//
// After validation, attaches { userId, party, token } to req.auth so
// downstream route handlers can forward the token to Canton.
// =============================================================================

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { getUserParty } from '../services/ledger-client.js';

export interface AuthInfo {
  userId: string;
  party: string;
  token: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

const jwksUrl = `${config.keycloakUrl}/realms/${config.keycloakRealm}/protocol/openid-connect/certs`;
const jwks = createRemoteJWKSet(new URL(jwksUrl));

// Cache: userId → primaryParty
const partyCache = new Map<string, string>();

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, jwks);
    payload = result.payload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const userId = payload.sub;
  if (!userId) {
    res.status(401).json({ error: 'Token missing sub claim' });
    return;
  }

  let party = partyCache.get(userId);
  if (!party) {
    try {
      party = await getUserParty(token, userId);
      partyCache.set(userId, party);
    } catch (err) {
      res.status(502).json({ error: `Failed to resolve party: ${(err as Error).message}` });
      return;
    }
  }

  req.auth = { userId, party, token };
  next();
}
