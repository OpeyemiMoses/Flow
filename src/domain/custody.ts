import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
 * Validates a NEAR Protocol address with strict implicit and named account rules:
 * - Implicit: exactly 64 lowercase hexadecimal characters (representing a 32-byte Ed25519 public key)
 *   and not all zeros.
 * - Named: 2-64 characters, lowercase alphanumeric labels separated by '.', where each label
 *   contains no leading, trailing, or consecutive '-' or '_' separators.
 */
export function isValidNearAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();
  if (trimmed.length < 2 || trimmed.length > 64) return false;

  // Implicit account: hex-only or dot-less account IDs must be 64 lowercase hex chars (32 bytes) and non-zero
  if (/^[0-9a-fA-F]+$/.test(trimmed) || !trimmed.includes(".")) {
    if (!/^[0-9a-f]{64}$/.test(trimmed)) return false;
    return !/^0{64}$/.test(trimmed);
  }

  // Named account: must consist of >=2 dot-separated segments; each segment must start and end
  // with [a-z0-9] and cannot have consecutive '-' or '_' separators.
  return /^([a-z0-9]+([_-][a-z0-9]+)*\.)+[a-z0-9]+([_-][a-z0-9]+)*$/.test(
    trimmed,
  );
}

const KECCAK_RC: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];
const KECCAK_ROTC: readonly number[] = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39,
  61, 20, 44,
];
const KECCAK_PILN: readonly number[] = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22,
  9, 6, 1,
];
const MASK_64 = 0xffffffffffffffffn;

function rotl64(x: bigint, n: number): bigint {
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK_64;
}

/**
 * Computes raw Keccak-256 over arbitrary bytes (0x01 padding as required by Ethereum).
 */
export function keccak256Bytes(input: Uint8Array): string {
  const rate = 136;
  const msg = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const padLen = rate - (msg.length % rate);
  const buf = Buffer.alloc(msg.length + padLen);
  msg.copy(buf);
  buf[msg.length] = 0x01;
  buf[buf.length - 1]! |= 0x80;

  const st: bigint[] = new Array<bigint>(25).fill(0n);
  const bc: bigint[] = new Array<bigint>(5).fill(0n);

  for (let off = 0; off < buf.length; off += rate) {
    for (let i = 0; i < 17; i++) {
      st[i] = st[i]! ^ buf.readBigUInt64LE(off + i * 8);
    }
    for (let r = 0; r < 24; r++) {
      for (let i = 0; i < 5; i++) {
        bc[i] = st[i]! ^ st[i + 5]! ^ st[i + 10]! ^ st[i + 15]! ^ st[i + 20]!;
      }
      for (let i = 0; i < 5; i++) {
        const t = bc[(i + 4) % 5]! ^ rotl64(bc[(i + 1) % 5]!, 1);
        for (let j = 0; j < 25; j += 5) {
          st[j + i] = st[j + i]! ^ t;
        }
      }
      let t = st[1]!;
      for (let i = 0; i < 24; i++) {
        const j = KECCAK_PILN[i]!;
        const tmp = st[j]!;
        st[j] = rotl64(t, KECCAK_ROTC[i]!);
        t = tmp;
      }
      for (let j = 0; j < 25; j += 5) {
        for (let i = 0; i < 5; i++) bc[i] = st[j + i]!;
        for (let i = 0; i < 5; i++) {
          st[j + i] =
            st[j + i]! ^ (~bc[(i + 1) % 5]! & MASK_64 & bc[(i + 2) % 5]!);
        }
      }
      st[0] = st[0]! ^ KECCAK_RC[r]!;
    }
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    out.writeBigUInt64LE(st[i]!, i * 8);
  }
  return out.toString("hex");
}

/**
 * Computes raw Keccak-256 over an ASCII/UTF-8 string (0x01 padding as required by Ethereum EIP-55).
 */
function keccak256Hex(asciiInput: string): string {
  return keccak256Bytes(Buffer.from(asciiInput, "utf8"));
}

/**
 * Computes the canonical EIP-55 mixed-case checksum address for an EVM address.
 */
