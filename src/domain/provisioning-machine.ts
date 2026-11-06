import { FlowError } from "../foundation/errors.ts";

export type ProvisioningStatus =
  | "PENDING"
  | "LEASED"
  | "SUBMITTED"
  | "REGISTERED"
  | "PROVISIONED"
  | "POLICY_VERIFYING"
  | "ACTIVE"
  | "UNKNOWN"
  | "MANUAL_REVIEW"
  | "FAILED"
  | "FROZEN";

export interface ProvisioningMachineState {
  readonly accountId: string;
  readonly status: ProvisioningStatus;
  readonly attempts: number;
  readonly leaseExpiresAt?: Date;
  readonly leaseHolder?: string;
  readonly walletId?: string;
  readonly nearAccountId?: string;
  readonly lastError?: string;
  readonly manualReviewReason?: string;
}

export type ProvisioningEvent =
  | {
      type: "ACQUIRE_LEASE";
      leaseExpiresAt: Date;
      leaseHolder: string;
      now: Date;
    }
  | { type: "RECORD_DISPATCH"; requestId: string; now: Date }
  | {
      type: "RECEIVE_REGISTRATION_SUCCESS";
      walletId: string;
      nearAccountId: string;
      now: Date;
    }
  | {
      type: "COMPLETE_ADDRESS_DERIVATION";
      now: Date;
    }
  | {
      type: "RECEIVE_SUCCESS";
      walletId: string;
      nearAccountId: string;
      now: Date;
    }
  | { type: "RECEIVE_AMBIGUOUS_ERROR"; error: string; now: Date }
  | { type: "RECEIVE_TERMINAL_ERROR"; error: string; now: Date }
  | { type: "START_POLICY_VERIFICATION"; now: Date }
  | { type: "POLICY_VERIFIED"; controller?: string; now: Date }
  | { type: "POLICY_REJECTED"; reason: string; now: Date }
  | { type: "ESCALATE_TO_MANUAL_REVIEW"; reason: string; now: Date }
  | { type: "OPERATOR_RESOLVE_WALLET"; walletId: string; now: Date }
  | { type: "OPERATOR_CANCEL_PROVISIONING"; reason: string; now: Date }
  | { type: "FREEZE_WALLET"; reason: string; now: Date };

/**
 * Pure state transition reducer for the durable wallet provisioning machine.
 * Enforces strict transitions, prevents duplicate wallet registrations,
 * and guarantees ambiguous provider responses transition to UNKNOWN/MANUAL_REVIEW.
 */
