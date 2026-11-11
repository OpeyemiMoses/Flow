# FLOW — Final Low-Value Inbound Payment Readiness Report

**Milestone**: Final Low-Value Inbound Payment Readiness Audit  
**Target Action**: Prepare exactly ONE low-value real inbound cross-chain payment (without executing yet)  
**Safety Status**:
- `FLOW_EXECUTION=disabled` (STRICTLY ENFORCED)
- `FLOW_PROVIDER_COMPATIBILITY_MODE=disabled` (STRICTLY ENFORCED)
- `can_sign_transfer=false` (STRICTLY ENFORCED ACROSS ALL NETWORKS)
- **Zero OutLayer Wallet Registrations Initiated**  
- **Zero Live Payable Deposit Addresses Created**  

---

## 1. Executive Summary & GO / NO-GO Determination

| Determination | Status | Rationale |
| :--- | :--- | :--- |
| **Execution Decision** | **NO-GO FOR IMMEDIATE EXECUTION** | In accordance with strict instructions: *"prepare exactly ONE low-value real inbound cross-chain payment, without executing it yet. Do not send funds, create a live payable quote, unlock outgoing signing or request another wallet registration."* |
| **Preflight Readiness** | **GO FOR AUTHORIZATION PREFLIGHT** | All architectural, cryptographic, RPC, database, and safety prerequisites have been audited and verified end-to-end. The system is 100% prepared to safely handle a single \$1.00 USDC inbound cross-chain payment when explicitly authorized. |

---

## 2. Important Architecture Correction: Inbound vs. Outgoing Signing Separation

### The Architectural Invariant
An incoming 1Click payment is an **inbound cross-chain settlement**. The recipient account on FLOW is purely a **passive recipient of funds** on Base Mainnet.

```
[Guest Payer] ──(Deposits SOL)──> [1Click Solver Deposit Address]
                                           │
                                    (1Click Routing)
                                           │
                                           ▼
                    [Permanent Base Address: 0x436BdB38888998e269E94301C2362C2f46bCF614]
                                           ▲
                                           │ (Passive On-Chain Receipt)
                                 [FLOW Custodial Account]
                     (can_sign_transfer = false, FLOW_EXECUTION = disabled)
```

### Key Audit Findings:
1. **Outgoing Signing Is Never Touched**:
   - OutLayer container signing keys, `SigningWorker`, and `FinancialAuthorizationPipeline.authorizeOutgoingPayment` are strictly bound to **outgoing transfers** where FLOW broadcasts a signed transaction.
   - For inbound payments, FLOW creates no signed transaction, holds no solver liquidity, and broadcasts no contract call.
   - Therefore, **incoming 1Click payments DO NOT require activating OutLayer outgoing signing**.
2. **Capability Table Verification**:
   The active OutLayer wallet (`8b21f3d5-0102-41cf-9897-9eeb16581171`) in PostgreSQL maintains:
   - `can_receive`: `true`
   - `can_sign_transfer`: `false` (on Base, Ethereum, Solana, and NEAR)
3. **Narrow Inbound Commitment Guardrail**:
   - When `FLOW_EXECUTION=disabled`, the guest checkout commit endpoint (`/api/pay/[id]/commit`) is protected by `flow.check_active_payment_rehearsal_authorization` and `flow.consume_payment_rehearsal_authorization`.
   - Without an explicit, single-use rehearsal authorization record bound to the specific payment request, all commit requests fail-closed with `403 PAYMENT_EXECUTION_DISABLED`.
   - This allows an authorized single inbound test to commit a live quote without unlocking outgoing signing credentials or globally enabling `FLOW_EXECUTION`.

---

## 3. Cryptographic Signature Verification Evidence

Every quote returned by 1Click (`https://1click.chaindefuser.com/v0/quote`) is cryptographically signed by the 1Click Manager Ed25519 keypair.

### Live Signature Verification Proof
We issued a live preflight quote request for 1.00 USDC on Base (`amount: "1000000"`) from Solana SOL:
- **Provider Status**: `HTTP 201 Created`
- **Returned Signature**: `ed25519:3fhDfuSGadHmukPA17eryzQZRaDjURyJQUo82w5GTjhDR9dnXA7fJoXc4z3qTt6ciw5cPv5n55LCPmPSDDTbyaUh`
- **Correlation ID**: `b98b5d84-6a77-4247-b2fe-968fa8714ccb`
- **SDK Verification**: Verified via `@defuse-protocol/one-click-sdk-typescript`:
  ```typescript
  import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
  const isValid = verifyQuoteSignature(quoteResponse);
  // Result: true
  ```
- **Tamper Resistance Proof**: Verified that mutating even 1 lamport (`amountIn`) or altering the recipient address results in `verifyQuoteSignature` returning `false`.

---

## 4. Exact Destination Binding Verification

All quote parameters strictly enforce the recipient's authentic, permanent Base Mainnet custodial address:

- **Recipient Custodial Address**: `0x436BdB38888998e269E94301C2362C2f46bCF614` (Verified in `flow.wallet_addresses` for `chain_id = '8453'`).
- **Destination Network**: `base-mainnet` (Chain ID `8453`).
- **Destination Asset Identifier**:
  - `ONECLICK_BASE_USDC_DEFUSE_ASSET_ID`: `nep141:base-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.omft.near`
  - Underlying ERC-20 contract: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Canonical Native Base USDC)
  - Decimals: `6`