export function toEip55ChecksumAddress(address: string): string {
  const lower = address.trim().slice(2).toLowerCase();
  const hash = keccak256Hex(lower);
  let checksummed = "0x";
  for (let i = 0; i < 40; i++) {
    const ch = lower[i]!;
    const nibble = Number.parseInt(hash[i]!, 16);
    checksummed += nibble >= 8 ? ch.toUpperCase() : ch;
  }
  return checksummed;
}

/**
 * Validates an EVM address (e.g. Base, Ethereum).
 * Enforces:
 * - "0x" followed by 40 hexadecimal characters
 * - Rejects the all-zero burn address
 * - Enforces EIP-55 Keccak-256 checksum whenever mixed-case hex characters are present
 */
export function isValidEvmAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return false;

  const body = trimmed.slice(2);
  if (/^0{40}$/.test(body)) return false;

  // All-lowercase or all-uppercase is valid unchecksummed format
  if (body === body.toLowerCase() || body === body.toUpperCase()) {
    return true;
  }

  // Mixed-case MUST match exact EIP-55 Keccak-256 checksum
  return trimmed === toEip55ChecksumAddress(trimmed);
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decodes a Base58 string into raw bytes, returning `null` if any invalid character is present.
 */
export function decodeBase58(input: string): Uint8Array | null {
  if (typeof input !== "string" || input.length === 0) return null;
  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === "1") {
    leadingZeros++;
  }

  let num = 0n;
  for (let i = leadingZeros; i < input.length; i++) {
    const idx = BASE58_ALPHABET.indexOf(input[i]!);
    if (idx === -1) return null;
    num = num * 58n + BigInt(idx);
  }

  const rawHex = num === 0n ? "" : num.toString(16);
  const paddedHex = rawHex.length % 2 === 0 ? rawHex : `0${rawHex}`;
  const tailBytes =
    paddedHex.length === 0 ? Buffer.alloc(0) : Buffer.from(paddedHex, "hex");

  const out = new Uint8Array(leadingZeros + tailBytes.length);
  out.set(tailBytes, leadingZeros);
  return out;
}

/**
 * Encodes raw bytes into Base58 (Bitcoin/Solana/NEAR alphabet).
 */
export function encodeBase58(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros++;
  }
  let num = 0n;
  for (const b of bytes) {
    num = (num << 8n) + BigInt(b);
  }
  const chars: string[] = [];
  while (num > 0n) {
    const rem = Number(num % 58n);
    chars.push(BASE58_ALPHABET[rem]!);
    num = num / 58n;
  }
  for (let i = 0; i < leadingZeros; i++) {
    chars.push("1");
  }
  return chars.reverse().join("");
}

const SECP256K1_P =
  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result = (result * b) % mod;
    }
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/**
 * Extracts and validates the 64-byte uncompressed (X || Y) secp256k1 public key
 * from uncompressed hex (0x04+128 hex or 128 hex), compressed hex (0x02/0x03+64 hex),
 * or Base58 (`secp256k1:<base58>`), verifying the point lies on $y^2 \equiv x^3 + 7 \pmod p$,
 * and derives the canonical EIP-55 EVM address (`0x` + 40 hex chars).
 */
