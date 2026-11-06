import { FlowError } from "../foundation/errors.ts";
import type { NetworkId } from "./providers.ts";

/**
 * Required launch networks that must have verified addresses and capabilities
 * before any wallet can complete custodial provisioning (ACTIVE).
 */
export const REQUIRED_LAUNCH_NETWORKS = ["near", "base", "solana"] as const;
export type RequiredLaunchNetwork = (typeof REQUIRED_LAUNCH_NETWORKS)[number];

/**
 * Authoritative wallet lifecycle statuses stored in `flow.wallets.status`.
 *
 * Precise lifecycle semantics:
 * - `SETUP_PENDING`: OutLayer registration completed and the encrypted bearer credential
 *   is durably persisted. No chain addresses or custody policies are verified yet.
 * - `PROVISIONING`: All required multi-chain addresses (`near`, `base`, `solana`) and
 *   baseline capabilities (`canDeriveAddress=true`, `canReceive=false`, `canSignTransfer=false`)
 *   are validated and persisted. Awaiting custody policy verification (`policy_state='none'`).
 * - `ACTIVE`: Custodial provisioning AND provider-backed custody policy verification are
 *   complete (`policy_state='stored'`, `frozen=false`, verified NEAR `controller_account_id`,
 *   and all required launch chain addresses/capabilities verified).
 *   IMPORTANT: `ACTIVE` means custodial provisioning and policy verification are complete;
 *   it does NOT mean live fund movement is enabled. Live fund readiness is governed by
 *   `evaluateWalletFundReadiness()`, which unconditionally blocks all fund movement and
 *   live fund receipt whenever `FLOW_EXECUTION=disabled`.
 * - `SETUP_FAILED`: Terminal provisioning or policy verification failure.
 * - `FROZEN`: Wallet frozen by custody controller or operator security action.
 * - `RECOVERY_PENDING`: Wallet quarantined for operator-assisted recovery.
 */
export type WalletLifecycleStatus =
  | "SETUP_PENDING"
  | "PROVISIONING"
  | "ACTIVE"
  | "SETUP_FAILED"
  | "FROZEN"
  | "RECOVERY_PENDING";

/**
 * Validates a NEAR Protocol address.
 * Standard NEAR addresses are either:
 * - Implicit: exactly 64 hexadecimal characters (representing a 32-byte ed25519 public key).
 * - Named: 2-64 character identifier with segments separated by '.', '-', or '_'.
 */
export function isValidNearAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();
  if (trimmed.length < 2 || trimmed.length > 64) return false;

  // In NEAR, an address composed entirely of hexadecimal characters is an implicit account,
  // which MUST be exactly 64 lowercase hexadecimal characters (representing a 32-byte ed25519 public key).
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    return /^[0-9a-f]{64}$/.test(trimmed);
  }

  // Named account: 2-64 chars, segments separated by '.', '-', or '_' (e.g. "alice.near", "treasury.org")
  return /^(([a-z0-9_-]+\.)*[a-z0-9_-]+)$/.test(trimmed);
}

/**
 * Validates an EVM address (e.g. Base, Ethereum).
 * Standard EVM address is "0x" followed by exactly 40 hexadecimal characters.
 */
export function isValidEvmAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  return /^0x[0-9a-fA-F]{40}$/.test(address.trim());
}

/**
 * Validates a Solana address.
 * Standard Solana address is a Base58-encoded string of 32 to 44 characters.
 */
export function isValidSolanaAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.trim());
}

/**
 * Validates an address for a specific network identifier.
 */
export function validateAddressForNetwork(
  network: NetworkId,
  address: string,
): { valid: boolean; normalized?: string; error?: string } {
  if (!address || typeof address !== "string") {
    return { valid: false, error: "Address must be a non-empty string." };
  }

  const trimmed = address.trim();

  switch (network) {
    case "near:mainnet":
    case "near:testnet":
    case "near": {
      const valid = isValidNearAddress(trimmed);
      return valid
        ? { valid: true, normalized: trimmed.toLowerCase() }
        : {
            valid: false,
            error:
              "Invalid NEAR address. Must be a 64-hex implicit account ID or valid named account.",
          };
    }

    case "eip155:8453": // Base
    case "eip155:1": // Ethereum
    case "base":
    case "ethereum": {
      const valid = isValidEvmAddress(trimmed);
      return valid
        ? { valid: true, normalized: trimmed.toLowerCase() }
        : {
            valid: false,
            error:
              "Invalid EVM address. Must be 0x followed by 40 hex characters.",
          };
    }

    case "solana:mainnet":
    case "solana": {
      const valid = isValidSolanaAddress(trimmed);
      return valid
        ? { valid: true, normalized: trimmed }
        : {
            valid: false,
            error:
              "Invalid Solana address. Must be Base58-encoded (32-44 characters).",
          };
    }

    default:
      return {
        valid: false,
        error: `Unsupported network for address validation: ${network}`,
      };
  }
}

