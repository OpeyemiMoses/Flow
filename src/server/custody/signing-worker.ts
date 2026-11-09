import { FlowError } from "../../foundation/errors.ts";
import {
  isFinancialExecutionDisabled,
  isValidNearAddress,
  validateAddressForNetwork,
} from "../../domain/custody.ts";
import { FinancialAuthorizationPipeline } from "../../domain/financial-authorization.ts";

export interface PreparedEvmTransaction {
  readonly chainId: number;
  readonly to: string;
  readonly valueAtomic: bigint;
  readonly nonce: number;
  readonly maxFeePerGasAtomic: bigint;
  readonly maxPriorityFeePerGasAtomic: bigint;
  readonly gasLimit: bigint;
  readonly data: string;
  readonly executionGated: boolean;
}

export interface PreparedSolanaTransaction {
  readonly recentBlockhash: string;
  readonly fromPubkey: string;
  readonly toPubkey: string;
  readonly lamportsAtomic: bigint;
  readonly executionGated: boolean;
}

export interface PreparedNearTransaction {
  readonly signerId: string;
  readonly receiverId: string;
  readonly nonce: bigint;
  readonly blockHash: string;
  readonly depositYoctoAtomic: bigint;
  readonly executionGated: boolean;
}

/**
 * Privileged Signing Preparation Worker.
 *
 * Responsibilities:
 * 1. Prepares network-specific unsigned transaction payloads for EVM, Solana, and NEAR.
 * 2. Enforces cryptographic address validation on destinations.
 * 3. Enforces execution gates: strictly blocks signing/broadcasting while FLOW_EXECUTION=disabled.
 * 4. Enforces worker role privilege isolation.
 */
export class SigningPreparationWorker {
  private readonly callerRole: string;

  constructor(callerRole = "flow_worker") {
    this.callerRole = callerRole;
    FinancialAuthorizationPipeline.assertPrivilegedSigningContext(callerRole);
  }

  /**
   * Prepares an EIP-1559 Base / Ethereum transaction payload.
   */
  prepareEvmTransaction(params: {
    readonly chainId: number;
    readonly to: string;
    readonly valueAtomic: bigint;
    readonly nonce: number;
    readonly maxFeePerGasAtomic: bigint;
    readonly maxPriorityFeePerGasAtomic: bigint;
    readonly gasLimit?: bigint;
    readonly data?: string;
  }): PreparedEvmTransaction {
    const network = params.chainId === 8453 ? "eip155:8453" : "eip155:1";
    const validation = validateAddressForNetwork(network, params.to);
    if (!validation.valid || !validation.normalized) {
      throw new FlowError(
        "CUSTODY_INVALID_ADDRESS",
        `Invalid EVM recipient address: ${params.to}`,
      );
    }

    if (params.valueAtomic < 0n) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        "Transaction value cannot be negative.",
      );
    }

    const executionDisabled = isFinancialExecutionDisabled();
    if (executionDisabled) {
      // Prepared representation is created for dry-run/simulation, but signing invocation is blocked
      return {
        chainId: params.chainId,
        to: validation.normalized,
        valueAtomic: params.valueAtomic,
        nonce: params.nonce,
        maxFeePerGasAtomic: params.maxFeePerGasAtomic,
        maxPriorityFeePerGasAtomic: params.maxPriorityFeePerGasAtomic,
        gasLimit: params.gasLimit ?? 21_000n,
        data: params.data ?? "0x",
        executionGated: true,
      };
    }

    throw new FlowError(
      "CUSTODY_EXECUTION_BLOCKED",
      "Live EVM signing is gated until owner mainnet authorization.",
    );
  }

  /**
   * Prepares a Solana native transfer transaction payload.
   */
  prepareSolanaTransaction(params: {
    readonly recentBlockhash: string;
    readonly fromPubkey: string;
    readonly toPubkey: string;
    readonly lamportsAtomic: bigint;
  }): PreparedSolanaTransaction {
    const fromValidation = validateAddressForNetwork(
      "solana:mainnet",
      params.fromPubkey,
    );
    if (!fromValidation.valid || !fromValidation.normalized) {
      throw new FlowError(
        "CUSTODY_INVALID_ADDRESS",
        `Invalid Solana pubkey: ${params.fromPubkey}`,
      );
    }

    const toValidation = validateAddressForNetwork(
      "solana:mainnet",
      params.toPubkey,
    );
    if (!toValidation.valid || !toValidation.normalized) {
      throw new FlowError(
        "CUSTODY_INVALID_ADDRESS",
        `Invalid Solana recipient address: ${params.toPubkey}`,
      );
    }

    if (params.lamportsAtomic < 0n) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        "Lamport amount cannot be negative.",
      );
    }

    if (!params.recentBlockhash || params.recentBlockhash.length < 32) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        "Invalid recent blockhash for Solana transaction.",
      );
    }

    const executionDisabled = isFinancialExecutionDisabled();
    if (executionDisabled) {
      return {
        recentBlockhash: params.recentBlockhash,
        fromPubkey: fromValidation.normalized,
        toPubkey: toValidation.normalized,
        lamportsAtomic: params.lamportsAtomic,
        executionGated: true,
      };
    }

    throw new FlowError(
      "CUSTODY_EXECUTION_BLOCKED",
      "Live Solana signing is gated until owner mainnet authorization.",
    );
  }

  /**
   * Prepares a NEAR native transfer transaction payload.
   */
  prepareNearTransaction(params: {
    readonly signerId: string;
    readonly receiverId: string;
    readonly nonce: bigint;
    readonly blockHash: string;
    readonly depositYoctoAtomic: bigint;
  }): PreparedNearTransaction {
    if (!isValidNearAddress(params.receiverId)) {
      throw new FlowError(
        "CUSTODY_INVALID_ADDRESS",
        `Invalid NEAR recipient account ID: ${params.receiverId}`,
      );
    }

    if (params.depositYoctoAtomic < 0n) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        "NEAR deposit amount cannot be negative.",
      );
    }

    if (!params.blockHash || params.blockHash.length < 32) {
      throw new FlowError(
        "INVALID_CONFIGURATION",
        "Invalid block hash for NEAR transaction.",
      );
    }

    const executionDisabled = isFinancialExecutionDisabled();
    if (executionDisabled) {
      return {
        signerId: params.signerId,
        receiverId: params.receiverId.toLowerCase(),
        nonce: params.nonce,
        blockHash: params.blockHash,
        depositYoctoAtomic: params.depositYoctoAtomic,
        executionGated: true,
      };
    }

    throw new FlowError(
      "CUSTODY_EXECUTION_BLOCKED",
      "Live NEAR signing is gated until owner mainnet authorization.",
    );
  }

  /**
   * Attempts to invoke signing enclave. Unconditionally blocked while FLOW_EXECUTION=disabled.
   */
  async signAndBroadcast(): Promise<never> {
    throw new FlowError(
      "CUSTODY_EXECUTION_BLOCKED",
      "Signing and transaction broadcast are strictly prohibited while FLOW_EXECUTION=disabled.",
    );
  }
}