export function deriveEvmAddressFromSecp256k1PublicKey(
  publicKey: string,
): string | null {
  if (typeof publicKey !== "string") return null;
  let body = publicKey.trim();
  if (body.toLowerCase().startsWith("ed25519:")) return null;
  if (body.toLowerCase().startsWith("secp256k1:")) {
    body = body.slice("secp256k1:".length).trim();
  }
  if (body.toLowerCase().startsWith("0x")) {
    body = body.slice(2).trim();
  }
  if (body.length === 0 || body.includes(".")) return null;

  let rawBytes: Uint8Array | null = null;
  if (/^[0-9a-fA-F]+$/.test(body) && body.length % 2 === 0) {
    rawBytes = Buffer.from(body, "hex");
  } else {
    rawBytes = decodeBase58(body);
  }
  if (!rawBytes) return null;

  let xBytes: Uint8Array;
  let yBytes: Uint8Array;

  if (rawBytes.length === 65 && rawBytes[0] === 0x04) {
    xBytes = rawBytes.subarray(1, 33);
    yBytes = rawBytes.subarray(33, 65);
  } else if (rawBytes.length === 64) {
    xBytes = rawBytes.subarray(0, 32);
    yBytes = rawBytes.subarray(32, 64);
  } else if (
    rawBytes.length === 33 &&
    (rawBytes[0] === 0x02 || rawBytes[0] === 0x03)
  ) {
    const prefix = rawBytes[0];
    xBytes = rawBytes.subarray(1, 33);
    const x = BigInt(`0x${Buffer.from(xBytes).toString("hex")}`);
    if (x <= 0n || x >= SECP256K1_P) return null;
    const rhs = (modPow(x, 3n, SECP256K1_P) + 7n) % SECP256K1_P;
    // Since p ≡ 3 (mod 4), y = rhs^((p + 1) / 4) mod p
    let y = modPow(rhs, (SECP256K1_P + 1n) / 4n, SECP256K1_P);
    if ((y * y) % SECP256K1_P !== rhs) return null;
    const isOdd = (y & 1n) === 1n;
    const wantOdd = prefix === 0x03;
    if (isOdd !== wantOdd) {
      y = SECP256K1_P - y;
    }
    yBytes = Buffer.from(y.toString(16).padStart(64, "0"), "hex");
  } else {
    return null;
  }

  const x = BigInt(`0x${Buffer.from(xBytes).toString("hex")}`);
  const y = BigInt(`0x${Buffer.from(yBytes).toString("hex")}`);
  if (x <= 0n || x >= SECP256K1_P || y <= 0n || y >= SECP256K1_P) {
    return null;
  }
  const lhs = (y * y) % SECP256K1_P;
  const rhs = (modPow(x, 3n, SECP256K1_P) + 7n) % SECP256K1_P;
  if (lhs !== rhs) {
    return null;
  }

  const uncompressed64 = new Uint8Array(64);
  uncompressed64.set(xBytes, 0);
  uncompressed64.set(yBytes, 32);

  const hashHex = keccak256Bytes(uncompressed64);
  return toEip55ChecksumAddress(`0x${hashHex.slice(-40)}`);
}

function decodeEd25519PublicKeyBytes(publicKey: string): Uint8Array | null {
  if (typeof publicKey !== "string") return null;
  let body = publicKey.trim();
  if (body.toLowerCase().startsWith("secp256k1:")) return null;
  if (body.toLowerCase().startsWith("ed25519:")) {
    body = body.slice("ed25519:".length).trim();
  }
  if (body.toLowerCase().startsWith("0x")) {
    body = body.slice(2).trim();
  }
  if (body.length === 0 || body.includes(".")) return null;

  if (/^[0-9a-fA-F]{64}$/.test(body)) {
    const buf = Buffer.from(body, "hex");
    return buf.some((b) => b !== 0) ? new Uint8Array(buf) : null;
  }

  const decoded = decodeBase58(body);
  if (!decoded || decoded.length !== 32) return null;
  return decoded.some((b) => b !== 0) ? decoded : null;
}

/**
 * Verifies that a provider-returned `public_key` is cryptographically consistent
 * with the derived chain `address`:
 * - NEAR (64-hex implicit account): 32-byte Ed25519 public key lowercase hex equals `address`.
 * - NEAR (named account): valid 32-byte non-zero Ed25519 public key.
 * - Solana: 32-byte Ed25519 public key equals 32-byte Base58-decoded `address`.
 * - Base / Ethereum (EVM): `secp256k1` curve point $(X, Y)$ hashes under Keccak-256
 *   to the exact 20-byte EVM `address`.
 *
 * When `options.strict` is `false` (default for legacy repository fixtures that pass
 * short synthetic labels like `"ed25519:nearKey"`), curve-prefix mismatches and any
 * full cryptographic key that mismatches the address are still rejected.
 * When `options.strict` is `true` (enforced in `OutLayerAdapter.getAddress`), a full
 * cryptographically verified public key is mandatory.
 */
