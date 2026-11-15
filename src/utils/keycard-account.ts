import { execFileSync } from "node:child_process";
import {
  getAddress,
  hashMessage,
  hashTypedData,
  isAddressEqual,
  keccak256,
  padHex,
  parseSignature,
  recoverAddress,
  recoverTransactionAddress,
  serializeSignature,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { publicKeyToAddress, toAccount } from "viem/accounts";
import { hashAuthorization } from "viem/utils";

type KeycardPublicKey = {
  address: Address;
  public_key: Hex;
};

type KeycardSignature = {
  signature_r: Hex;
  signature_s: Hex;
  signature_v: number;
};

export function createKeycardAccount({
  binary,
  path = "m/44'/60'/0'/0/0",
}: {
  binary: string;
  path?: string;
}) {
  if (!binary) throw new Error("Keycard CLI binary required");
  if (!process.env.KEYCARD_PIN) {
    throw new Error("KEYCARD_PIN required for prototype");
  }

  function command<T>(name: string, args: string[]): T {
    const output = execFileSync(
      binary,
      [name, ...args, "--json", "--log-level", "error"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return JSON.parse(output) as T;
  }

  const exported = command<KeycardPublicKey>(
    "export-public-key",
    ["--path", path],
  );

  const address = getAddress(exported.address);

  if (!isAddressEqual(address, publicKeyToAddress(exported.public_key))) {
    throw new Error("Keycard public key/address mismatch");
  }

  async function signDigest(digest: Hex): Promise<Hex> {
    const result = command<KeycardSignature>("sign", [
      "--hex", digest,
      "--path", path,
      "--algo", "ecdsa",
    ]);

    const yParity = Number(result.signature_v);
    if (yParity !== 0 && yParity !== 1) {
      throw new Error("Invalid Keycard recovery parity");
    }

    const signature = serializeSignature({
      r: padHex(result.signature_r, { size: 32 }),
      s: padHex(result.signature_s, { size: 32 }),
      yParity,
    });

    const recovered = await recoverAddress({
      hash: digest,
      signature,
    });

    if (!isAddressEqual(recovered, address)) {
      throw new Error("Keycard signature verification failed");
    }

    return signature;
  }

  return toAccount({
    address,

    async signMessage({ message }) {
      return signDigest(hashMessage(message));
    },

    async signTypedData(typedData) {
      return signDigest(hashTypedData(typedData));
    },

    async signTransaction(transaction, options) {
      if (options?.serializer) {
        throw new Error("Custom transaction serializers unsupported");
      }

      if (transaction.type !== "eip1559") {
        throw new Error("Only EIP-1559 transactions supported");
      }

      const tx = transaction as TransactionSerializableEIP1559;

      if (
        !Number.isSafeInteger(tx.chainId) ||
        tx.chainId <= 0 ||
        tx.nonce === undefined ||
        !Number.isSafeInteger(tx.nonce) ||
        tx.nonce < 0 ||
        !tx.to ||
        typeof tx.gas !== "bigint" ||
        tx.gas <= 0n ||
        typeof tx.value !== "bigint" ||
        tx.value < 0n ||
        typeof tx.maxFeePerGas !== "bigint" ||
        typeof tx.maxPriorityFeePerGas !== "bigint" ||
        tx.maxPriorityFeePerGas < 0n ||
        tx.maxFeePerGas < tx.maxPriorityFeePerGas
      ) {
        throw new Error("Explicit, valid EIP-1559 fields required");
      }

      const digest = keccak256(serializeTransaction(tx));
      const signature = await signDigest(digest);
      const signed = serializeTransaction(
        tx,
        parseSignature(signature),
      );

      const recovered = await recoverTransactionAddress({
        serializedTransaction: signed,
      });

      if (!isAddressEqual(recovered, address)) {
        throw new Error("Signed transaction sender mismatch");
      }

      return signed;
    },

    async signAuthorization(authorization) {
      const { chainId, nonce } = authorization;
      const contractAddress =
        authorization.contractAddress ?? authorization.address;

      if (!Number.isSafeInteger(chainId) || chainId <= 0) {
        throw new Error("Explicit nonzero chain ID required");
      }
      if (!Number.isSafeInteger(nonce) || nonce < 0) {
        throw new Error("Explicit valid nonce required");
      }

      if (!contractAddress) {
        throw new Error("Explicit EIP-7702 delegate address required");
      }

      const delegate = getAddress(contractAddress);
      const signature = await signDigest(
        hashAuthorization({
          contractAddress: delegate,
          chainId,
          nonce,
        }),
      );

      return {
        address: delegate,
        chainId,
        nonce,
        ...parseSignature(signature),
      };
    },
  });
}