export function reduceProvisioningState(
  state: ProvisioningMachineState,
  event: ProvisioningEvent,
): ProvisioningMachineState {
  switch (event.type) {
    case "ACQUIRE_LEASE": {
      // Lease can only be acquired if PENDING, or if an existing lease expired before dispatch,
      // or if resuming address derivation / policy verification on an already REGISTERED or PROVISIONED wallet whose lease expired
      const canLease =
        state.status === "PENDING" ||
        (state.status === "LEASED" &&
          state.leaseExpiresAt &&
          state.leaseExpiresAt.getTime() <= event.now.getTime()) ||
        ((state.status === "REGISTERED" || state.status === "PROVISIONED") &&
          state.leaseExpiresAt &&
          state.leaseExpiresAt.getTime() <= event.now.getTime());

      if (!canLease) {
        throw new FlowError(
          "INVALID_STATE_TRANSITION",
          `Cannot acquire lease for account ${state.accountId} in status ${state.status}.`,
        );
      }

      return {
        ...state,
        status: "LEASED",
        attempts: state.attempts + 1,
        leaseExpiresAt: event.leaseExpiresAt,
        leaseHolder: event.leaseHolder,
      };
    }

    case "RECORD_DISPATCH": {
      if (state.status !== "LEASED") {
        throw new FlowError(
          "INVALID_STATE_TRANSITION",
          `Cannot record dispatch for account ${state.accountId} in status ${state.status}. Must be LEASED.`,
        );
      }
      return {
        ...state,
        status: "SUBMITTED",
      };
    }

    case "RECEIVE_REGISTRATION_SUCCESS": {
      if (state.status !== "SUBMITTED" && state.status !== "LEASED") {
        throw new FlowError(
          "INVALID_STATE_TRANSITION",
          `Cannot record registration success for account ${state.accountId} in status ${state.status}.`,
        );
      }
      return {
        ...state,
        status: "REGISTERED",
        walletId: event.walletId,
        nearAccountId: event.nearAccountId,
        lastError: undefined,
      };
    }

    case "COMPLETE_ADDRESS_DERIVATION": {
      if (state.status !== "REGISTERED" && state.status !== "LEASED") {
        throw new FlowError(
          "INVALID_STATE_TRANSITION",
          `Cannot complete address derivation in status ${state.status}. Must be REGISTERED or LEASED.`,
        );
      }
      return {
        ...state,
        status: "PROVISIONED",
      };
    }

    case "RECEIVE_SUCCESS": {
      if (
        state.status !== "SUBMITTED" &&
        state.status !== "LEASED" &&
        state.status !== "REGISTERED"
      ) {
        throw new FlowError(
          "INVALID_STATE_TRANSITION",
          `Cannot receive success for account ${state.accountId} in status ${state.status}.`,
        );
      }
      return {
        ...state,
        status: "PROVISIONED",
        walletId: event.walletId,
        nearAccountId: event.nearAccountId,
        leaseExpiresAt: undefined,
        leaseHolder: undefined,
        lastError: undefined,
      };
    }

    case "RECEIVE_AMBIGUOUS_ERROR": {
      // CRITICAL SAFETY RULE:
      // An ambiguous outcome (timeout, connection reset, 504) after dispatch
      // MUST NOT automatically retry or re-register a wallet.
      // It moves to UNKNOWN for reconciliation or MANUAL_REVIEW.
      if (state.status !== "SUBMITTED" && state.status !== "LEASED") {
        throw new FlowError(
          "INVALID_STATE_TRANSITION",
          `Cannot record ambiguous error for account ${state.accountId} in status ${state.status}.`,
        );
      }
      return {
        ...state,
        status: "UNKNOWN",
        lastError: event.error,
        leaseExpiresAt: undefined,
        leaseHolder: undefined,
      };
    }

    case "RECEIVE_TERMINAL_ERROR": {
      if (state.status !== "SUBMITTED" && state.status !== "LEASED") {
        throw new FlowError(
          "INVALID_STATE_TRANSITION",
          `Cannot record terminal error for account ${state.accountId} in status ${state.status}.`,
        );
      }
      return {
        ...state,
        status: "FAILED",
        lastError: event.error,
        leaseExpiresAt: undefined,
        leaseHolder: undefined,
      };
    }

    case "START_POLICY_VERIFICATION": {
      if (state.status !== "PROVISIONED") {
        throw new FlowError(
          "INVALID_STATE_TRANSITION",
          `Cannot start policy verification in status ${state.status}. Must be PROVISIONED.`,
        );
      }
      return {
        ...state,
        status: "POLICY_VERIFYING",
      };
    }

    case "POLICY_VERIFIED": {
      if (
        state.status !== "POLICY_VERIFYING" &&
        state.status !== "PROVISIONED"
      ) {
        throw new FlowError(
          "INVALID_STATE_TRANSITION",
          `Cannot mark policy verified in status ${state.status}.`,
        );
      }
      return {
        ...state,
        status: "ACTIVE",
        lastError: undefined,
      };
    }

    case "POLICY_REJECTED": {
      return {
        ...state,
        status: "FAILED",
        lastError: `Policy rejected: ${event.reason}`,
      };
    }

    case "ESCALATE_TO_MANUAL_REVIEW": {
      if (state.status !== "UNKNOWN" && state.status !== "FAILED") {
        throw new FlowError(
          "INVALID_STATE_TRANSITION",
          `Cannot escalate to manual review from status ${state.status}.`,
        );
      }
      return {
        ...state,
        status: "MANUAL_REVIEW",
        manualReviewReason: event.reason,
      };
    }

    case "OPERATOR_RESOLVE_WALLET": {
      if (state.status !== "MANUAL_REVIEW" && state.status !== "UNKNOWN") {
        throw new FlowError(
          "INVALID_STATE_TRANSITION",
          `Operator can only resolve wallets in UNKNOWN or MANUAL_REVIEW, not ${state.status}.`,
        );
      }
      return {
        ...state,
        status: "PROVISIONED",
        walletId: event.walletId,
        manualReviewReason: undefined,
        lastError: undefined,
      };
    }

    case "OPERATOR_CANCEL_PROVISIONING": {
      return {
        ...state,
        status: "FAILED",
        manualReviewReason: `Cancelled by operator: ${event.reason}`,
      };
    }

    case "FREEZE_WALLET": {
      return {
        ...state,
        status: "FROZEN",
        lastError: `Wallet frozen: ${event.reason}`,
      };
    }

    default:
      return state;
  }
}