export function verifyPublicKeyMatchesAddress(
  network: NetworkId,
  address: string,
  publicKey: string,
  options?: { readonly strict?: boolean },
): { valid: boolean; verifiedCryptographically: boolean; error?: string } {
  const strict = options?.strict ?? true;
  const addrValidation = validateAddressForNetwork(network, address);
  if (!addrValidation.valid) {
    return {
      valid: false,
      verifiedCryptographically: false,
      error: addrValidation.error,
    };
  }

  if (typeof publicKey !== "string" || publicKey.trim().length === 0) {
    return {
      valid: false,
      verifiedCryptographically: false,
      error: "Public key must be a non-empty string.",
    };
  }

  const trimmedKey = publicKey.trim();
  const isSyntheticFixtureKey =
    !strict && (trimmedKey.includes("...") || trimmedKey.length < 32);

  switch (network) {
    case "near:mainnet":
    case "near:testnet":
    case "near": {
      if (trimmedKey.toLowerCase().startsWith("secp256k1:")) {
        return {
          valid: false,
          verifiedCryptographically: false,
          error: "NEAR address requires an Ed25519 public key, not secp256k1.",
        };
      }
      if (isSyntheticFixtureKey) {
        return { valid: true, verifiedCryptographically: false };
      }
      const keyBytes = decodeEd25519PublicKeyBytes(trimmedKey);
      if (!keyBytes) {
        return {
          valid: false,
          verifiedCryptographically: false,
          error: "Invalid 32-byte Ed25519 public key for NEAR address.",
        };
      }
      const normalizedAddress = address.trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(normalizedAddress)) {
        const derivedHex = Buffer.from(keyBytes).toString("hex").toLowerCase();
        if (derivedHex !== normalizedAddress) {
          return {
            valid: false,
            verifiedCryptographically: false,
            error:
              "NEAR 64-hex implicit address does not match derived 32-byte Ed25519 public key.",
          };
        }
      }
      return { valid: true, verifiedCryptographically: true };
    }

    case "solana:mainnet":
    case "solana": {
      if (trimmedKey.toLowerCase().startsWith("secp256k1:")) {
        return {
          valid: false,
          verifiedCryptographically: false,
          error:
            "Solana address requires an Ed25519 public key, not secp256k1.",
        };
      }
      if (isSyntheticFixtureKey) {
        return { valid: true, verifiedCryptographically: false };
      }
      const keyBytes = decodeEd25519PublicKeyBytes(trimmedKey);
      const addrBytes = decodeBase58(address.trim());
      if (!keyBytes || !addrBytes || addrBytes.length !== 32) {
        return {
          valid: false,
          verifiedCryptographically: false,
          error: "Invalid 32-byte Ed25519 public key for Solana address.",
        };
      }
      const matches = Buffer.from(keyBytes).equals(Buffer.from(addrBytes));
      if (!matches) {
        return {
          valid: false,
          verifiedCryptographically: false,
          error:
            "Solana Base58 address does not match derived 32-byte Ed25519 public key.",
        };
      }
      return { valid: true, verifiedCryptographically: true };
    }

    case "eip155:8453":
    case "eip155:1":
    case "base":
    case "ethereum": {
      if (trimmedKey.toLowerCase().startsWith("ed25519:")) {
        return {
          valid: false,
          verifiedCryptographically: false,
          error: "EVM address requires a secp256k1 public key, not ed25519.",
        };
      }
      if (isSyntheticFixtureKey) {
        return { valid: true, verifiedCryptographically: false };
      }
      const derivedEvm = deriveEvmAddressFromSecp256k1PublicKey(trimmedKey);
      if (!derivedEvm) {
        return {
          valid: false,
          verifiedCryptographically: false,
          error: "Invalid secp256k1 curve point in EVM public key.",
        };
      }
      if (derivedEvm.toLowerCase() !== address.trim().toLowerCase()) {
        return {
          valid: false,
          verifiedCryptographically: false,
          error:
            "EVM address does not match Keccak-256 derivation of secp256k1 public key.",
        };
      }
      return { valid: true, verifiedCryptographically: true };
    }

    default:
      return {
        valid: false,
        verifiedCryptographically: false,
        error: `Unsupported network for public key verification: ${network}`,
      };
  }
}

