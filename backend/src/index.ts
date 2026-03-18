import { app } from './app.js';
import { config } from './config.js';

app.listen(config.port, () => {
  console.log(`Backend ${config.institutionName} listening on port ${config.port}`);
});
