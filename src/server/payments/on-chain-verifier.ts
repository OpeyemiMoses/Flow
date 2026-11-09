import { FlowError } from "../../foundation/errors.ts";
import type { FlowDb } from "../../foundation/prisma.ts";
import {
  callJsonRpc,
  type JsonRpcOptions,
} from "../assets/connectors/rpc-client.ts";
import {
  ERC20_TRANSFER_EVENT_TOPIC,
  parseTopicToAddress,
} from "../assets/indexers/evm-indexer.ts";

export type VerificationType =
  "SOURCE_DEPOSIT" | "DESTINATION_SETTLEMENT" | "1CLICK_EXECUTION";

export type EvidenceSource =
  "CHAIN_RPC_DIRECT" | "1CLICK_STATUS_API" | "FIXTURE_EVIDENCE";

export type VerificationFinality = "FINALIZED" | "CONFIRMED" | "PENDING";

export interface VerifiedTransferResult {
  readonly network: string;
  readonly txHash: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly assetId: string;
  readonly tokenContract: string | null;
  readonly atomicAmount: bigint;
  readonly blockHeight: bigint;
  readonly blockHash: string;
  readonly finality: VerificationFinality;
  readonly memo: string | null;
  readonly evidenceSource: EvidenceSource;
  readonly rawEvidence: Record<string, unknown>;
  readonly isSuccess: boolean;
}

export interface VerifyEvmTransferParams {
  readonly rpcUrl: string;
  readonly network: string;
  readonly txHash: string;
  readonly expectedRecipient: string;
  readonly expectedAssetId: string;
  readonly expectedTokenContract?: string | null;
  readonly minimumAtomicAmount: bigint;
  readonly requiredConfirmations?: number;
}

/**
 * Genuine read-only EVM transfer verification for Ethereum Mainnet and Base.
 * Validates tx inclusion, successful receipt status (0x1), correct recipient,
 * asset contract/native match, and atomic amount satisfaction.
 */
