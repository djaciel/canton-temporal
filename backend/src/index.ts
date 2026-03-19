import { app } from './app.js';
import { config } from './config.js';
import { EventConsumer } from './services/event-consumer.js';
import { getUserParty } from './services/ledger-client.js';

app.listen(config.port, () => {
  console.log(`Backend ${config.institutionName} listening on port ${config.port}`);

  // Start event consumer — resolves bot party via Canton /v2/users/{id}
  const consumer = new EventConsumer(async (token: string) => {
    // Decode bot user's sub claim from the JWT to get the userId
    const payload = JSON.parse(atob(token.split('.')[1]));
    return getUserParty(token, payload.sub);
  });
  consumer.start();
});
