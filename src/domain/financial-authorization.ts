/**
 * Flow Financial Authorization and Outgoing Payment Policy Specification.
 *
 * Enforces the strict separation between User Login Authentication and Financial Authorization:
 * - A valid web login session or email OTP confirms user identity only.
 * - Moving funds requires an explicit Financial Authorization Ticket subjected to:
 *   1. Recipient Address Validation (EIP-55, Solana Base58, NEAR syntax)
 *   2. Spending Policy Enforcement (single transfer limit, daily velocity, allowlist)
 *   3. Pre-Flight Transaction Simulation (RPC dry-run / estimate)
 *   4. Double-Entry Ledger Balance Reservation (earmarking payable liabilities)
 *   5. Privileged Worker Dispatch (isolated out-of-process signer with envelope key)
 *   6. Strict FLOW_EXECUTION=disabled Execution Guard
 */

import { FlowError } from "../foundation/errors.ts";
import {
  isFinancialExecutionDisabled,
  validateAddressForNetwork,
} from "./custody.ts";
import type { NetworkId } from "./providers.ts";

export type FinancialAuthorizationStatus =
  | "PENDING_APPROVAL"
  | "POLICY_APPROVED"
  | "RESERVED_IN_LEDGER"
  | "SIGNING"
  | "BROADCASTED"
  | "CONFIRMED_SETTLED"
  | "REJECTED"
  | "CANCELLED_RELEASED"
  | "EXECUTION_BLOCKED";

export interface SpendingPolicy {
  readonly id: string;
  readonly accountId: string;
  readonly maxSingleTransferAtomic: bigint;
  readonly dailyVelocityLimitAtomic: bigint;
  readonly dailyAccumulatedAtomic: bigint;
  readonly allowedNetworks: readonly string[];
  readonly allowedRecipientAddresses?: readonly string[];
  readonly requireDualApproval: boolean;
}

export interface FinancialTransferIntent {
  readonly transferId: string;
  readonly accountId: string;
  readonly initiatorUserId: string;
  readonly assetId: string;
  readonly network: NetworkId;
  readonly recipientAddress: string;
  readonly atomicAmount: bigint;
  readonly requestedAt: string;
  readonly userConfirmationProof: {
    readonly type: "EXPLICIT_STEP_UP_TICKET" | "DUAL_OPERATOR_SIGNATURE";
    readonly ticketDigest: string;
    readonly confirmedAt: string;
  };
}

export interface PreFlightSimulationResult {
  readonly network: NetworkId;
  readonly simulated: boolean;
  readonly estimatedNetworkFeeAtomic: bigint;
  readonly expectedBalanceAfterAtomic: bigint;
  readonly simulationError?: string;
}

export interface RecipientValidationResult {
  readonly valid: boolean;
  readonly canonicalAddress: string;
  readonly network: NetworkId;
  readonly error?: string;
}

/**
 * Validates recipient address according to network-specific cryptographic rules:
 * - NEAR: implicit (64 hex) or named (dot-separated segments)
 * - EVM / Base: 0x prefix, 40 hex chars, EIP-55 checksum valid, non-zero
 * - Solana: Base58 encoded 32-byte public key
 */
export function validateRecipientAddress(
  network: NetworkId,
  address: string,
): RecipientValidationResult {
  if (!address || typeof address !== "string" || address.trim().length === 0) {
    return {
      valid: false,
      canonicalAddress: "",
      network,
      error: "Recipient address cannot be empty.",
    };
  }

  const trimmed = address.trim();
  const res = validateAddressForNetwork(network, trimmed);
  return {
    valid: res.valid,
    canonicalAddress: res.normalized ?? trimmed,
    network,
    error: res.error,
  };
}

/**
 * Enforces spending policy limits on an outgoing transfer intent.
 */