export async function verifyEvmTransfer(
  params: VerifyEvmTransferParams,
  options?: JsonRpcOptions,
): Promise<VerifiedTransferResult> {
  const normExpectedRecipient = params.expectedRecipient.toLowerCase().trim();
  const normTokenContract =
    params.expectedTokenContract?.toLowerCase().trim() ?? null;

  // 1. Fetch Transaction
  const txRes = await callJsonRpc<{
    hash: string;
    from: string;
    to: string | null;
    value: string;
    input: string;
    blockNumber: string | null;
    blockHash: string | null;
  }>(params.rpcUrl, "eth_getTransactionByHash", [params.txHash], options);

  if (txRes.response.error || !txRes.response.result) {
    throw new FlowError(
      "RPC_NETWORK_ERROR",
      `Failed to fetch EVM transaction ${params.txHash}: ${txRes.response.error?.message ?? "Transaction not found"}`,
    );
  }

  const tx = txRes.response.result;
  if (!tx.blockNumber || !tx.blockHash) {
    return {
      network: params.network,
      txHash: params.txHash,
      fromAddress: tx.from.toLowerCase(),
      toAddress: (tx.to ?? "").toLowerCase(),
      assetId: params.expectedAssetId,
      tokenContract: normTokenContract,
      atomicAmount: 0n,
      blockHeight: 0n,
      blockHash: "",
      finality: "PENDING",
      memo: null,
      evidenceSource: "CHAIN_RPC_DIRECT",
      rawEvidence: { tx },
      isSuccess: false,
    };
  }

  // 2. Fetch Receipt
  const receiptRes = await callJsonRpc<{
    status: string;
    blockNumber: string;
    blockHash: string;
    logs: Array<{
      address: string;
      topics: string[];
      data: string;
      removed?: boolean;
    }>;
  }>(params.rpcUrl, "eth_getTransactionReceipt", [params.txHash], options);

  if (receiptRes.response.error || !receiptRes.response.result) {
    throw new FlowError(
      "RPC_NETWORK_ERROR",
      `Failed to fetch EVM transaction receipt for ${params.txHash}`,
    );
  }

  const receipt = receiptRes.response.result;
  const isSuccess = receipt.status === "0x1";
  if (!isSuccess) {
    throw new FlowError(
      "CUSTODY_PROVIDER_ERROR",
      `EVM transaction reverted on-chain (status 0x0): ${params.txHash}`,
    );
  }

  // 3. Confirmations and Finality
  const blockNumberRes = await callJsonRpc<string>(
    params.rpcUrl,
    "eth_blockNumber",
    [],
    options,
  );
  const latestBlock = blockNumberRes.response.result
    ? BigInt(blockNumberRes.response.result)
    : BigInt(receipt.blockNumber);
  const txBlock = BigInt(receipt.blockNumber);
  const confirmations =
    latestBlock >= txBlock ? latestBlock - txBlock + 1n : 0n;

  const requiredConfs = BigInt(
    params.requiredConfirmations ?? (params.network.includes("base") ? 1 : 6),
  );
  const finality: VerificationFinality =
    confirmations >= requiredConfs ? "FINALIZED" : "CONFIRMED";

  // 4. Asset & Amount Extraction
  let atomicAmount = 0n;
  let fromAddress = tx.from.toLowerCase();
  let toAddress = (tx.to ?? "").toLowerCase();

  if (!normTokenContract) {
    // Native ETH
    atomicAmount = BigInt(tx.value || "0");
    if (toAddress !== normExpectedRecipient) {
      throw new FlowError(
        "RECIPIENT_ADDRESS_MISMATCH",
        `RECIPIENT_ADDRESS_MISMATCH: EVM native transfer recipient mismatch: expected ${normExpectedRecipient}, got ${toAddress}`,
      );
    }
  } else {
    // ERC-20 Token Transfer
    const transferLogs = receipt.logs.filter(
      (log) =>
        !log.removed &&
        log.topics[0]?.toLowerCase() ===
          ERC20_TRANSFER_EVENT_TOPIC.toLowerCase() &&
        log.address.toLowerCase() === normTokenContract,
    );

    const matchingLog = transferLogs.find((log) => {
      const recipientTopic = log.topics[2];
      if (!recipientTopic) return false;
      const parsedRecipient = parseTopicToAddress(recipientTopic);
      return parsedRecipient.toLowerCase() === normExpectedRecipient;
    });

    if (!matchingLog) {
      throw new FlowError(
        "RECIPIENT_ADDRESS_MISMATCH",
        `RECIPIENT_ADDRESS_MISMATCH: No ERC-20 transfer event found matching recipient ${normExpectedRecipient} on contract ${normTokenContract}`,
      );
    }

    if (matchingLog.topics[1]) {
      fromAddress = parseTopicToAddress(matchingLog.topics[1]).toLowerCase();
    }
    toAddress = normExpectedRecipient;
    atomicAmount = BigInt(matchingLog.data || "0");
  }

  if (atomicAmount < params.minimumAtomicAmount) {
    throw new FlowError(
      "UNDERPAID_AMOUNT",
      `UNDERPAID_AMOUNT: Transferred amount (${atomicAmount.toString()}) is less than required minimum (${params.minimumAtomicAmount.toString()})`,
    );
  }

  return {
    network: params.network,
    txHash: params.txHash,
    fromAddress,
    toAddress,
    assetId: params.expectedAssetId,
    tokenContract: normTokenContract,
    atomicAmount,
    blockHeight: txBlock,
    blockHash: receipt.blockHash,
    finality,
    memo: null,
    evidenceSource: "CHAIN_RPC_DIRECT",
    rawEvidence: {
      tx,
      receipt: {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      },
      confirmations: confirmations.toString(),
    },
    isSuccess: true,
  };
}

export interface VerifySolanaTransferParams {
  readonly rpcUrl: string;
  readonly network: string;
  readonly txSignature: string;
  readonly expectedRecipient: string;
  readonly expectedAssetId: string;
  readonly expectedTokenMint?: string | null;
  readonly minimumAtomicAmount: bigint;
  readonly expectedMemo?: string | null;
}

/**
 * Genuine read-only Solana transfer verification.
 * Validates transaction inclusion, execution without errors, correct recipient,
 * mint matching for SPL tokens, and memo/tag match where required.
 */
