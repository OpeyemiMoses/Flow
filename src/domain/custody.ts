import type { NetworkId } from "./providers.ts";

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
 * Authoritative capability mappings verified against OutLayer OpenAPI 0.1.0-alpha.4.
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
    canReceive: true,
    canReadNativeBalance: true,
    canReadIntentsBalance: true,
    canSignTransfer: true,
    broadcastMode: "provider_broadcast",
    canRotateCredentials: true,
  },
  base: {
    network: "eip155:8453",
    canDeriveAddress: true,
    canReceive: true,
    canReadNativeBalance: false, // Requires independent Base RPC
    canReadIntentsBalance: false,
    canSignTransfer: true,
    broadcastMode: "caller_broadcast", // OutLayer signs raw tx; FLOW broadcasts
    canRotateCredentials: true,
  },
  ethereum: {
    network: "eip155:1",
    canDeriveAddress: true,
    canReceive: true,
    canReadNativeBalance: false, // Requires independent Ethereum RPC
    canReadIntentsBalance: false,
    canSignTransfer: true,
    broadcastMode: "caller_broadcast",
    canRotateCredentials: true,
  },
  solana: {
    network: "solana:mainnet",
    canDeriveAddress: true,
    canReceive: true,
    canReadNativeBalance: false, // Requires independent Solana RPC
    canReadIntentsBalance: false,
    canSignTransfer: true,
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
export type OutLayerPolicyState =
  | "none" // No policy stored in TEE; unbounded by customer policy (unverified custody)
  | "stored" // Verified policy stored in TEE; default-DENY
  | "unverified" // Network error or inability to verify TEE state
  | "rejected"; // Policy violates security rules or wallet is frozen

export interface CustodyPolicySummary {
  readonly walletId: string;
  readonly controller?: string;
  readonly state: OutLayerPolicyState;
  readonly frozen: boolean;
  /** Whether the wallet is permitted to participate in financial operations */
  readonly allowsFinancialExecution: boolean;
}

/**
 * Assesses whether a custody policy summary allows financial operations.
 * Enforces that a wallet with policy="none" or "unverified" NEVER allows execution.
 */
export function evaluatePolicyReadiness(
  policy: CustodyPolicySummary,
  globalExecutionDisabled: boolean,
): boolean {
  if (globalExecutionDisabled) return false;
  if (policy.frozen) return false;
  if (policy.state !== "stored") return false;
  return policy.allowsFinancialExecution;
}
