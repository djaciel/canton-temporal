import { LedgerClient } from '../ledger/client';
import { Contract, EmptyArg, SwapProposal, SwapSettlement, TEMPLATE_IDS } from '../types/contracts';

/**
 * Encapsulates ledger actions available to a swap counterparty (typically Bob).
 *
 * The counterparty's role is to respond to incoming `SwapProposal` contracts:
 * they can Accept (by pledging an asset) or Reject.
 */
export class Counterparty {
  constructor(
    private readonly client: LedgerClient,
    private readonly party: string,
  ) {}

  // ─── Respond to proposals ──────────────────────────────────────────────────

  /**
   * Accept a swap proposal by pledging an asset as the counter-leg.
   *
   * The JSON API validates (via the Daml contract) that:
   *   - The pledged asset's symbol matches `requestedSymbol`
   *   - The pledged quantity is ≥ `requestedQuantity`
   *   - The asset is currently owned by this party
   *
   * Returns `exerciseResult = contractId` of the new `SwapSettlement`.
   *
   * Daml: `choice Accept : ContractId SwapSettlement`
   */
  async acceptProposal(
    proposalContractId: string,
    counterpartyAssetCid: string,
  ) {
    console.log(
      `[Counterparty:${this.party}] Accepting proposal ${proposalContractId}...`,
    );
    return this.client.exercise<{ counterpartyAssetCid: string }, string>(
      TEMPLATE_IDS.SWAP_PROPOSAL,
      proposalContractId,
      'Accept',
      { counterpartyAssetCid },
    );
  }

  /**
   * Reject an incoming swap proposal.
   * The `SwapProposal` contract is archived; no settlement is created.
   *
   * Daml: `choice Reject : ()`
   */
  async rejectProposal(proposalContractId: string) {
    console.log(
      `[Counterparty:${this.party}] Rejecting proposal ${proposalContractId}...`,
    );
    return this.client.exercise<EmptyArg, null>(
      TEMPLATE_IDS.SWAP_PROPOSAL,
      proposalContractId,
      'Reject',
      {},
    );
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  /** Return all active SwapProposal contracts where this party is the counterparty. */
  async queryIncomingProposals(): Promise<Contract<SwapProposal>[]> {
    return this.client.query<SwapProposal>(TEMPLATE_IDS.SWAP_PROPOSAL, {
      counterparty: this.party,
    });
  }

  /** Return all active SwapSettlement contracts where this party is the counterparty. */
  async queryPendingSettlements(): Promise<Contract<SwapSettlement>[]> {
    return this.client.query<SwapSettlement>(TEMPLATE_IDS.SWAP_SETTLEMENT, {
      counterparty: this.party,
    });
  }
}
