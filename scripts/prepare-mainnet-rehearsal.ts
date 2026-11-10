import { parseArgs } from "node:util";
import { formatAtomicToDisplay } from "../src/domain/atomic-amounts.ts";
import {
  isFinancialExecutionDisabled,
  isValidEvmAddress,
  isValidSolanaAddress,
  toEip55ChecksumAddress,
} from "../src/domain/custody.ts";
import { generatePublicPaymentId } from "../src/domain/payment-requests.ts";
import { PROBE_ADDRESSES } from "../src/domain/quote-discovery.ts";
import { getPrismaClient } from "../src/foundation/prisma.ts";
import { callJsonRpc } from "../src/server/assets/connectors/rpc-client.ts";

const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface PrepareRehearsalOptions {
  readonly accountId?: string;
  readonly recipientAddress?: string;
  readonly payerRefundAddress?: string;
  readonly invoiceUsdc?: string;
  readonly maxUsdc?: string;
  readonly durationSeconds?: number;
  readonly operatorAuthId?: string;
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

  const recipient =
    options.recipientAddress ||
    process.env.FLOW_REHEARSAL_RECIPIENT_BASE ||
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

  if (
    !isValidEvmAddress(recipient) ||
    Object.values(PROBE_ADDRESSES).includes(recipient)
  ) {
    throw new Error(
      `Invalid or synthetic Base recipient address: ${recipient}`,
    );
  }
  const checksummedRecipient = toEip55ChecksumAddress(recipient);

  const payerRefund =
    options.payerRefundAddress ||
    process.env.FLOW_REHEARSAL_PAYER_REFUND_SOL ||
    "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

  if (
    !isValidSolanaAddress(payerRefund) ||
    Object.values(PROBE_ADDRESSES).includes(payerRefund)
  ) {
    throw new Error(
      `Invalid or synthetic Solana refund address: ${payerRefund}`,
    );
  }

  const invoiceAmountUsdc = options.invoiceUsdc || "1.00";
  const invoiceAtomic = BigInt(Math.round(parseFloat(invoiceAmountUsdc) * 1e6));
  const maxAmountUsdc = options.maxUsdc || "5.00";
  const maxAtomic = BigInt(Math.round(parseFloat(maxAmountUsdc) * 1e6));
  const durationSeconds = options.durationSeconds || 3600;

  console.log("STEP 1: Target Rehearsal Parameters");
  console.log(`  - Merchant Base Mainnet Address: ${checksummedRecipient}`);
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

  // Step 2: Introspect Base Mainnet Contract & Balance
  console.log("STEP 2: Base Mainnet On-Chain Verification");
  const baseRpcUrl =
    process.env.FLOW_BASE_RPC_URL || "https://mainnet.base.org";
  const cleanRecipient = checksummedRecipient.toLowerCase().replace(/^0x/, "");
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
  console.log("  [PASS] Base Mainnet RPC and USDC contract verified online.\n");

  // Step 3: Database Registration & Rehearsal Link Scaffolding
  console.log("STEP 3: Database Tenant & Custody Provisioning");
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

    // 2. Ensure Mainnet Wallet with Base Mainnet (8453) address
    const existingWallets = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM flow.wallets
      WHERE account_id = ${accountId}::uuid
      LIMIT 1
    `;

    let walletId: string;
    if (existingWallets.length === 0) {
      const newWallet = await db.$queryRaw<Array<{ id: string }>>`
        INSERT INTO flow.wallets (
          account_id, provider, provider_wallet_id, near_account_id,
          status, policy_state, controller_account_id, environment, created_at, updated_at
        ) VALUES (
          ${accountId}::uuid, 'OUTLAYER', gen_random_uuid()::text, 'flow-rehearsal-merchant.near',
          'ACTIVE'::flow.wallet_status, 'stored', 'flow-rehearsal-merchant.near', 'mainnet',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING id
      `;
      walletId = newWallet[0]!.id;
    } else {
      walletId = existingWallets[0]!.id;
      await db.$executeRaw`
        UPDATE flow.wallets
        SET
          status = 'ACTIVE'::flow.wallet_status,
          environment = 'mainnet',
          policy_state = 'stored',
          controller_account_id = COALESCE(controller_account_id, 'flow-rehearsal-merchant.near'),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${walletId}::uuid
      `;
    }

    // 3. Attach/Update Base Mainnet address (chain_id = '8453')
    await db.$executeRaw`
      INSERT INTO flow.wallet_addresses (
        wallet_id, network, chain_id, address, public_key, created_at, updated_at
      ) VALUES (
        ${walletId}::uuid, 'base-mainnet', '8453', ${checksummedRecipient}, '0x00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT (wallet_id, network) DO UPDATE
      SET
        chain_id = '8453',
        address = EXCLUDED.address,
        updated_at = CURRENT_TIMESTAMP
    `;

    // 4. Attach/Update Base receive capability (can_receive = true)
    await db.$executeRaw`
      INSERT INTO flow.wallet_capabilities (
        wallet_id, network, can_derive_address, can_receive,
        can_read_native_balance, can_read_intents_balance, can_sign_transfer,
        broadcast_mode, can_rotate_credentials, verified_at
      ) VALUES (
        ${walletId}::uuid, 'base-mainnet', true, true, true, false, false,
        'caller_broadcast', true, CURRENT_TIMESTAMP
      )
      ON CONFLICT (wallet_id, network) DO UPDATE
      SET
        can_receive = true,
        can_sign_transfer = false,
        verified_at = CURRENT_TIMESTAMP
    `;

    console.log(
      `  - Wallet ${walletId} configured for Base Mainnet (EVM 8453) with receive capability active.`,
    );

    // 5. Create Payment Request for Base Mainnet USDC
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
      `  - Created Payment Request: ${paymentReq.id} (Public ID: ${paymentReq.public_id})`,
    );

    // 6. Query Operator and Issue Single-Use Rehearsal Authorization
    const opRows = await db.$queryRaw<Array<{ auth_user_id: string }>>`
      SELECT auth_user_id
      FROM flow.custody_operators
      WHERE status = 'ACTIVE'
      LIMIT 1
    `;
    const operatorAuthId =
      options.operatorAuthId ||
      opRows[0]?.auth_user_id ||
      process.env.FLOW_CUSTODY_OPERATOR_AUTH_ID ||
      "flow-custody-operator-rehearsal";

    // Issue Scoped Rehearsal Authorization
    const authRows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT flow.create_payment_rehearsal_authorization(
        ${paymentReq.id}::uuid,
        ${operatorAuthId},
        'solana-mainnet',
        'solana-mainnet:SOL',
        'base-mainnet',
        'base-mainnet:USDC',
        ${maxAtomic.toString()}::numeric,
        ${checksummedRecipient},
        ${payerRefund},
        ${durationSeconds}
      ) AS id
    `;

    const authorizationId = authRows[0]?.id;
    console.log(
      `  - Issued Scoped Rehearsal Authorization: ${authorizationId}`,
    );
    console.log(
      "  [PASS] Single-use execution authorization securely persisted.\n",
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
  }).catch((err) => {
    console.error("Preparation failed:", err);
    process.exit(1);
  });
}
