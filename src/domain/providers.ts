export type NetworkId = string;

export interface AssetRef {
  readonly network: NetworkId;
  readonly standard: string;
  readonly identifier: string;
  readonly decimals: number;
}

export interface ChainAddress {
  readonly network: NetworkId;
  readonly value: string;
}

export interface AssetAmount {
  readonly asset: AssetRef;
  /** Canonical nonnegative integer string in the asset's smallest unit. */
  readonly atomic: string;
}

export interface WalletReference {
  readonly providerWalletId: string;
  readonly credentialReference?: string;
}

export interface WalletCapabilities {
  readonly canReceive: boolean;
  readonly canSignTransfer: boolean;
  readonly canBroadcastTransfer: boolean;
  readonly canReadNativeBalance: boolean;
}

export interface WalletProvider {
  provisionWallet(input: {
    readonly accountReference: string;
    readonly idempotencyKey: string;
  }): Promise<WalletReference>;
  getAddress(
    wallet: WalletReference,
    network: NetworkId,
  ): Promise<ChainAddress>;
  getCapabilities(
    wallet: WalletReference,
    asset: AssetRef,
  ): Promise<WalletCapabilities>;
}

export interface QuoteRequest {
  readonly source: {
    readonly asset: AssetRef;
    readonly refundTo: ChainAddress;
  };
  readonly destination: {
    readonly asset: AssetRef;
    readonly recipient: ChainAddress;
  };
  readonly amount: {
    readonly side: "source" | "destination";
    readonly atomic: string;
  };
  readonly maxSlippageBps: number;
}

export interface QuoteTerms {
  readonly source: AssetAmount;
  readonly destination: AssetAmount;
  readonly minimumDestination: AssetAmount;
  readonly fees: readonly AssetAmount[];
}

export interface CommittedRoute {
  readonly reference: string;
  readonly terms: QuoteTerms;
  readonly expiresAt: string;
  readonly deposit: {
    readonly amount: AssetAmount;
    readonly address: ChainAddress;
    readonly memo?: string;
  };
}

export interface ChainTransaction {
  readonly network: NetworkId;
  readonly hash: string;
}

export interface RouteObservation {
  readonly state:
    | "awaiting-funding"
    | "funded"
    | "routing"
    | "delivery-reported"
    | "refund-reported"
    | "review";
  readonly originTransactions: readonly ChainTransaction[];
  readonly destinationTransactions: readonly ChainTransaction[];
}

export interface RoutingProvider {
  previewQuote(request: QuoteRequest): Promise<QuoteTerms>;
  commitQuote(
    request: QuoteRequest,
    idempotencyKey: string,
  ): Promise<CommittedRoute>;
  observeRoute(reference: string): Promise<RouteObservation>;
}

export interface TransferEvidence {
  readonly transaction: ChainTransaction;
  readonly transferKey: string;
  readonly blockHash: string;
  readonly recipient: ChainAddress;
  readonly amount: AssetAmount;
  readonly finality: "observed" | "finalized";
}

export interface ChainEvidenceProvider {
  readTransfers(
    transaction: ChainTransaction,
  ): Promise<readonly TransferEvidence[]>;
}