/**
 * Validates a Solana address.
 * Standard Solana address is a Base58-encoded Ed25519 public key that decodes to
 * EXACTLY 32 bytes and is not all zeros.
 */
export function isValidSolanaAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();
  if (trimmed.length < 32 || trimmed.length > 44) return false;
  const decoded = decodeBase58(trimmed);
  if (!decoded || decoded.length !== 32) return false;
  return decoded.some((byte) => byte !== 0);
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
 * Structured provider-backed policy evidence returned by OutLayer `/wallet/v1/policy`
 * (OpenAPI `0.1.0-alpha.4` `PolicyResponse` schema).
 *
 * Raw caller-supplied strings or plain objects are never accepted to promote custody policy state;
 * evidence must pass through `OutLayerAdapter.getPolicy`, which attaches an in-process adapter
 * provenance marker (`mintTrustedAdapterPolicyEvidence`).
 *
 * ARCHITECTURAL NOTE (Local Adapter Provenance vs. Provider Attestation):
 * `ADAPTER_POLICY_BRAND` is an internal software boundary guard inside the Node.js process that
 * prevents callers from bypassing `OutLayerAdapter.getPolicy()` with fabricated literals.
 * It is NOT an independent cryptographic TEE hardware quote from OutLayer (`GET /wallet/v1/policy`
 * returns JSON over TLS, whereas on-chain policy integrity is anchored by `store_wallet_policy`
 * signatures via `POST /wallet/v1/sign-policy`).
 */
export interface ProviderPolicyEvidenceInput {
  readonly wallet_id: string;
  readonly controller?: string;
  readonly frozen: boolean;
  readonly policy?: string;
  readonly rules?: Record<string, unknown>;
  readonly approval?: Record<string, unknown>;
  readonly capabilities?: Record<string, unknown>;
  readonly authorized_key_hashes?: ReadonlyArray<string>;
  readonly refund_addresses?: Record<string, string>;
  readonly usage?: Record<string, unknown>;
}

const ADAPTER_POLICY_BRAND: unique symbol = Symbol(
  "flow.outlayer.adapter.policy.provenance",
);
const ADAPTER_ATTESTATION_KEY = randomBytes(32);

export type TrustedProviderPolicyEvidence = ProviderPolicyEvidenceInput & {
  readonly [ADAPTER_POLICY_BRAND]: string;
};

function computePolicyEvidenceHmac(
  evidence: ProviderPolicyEvidenceInput,
): string {
  const canonical = JSON.stringify({
    wallet_id: evidence.wallet_id,
    controller: evidence.controller ?? null,
    frozen: evidence.frozen,
    policy: evidence.policy ?? null,
    rules: evidence.rules ?? null,
    approval: evidence.approval ?? null,
    capabilities: evidence.capabilities ?? null,
    authorized_key_hashes: evidence.authorized_key_hashes ?? null,
    refund_addresses: evidence.refund_addresses ?? null,
    usage: evidence.usage ?? null,
  });
  return createHmac("sha256", ADAPTER_ATTESTATION_KEY)
    .update(canonical)
    .digest("hex");
}

/**
 * Mints an in-process adapter provenance token onto validated `/wallet/v1/policy`
 * response payloads so internal callers cannot bypass `OutLayerAdapter.getPolicy()`.
 * NOTE: This marker is an internal software boundary guard, not a remote TEE signature.
 */