export async function verifySolanaTransfer(
  params: VerifySolanaTransferParams,
  options?: JsonRpcOptions,
): Promise<VerifiedTransferResult> {
  const normExpectedRecipient = params.expectedRecipient.trim();
  const normTokenMint = params.expectedTokenMint?.trim() ?? null;

  const txRes = await callJsonRpc<{
    slot: number;
    blockTime: number | null;
    transaction: {
      signatures: string[];
      message: {
        accountKeys: Array<{
          pubkey: string;
          signer: boolean;
          writable: boolean;
        }>;
        instructions: Array<{
          programId?: string;
          program?: string;
          parsed?: {
            info?: Record<string, unknown>;
            type?: string;
          };
        }>;
      };
    };
    meta: {
      err: unknown | null;
      preBalances: number[];
      postBalances: number[];
      preTokenBalances?: Array<{
        accountIndex: number;
        mint: string;
        owner?: string;
        uiTokenAmount: {
          amount: string;
          decimals: number;
        };
      }>;
      postTokenBalances?: Array<{
        accountIndex: number;
        mint: string;
        owner?: string;
        uiTokenAmount: {
          amount: string;
          decimals: number;
        };
      }>;
      logMessages?: string[];
    } | null;
  }>(
    params.rpcUrl,
    "getTransaction",
    [
      params.txSignature,
      {
        commitment: "finalized",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      },
    ],
    options,
  );

  if (txRes.response.error || !txRes.response.result) {
    throw new FlowError(
      "RPC_NETWORK_ERROR",
      `Failed to fetch Solana transaction ${params.txSignature}: ${txRes.response.error?.message ?? "Transaction not found"}`,
    );
  }

  const tx = txRes.response.result;
  if (!tx.meta || tx.meta.err !== null) {
    throw new FlowError(
      "CUSTODY_PROVIDER_ERROR",
      `Solana transaction failed or reverted on-chain: ${JSON.stringify(tx.meta?.err)}`,
    );
  }

  let atomicAmount = 0n;
  const fromAddress = tx.transaction.message.accountKeys[0]?.pubkey ?? "";
  const toAddress = normExpectedRecipient;

  if (!normTokenMint) {
    // Native SOL
    const recipientIndex = tx.transaction.message.accountKeys.findIndex(
      (k) => k.pubkey === normExpectedRecipient,
    );
    if (recipientIndex === -1) {
      throw new FlowError(
        "RECIPIENT_ADDRESS_MISMATCH",
        `RECIPIENT_ADDRESS_MISMATCH: Recipient ${normExpectedRecipient} not found in Solana transaction accounts`,
      );
    }
    const preLamports = BigInt(tx.meta.preBalances[recipientIndex] ?? 0);
    const postLamports = BigInt(tx.meta.postBalances[recipientIndex] ?? 0);
    if (postLamports > preLamports) {
      atomicAmount = postLamports - preLamports;
    }
  } else {
    // SPL Token
    const preTokens = (tx.meta.preTokenBalances ?? []).filter(
      (b) => b.mint === normTokenMint && b.owner === normExpectedRecipient,
    );
    const postTokens = (tx.meta.postTokenBalances ?? []).filter(
      (b) => b.mint === normTokenMint && b.owner === normExpectedRecipient,
    );

    const preAmount = preTokens.reduce(
      (acc, t) => acc + BigInt(t.uiTokenAmount.amount || "0"),
      0n,
    );
    const postAmount = postTokens.reduce(
      (acc, t) => acc + BigInt(t.uiTokenAmount.amount || "0"),
      0n,
    );

    if (postAmount > preAmount) {
      atomicAmount = postAmount - preAmount;
    } else {
      // Check parsed transfer instructions
      for (const inst of tx.transaction.message.instructions) {
        if (
          inst.parsed?.type === "transfer" ||
          inst.parsed?.type === "transferChecked"
        ) {
          const info = inst.parsed.info as Record<string, unknown> | undefined;
          if (
            info?.destination === normExpectedRecipient ||
            info?.authority === normExpectedRecipient
          ) {
            atomicAmount = BigInt(String(info.amount || info.lamports || "0"));
            break;
          }
        }
      }
    }
  }

  if (atomicAmount < params.minimumAtomicAmount) {
    throw new FlowError(
      "UNDERPAID_AMOUNT",
      `UNDERPAID_AMOUNT: Solana transferred amount (${atomicAmount.toString()}) is less than required minimum (${params.minimumAtomicAmount.toString()})`,
    );
  }

  // Memo check if expected
  if (params.expectedMemo) {
    const logs = tx.meta.logMessages ?? [];
    const hasMemo = logs.some((l) => l.includes(params.expectedMemo!));
    if (!hasMemo) {
      throw new FlowError(
        "MEMO_MISMATCH",
        `MEMO_MISMATCH: Expected Solana memo '${params.expectedMemo}' not found in transaction logs`,
      );
    }
  }

  return {
    network: params.network,
    txHash: params.txSignature,
    fromAddress,
    toAddress,
    assetId: params.expectedAssetId,
    tokenContract: normTokenMint,
    atomicAmount,
    blockHeight: BigInt(tx.slot),
    blockHash: `slot_${tx.slot}`,
    finality: "FINALIZED",
    memo: params.expectedMemo ?? null,
    evidenceSource: "CHAIN_RPC_DIRECT",
    rawEvidence: {
      slot: tx.slot,
      blockTime: tx.blockTime,
      signatures: tx.transaction.signatures,
    },
    isSuccess: true,
  };
}