/**
 * OutLayer execution and broadcast mode per network.
 */
export type BroadcastMode =
  | "provider_broadcast" // Provider broadcasts directly (e.g. native NEAR)
  | "caller_broadcast" // Provider returns signed raw tx; FLOW/caller must broadcast (e.g. EVM, Solana)
  | "unsupported"; // Network cannot sign or broadcast

/**
 * Verified capability descriptor for a network under OutLayer custody.
 */
export interface NetworkCustodyCapabilities {
  readonly network: NetworkId;
  readonly canDeriveAddress: boolean;
  readonly canReceive: boolean;
  readonly canReadNativeBalance: boolean;
  readonly canReadIntentsBalance: boolean;
  readonly canSignTransfer: boolean;
  readonly broadcastMode: BroadcastMode;
  readonly canRotateCredentials: boolean;
}

/**
 * Authoritative baseline capability mappings verified against OutLayer OpenAPI 0.1.0-alpha.4.
 * Note: During M2 (`FLOW_EXECUTION=disabled`), `canSignTransfer` is strictly `false`
 * across all networks, and `canReceive` defaults to `false` until custody policy
 * verification succeeds (`verifyCustodyPolicyEvidence`).
 */
export const OUTLAYER_CAPABILITIES: Readonly<{
  near: NetworkCustodyCapabilities;
  base: NetworkCustodyCapabilities;
  ethereum: NetworkCustodyCapabilities;
  solana: NetworkCustodyCapabilities;
  bitcoin: NetworkCustodyCapabilities;
}> = Object.freeze({
  near: {
    network: "near:mainnet",
    canDeriveAddress: true,
    canReceive: false,
    canReadNativeBalance: true,
    canReadIntentsBalance: true,
    canSignTransfer: false,
    broadcastMode: "provider_broadcast",
    canRotateCredentials: true,
  },
  base: {
    network: "eip155:8453",
    canDeriveAddress: true,
    canReceive: false,
    canReadNativeBalance: false, // Requires independent Base RPC
    canReadIntentsBalance: false,
    canSignTransfer: false,
    broadcastMode: "caller_broadcast", // OutLayer signs raw tx; FLOW broadcasts
    canRotateCredentials: true,
  },
  ethereum: {
    network: "eip155:1",
    canDeriveAddress: true,
    canReceive: false,
    canReadNativeBalance: false, // Requires independent Ethereum RPC
    canReadIntentsBalance: false,
    canSignTransfer: false,
    broadcastMode: "caller_broadcast",
    canRotateCredentials: true,
  },
  solana: {
    network: "solana:mainnet",
    canDeriveAddress: true,
    canReceive: false,
    canReadNativeBalance: false, // Requires independent Solana RPC
    canReadIntentsBalance: false,
    canSignTransfer: false,
    broadcastMode: "caller_broadcast",
    canRotateCredentials: true,
  },
  bitcoin: {
    network: "bip122:000000000019d6689c085ae165831e93",
    canDeriveAddress: false, // OutLayer OpenAPI notes Bitcoin is not serviced by wallet v1
    canReceive: false,
    canReadNativeBalance: false,
    canReadIntentsBalance: false,
    canSignTransfer: false,
    broadcastMode: "unsupported",
    canRotateCredentials: false,
  },
});

/**
 * Policy lifecycle states in OutLayer TEE enclave.
 */
export const ALLOWED_POLICY_STATES = [
  "none",
  "stored",
  "unverified",
  "rejected",
] as const;

export type OutLayerPolicyState = (typeof ALLOWED_POLICY_STATES)[number];