- **recipientType**: `DESTINATION_CHAIN`
- **Separation of Addresses**:
  - Recipient settlement destination: `0x436BdB38888998e269E94301C2362C2f46bCF614` (Permanent FLOW wallet).
  - Payer deposit destination: Solver-generated one-time Solana deposit address (never mixed with FLOW's addresses).

---

## 5. Live Pricing & Minimum Supported Payment Amount Discovery

Live querying of the production 1Click routing engine revealed the exact lower bound and fee structure:

1. **Sub-Threshold Probe (10,000 atomic units = 0.01 USDC)**:
   - Provider returned `HTTP 400 Bad Request`
   - Explicit Provider Error: `"Amount is too low for bridge, try at least 83676"`
2. **Absolute Bridge Minimum**:
   - `83,676` atomic units (~**0.083676 USDC**)
3. **Tested Test Amount (1.00 USDC = 1,000,000 atomic units)**:
   - Provider returned `HTTP 201 Created`
   - Quoted Source: `0.012268315 SOL` (`12,268,315` lamports ≈ \$1.018 USD)
   - App Fee: 20 bps (0.2%)
   - Base Withdrawal Fee: `2,400` atomic units (~0.0024 USDC)
   - Solana Refund Fee: `120,541` lamports (~0.00012 SOL ≈ \$0.01 USD)
   - Time Estimate: `24 seconds`

---

## 6. Live RPC & Multi-Chain On-Chain Verification

Direct live JSON-RPC queries confirmed connectivity, block synchronization, and contract validity:

1. **Base Mainnet (`https://mainnet.base.org`)**:
   - Chain ID: `8453` (Confirmed genuine Base Mainnet)
   - Contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (`eth_call balanceOf`):
     - Recipient address `0x436BdB38888998e269E94301C2362C2f46bCF614` balance: `0` atomic units (0.000000 USDC)
2. **Solana Mainnet (`https://api.mainnet-beta.solana.com`)**:
   - Live Slot: `468,058,240` (Synchronized)
3. **NEAR Mainnet (`https://rpc.mainnet.near.org`)**:
   - Chain ID: `mainnet`
   - Height: `224,041,211` (Synchronized)

### Two-Sided Settlement Invariant:
`PaymentMonitoringWorker` (`payment-monitoring-worker.ts`) and the database stored procedure `flow.worker_settle_payment_attempt`:
- Require a verified `SOURCE_DEPOSIT` verification record with `finality = 'FINALIZED'`.
- Require a verified `DESTINATION_SETTLEMENT` verification record with `finality = 'FINALIZED'`.
- Require `OnChainVerifier.verifyEvmTransfer` to confirm:
  - EVM receipt status `0x1` (successful execution).
  - ERC-20 `Transfer` event topic matches `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
  - Recipient topic matches `0x436BdB38888998e269E94301C2362C2f46bCF614`.
  - Amount transferred is $\ge$ invoice atomic amount (`1,000,000`).
  - Block confirmations and reorganization detection verified.
- **No invoice can transition to `PAID` or ledger balance credited without meeting every one of these criteria.**

---

## 7. Failure & Recovery Case Matrix

| Scenario | Tested Behavior | Protection Mechanism |
| :--- | :--- | :--- |
| **Expired Quote** | Payer attempts commit after `quoteExpiresAt` | Rejected with `400 QUOTE_EXPIRED` without grace extension |
| **Underpaid Deposit** | Payer sends fewer tokens than `amountIn` | Solver does not route; attempt remains in monitoring; expires to `EXPIRED` |
| **Refund Routing** | Swap fails or liquidity drops post-deposit | Solver sends refund to `payerRefundAddress` on Solana; worker transitions to `REFUNDED` |
| **Duplicate Deposit** | Payer deposits twice for the same quote | Stored procedure `worker_settle_payment_attempt` is idempotent; locks row `FOR UPDATE` |
| **Provider Timeout** | 1Click API is unreachable or slow | `fetchOneClickCommittedQuote` aborts after 8s; database rolls back transaction |
| **Destination Mismatch** | Delivery made to wrong address | `OnChainVerifier` checks recipient topic; fails verification with `RECIPIENT_ADDRESS_MISMATCH` |

---

## 8. Prerequisites & Maximum Payer Cost for Live Test

To execute exactly one live $1.00 USDC payment test in the next step, the following exact prerequisites must be provided:

1. **Payer Solana Wallet**: A funded Solana wallet with at least **`0.015 SOL`** (~$1.25 USD) to cover the deposit and network gas.
2. **Payer Solana Refund Address**: The payer's exact public key (e.g. `GvTihjQRfzPtuk4iptiDnsWLojCFX1QBSDgzgi8JAgAS` or dedicated payer address).
3. **Single-Use Rehearsal Authorization**: An authorization row created via `flow.create_payment_rehearsal_authorization` binding:
   - Maximum amount: `1,100,000` atomic units ($1.10 USDC ceiling)
   - Expiration: 1 hour
   - Allowed recipient: `0x436BdB38888998e269E94301C2362C2f46bCF614`
4. **Maximum Financial Risk**:
   - Maximum loss if completely unrefunded: **\$1.05 USD** (the deposited SOL).
   - Recipient incoming yield: **1.000000 USDC** directly to Base Mainnet custody address.
   - FLOW outgoing cost: **\$0.00** (Zero gas spent).
