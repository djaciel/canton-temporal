// =============================================================================
// Swap REST Endpoints
//
// POST /api/swaps/propose          — Create SwapProposal on Canton
// POST /api/swaps/:id/accept       — Exercise Accept on SwapProposal
// POST /api/swaps/:id/settle       — Exercise Settle on SwapSettlement
// POST /api/swaps/:id/reject       — Exercise Reject on SwapProposal
// POST /api/swaps/:id/cancel       — Exercise Cancel on SwapProposal
// GET  /api/swaps/pending          — Query active SwapProposals from projection
// GET  /api/swaps/settlements      — Query active SwapSettlements from projection
//
// All mutation endpoints forward the user's OIDC token to Canton.
// Canton enforces canActAs permissions (proposer, counterparty, settler).
// =============================================================================

import { Router, type Request, type Response } from 'express';
import { create, exercise, TEMPLATE_IDS, LedgerError } from '../services/ledger-client.js';
import { queryActiveContractsByTemplate } from '../db/queries.js';

export const swapsRouter = Router();

function handleLedgerError(err: unknown, res: Response): void {
  if (err instanceof LedgerError) {
    if (err.status === 403) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    res.status(err.status >= 500 ? 502 : err.status).json({ error: err.message });
    return;
  }
  res.status(503).json({ error: 'Canton ledger unavailable' });
}

// POST /api/swaps/propose — create SwapProposal
swapsRouter.post('/propose', async (req: Request, res: Response) => {
  const { userId, party, token } = req.auth!;
  const {
    offeredAssetCid,
    offeredSymbol,
    offeredQuantity,
    requestedSymbol,
    requestedQuantity,
    counterpartyParty,
    settlerParty,
  } = req.body;

  if (!offeredAssetCid || !offeredSymbol || !offeredQuantity || !requestedSymbol || !requestedQuantity || !counterpartyParty || !settlerParty) {
    res.status(400).json({ error: 'Missing required fields: offeredAssetCid, offeredSymbol, offeredQuantity, requestedSymbol, requestedQuantity, counterpartyParty, settlerParty' });
    return;
  }

  try {
    const result = await create(token, userId, party, TEMPLATE_IDS.SWAP_PROPOSAL, {
      proposer: party,
      counterparty: counterpartyParty,
      settler: settlerParty,
      offeredAssetCid,
      offeredSymbol,
      offeredQuantity: String(offeredQuantity),
      requestedSymbol,
      requestedQuantity: String(requestedQuantity),
    });

    res.status(201).json({ contractId: result.contractId });
  } catch (err) {
    handleLedgerError(err, res);
  }
});

// POST /api/swaps/:id/accept — exercise Accept on SwapProposal
swapsRouter.post('/:id/accept', async (req: Request, res: Response) => {
  const { userId, party, token } = req.auth!;
  const { counterpartyAssetCid } = req.body;

  if (!counterpartyAssetCid) {
    res.status(400).json({ error: 'Missing required field: counterpartyAssetCid' });
    return;
  }

  try {
    const result = await exercise(
      token, userId, party,
      TEMPLATE_IDS.SWAP_PROPOSAL,
      req.params.id,
      'Accept',
      { counterpartyAssetCid },
    );

    res.json({ settlementContractId: result.exerciseResult });
  } catch (err) {
    handleLedgerError(err, res);
  }
});

// POST /api/swaps/:id/settle — exercise Settle on SwapSettlement
swapsRouter.post('/:id/settle', async (req: Request, res: Response) => {
  const { userId, party, token } = req.auth!;

  try {
    const result = await exercise(
      token, userId, party,
      TEMPLATE_IDS.SWAP_SETTLEMENT,
      req.params.id,
      'Settle',
      {},
    );

    res.json({ exerciseResult: result.exerciseResult });
  } catch (err) {
    handleLedgerError(err, res);
  }
});

// POST /api/swaps/:id/reject — exercise Reject on SwapProposal
swapsRouter.post('/:id/reject', async (req: Request, res: Response) => {
  const { userId, party, token } = req.auth!;

  try {
    await exercise(
      token, userId, party,
      TEMPLATE_IDS.SWAP_PROPOSAL,
      req.params.id,
      'Reject',
      {},
    );

    res.json({ status: 'rejected' });
  } catch (err) {
    handleLedgerError(err, res);
  }
});

// POST /api/swaps/:id/cancel — exercise Cancel on SwapProposal
swapsRouter.post('/:id/cancel', async (req: Request, res: Response) => {
  const { userId, party, token } = req.auth!;

  try {
    await exercise(
      token, userId, party,
      TEMPLATE_IDS.SWAP_PROPOSAL,
      req.params.id,
      'Cancel',
      {},
    );

    res.json({ status: 'cancelled' });
  } catch (err) {
    handleLedgerError(err, res);
  }
});

// GET /api/swaps/pending — query active SwapProposals from projection
swapsRouter.get('/pending', async (_req: Request, res: Response) => {
  try {
    const proposals = await queryActiveContractsByTemplate(TEMPLATE_IDS.SWAP_PROPOSAL);
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: 'Failed to query pending swaps' });
  }
});

// GET /api/swaps/settlements — query active SwapSettlements from projection
swapsRouter.get('/settlements', async (_req: Request, res: Response) => {
  try {
    const settlements = await queryActiveContractsByTemplate(TEMPLATE_IDS.SWAP_SETTLEMENT);
    res.json(settlements);
  } catch (err) {
    res.status(500).json({ error: 'Failed to query settlements' });
  }
});