export function isValidPolicyState(
  value: unknown,
): value is OutLayerPolicyState {
  return (
    typeof value === "string" &&
    (ALLOWED_POLICY_STATES as readonly string[]).includes(value)
  );
}

/**
 * Structured provider-backed policy evidence returned by OutLayer `/wallet/v1/policy`.
 * Raw caller-supplied strings are never accepted to promote custody policy state.
 */
export interface ProviderPolicyEvidenceInput {
  readonly wallet_id: string;
  readonly controller?: string;
  readonly frozen: boolean;
  readonly policy?: string;
  readonly rules?: Record<string, unknown>;
}

export interface VerifiedCustodyPolicy {
  readonly providerWalletId: string;
  readonly controllerAccountId: string;
  readonly policyState: "stored";
  readonly frozen: false;
}

/**
 * Validates provider-backed custody policy evidence before a wallet can transition
 * to `ACTIVE` or receive `policy_state = 'stored'`.
 * Rejects caller-supplied strings, mismatched wallet IDs, frozen wallets,
 * unverified/none policies, missing/invalid NEAR controller accounts, or missing rules.
 */
export function verifyCustodyPolicyEvidence(
  evidence: unknown,
  expectedProviderWalletId: string,
): VerifiedCustodyPolicy {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      "Custody policy promotion requires structured provider policy evidence, not a raw string or primitive.",
    );
  }

  const record = evidence as Record<string, unknown>;
  const walletId = record.wallet_id;
  if (typeof walletId !== "string" || walletId.trim().length === 0) {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      "Custody policy evidence is missing provider wallet_id.",
    );
  }

  if (walletId !== expectedProviderWalletId) {
    throw new FlowError(
      "CUSTODY_PROVIDER_CORRELATION_ERROR",
      `Custody policy evidence wallet_id (${walletId}) does not match expected wallet (${expectedProviderWalletId}).`,
    );
  }

  if (record.frozen !== false) {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      "Custody policy verification failed: wallet is frozen or missing frozen=false.",
    );
  }

  if (!isValidPolicyState(record.policy) || record.policy !== "stored") {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      `Custody policy verification requires policy='stored'; received '${String(record.policy ?? "undefined")}'.`,
    );
  }

  if (
    typeof record.controller !== "string" ||
    !isValidNearAddress(record.controller)
  ) {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      "Custody policy verification requires a valid NEAR controller account ID.",
    );
  }

  if (
    !record.rules ||
    typeof record.rules !== "object" ||
    Array.isArray(record.rules)
  ) {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      "Custody policy verification requires a non-null policy rules object.",
    );
  }

  return {
    providerWalletId: expectedProviderWalletId,
    controllerAccountId: record.controller.trim().toLowerCase(),
    policyState: "stored",
    frozen: false,
  };
}

function normalizeRequiredNetwork(
  network: string,
): RequiredLaunchNetwork | null {
  switch (network) {
    case "near":
    case "near:mainnet":
      return "near";
    case "base":
    case "eip155:8453":
      return "base";
    case "solana":
    case "solana:mainnet":
      return "solana";
    default:
      return null;
  }
}

/**
 * Validates that a wallet has complete, format-verified multi-chain addresses and
 * capabilities for all required launch networks (`near`, `base`, `solana`), and
 * enforces capability grant invariants (`canSignTransfer` must be `false`, and
 * `canReceive` cannot be `true` before policy verification).
 */
