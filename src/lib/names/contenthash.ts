import { concatHex, type Hex } from "viem";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function encodeUvarint(x: number): Uint8Array {
  let v = BigInt(x);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

function base58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`Invalid base58 character in CID: ${char}`);
    num = num * 58n + BigInt(digit);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  // Preserve leading zero bytes encoded as leading '1's in base58.
  let leading = 0;
  for (const c of str) {
    if (c !== "1") break;
    leading++;
  }
  if (leading === 0) return bytes;
  const out = new Uint8Array(leading + bytes.length);
  out.set(bytes, leading);
  return out;
}

function base32Decode(str: string): Uint8Array {
  const cleaned = str.toLowerCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base32 character in CID: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(output);
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Encode an `ipfs://` or `bzz://` URI as an ENSIP-7 contenthash (used by ENS/GNS/WNS).
 */
export function encodeWebsiteContenthash(input: string): Hex {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();

  if (!lower.startsWith("ipfs://") && !lower.startsWith("bzz://")) {
    throw new Error("use ipfs:// or bzz:// prefix for content hash");
  }

  if (lower.startsWith("bzz://")) {
    const hash = trimmed.slice(6).replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(
        "Invalid Swarm reference (expected bzz:// followed by 64 hex characters)."
      );
    }
    return `0xe40101fa011b20${hash}`;
  }

  let cid = trimmed.slice("ipfs://".length);
  if (cid.startsWith("/ipfs/")) cid = cid.slice(6);
  if (cid.endsWith("/")) cid = cid.slice(0, -1);
  if (!cid || cid.includes("/")) {
    throw new Error("ipfs:// URI must be a CID without a path.");
  }

  let cidBytes: Uint8Array;
  if (cid.startsWith("Qm")) {
    const multihash = base58Decode(cid);
    cidBytes = new Uint8Array(2 + multihash.length);
    cidBytes[0] = 0x01;
    cidBytes[1] = 0x70;
    cidBytes.set(multihash, 2);
  } else if (cid.toLowerCase().startsWith("baf")) {
    cidBytes = base32Decode(cid.slice(1));
  } else if (cid.startsWith("f") || cid.startsWith("F")) {
    const hex = cid.slice(1);
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) {
      throw new Error("Invalid hex-encoded CID.");
    }
    cidBytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < cidBytes.length; i++) {
      cidBytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
  } else {
    throw new Error("Unsupported CID format. Use Qm… or baf… under ipfs://.");
  }

  return concatHex([bytesToHex(encodeUvarint(0xe3)), bytesToHex(cidBytes)]);
}
