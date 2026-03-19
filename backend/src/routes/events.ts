// =============================================================================
// Query Endpoints — Events & Contracts from Projection
//
// GET /api/events     — Query contract_events with pagination and optional
//                       templateId filter (ordered by offset descending)
// GET /api/contracts  — Query all active_contracts (no template filter)
//
// Both endpoints read from the local PostgreSQL projection DB.
// Auth middleware (upstream) ensures a valid OIDC token is present.
// =============================================================================

import { Router, type Request, type Response } from 'express';
import { queryContractEvents, queryAllActiveContracts } from '../db/queries.js';

export const eventsRouter = Router();

// GET /api/events — query contract events with pagination
eventsRouter.get('/events', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const templateId = req.query.templateId as string | undefined;

  try {
    const events = await queryContractEvents({ limit, offset, templateId });
    res.json(events);
  } catch {
    res.status(500).json({ error: 'Failed to query events' });
  }
});

// GET /api/contracts — query all active contracts
eventsRouter.get('/contracts', async (_req: Request, res: Response) => {
  try {
    const contracts = await queryAllActiveContracts();
    res.json(contracts);
  } catch {
    res.status(500).json({ error: 'Failed to query contracts' });
  }
});
