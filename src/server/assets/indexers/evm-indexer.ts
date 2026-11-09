import { FlowError } from "../../../foundation/errors.ts";
import { callJsonRpc, type JsonRpcOptions } from "../connectors/rpc-client.ts";
import type {
  ActivityDirection,
  ActivityFinality,
} from "../../../domain/activities.ts";

export interface EvmIndexerOptions extends JsonRpcOptions {
  readonly chainId: string;
  readonly network: string;
}

export interface EvmLogEntry {
  readonly address: string;
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly data: string;
  readonly logIndex: string;
  readonly topics: string[];
  readonly transactionHash: string;
  readonly transactionIndex: string;
  readonly removed?: boolean;
}

export interface RawEvmActivityItem {
  readonly txHash: string;
  readonly eventIndex: number;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly contractAddress: string | null;
  readonly atomicAmount: bigint;
  readonly blockHeight: bigint;
  readonly blockHash: string;
  readonly blockTimestamp: Date | null;
  readonly finality: ActivityFinality;
  readonly direction: ActivityDirection;
  readonly activityType: "ON_CHAIN_TRANSFER" | "ON_CHAIN_INTERACTION";
  readonly network: string;
  readonly chainId: string;
  readonly ecosystem: "evm";
  readonly feeAtomicAmount: bigint | null;
  readonly metadata: Record<string, unknown>;
}

// ERC-20 Transfer(address,address,uint256) topic
export const ERC20_TRANSFER_EVENT_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function padAddressToTopic(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return "0x" + clean.padStart(64, "0");
}

export function parseTopicToAddress(topic: string): string {
  const clean = topic.toLowerCase().replace(/^0x/, "");
  const addr = clean.slice(-40);
  return "0x" + addr;
}

/**
 * Indexes verified on-chain transfers and logs for an EVM address
 * across Base (8453, 84532) and Ethereum Mainnet (1).
 */
export async function indexEvmAddressActivities(
  rpcUrl: string,
  walletAddress: string,
  options: EvmIndexerOptions & {
    readonly fromBlock?: bigint;
    readonly toBlock?: bigint;
    readonly maxBlockRange?: number;
  },
): Promise<RawEvmActivityItem[]> {
  const normalizedWallet = walletAddress.toLowerCase();

  // 1. Verify chain ID
  const chainIdRes = await callJsonRpc<string>(
    rpcUrl,
    "eth_chainId",
    [],
    options,
  );
  if (chainIdRes.response.error || !chainIdRes.response.result) {
    throw new FlowError(
      "RPC_NETWORK_ERROR",
      `Failed to verify EVM chain ID on ${rpcUrl}: ${chainIdRes.response.error?.message ?? "Empty result"}`,
    );
  }
  const actualChainId = BigInt(chainIdRes.response.result).toString();
  if (actualChainId !== options.chainId) {
    throw new FlowError(
      "CHAIN_ID_MISMATCH",
      `EVM chain ID mismatch on ${rpcUrl}: expected ${options.chainId}, got ${actualChainId}`,
    );
  }

  // 2. Fetch latest block number
  const blockRes = await callJsonRpc<string>(
    rpcUrl,
    "eth_blockNumber",
    [],
    options,
  );
  if (blockRes.response.error || !blockRes.response.result) {
    throw new FlowError(
      "RPC_NETWORK_ERROR",
      `Failed to get block number from ${rpcUrl}: ${blockRes.response.error?.message ?? "Empty result"}`,
    );
  }
  const latestBlock = BigInt(blockRes.response.result);

  const maxRange = BigInt(options.maxBlockRange ?? 100);
  const targetToBlock = options.toBlock ?? latestBlock;
  const targetFromBlock =
    options.fromBlock ??
    (targetToBlock > maxRange ? targetToBlock - maxRange : 0n);

  const fromBlockHex = "0x" + targetFromBlock.toString(16);
  const toBlockHex = "0x" + targetToBlock.toString(16);

  const paddedTarget = padAddressToTopic(normalizedWallet);

  // 3. Query Transfer logs where address is recipient (incoming) and sender (outgoing)
  const [incomingLogsRes, outgoingLogsRes] = await Promise.all([
    callJsonRpc<EvmLogEntry[]>(
      rpcUrl,
      "eth_getLogs",
      [
        {
          fromBlock: fromBlockHex,
          toBlock: toBlockHex,
          topics: [ERC20_TRANSFER_EVENT_TOPIC, null, paddedTarget],
        },
      ],
      options,
    ),
    callJsonRpc<EvmLogEntry[]>(
      rpcUrl,
      "eth_getLogs",
      [
        {
          fromBlock: fromBlockHex,
          toBlock: toBlockHex,
          topics: [ERC20_TRANSFER_EVENT_TOPIC, paddedTarget, null],
        },
      ],
      options,
    ),
  ]);

  const allLogs: EvmLogEntry[] = [];
  if (incomingLogsRes.response.result) {
    allLogs.push(...incomingLogsRes.response.result);
  }
  if (outgoingLogsRes.response.result) {
    allLogs.push(...outgoingLogsRes.response.result);
  }

  // Deduplicate logs by txHash + logIndex
  const seenLogKeys = new Set<string>();
  const uniqueLogs: EvmLogEntry[] = [];
  for (const log of allLogs) {
    if (log.removed) continue;
    const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    if (!seenLogKeys.has(key)) {
      seenLogKeys.add(key);
      uniqueLogs.push(log);
    }
  }

  // 4. Parse logs into normalized activity items
  const activities: RawEvmActivityItem[] = [];

  for (const log of uniqueLogs) {
    if (log.topics.length < 3 || !log.topics[1] || !log.topics[2]) continue;

    const fromAddr = parseTopicToAddress(log.topics[1]);
    const toAddr = parseTopicToAddress(log.topics[2]);
    const isFromMe = fromAddr.toLowerCase() === normalizedWallet;
    const isToMe = toAddr.toLowerCase() === normalizedWallet;

    let direction: ActivityDirection = "INTERNAL";
    if (isFromMe && isToMe) {
      direction = "INTERNAL";
    } else if (isToMe) {
      direction = "INCOMING";
    } else if (isFromMe) {
      direction = "OUTGOING";
    }

    let atomicAmount = 0n;
    try {
      atomicAmount = BigInt(log.data);
    } catch {
      atomicAmount = 0n;
    }

    const blockHeight = BigInt(log.blockNumber);
    const eventIndex = parseInt(log.logIndex, 16);
    const confirmations =
      latestBlock >= blockHeight ? latestBlock - blockHeight : 0n;
    const finality: ActivityFinality =
      confirmations >= 12n ? "FINALIZED" : "CONFIRMED";

    activities.push({
      txHash: log.transactionHash,
      eventIndex,
      fromAddress: fromAddr,
      toAddress: toAddr,
      contractAddress: log.address.toLowerCase(),
      atomicAmount,
      blockHeight,
      blockHash: log.blockHash,
      blockTimestamp: null,
      finality,
      direction,
      activityType: "ON_CHAIN_TRANSFER",
      network: options.network,
      chainId: options.chainId,
      ecosystem: "evm",
      feeAtomicAmount: null,
      metadata: {
        confirmations: confirmations.toString(),
        contractAddress: log.address,
      },
    });
  }

  return activities;
}
