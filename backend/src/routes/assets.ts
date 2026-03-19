// =============================================================================
// Asset REST Endpoints
//
// POST /api/assets — Create an asset on Canton ledger (requires canActAs)
// GET  /api/assets — Query active assets from projection DB
//
// Auth middleware (upstream) attaches req.auth = { userId, party, token }.
// POST forwards the user's token to Canton; Canton enforces canActAs/canReadAs.
// GET reads from the local projection DB (no Canton call needed).
// =============================================================================

import { Router, type Request, type Response } from 'express';
import { create, TEMPLATE_IDS, LedgerError } from '../services/ledger-client.js';
import { queryActiveContractsByTemplate } from '../db/queries.js';

export const assetsRouter = Router();

// POST /api/assets — create asset via Canton
assetsRouter.post('/', async (req: Request, res: Response) => {
  const { userId, party, token } = req.auth!;
  const { symbol, quantity, observers } = req.body;

  if (!symbol || quantity == null) {
    res.status(400).json({ error: 'Missing required fields: symbol, quantity' });
    return;
  }

  try {
    const result = await create(token, userId, party, TEMPLATE_IDS.ASSET, {
      issuer: party,
      owner: party,
      symbol,
      quantity: String(quantity),
      observers: observers ?? [],
    });

    res.status(201).json({ contractId: result.contractId });
  } catch (err) {
    if (err instanceof LedgerError) {
      if (err.status === 403) {
        res.status(403).json({ error: 'Insufficient permissions (canActAs required)' });
        return;
      }
      res.status(err.status >= 500 ? 502 : err.status).json({ error: err.message });
      return;
    }
    res.status(503).json({ error: 'Canton ledger unavailable' });
  }
});

// GET /api/assets — query active assets from projection
assetsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const assets = await queryActiveContractsByTemplate(TEMPLATE_IDS.ASSET);
    res.json(assets);
  } catch (err) {
    res.status(500).json({ error: 'Failed to query assets' });
  }
});
