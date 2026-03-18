export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  institutionName: process.env.INSTITUTION_NAME || 'unknown',
  participantUrl: process.env.PARTICIPANT_URL || 'http://localhost:5013',
  dbUrl: process.env.DATABASE_URL || 'postgresql://canton:canton@localhost:5432/backend_rojo',
  keycloakUrl: process.env.KEYCLOAK_URL || 'http://localhost:8080',
  keycloakRealm: process.env.KEYCLOAK_REALM || 'canton',
  botUsername: process.env.BOT_USERNAME || 'bot-rojo',
  botPassword: process.env.BOT_PASSWORD || 'bot123',
  pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '2000', 10),
} as const;