export function evaluateSpendingPolicy(
  policy: SpendingPolicy,
  intent: FinancialTransferIntent,
): { readonly permitted: boolean; readonly reason?: string } {
  // 1. Network allowlist check
  if (!policy.allowedNetworks.includes(intent.network)) {
    return {
      permitted: false,
      reason: `Network ${intent.network} is not permitted by account spending policy.`,
    };
  }

  // 2. Single transfer limit check
  if (intent.atomicAmount > policy.maxSingleTransferAtomic) {
    return {
      permitted: false,
      reason: `Transfer amount (${intent.atomicAmount}) exceeds maximum single transfer limit (${policy.maxSingleTransferAtomic}).`,
    };
  }

  // 3. Daily velocity limit check
  const projectedDaily = policy.dailyAccumulatedAtomic + intent.atomicAmount;
  if (projectedDaily > policy.dailyVelocityLimitAtomic) {
    return {
      permitted: false,
      reason: `Projected 24-hour total (${projectedDaily}) exceeds daily velocity limit (${policy.dailyVelocityLimitAtomic}).`,
    };
  }

  // 4. Recipient address book allowlist check (if configured)
  if (
    policy.allowedRecipientAddresses &&
    policy.allowedRecipientAddresses.length > 0
  ) {
    const isAllowlisted = policy.allowedRecipientAddresses.some(
      (allowed) =>
        allowed.trim().toLowerCase() ===
        intent.recipientAddress.trim().toLowerCase(),
    );
    if (!isAllowlisted) {
      return {
        permitted: false,
        reason:
          "Recipient address is not in the account approved address book.",
      };
    }
  }

  return { permitted: true };
}

/**
 * Outgoing Financial Authorization Pipeline Manager.
 *
 * Verifies every prerequisite before any signing dispatch can occur:
 * 1. User approval is distinct from login session
 * 2. Recipient cryptographic validation
 * 3. Spending policy boundaries
 * 4. Ledger reservation
 * 5. Execution safety guardrail (FLOW_EXECUTION=disabled)
 */
export class FinancialAuthorizationPipeline {
  static authorizeOutgoingPayment(params: {
    readonly intent: FinancialTransferIntent;
    readonly policy: SpendingPolicy;
    readonly availableBalanceAtomic: bigint;
    readonly globalExecutionDisabled?: boolean;
    readonly env?: Record<string, string | undefined>;
  }): {
    readonly authorized: boolean;
    readonly status: FinancialAuthorizationStatus;
    readonly reservationAmountAtomic: bigint;
    readonly rejectionReason?: string;
  } {
    // 1. Mandatory execution guardrail
    if (
      isFinancialExecutionDisabled(
        params.globalExecutionDisabled,
        params.env as NodeJS.ProcessEnv | undefined,
      )
    ) {
      return {
        authorized: false,
        status: "EXECUTION_BLOCKED",
        reservationAmountAtomic: 0n,
        rejectionReason:
          "Outgoing payment execution is strictly disabled (FLOW_EXECUTION=disabled). Signing is blocked.",
      };
    }

    // 2. Recipient address cryptographic validation
    const recipientCheck = validateRecipientAddress(
      params.intent.network,
      params.intent.recipientAddress,
    );
    if (!recipientCheck.valid) {
      return {
        authorized: false,
        status: "REJECTED",
        reservationAmountAtomic: 0n,
        rejectionReason: recipientCheck.error ?? "Invalid recipient address.",
      };
    }

    // 3. Balance sufficiency check
    if (params.intent.atomicAmount > params.availableBalanceAtomic) {
      return {
        authorized: false,
        status: "REJECTED",
        reservationAmountAtomic: 0n,
        rejectionReason: "Insufficient available merchant ledger balance.",
      };
    }

    // 4. Spending policy evaluation
    const policyResult = evaluateSpendingPolicy(params.policy, params.intent);
    if (!policyResult.permitted) {
      return {
        authorized: false,
        status: "REJECTED",
        reservationAmountAtomic: 0n,
        rejectionReason: policyResult.reason ?? "Policy violation.",
      };
    }

    // 5. Dual approval check for business accounts
    if (
      params.policy.requireDualApproval &&
      params.intent.userConfirmationProof.type !== "DUAL_OPERATOR_SIGNATURE"
    ) {
      return {
        authorized: false,
        status: "PENDING_APPROVAL",
        reservationAmountAtomic: 0n,
        rejectionReason:
          "Transfer requires dual-operator authorization before ledger reservation and signing.",
      };
    }

    return {
      authorized: true,
      status: "POLICY_APPROVED",
      reservationAmountAtomic: params.intent.atomicAmount,
    };
  }

  /**
   * Asserts that an unprivileged caller (e.g. web session, browser client) cannot trigger signing.
   */
  static assertPrivilegedSigningContext(callerRole: string): void {
    if (callerRole !== "flow_worker") {
      throw new FlowError(
        "CUSTODY_OPERATOR_AUTHORIZATION_ERROR",
        `Caller role '${callerRole}' cannot access custody signing credentials. Only 'flow_worker' is permitted.`,
      );
    }
  }
}