export function validateRequiredWalletProvisioning(params: {
  readonly nearAccountId: string;
  readonly addresses: ReadonlyArray<{
    readonly network: string;
    readonly chainId: string;
    readonly address: string;
    readonly publicKey: string;
  }>;
  readonly capabilities: ReadonlyArray<{
    readonly network: string;
    readonly canDeriveAddress: boolean;
    readonly canReceive: boolean;
    readonly canSignTransfer: boolean;
    readonly broadcastMode: string;
  }>;
  readonly policyVerified: boolean;
}): void {
  if (!isValidNearAddress(params.nearAccountId)) {
    throw new FlowError(
      "CUSTODY_INVALID_ADDRESS",
      "Wallet near_account_id is not a valid NEAR address.",
    );
  }

  const foundAddressNetworks = new Set<RequiredLaunchNetwork>();
  for (const addr of params.addresses) {
    const validation = validateAddressForNetwork(
      addr.network as NetworkId,
      addr.address,
    );
    if (!validation.valid) {
      throw new FlowError(
        "CUSTODY_INVALID_ADDRESS",
        `Invalid address for network ${addr.network}: ${validation.error}`,
      );
    }

    if (
      typeof addr.publicKey !== "string" ||
      addr.publicKey.trim().length === 0 ||
      typeof addr.chainId !== "string" ||
      addr.chainId.trim().length === 0
    ) {
      throw new FlowError(
        "INCOMPLETE_WALLET_PROVISIONING",
        `Address record for network ${addr.network} is missing publicKey or chainId.`,
      );
    }

    const canonical = normalizeRequiredNetwork(addr.network);
    if (canonical) {
      if (
        canonical === "near" &&
        addr.address.trim().toLowerCase() !==
          params.nearAccountId.trim().toLowerCase()
      ) {
        throw new FlowError(
          "CUSTODY_PROVIDER_CORRELATION_ERROR",
          "Derived NEAR address does not match registered wallet near_account_id.",
        );
      }
      foundAddressNetworks.add(canonical);
    }
  }

  for (const requiredNet of REQUIRED_LAUNCH_NETWORKS) {
    if (!foundAddressNetworks.has(requiredNet)) {
      throw new FlowError(
        "INCOMPLETE_WALLET_PROVISIONING",
        `Missing verified address for required launch network: ${requiredNet}.`,
      );
    }
  }

  const foundCapNetworks = new Set<RequiredLaunchNetwork>();
  for (const cap of params.capabilities) {
    if (cap.canSignTransfer) {
      throw new FlowError(
        "INVALID_CAPABILITY_GRANT",
        `Network ${cap.network} cannot grant can_sign_transfer while FLOW_EXECUTION=disabled.`,
      );
    }

    if (!params.policyVerified && cap.canReceive) {
      throw new FlowError(
        "INVALID_CAPABILITY_GRANT",
        `Network ${cap.network} cannot grant can_receive before custody policy is verified.`,
      );
    }

    if (!cap.canDeriveAddress) {
      throw new FlowError(
        "INCOMPLETE_WALLET_PROVISIONING",
        `Network ${cap.network} must have can_derive_address=true.`,
      );
    }

    const canonical = normalizeRequiredNetwork(cap.network);
    if (canonical) {
      foundCapNetworks.add(canonical);
    }
  }

  for (const requiredNet of REQUIRED_LAUNCH_NETWORKS) {
    if (!foundCapNetworks.has(requiredNet)) {
      throw new FlowError(
        "INCOMPLETE_WALLET_PROVISIONING",
        `Missing verified capability record for required launch network: ${requiredNet}.`,
      );
    }
  }
}

export interface CustodyPolicySummary {
  readonly walletId: string;
  readonly controller?: string;
  readonly state: OutLayerPolicyState;
  readonly frozen: boolean;
  /** Whether the wallet is permitted to participate in financial operations */
  readonly allowsFinancialExecution: boolean;
}

/**
 * Checks whether global financial execution is disabled.
 * Unconditionally returns `true` when `FLOW_EXECUTION=disabled` (or anything other
 * than `"enabled"` in `process.env.FLOW_EXECUTION`) or when `globalExecutionDisabled` is true.
 */
export function isFinancialExecutionDisabled(
  globalExecutionDisabled?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (globalExecutionDisabled === true) return true;
  const envMode = env.FLOW_EXECUTION ?? "disabled";
  return envMode !== "enabled";
}

/**
 * Assesses whether a custody policy summary allows financial operations.
 * Enforces that `FLOW_EXECUTION=disabled` unconditionally blocks execution,
 * and that a wallet with policy="none", "unverified", "rejected", frozen=true,
 * or missing a valid NEAR controller NEVER allows execution.
 */
export function evaluatePolicyReadiness(
  policy: CustodyPolicySummary,
  globalExecutionDisabled = true,
): boolean {
  if (isFinancialExecutionDisabled(globalExecutionDisabled)) return false;
  if (policy.frozen) return false;
  if (policy.state !== "stored") return false;
  if (!policy.controller || !isValidNearAddress(policy.controller)) {
    return false;
  }
  return policy.allowsFinancialExecution;
}