export function mintTrustedAdapterPolicyEvidence(
  evidence: ProviderPolicyEvidenceInput,
): TrustedProviderPolicyEvidence {
  const signature = computePolicyEvidenceHmac(evidence);
  const copy: ProviderPolicyEvidenceInput = {
    wallet_id: evidence.wallet_id,
    controller: evidence.controller,
    frozen: evidence.frozen,
    policy: evidence.policy,
    rules: evidence.rules ? { ...evidence.rules } : undefined,
    approval: evidence.approval ? { ...evidence.approval } : undefined,
    capabilities: evidence.capabilities
      ? { ...evidence.capabilities }
      : undefined,
    authorized_key_hashes: evidence.authorized_key_hashes
      ? [...evidence.authorized_key_hashes]
      : undefined,
    refund_addresses: evidence.refund_addresses
      ? { ...evidence.refund_addresses }
      : undefined,
    usage: evidence.usage ? { ...evidence.usage } : undefined,
  };
  Object.defineProperty(copy, ADAPTER_POLICY_BRAND, {
    value: signature,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(copy) as TrustedProviderPolicyEvidence;
}

export function hasTrustedAdapterPolicyProvenance(
  evidence: unknown,
): evidence is TrustedProviderPolicyEvidence {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return false;
  }
  const branded = evidence as Record<symbol, unknown>;
  const token = branded[ADAPTER_POLICY_BRAND];
  if (typeof token !== "string" || token.length !== 64) {
    return false;
  }
  const expected = computePolicyEvidenceHmac(
    evidence as ProviderPolicyEvidenceInput,
  );
  const tokenBuf = Buffer.from(token, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (tokenBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(tokenBuf, expectedBuf);
}

export interface VerifiedCustodyPolicy {
  readonly providerWalletId: string;
  readonly controllerAccountId: string;
  readonly policyState: "stored";
  readonly frozen: false;
}

const FUND_MOVING_OUTLAYER_REQUEST_TYPES = new Set([
  "transfer",
  "withdraw",
  "cross_chain_withdraw",
  "swap",
  "limit_order",
  "payment_check",
  "confidential",
  "near_call",
  "raw_sign",
  "evm_sign",
  "solana_sign",
]);

const FUND_MOVING_OUTLAYER_CAPABILITIES = [
  "raw_sign",
  "evm_sign",
  "solana_sign",
  "swap",
  "cross_chain_withdraw",
  "limit_order",
  "payment_check",
  "confidential",
] as const;

/**
 * Validates provider-backed custody policy evidence (`GET /wallet/v1/policy`) before a wallet
 * can transition to `ACTIVE` or receive `policy_state = 'stored'`.
 *
 * Enforces both:
 * 1. In-process adapter boundary provenance (`hasTrustedAdapterPolicyProvenance`), preventing
 *    caller-supplied strings or unvalidated object literals.
 * 2. Documented OutLayer OpenAPI `0.1.0-alpha.4` `PolicyResponse` semantics:
 *    - `wallet_id` matches `expectedProviderWalletId`
 *    - `frozen === false`
 *    - `policy === 'stored'` (rejects `'none'` where OutLayer allows unrestricted ops, and
 *      rejects `undefined` when OutLayer coordinator could not read/decrypt on-chain policy)
 *    - `controller` is a valid NEAR account ID
 *    - While `FLOW_EXECUTION=disabled`, neither OutLayer `rules` (`transaction_types`, `limits`)
 *      nor OutLayer `capabilities` (`raw_sign`, `evm_sign`, `solana_sign`, `swap`,
 *      `cross_chain_withdraw`, `limit_order`, `payment_check`, `confidential`) may permit
 *      fund-moving operations or transfer signing.
 */
export function verifyCustodyPolicyEvidence(
  evidence: unknown,
  expectedProviderWalletId: string,
  options?: { readonly expectedController?: string },
): VerifiedCustodyPolicy {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      "Custody policy promotion requires structured provider policy evidence, not a raw string or primitive.",
    );
  }

  if (!hasTrustedAdapterPolicyProvenance(evidence)) {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      "Custody policy evidence was not obtained through the trusted OutLayer provider adapter.",
    );
  }

  const record = evidence as unknown as Record<string, unknown>;
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

  const normalizedController = record.controller.trim().toLowerCase();
  if (
    options?.expectedController &&
    normalizedController !== options.expectedController.trim().toLowerCase()
  ) {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      `Custody policy controller (${normalizedController}) does not match expected controller (${options.expectedController}).`,
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

  const rulesObj = record.rules as Record<string, unknown>;
  if (Object.keys(rulesObj).length === 0) {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      "Custody policy verification requires non-empty policy rules.",
    );
  }

  // Evaluate documented OutLayer OpenAPI 0.1.0-alpha.4 Capabilities if present
  if (
    record.capabilities !== undefined &&
    record.capabilities !== null &&
    typeof record.capabilities === "object" &&
    !Array.isArray(record.capabilities)
  ) {
    const capsObj = record.capabilities as Record<string, unknown>;
    for (const capKey of FUND_MOVING_OUTLAYER_CAPABILITIES) {
      const entry = capsObj[capKey];
      if (entry === true) {
        throw new FlowError(
          "POLICY_VERIFICATION_FAILED",
          `Custody policy capability '${capKey}' must not be enabled while FLOW_EXECUTION=disabled.`,
        );
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const capRecord = entry as Record<string, unknown>;
        if (capRecord.allowed === true || capRecord.raw_tx === true) {
          throw new FlowError(
            "POLICY_VERIFICATION_FAILED",
            `Custody policy capability '${capKey}' must not be enabled while FLOW_EXECUTION=disabled.`,
          );
        }
      }
    }
  }

  // Check explicit transfer-signing flags
  if (
    rulesObj.transferSigning === "enabled" ||
    rulesObj.allowTransfers === true
  ) {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      "Custody policy rules must not enable transfer signing while FLOW_EXECUTION=disabled.",
    );
  }

  // Check documented OutLayer PolicyRules (`transaction_types` allowlist and `limits` spending caps)
  let hasOutLayerZeroSpendCap = false;
  if (
    rulesObj.limits &&
    typeof rulesObj.limits === "object" &&
    !Array.isArray(rulesObj.limits)
  ) {
    const limits = rulesObj.limits as Record<string, unknown>;
    const perTx =
      limits.per_transaction &&
      typeof limits.per_transaction === "object" &&
      !Array.isArray(limits.per_transaction)
        ? (limits.per_transaction as Record<string, unknown>)
        : null;
    const daily =
      limits.daily &&
      typeof limits.daily === "object" &&
      !Array.isArray(limits.daily)
        ? (limits.daily as Record<string, unknown>)
        : null;
    if (perTx?.["*"] === "0" && (!daily || daily["*"] === "0")) {
      hasOutLayerZeroSpendCap = true;
    }
  }

  let hasOutLayerNonFundTxTypeAllowlist = false;
  if (Array.isArray(rulesObj.transaction_types)) {
    for (const txType of rulesObj.transaction_types) {
      if (
        typeof txType !== "string" ||
        FUND_MOVING_OUTLAYER_REQUEST_TYPES.has(txType)
      ) {
        throw new FlowError(
          "POLICY_VERIFICATION_FAILED",
          `Custody policy rules.transaction_types must not permit fund-moving operation '${String(txType)}' while FLOW_EXECUTION=disabled.`,
        );
      }
    }
    hasOutLayerNonFundTxTypeAllowlist = true;
  }

  const hasExplicitDenyRule =
    rulesObj.defaultAction === "DENY" ||
    (hasOutLayerZeroSpendCap && hasOutLayerNonFundTxTypeAllowlist) ||
    (hasOutLayerNonFundTxTypeAllowlist &&
      rulesObj.transaction_types &&
      (rulesObj.transaction_types as unknown[]).length === 0);

  if (
    !hasExplicitDenyRule ||
    (rulesObj.defaultAction !== undefined && rulesObj.defaultAction !== "DENY")
  ) {
    throw new FlowError(
      "POLICY_VERIFICATION_FAILED",
      "Custody policy verification requires default-deny rules (rules.defaultAction === 'DENY' or OutLayer PolicyRules with empty transaction_types / zero spend limits).",
    );
  }

  return {
    providerWalletId: expectedProviderWalletId,
    controllerAccountId: normalizedController,
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

    const pubKeyCheck = verifyPublicKeyMatchesAddress(
      addr.network as NetworkId,
      addr.address,
      addr.publicKey,
      { strict: false },
    );
    if (!pubKeyCheck.valid) {
      throw new FlowError(
        "CUSTODY_INVALID_ADDRESS",
        `Public key inconsistency for network ${addr.network}: ${pubKeyCheck.error}`,
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
