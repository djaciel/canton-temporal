const KC_URL = "http://localhost:8080";
const REALM = "canton";
const CLIENT_ID = "ledger-api";
const SCOPE_NAME = "daml_ledger_api";

const USERS = [
  { username: "trader-rojo", email: "trader-rojo@banco-rojo.local", firstName: "Trader", lastName: "Rojo", password: "trader123" },
  { username: "supervisor-rojo", email: "supervisor-rojo@banco-rojo.local", firstName: "Supervisor", lastName: "Rojo", password: "supervisor123" },
  { username: "bot-rojo", email: "bot-rojo@banco-rojo.local", firstName: "Bot", lastName: "Rojo", password: "bot123" },
  { username: "trader-azul", email: "trader-azul@banco-azul.local", firstName: "Trader", lastName: "Azul", password: "trader123" },
  { username: "supervisor-azul", email: "supervisor-azul@banco-azul.local", firstName: "Supervisor", lastName: "Azul", password: "supervisor123" },
  { username: "bot-azul", email: "bot-azul@banco-azul.local", firstName: "Bot", lastName: "Azul", password: "bot123" },
];

// --- Admin token ---

async function getAdminToken(): Promise<string> {
  const res = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "admin",
      password: "admin",
    }),
  });
  if (!res.ok) throw new Error(`Failed to get admin token: ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// --- Realm ---

async function createRealm(token: string): Promise<void> {
  const res = await fetch(`${KC_URL}/admin/realms`, {
    method: "POST",
    headers: authHeader(token),
    body: JSON.stringify({
      realm: REALM,
      enabled: true,
      accessTokenLifespan: 300,
    }),
  });
  if (res.status === 409) {
    console.log("  Realm 'canton' already exists, skipping");
    return;
  }
  if (!res.ok) throw new Error(`Failed to create realm: ${res.status} ${await res.text()}`);
  console.log("  Realm 'canton' created (accessTokenLifespan=300)");
}

// --- Client Scope ---

async function createClientScope(token: string): Promise<string> {
  // Create scope
  const res = await fetch(`${KC_URL}/admin/realms/${REALM}/client-scopes`, {
    method: "POST",
    headers: authHeader(token),
    body: JSON.stringify({
      name: SCOPE_NAME,
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": "true" },
    }),
  });

  let scopeId: string;
  if (res.status === 409) {
    console.log("  Client scope 'daml_ledger_api' already exists, skipping");
    // Fetch existing scope ID
    const scopesRes = await fetch(`${KC_URL}/admin/realms/${REALM}/client-scopes`, {
      headers: authHeader(token),
    });
    const scopes = (await scopesRes.json()) as { id: string; name: string }[];
    const existing = scopes.find((s) => s.name === SCOPE_NAME);
    if (!existing) throw new Error("Scope not found after 409");
    scopeId = existing.id;
  } else if (!res.ok) {
    throw new Error(`Failed to create client scope: ${res.status} ${await res.text()}`);
  } else {
    // Extract scope ID from Location header or fetch it
    const scopesRes = await fetch(`${KC_URL}/admin/realms/${REALM}/client-scopes`, {
      headers: authHeader(token),
    });
    const scopes = (await scopesRes.json()) as { id: string; name: string }[];
    const created = scopes.find((s) => s.name === SCOPE_NAME);
    if (!created) throw new Error("Scope not found after creation");
    scopeId = created.id;
    console.log("  Client scope 'daml_ledger_api' created");
  }

  // Add mappers
  await addMapper(token, scopeId, {
    name: "audience-participant1",
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    config: {
      "included.custom.audience": "https://daml.com/jwt/aud/participant/participant1",
      "id.token.claim": "false",
      "access.token.claim": "true",
    },
  });

  await addMapper(token, scopeId, {
    name: "audience-participant2",
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    config: {
      "included.custom.audience": "https://daml.com/jwt/aud/participant/participant2",
      "id.token.claim": "false",
      "access.token.claim": "true",
    },
  });

  await addMapper(token, scopeId, {
    name: "sub-mapper",
    protocol: "openid-connect",
    protocolMapper: "oidc-sub-mapper",
    config: {
      "access.token.claim": "true",
    },
  });

  return scopeId;
}

async function addMapper(
  token: string,
  scopeId: string,
  mapper: Record<string, unknown>
): Promise<void> {
  const res = await fetch(
    `${KC_URL}/admin/realms/${REALM}/client-scopes/${scopeId}/protocol-mappers/models`,
    {
      method: "POST",
      headers: authHeader(token),
      body: JSON.stringify(mapper),
    }
  );
  if (res.status === 409) {
    console.log(`  Mapper '${(mapper as { name: string }).name}' already exists, skipping`);
    return;
  }
  if (!res.ok) throw new Error(`Failed to add mapper '${(mapper as { name: string }).name}': ${res.status} ${await res.text()}`);
  console.log(`  Mapper '${(mapper as { name: string }).name}' added`);
}

// --- Client ---

async function createClient(token: string): Promise<void> {
  const res = await fetch(`${KC_URL}/admin/realms/${REALM}/clients`, {
    method: "POST",
    headers: authHeader(token),
    body: JSON.stringify({
      clientId: CLIENT_ID,
      publicClient: true,
      directAccessGrantsEnabled: true,
      standardFlowEnabled: true,
      defaultClientScopes: [SCOPE_NAME],
    }),
  });
  if (res.status === 409) {
    console.log("  Client 'ledger-api' already exists, skipping");
    return;
  }
  if (!res.ok) throw new Error(`Failed to create client: ${res.status} ${await res.text()}`);
  console.log("  Client 'ledger-api' created (public, directAccessGrants)");
}

// --- Users ---

async function createUsers(token: string): Promise<Record<string, string>> {
  const userMap: Record<string, string> = {};

  for (const user of USERS) {
    const res = await fetch(`${KC_URL}/admin/realms/${REALM}/users`, {
      method: "POST",
      headers: authHeader(token),
      body: JSON.stringify({
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        emailVerified: true,
        enabled: true,
        credentials: [{ type: "password", value: user.password, temporary: false }],
      }),
    });

    let userId: string;
    if (res.status === 409) {
      console.log(`  User '${user.username}' already exists, fetching UUID`);
      userId = await getUserId(token, user.username);
    } else if (!res.ok) {
      throw new Error(`Failed to create user '${user.username}': ${res.status} ${await res.text()}`);
    } else {
      // Get the UUID from the Location header
      const location = res.headers.get("Location");
      if (location) {
        userId = location.split("/").pop()!;
      } else {
        userId = await getUserId(token, user.username);
      }
      console.log(`  User '${user.username}' created`);
    }

    userMap[user.username] = userId;
  }

  return userMap;
}

async function getUserId(token: string, username: string): Promise<string> {
  const res = await fetch(
    `${KC_URL}/admin/realms/${REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
    { headers: authHeader(token) }
  );
  if (!res.ok) throw new Error(`Failed to fetch user '${username}': ${res.status}`);
  const users = (await res.json()) as { id: string }[];
  if (users.length === 0) throw new Error(`User '${username}' not found`);
  return users[0].id;
}

// --- Main ---

export async function setupKeycloak(): Promise<Record<string, string>> {
  console.log("=== Keycloak Provisioning ===\n");

  console.log("1. Getting admin token...");
  const token = await getAdminToken();
  console.log("  Admin token obtained\n");

  console.log("2. Creating realm...");
  await createRealm(token);
  console.log("");

  console.log("3. Creating client scope with mappers...");
  await createClientScope(token);
  console.log("");

  console.log("4. Creating client...");
  await createClient(token);
  console.log("");

  console.log("5. Creating users...");
  const userMap = await createUsers(token);
  console.log("");

  console.log("=== User UUID Mapping ===");
  for (const [username, uuid] of Object.entries(userMap)) {
    console.log(`  ${username} → ${uuid}`);
  }
  console.log("");

  console.log("=== Keycloak Provisioning Complete ===");
  return userMap;
}

// Run directly
const isDirectRun = process.argv[1]?.includes("keycloak-setup");
if (isDirectRun) {
  setupKeycloak().catch((err) => {
    console.error(`\nKEYCLOAK SETUP FAILED: ${err.message}`);
    process.exit(1);
  });
}
