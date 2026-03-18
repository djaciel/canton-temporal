import { describe, it, expect } from 'vitest';
import { TokenProvider } from '../services/token-provider.js';

describe('TokenProvider', () => {
  it('constructs without error', () => {
    const provider = new TokenProvider('bot-rojo', 'bot123', 'http://localhost:8080', 'canton');
    expect(provider).toBeDefined();
  });

  it('getToken throws when keycloak is not available', async () => {
    const provider = new TokenProvider('bot-rojo', 'bot123', 'http://localhost:19999', 'canton');
    await expect(provider.getToken()).rejects.toThrow();
  });
});
