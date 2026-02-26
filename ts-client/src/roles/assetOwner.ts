import { LedgerClient } from '../ledger/client';
import { Asset, Contract, TEMPLATE_IDS, toDecimalString } from '../types/contracts';

// ─── Param types ──────────────────────────────────────────────────────────────

export interface CreateAssetParams {
  symbol: string;
  quantity: number;
  /** Parties that can see this asset (e.g. the settler and counterparty). */
  observers?: string[];
}

export interface ProposeSwapParams {
  counterparty: string;
  settler: string;
  offeredAssetCid: string;
  offeredSymbol: string;
  offeredQuantity: number;
  requestedSymbol: string;
  requestedQuantity: number;
}

export interface AuthorizeTransferParams {
  /** The party authorized to execute this transfer (typically the Operator). */
  operator: string;
  newOwner: string;
  assetCid: string;
}

// ─── Role class ───────────────────────────────────────────────────────────────

/**
 * Encapsulates all ledger actions available to an asset owner (Alice, Bob, etc.).
 *
 * Each instance is tied to a single party via its `LedgerClient` token.
 * Only actions that the party is the `controller` of in Daml are exposed here.
 */
export class AssetOwner {
  constructor(
    private readonly client: LedgerClient,
    private readonly party: string,
  ) {}

  // ─── Asset lifecycle ───────────────────────────────────────────────────────

  /**
   * Issue (mint) a new asset. The party is both issuer and initial owner.
   * Corresponds to: `createCmd Asset with issuer = owner = this.party`
   */
  async createAsset(params: CreateAssetParams): Promise<Contract<Asset>> {
    console.log(
      `[AssetOwner:${this.party}] Issuing ${params.quantity} ${params.symbol}...`,
    );
    return this.client.create<Asset>(TEMPLATE_IDS.ASSET, {
      issuer:    this.party,
      owner:     this.party,
      symbol:    params.symbol,
      quantity:  toDecimalString(params.quantity),
      observers: params.observers ?? [],
    });
  }

  // ─── UTXO operations ───────────────────────────────────────────────────────

  /**
   * Split this asset into two at `splitQuantity`.
   * Returns `exerciseResult = [firstContractId, secondContractId]`.
   *
   * Daml: `choice Split : (ContractId Asset, ContractId Asset)`
   */
  async splitAsset(contractId: string, splitQuantity: number) {
    console.log(
      `[AssetOwner:${this.party}] Splitting asset — carving out ${splitQuantity}...`,
    );
    return this.client.exercise(
      TEMPLATE_IDS.ASSET,
      contractId,
      'Split',
      { splitQuantity: toDecimalString(splitQuantity) },
    );
  }

  /**
   * Merge `otherContractId` into `primaryContractId` (same symbol required).
   * The `other` contract is consumed; returns the new merged contract.
   *
   * Daml: `choice Merge : ContractId Asset`
   */
  async mergeAssets(primaryContractId: string, otherContractId: string) {
    console.log(`[AssetOwner:${this.party}] Merging two assets...`);
    return this.client.exercise(
      TEMPLATE_IDS.ASSET,
      primaryContractId,
      'Merge',
      { otherCid: otherContractId },
    );
  }

  /**
   * Add a new observer to this asset so the given party can see the contract.
   *
   * Daml: `choice Disclose : ContractId Asset`
   */
  async discloseAsset(contractId: string, newObserver: string) {
    console.log(`[AssetOwner:${this.party}] Disclosing asset to ${newObserver}...`);
    return this.client.exercise(
      TEMPLATE_IDS.ASSET,
      contractId,
      'Disclose',
      { newObserver },
    );
  }

  // ─── Swap proposal ─────────────────────────────────────────────────────────

  /**
   * Propose a swap: offer one asset in exchange for a specific symbol/quantity
   * from the counterparty.
   *
   * Daml: `createCmd SwapProposal`
   */
  async proposeSwap(params: ProposeSwapParams) {
    console.log(
      `[AssetOwner:${this.party}] Proposing swap: ` +
        `${params.offeredQuantity} ${params.offeredSymbol} ↔ ` +
        `${params.requestedQuantity} ${params.requestedSymbol}...`,
    );
    return this.client.create(TEMPLATE_IDS.SWAP_PROPOSAL, {
      proposer:          this.party,
      counterparty:      params.counterparty,
      settler:           params.settler,
      offeredAssetCid:   params.offeredAssetCid,
      offeredSymbol:     params.offeredSymbol,
      offeredQuantity:   toDecimalString(params.offeredQuantity),
      requestedSymbol:   params.requestedSymbol,
      requestedQuantity: toDecimalString(params.requestedQuantity),
    });
  }

  /**
   * Cancel a pending swap proposal before the counterparty responds.
   *
   * Daml: `choice Cancel : ()`
   */
  async cancelProposal(proposalContractId: string) {
    console.log(`[AssetOwner:${this.party}] Cancelling swap proposal...`);
    return this.client.exercise(
      TEMPLATE_IDS.SWAP_PROPOSAL,
      proposalContractId,
      'Cancel',
      {},
    );
  }

  // ─── Batching: TransferRequest ─────────────────────────────────────────────

  /**
   * Pre-authorize the operator to transfer `assetCid` to `newOwner`.
   * Creates a `TransferRequest` signed by this party (the owner).
   *
   * The operator can later batch this with other requests and execute
   * all of them in a single Daml transaction via `TransferBatch`.
   *
   * Daml: `createCmd TransferRequest`
   */
  async authorizeTransfer(params: AuthorizeTransferParams) {
    console.log(
      `[AssetOwner:${this.party}] Creating TransferRequest ` +
        `(asset → ${params.newOwner}, authorized operator: ${params.operator})...`,
    );
    return this.client.create(TEMPLATE_IDS.TRANSFER_REQUEST, {
      operator: params.operator,
      owner:    this.party,
      newOwner: params.newOwner,
      assetCid: params.assetCid,
    });
  }

  /**
   * Cancel a previously created TransferRequest before the operator executes it.
   *
   * Daml: `choice CancelTransfer : ()`
   */
  async cancelTransferRequest(transferRequestContractId: string) {
    console.log(`[AssetOwner:${this.party}] Cancelling TransferRequest...`);
    return this.client.exercise(
      TEMPLATE_IDS.TRANSFER_REQUEST,
      transferRequestContractId,
      'CancelTransfer',
      {},
    );
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  /** Return all active Asset contracts currently owned by this party. */
  async queryAssets() {
    return this.client.query<Asset>(TEMPLATE_IDS.ASSET, { owner: this.party });
  }
}