export interface VerifyNearTransferParams {
  readonly rpcUrl: string;
  readonly network: string;
  readonly txHash: string;
  readonly senderAccountId: string;
  readonly expectedRecipient: string;
  readonly expectedAssetId: string;
  readonly expectedTokenContract?: string | null;
  readonly minimumAtomicAmount: bigint;
}

/**
 * Genuine read-only NEAR transfer verification.
 * Validates transaction outcome status, receiver identity,
 * native Transfer action or ft_transfer FunctionCall args.
 */
export async function verifyNearTransfer(
  params: VerifyNearTransferParams,
  options?: JsonRpcOptions,
): Promise<VerifiedTransferResult> {
  const normExpectedRecipient = params.expectedRecipient.trim();
  const normTokenContract = params.expectedTokenContract?.trim() ?? null;

  const txRes = await callJsonRpc<{
    status: {
      SuccessValue?: string;
      Failure?: unknown;
    };
    transaction: {
      hash: string;
      signer_id: string;
      receiver_id: string;
      actions: Array<{
        Transfer?: {
          deposit: string;
        };
        FunctionCall?: {
          method_name: string;
          args: string;
          deposit: string;
          gas: number;
        };
      }>;
    };
    transaction_outcome: {
      block_hash: string;
      outcome: {
        status: {
          SuccessReceiptId?: string;
          Failure?: unknown;
        };
      };
    };
  }>(params.rpcUrl, "tx", [params.txHash, params.senderAccountId], options);

  if (txRes.response.error || !txRes.response.result) {
    throw new FlowError(
      "RPC_NETWORK_ERROR",
      `Failed to fetch NEAR transaction ${params.txHash}: ${txRes.response.error?.message ?? "Transaction not found"}`,
    );
  }

  const tx = txRes.response.result;
  const isFailed =
    Boolean(tx.status.Failure) ||
    Boolean(tx.transaction_outcome.outcome.status.Failure);
  if (isFailed) {
    throw new FlowError(
      "CUSTODY_PROVIDER_ERROR",
      `NEAR transaction failed on-chain: ${JSON.stringify(tx.status.Failure ?? tx.transaction_outcome.outcome.status.Failure)}`,
    );
  }

  let atomicAmount = 0n;
  const fromAddress = tx.transaction.signer_id;
  let toAddress = tx.transaction.receiver_id;

  if (!normTokenContract) {
    // Native NEAR Transfer
    const transferAction = tx.transaction.actions.find((a) => a.Transfer);
    if (!transferAction || !transferAction.Transfer) {
      throw new FlowError(
        "RECIPIENT_ADDRESS_MISMATCH",
        "NEAR transaction has no native Transfer action",
      );
    }
    if (toAddress !== normExpectedRecipient) {
      throw new FlowError(
        "RECIPIENT_ADDRESS_MISMATCH",
        `RECIPIENT_ADDRESS_MISMATCH: NEAR native transfer receiver mismatch: expected ${normExpectedRecipient}, got ${toAddress}`,
      );
    }
    atomicAmount = BigInt(transferAction.Transfer.deposit);
  } else {
    // NEP-141 Token Transfer
    const ftAction = tx.transaction.actions.find(
      (a) =>
        a.FunctionCall &&
        (a.FunctionCall.method_name === "ft_transfer" ||
          a.FunctionCall.method_name === "ft_transfer_call"),
    );
    if (!ftAction || !ftAction.FunctionCall) {
      throw new FlowError(
        "RECIPIENT_ADDRESS_MISMATCH",
        "RECIPIENT_ADDRESS_MISMATCH: NEAR transaction has no ft_transfer FunctionCall action",
      );
    }
    if (toAddress !== normTokenContract) {
      throw new FlowError(
        "ASSET_MISMATCH",
        `ASSET_MISMATCH: NEAR token contract mismatch: expected ${normTokenContract}, got ${toAddress}`,
      );
    }

    try {
      const decodedArgs = JSON.parse(
        Buffer.from(ftAction.FunctionCall.args, "base64").toString("utf8"),
      ) as { receiver_id?: string; amount?: string };
      toAddress = decodedArgs.receiver_id ?? "";
      if (toAddress !== normExpectedRecipient) {
        throw new FlowError(
          "RECIPIENT_ADDRESS_MISMATCH",
          `RECIPIENT_ADDRESS_MISMATCH: NEAR ft_transfer receiver mismatch: expected ${normExpectedRecipient}, got ${toAddress}`,
        );
      }
      atomicAmount = BigInt(decodedArgs.amount || "0");
    } catch (err) {
      throw new FlowError(
        "CUSTODY_PROVIDER_ERROR",
        `Failed to decode NEAR ft_transfer args: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (atomicAmount < params.minimumAtomicAmount) {
    throw new FlowError(
      "UNDERPAID_AMOUNT",
      `UNDERPAID_AMOUNT: NEAR transferred amount (${atomicAmount.toString()}) is less than required minimum (${params.minimumAtomicAmount.toString()})`,
    );
  }

  return {
    network: params.network,
    txHash: params.txHash,
    fromAddress,
    toAddress,
    assetId: params.expectedAssetId,
    tokenContract: normTokenContract,
    atomicAmount,
    blockHeight: 0n,
    blockHash: tx.transaction_outcome.block_hash,
    finality: "FINALIZED",
    memo: null,
    evidenceSource: "CHAIN_RPC_DIRECT",
    rawEvidence: {
      signer_id: tx.transaction.signer_id,
      receiver_id: tx.transaction.receiver_id,
      block_hash: tx.transaction_outcome.block_hash,
    },
    isSuccess: true,
  };
}

/**
 * Universal verification recorder:
 * Validates on-chain and provider evidence and persists a durable record
 * in flow.payment_verifications using the privileged worker connection.
 */
export async function recordVerificationInDatabase(
  workerDb: FlowDb,
  attemptPublicId: string,
  verification: VerifiedTransferResult,
  verificationType: VerificationType,
): Promise<{
  readonly verificationId: string;
  readonly status: string;
  readonly isLateDeposit: boolean;
}> {
  const result = await workerDb.$queryRaw<
    Array<{
      verification_id: string;
      payment_attempt_id: string;
      verification_type: string;
      status: string;
      is_late_deposit: boolean;
    }>
  >`
    SELECT * FROM flow.record_payment_verification(
      ${attemptPublicId},
      ${verificationType},
      ${verification.network},
      ${verification.txHash},
      ${verification.fromAddress},
      ${verification.toAddress},
      ${verification.assetId},
      ${verification.tokenContract},
      ${verification.atomicAmount.toString()}::numeric,
      ${verification.blockHeight ? Number(verification.blockHeight) : null},
      ${verification.blockHash},
      ${verification.finality},
      ${verification.memo},
      ${verification.evidenceSource},
      ${JSON.stringify(verification.rawEvidence)}::jsonb
    )
  `;

  if (result.length === 0) {
    throw new FlowError(
      "DATABASE_UNAVAILABLE",
      "Failed to record payment verification in database.",
    );
  }

  return {
    verificationId: result[0]!.verification_id,
    status: result[0]!.status,
    isLateDeposit: result[0]!.is_late_deposit,
  };
}