export interface WalletFundReadinessCheck {
  readonly isReady: boolean;
  readonly reason?: string;
  readonly blockingReasons: ReadonlyArray<string>;
  readonly canReceiveFunds: boolean;
  readonly canSignTransfers: boolean;
}

/**
 * Assesses complete wallet fund-readiness.
 * Decouples custodial provisioning completion (`walletStatus === 'ACTIVE'`) from
 * live fund-receiving and signing eligibility.
 *
 * CRITICAL GUARANTEE:
 * Whenever `FLOW_EXECUTION=disabled` (or `globalExecutionDisabled` is true),
 * this evaluator UNCONDITIONALLY returns:
 *   `{ isReady: false, canReceiveFunds: false, canSignTransfers: false }`
 * regardless of `walletStatus`, `policySummary`, or capability flags.
 */
export function evaluateWalletFundReadiness(params: {
  readonly walletStatus: string;
  readonly policySummary: CustodyPolicySummary;
  readonly derivedAddresses: ReadonlyArray<{
    network: string;
    address: string;
  }>;
  readonly capabilities: ReadonlyArray<{
    network: string;
    canSignTransfer: boolean;
    canReceive: boolean;
  }>;
  readonly globalExecutionDisabled?: boolean;
}): WalletFundReadinessCheck {
  const blockingReasons: string[] = [];

  const executionDisabled = isFinancialExecutionDisabled(
    params.globalExecutionDisabled,
  );
  if (executionDisabled) {
    blockingReasons.push(
      "Global financial execution is disabled (FLOW_EXECUTION=disabled).",
    );
  }

  if (params.walletStatus !== "ACTIVE") {
    blockingReasons.push(
      `Wallet status is ${params.walletStatus}, not ACTIVE.`,
    );
  }

  if (params.policySummary.frozen) {
    blockingReasons.push("Wallet is frozen by custody controller.");
  }

  if (
    !isValidPolicyState(params.policySummary.state) ||
    params.policySummary.state !== "stored"
  ) {
    blockingReasons.push(
      `Custody policy state is '${String(params.policySummary.state)}', requires verified 'stored' policy.`,
    );
  }

  if (
    !params.policySummary.controller ||
    !isValidNearAddress(params.policySummary.controller)
  ) {
    blockingReasons.push(
      "Custody policy is missing a verified NEAR controller account.",
    );
  }

  if (!params.policySummary.allowsFinancialExecution) {
    blockingReasons.push("Custody policy does not permit financial execution.");
  }

  // Check required chains have valid addresses: NEAR, Base, Solana
  const hasNear = params.derivedAddresses.some(
    (a) =>
      (a.network === "near" || a.network === "near:mainnet") &&
      isValidNearAddress(a.address),
  );
  const hasBase = params.derivedAddresses.some(
    (a) =>
      (a.network === "base" || a.network === "eip155:8453") &&
      isValidEvmAddress(a.address),
  );
  const hasSolana = params.derivedAddresses.some(
    (a) =>
      (a.network === "solana" || a.network === "solana:mainnet") &&
      isValidSolanaAddress(a.address),
  );

  if (!hasNear || !hasBase || !hasSolana) {
    blockingReasons.push(
      "Missing verified addresses for one or more required chains (NEAR, Base, Solana).",
    );
  }

  const hasNearCap = params.capabilities.some(
    (c) =>
      (c.network === "near" || c.network === "near:mainnet") && c.canReceive,
  );
  const hasBaseCap = params.capabilities.some(
    (c) =>
      (c.network === "base" || c.network === "eip155:8453") && c.canReceive,
  );
  const hasSolanaCap = params.capabilities.some(
    (c) =>
      (c.network === "solana" || c.network === "solana:mainnet") &&
      c.canReceive,
  );

  if (!hasNearCap || !hasBaseCap || !hasSolanaCap) {
    blockingReasons.push(
      "Missing verified receive capabilities for one or more required chains (NEAR, Base, Solana).",
    );
  }

  if (blockingReasons.length > 0) {
    return {
      isReady: false,
      reason: blockingReasons.join(" "),
      blockingReasons,
      canReceiveFunds: false,
      canSignTransfers: false,
    };
  }

  const anySignEnabled = params.capabilities.some((c) => c.canSignTransfer);
  return {
    isReady: true,
    blockingReasons: [],
    canReceiveFunds: true,
    canSignTransfers: anySignEnabled,
  };
}
