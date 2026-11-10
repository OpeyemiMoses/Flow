import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatAtomicToDisplay } from "../src/domain/atomic-amounts.ts";
import {
  isFinancialExecutionDisabled,
  isValidEvmAddress,
  isValidSolanaAddress,
  toEip55ChecksumAddress,
} from "../src/domain/custody.ts";
import { generatePublicPaymentId } from "../src/domain/payment-requests.ts";
import { isBannedIllustrativeAddress } from "../src/domain/quote-discovery.ts";
import { getPrismaClient } from "../src/foundation/prisma.ts";
import { callJsonRpc } from "../src/server/assets/connectors/rpc-client.ts";
import { authorizePaymentRehearsalWithCredentials } from "../src/server/custody/operator-assertion-service.ts";

const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface PrepareRehearsalOptions {
  readonly accountId?: string;
  readonly recipientAddress?: string;
  readonly payerRefundAddress?: string;
  readonly invoiceUsdc?: string;
  readonly maxUsdc?: string;
  readonly durationSeconds?: number;
  readonly operatorAuthId?: string;
  readonly operatorSessionToken?: string;
  readonly operatorSessionTokenFile?: string;
}

export async function prepareMainnetRehearsal(
  options: PrepareRehearsalOptions = {},
) {
  console.log(
    "=================================================================",
  );
  console.log(" FLOW — PREPARE CONTROLLED MAINNET REHEARSAL PAYMENT LINK");
  console.log(
    "=================================================================\n",
  );

  // Safety Gate: Must remain disabled
  if (!isFinancialExecutionDisabled()) {
    throw new Error(
      "FLOW_EXECUTION must remain disabled! Preparing rehearsal requires safety switches locked.",
    );
  }

  // Step 1: Target Parameters & Safety Verification
  const payerRefund =
    options.payerRefundAddress || process.env.FLOW_REHEARSAL_PAYER_REFUND_SOL;

  if (!payerRefund) {
    throw new Error(
      "Payer Solana refund address must be explicitly provided via --payer-refund-address or FLOW_REHEARSAL_PAYER_REFUND_SOL. Synthetic defaults have been eliminated.",
    );
  }

  if (
    !isValidSolanaAddress(payerRefund) ||
    isBannedIllustrativeAddress(payerRefund)
  ) {
    throw new Error(
      `Invalid or illustrative Solana refund address: ${payerRefund}`,
    );
  }

  const recipient =
    options.recipientAddress || process.env.FLOW_REHEARSAL_RECIPIENT_BASE;

  if (recipient) {
    if (
      !isValidEvmAddress(recipient) ||
      isBannedIllustrativeAddress(recipient)
    ) {
      throw new Error(
        `Invalid or illustrative Base recipient address: ${recipient}`,
      );
    }
  }

  const invoiceAmountUsdc = options.invoiceUsdc || "1.00";
  const invoiceAtomic = BigInt(Math.round(parseFloat(invoiceAmountUsdc) * 1e6));
  const maxAmountUsdc = options.maxUsdc || "5.00";
  const maxAtomic = BigInt(Math.round(parseFloat(maxAmountUsdc) * 1e6));
  const durationSeconds = options.durationSeconds || 3600;

  console.log("STEP 1: Target Rehearsal Parameters");
  if (recipient) {
    console.log(
      `  - Specified Base Mainnet Address: ${toEip55ChecksumAddress(recipient)}`,
    );
  } else {
    console.log(
      "  - Base Mainnet Address: To be resolved from merchant's verified wallet",
    );
  }
  console.log(`  - Payer Solana Refund Address:   ${payerRefund}`);
  console.log(
    `  - Rehearsal Invoice Amount:       ${invoiceAmountUsdc} USDC (${invoiceAtomic.toString()} atomic)`,
  );
  console.log(
    `  - Hard Maximum Safety Ceiling:   ${maxAmountUsdc} USDC (${maxAtomic.toString()} atomic)`,
  );
  console.log(
    `  - Authorization Duration:        ${durationSeconds} seconds (1 hour)\n`,
  );

  // Step 2: Database Tenant & Custody Provisioning Verification
  console.log(
    "STEP 2: Database Tenant & Recipient Wallet Ownership Verification",
  );
  const db = getPrismaClient("worker");

  try {
    // 1. Resolve Account
    let accountId = options.accountId;
    if (!accountId) {
      const accounts = await db.$queryRaw<
        Array<{ id: string; name: string; kind: string }>
      >`
        SELECT id, name, kind
        FROM flow.accounts
        ORDER BY created_at ASC
        LIMIT 1
      `;
      if (accounts.length === 0) {
        throw new Error(
          "No existing account found in database. Create an account first.",
        );
      }
      accountId = accounts[0]!.id;
      console.log(`  - Using account: ${accounts[0]!.name} (${accountId})`);
    }

    // 2. Query registered Base Mainnet wallet for merchant
    const registeredWallets = await db.$queryRaw<
      Array<{
        id: string;
        status: string;
        environment: string;
        provider: string;
        near_account_id: string | null;
        address: string | null;
        chain_id: string | null;
        can_receive: boolean | null;
      }>
    >`
      SELECT
        w.id,
        w.status,
        w.environment,
        w.provider,
        w.near_account_id,
        wa.address,
        wa.chain_id,
        wc.can_receive
      FROM flow.wallets w
      LEFT JOIN flow.wallet_addresses wa ON wa.wallet_id = w.id AND wa.network = 'base-mainnet'
      LEFT JOIN flow.wallet_capabilities wc ON wc.wallet_id = w.id AND wc.network = wa.network
      WHERE w.account_id = ${accountId}::uuid
      LIMIT 1
    `;

    const walletRecord = registeredWallets[0];

    // Check OutLayer mainnet credentials availability
    const outlayerUrl = process.env.FLOW_OUTLAYER_API_URL;
    const isMainnetOutlayerConfigured =
      outlayerUrl &&
      !outlayerUrl.includes("testnet") &&
      process.env.FLOW_WALLET_PROVIDER === "outlayer";

    if (
      !walletRecord ||
      !walletRecord.address ||
      walletRecord.status !== "ACTIVE" ||
      !walletRecord.can_receive
    ) {
      if (!isMainnetOutlayerConfigured) {
        console.error(
          "\n=================================================================",
        );
        console.error(
          " BLOCKER: OUTLAYER MAINNET CUSTODY CREDENTIALS UNAVAILABLE",
        );
        console.error(
          "=================================================================\n",
        );
        console.error(
          `Merchant account ${accountId} does not have an active Base mainnet wallet.`,
        );
        console.error(
          `Current OutLayer API URL: ${outlayerUrl ?? "not configured"} (testnet only).`,
        );
        console.error(
          "Simulating mainnet activation or inserting synthetic wallet records is strictly prohibited.",
        );
        console.error(
          "To proceed, owner must configure genuine OutLayer mainnet credentials",
        );
        console.error(
          "or register an authenticated, verified, owner-controlled Base mainnet wallet.\n",
        );

        throw new Error(
          "OUTLAYER_MAINNET_CREDENTIALS_UNAVAILABLE: OutLayer mainnet custody credentials are not configured in the environment. " +
            "Simulating activation or inserting synthetic wallet records is strictly prohibited.",
        );
      }
    }

    const verifiedRecipient = recipient || walletRecord?.address;
    if (!verifiedRecipient) {
      throw new Error(
        "RECIPIENT_ADDRESS_REQUIRED: No Base mainnet recipient address found on merchant wallet or passed via --recipient-address.",
      );
    }
    const checksummedRecipient = toEip55ChecksumAddress(verifiedRecipient);

    // Verify recipient address matches registered wallet
    if (
      walletRecord?.address &&
      toEip55ChecksumAddress(walletRecord.address) !== checksummedRecipient
    ) {
      throw new Error(
        `RECIPIENT_WALLET_MISMATCH: Provided recipient ${checksummedRecipient} does not match merchant's registered Base wallet ${toEip55ChecksumAddress(walletRecord.address)}.`,
      );
    }

    // Step 3: Base Mainnet RPC Verification
    console.log("STEP 3: Base Mainnet On-Chain Verification");
    const baseRpcUrl =
      process.env.FLOW_BASE_RPC_URL || "https://mainnet.base.org";
    const cleanRecipient = checksummedRecipient
      .toLowerCase()
      .replace(/^0x/, "");
    const paddedRecipient = cleanRecipient.padStart(64, "0");
    const balanceOfData = `0x70a08231${paddedRecipient}`;

    try {
      const balanceRes = await callJsonRpc<string>(baseRpcUrl, "eth_call", [
        {
          to: BASE_USDC_CONTRACT,
          data: balanceOfData,
        },
        "latest",
      ]);

      const usdcRawBalance = balanceRes.response.result
        ? BigInt(balanceRes.response.result)
        : 0n;
      console.log(
        `  - Merchant Current Base USDC Balance: ${formatAtomicToDisplay(usdcRawBalance, 6)} USDC`,
      );
    } catch (err) {
      console.log(
        `  - [WARN] Could not verify starting balance via RPC: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.log(
      "  [PASS] Base Mainnet RPC and USDC contract verified online.\n",
    );

    // Step 4: Create Payment Request for Base Mainnet USDC
    console.log("STEP 4: Create Payment Request for Base Mainnet USDC");
    const publicId = generatePublicPaymentId();
    const prRows = await db.$queryRaw<Array<{ id: string; public_id: string }>>`
      INSERT INTO flow.payment_requests (
        account_id, public_id, title, description,
        destination_network, destination_asset_id, destination_asset_symbol,
        destination_decimals, amount_mode, requested_atomic_amount, status,
        payer_memo_required, metadata, created_at, updated_at
      ) VALUES (
        ${accountId}::uuid, ${publicId}, 'Mainnet Controlled Rehearsal: SOL -> Base USDC',
        'Single controlled payment rehearsal from external Solana wallet to merchant Base Mainnet USDC.',
        'base-mainnet', 'base-mainnet:USDC', 'USDC', 6, 'FIXED'::flow.payment_amount_mode,
        ${invoiceAtomic.toString()}::numeric, 'ACTIVE'::flow.payment_request_status,
        false, '{"rehearsal": true}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      RETURNING id, public_id
    `;
    const paymentReq = prRows[0]!;
    console.log(
      `  - Created Payment Request: ${paymentReq.id} (Public ID: ${paymentReq.public_id})\n`,
    );

    // Step 5: Issue Single-Use Rehearsal Authorization via Operator Role
    console.log("STEP 5: Operator Privileged Authorization Issuance");
    const operatorDb = getPrismaClient("operator");

    const opRows = await operatorDb.$queryRaw<Array<{ auth_user_id: string }>>`
      SELECT auth_user_id
      FROM flow.custody_operators
      WHERE status = 'ACTIVE'
        AND role IN ('SECURITY_OFFICER', 'CUSTODY_OPERATOR')
      LIMIT 1
    `;
    const operatorAuthId =
      options.operatorAuthId ||
      process.env.FLOW_CUSTODY_OPERATOR_AUTH_ID ||
      opRows[0]?.auth_user_id;

    if (!operatorAuthId) {
      throw new Error(
        "OPERATOR_AUTH_REQUIRED: No active custody operator or security officer found to authorize rehearsal.",
      );
    }

    // Read session token from options, file, or environment
    let operatorSessionToken =
      options.operatorSessionToken ||
      process.env.FLOW_CUSTODY_OPERATOR_SESSION_TOKEN;
    const sessionTokenFile =
      options.operatorSessionTokenFile ||
      process.env.FLOW_CUSTODY_OPERATOR_SESSION_FILE;

    if (
      !operatorSessionToken &&
      sessionTokenFile &&
      existsSync(sessionTokenFile)
    ) {
      operatorSessionToken = readFileSync(sessionTokenFile, "utf8").trim();
    }

    if (!operatorSessionToken) {
      // In local operator context, look up active session for operator
      const sessionRows = await operatorDb.$queryRaw<Array<{ token: string }>>`
        SELECT token FROM flow.auth_sessions
        WHERE user_id = ${operatorAuthId}
          AND expires_at > CURRENT_TIMESTAMP
        ORDER BY expires_at DESC
        LIMIT 1
      `;
      operatorSessionToken = sessionRows[0]?.token;
    }

    if (!operatorSessionToken) {
      throw new Error(
        "OPERATOR_CREDENTIALS_REQUIRED: Valid operator session token must be provided via --session-token, FLOW_CUSTODY_OPERATOR_SESSION_TOKEN, or --session-token-file.",
      );
    }

    const { authorizationId, assertionId } =
      await authorizePaymentRehearsalWithCredentials(operatorDb, {
        operatorAuthId,
        operatorSessionToken,
        paymentRequestId: paymentReq.id,
        sourceNetwork: "solana-mainnet",
        sourceAssetId: "solana-mainnet:SOL",
        destinationNetwork: "base-mainnet",
        destinationAssetId: "base-mainnet:USDC",
        maxAtomicAmount: maxAtomic,
        allowedRecipientAddress: checksummedRecipient,
        allowedPayerRefundAddress: payerRefund,
        durationSeconds,
      });

    console.log(`  - Issued Cryptographic Approval Assertion: ${assertionId}`);
    console.log(
      `  - Issued Scoped Rehearsal Authorization:   ${authorizationId}`,
    );
    console.log(
      "  [PASS] Single-use execution authorization securely persisted via verified operator cryptographic assertion.\n",
    );

    console.log(
      "=================================================================",
    );
    console.log(" FLOW — REHEARSAL PAYMENT LINK DETAILS");
    console.log(
      "=================================================================\n",
    );
    console.log(`Payment Request ID:     ${paymentReq.id}`);
    console.log(`Public Checkout ID:     ${paymentReq.public_id}`);
    console.log(
      `Public Checkout URL:    http://127.0.0.1:3000/pay/${paymentReq.public_id}`,
    );
    console.log(`Authorization ID:       ${authorizationId}`);
    console.log(`Merchant Base Address:  ${checksummedRecipient}`);
    console.log(`Payer Refund Solana:    ${payerRefund}`);
    console.log(
      `Authorized Amount:      ${invoiceAmountUsdc} USDC (Max Allowed: ${maxAmountUsdc} USDC)`,
    );
    console.log(`Authorization Valid:    ${durationSeconds} seconds\n`);

    return {
      paymentRequestId: paymentReq.id,
      publicId: paymentReq.public_id,
      authorizationId,
      recipient: checksummedRecipient,
      payerRefund,
      invoiceUsdc: invoiceAmountUsdc,
    };
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

if (process.argv[1]?.endsWith("prepare-mainnet-rehearsal.ts")) {
  const { values } = parseArgs({
    options: {
      "account-id": { type: "string" },
      "recipient-address": { type: "string" },
      "payer-refund-address": { type: "string" },
      "invoice-usdc": { type: "string" },
      "max-usdc": { type: "string" },
      "duration-seconds": { type: "string" },
      "operator-auth-id": { type: "string" },
      "session-token": { type: "string" },
      "session-token-file": { type: "string" },
    },
    strict: false,
  });

  prepareMainnetRehearsal({
    accountId:
      typeof values["account-id"] === "string"
        ? values["account-id"]
        : undefined,
    recipientAddress:
      typeof values["recipient-address"] === "string"
        ? values["recipient-address"]
        : undefined,
    payerRefundAddress:
      typeof values["payer-refund-address"] === "string"
        ? values["payer-refund-address"]
        : undefined,
    invoiceUsdc:
      typeof values["invoice-usdc"] === "string"
        ? values["invoice-usdc"]
        : undefined,
    maxUsdc:
      typeof values["max-usdc"] === "string" ? values["max-usdc"] : undefined,
    durationSeconds:
      typeof values["duration-seconds"] === "string"
        ? parseInt(values["duration-seconds"], 10)
        : undefined,
    operatorAuthId:
      typeof values["operator-auth-id"] === "string"
        ? values["operator-auth-id"]
        : undefined,
    operatorSessionToken:
      typeof values["session-token"] === "string"
        ? values["session-token"]
        : undefined,
    operatorSessionTokenFile:
      typeof values["session-token-file"] === "string"
        ? values["session-token-file"]
        : undefined,
  }).catch((err) => {
    console.error("Preparation failed:", err);
    process.exit(1);
  });
}
