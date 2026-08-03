import {
  encodeFunctionData,
  getAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { namehash } from "viem/ens";

import type { KohakuPublicClient } from "../../utils/rpc.js";
import {
  ENS_BASE_REGISTRAR,
  ENS_ETH_REGISTRAR_CONTROLLER,
  ENS_NAME_WRAPPER,
  ENS_PUBLIC_RESOLVER,
  ENS_REGISTRY,
  ENS_REVERSE_REGISTRAR,
  GNS_CONTRACT,
  GWEI_NODE,
  ONE_YEAR_SECONDS,
  WEI_NODE,
  WNS_CONTRACT,
} from "./constants.js";
import {
  ENS_BASE_REGISTRAR_ABI,
  ENS_CONTROLLER_ABI,
  ENS_NAME_WRAPPER_ABI,
  ENS_REGISTRY_ABI,
  ENS_RESOLVER_ABI,
  ENS_REVERSE_REGISTRAR_ABI,
  NAME_NFT_ABI,
} from "./abis.js";
import type {
  NameOwnership,
  ParsedName,
  PreparedTx,
  TransferRole,
} from "./types.js";

export function nftContract(protocol: "gns" | "wns"): Address {
  return protocol === "gns" ? GNS_CONTRACT : WNS_CONTRACT;
}

export function nftParentId(protocol: "gns" | "wns"): bigint {
  return BigInt(protocol === "gns" ? GWEI_NODE : WEI_NODE);
}

export function ensLabelTokenId(label: string): bigint {
  return BigInt(keccak256(toBytes(label)));
}

export function assertEnsMainnet(chainId: bigint): void {
  if (chainId !== 1n) {
    throw new Error(
      "ENS write operations use ENS v1 contracts on Ethereum mainnet only " +
        `(current chain id ${chainId}). Use a mainnet wallet/RPC, or manage .gwei/.wei on this chain.`
    );
  }
}

export async function readNameOwnership(
  client: KohakuPublicClient,
  parsed: ParsedName
): Promise<NameOwnership> {
  if (parsed.protocol === "ens") {
    assertEnsMainnet(BigInt(client.chain?.id ?? 0));
    const node = namehash(parsed.name) as Hex;
    const labelId = ensLabelTokenId(parsed.label);
    const [registryOwner, baseOwner] = await Promise.all([
      client.readContract({
        address: ENS_REGISTRY,
        abi: ENS_REGISTRY_ABI,
        functionName: "owner",
        args: [node],
      }),
      client.readContract({
        address: ENS_BASE_REGISTRAR,
        abi: ENS_BASE_REGISTRAR_ABI,
        functionName: "ownerOf",
        args: [labelId],
      }),
    ]);
    const wrapped =
      getAddress(baseOwner).toLowerCase() === ENS_NAME_WRAPPER.toLowerCase();
    let owner: Address;
    if (wrapped) {
      owner = getAddress(
        await client.readContract({
          address: ENS_NAME_WRAPPER,
          abi: ENS_NAME_WRAPPER_ABI,
          functionName: "ownerOf",
          args: [BigInt(node)],
        })
      );
    } else {
      owner = getAddress(baseOwner);
    }
    return {
      owner,
      manager: getAddress(registryOwner),
      wrapped,
      node,
    };
  }

  const contract = nftContract(parsed.protocol);
  const tokenId = await client.readContract({
    address: contract,
    abi: NAME_NFT_ABI,
    functionName: "computeId",
    args: [parsed.name],
  });
  const owner = getAddress(
    await client.readContract({
      address: contract,
      abi: NAME_NFT_ABI,
      functionName: "ownerOf",
      args: [tokenId],
    })
  );
  return {
    owner,
    manager: owner,
    wrapped: false,
    node: `0x${tokenId.toString(16).padStart(64, "0")}` as Hex,
    tokenId,
  };
}

function tx(
  step: string,
  to: Address,
  data: Hex,
  value: bigint = 0n
): PreparedTx {
  return { step, to, data, value };
}

export async function prepareNftRegister(opts: {
  client: KohakuPublicClient;
  parsed: ParsedName & { protocol: "gns" | "wns" };
  owner: Address;
  secret: Hex;
}): Promise<{ commit: PreparedTx; reveal: PreparedTx; feeWei: bigint }> {
  const { client, parsed, owner, secret } = opts;
  const contract = nftContract(parsed.protocol);
  const parentId = nftParentId(parsed.protocol);
  const available = await client.readContract({
    address: contract,
    abi: NAME_NFT_ABI,
    functionName: "isAvailable",
    args: [parsed.label, parentId],
  });
  if (!available) {
    throw new Error(`Name "${parsed.name}" is not available.`);
  }

  const tokenId = await client.readContract({
    address: contract,
    abi: NAME_NFT_ABI,
    functionName: "computeId",
    args: [parsed.name],
  });
  const [fee, premium, commitment] = await Promise.all([
    client.readContract({
      address: contract,
      abi: NAME_NFT_ABI,
      functionName: "getFee",
      args: [BigInt(new TextEncoder().encode(parsed.label).length)],
    }),
    client.readContract({
      address: contract,
      abi: NAME_NFT_ABI,
      functionName: "getPremium",
      args: [tokenId],
    }),
    client.readContract({
      address: contract,
      abi: NAME_NFT_ABI,
      functionName: "makeCommitment",
      args: [parsed.label, owner, secret],
    }),
  ]);
  const feeWei = fee + premium;
  return {
    feeWei,
    commit: tx(
      "commit",
      contract,
      encodeFunctionData({
        abi: NAME_NFT_ABI,
        functionName: "commit",
        args: [commitment],
      })
    ),
    reveal: tx(
      "reveal",
      contract,
      encodeFunctionData({
        abi: NAME_NFT_ABI,
        functionName: "reveal",
        args: [parsed.label, secret],
      }),
      feeWei
    ),
  };
}

export async function prepareEnsRegister(opts: {
  client: KohakuPublicClient;
  parsed: ParsedName;
  owner: Address;
  secret: Hex;
  durationSeconds: bigint;
  reverseRecord: boolean;
}): Promise<{ commit: PreparedTx; register: PreparedTx; feeWei: bigint }> {
  assertEnsMainnet(BigInt(opts.client.chain?.id ?? 0));
  const { client, parsed, owner, secret, durationSeconds, reverseRecord } = opts;
  if (durationSeconds < 28n * 24n * 60n * 60n) {
    throw new Error("ENS registration duration must be at least 28 days.");
  }
  const available = await client.readContract({
    address: ENS_ETH_REGISTRAR_CONTROLLER,
    abi: ENS_CONTROLLER_ABI,
    functionName: "available",
    args: [parsed.label],
  });
  if (!available) {
    throw new Error(`Name "${parsed.name}" is not available.`);
  }
  const price = await client.readContract({
    address: ENS_ETH_REGISTRAR_CONTROLLER,
    abi: ENS_CONTROLLER_ABI,
    functionName: "rentPrice",
    args: [parsed.label, durationSeconds],
  });
  // Buffer for price oracle movement during the 60s commit wait.
  const feeWei = ((price.base + price.premium) * 110n) / 100n;
  const commitment = await client.readContract({
    address: ENS_ETH_REGISTRAR_CONTROLLER,
    abi: ENS_CONTROLLER_ABI,
    functionName: "makeCommitment",
    args: [
      parsed.label,
      owner,
      durationSeconds,
      secret,
      ENS_PUBLIC_RESOLVER,
      [],
      reverseRecord,
      0,
    ],
  });
  const registerArgs = [
    parsed.label,
    owner,
    durationSeconds,
    secret,
    ENS_PUBLIC_RESOLVER,
    [],
    reverseRecord,
    0,
  ] as const;
  return {
    feeWei,
    commit: tx(
      "commit",
      ENS_ETH_REGISTRAR_CONTROLLER,
      encodeFunctionData({
        abi: ENS_CONTROLLER_ABI,
        functionName: "commit",
        args: [commitment],
      })
    ),
    register: tx(
      "register",
      ENS_ETH_REGISTRAR_CONTROLLER,
      encodeFunctionData({
        abi: ENS_CONTROLLER_ABI,
        functionName: "register",
        args: [...registerArgs],
      }),
      feeWei
    ),
  };
}

export async function prepareRenew(opts: {
  client: KohakuPublicClient;
  parsed: ParsedName;
  ownership: NameOwnership;
  durationSeconds: bigint;
}): Promise<PreparedTx> {
  const { client, parsed, ownership, durationSeconds } = opts;
  if (parsed.protocol === "ens") {
    assertEnsMainnet(BigInt(client.chain?.id ?? 0));
    const price = await client.readContract({
      address: ENS_ETH_REGISTRAR_CONTROLLER,
      abi: ENS_CONTROLLER_ABI,
      functionName: "rentPrice",
      args: [parsed.label, durationSeconds],
    });
    const feeWei = ((price.base + price.premium) * 105n) / 100n;
    return tx(
      "renew",
      ENS_ETH_REGISTRAR_CONTROLLER,
      encodeFunctionData({
        abi: ENS_CONTROLLER_ABI,
        functionName: "renew",
        args: [parsed.label, durationSeconds],
      }),
      feeWei
    );
  }
  const contract = nftContract(parsed.protocol);
  const tokenId = ownership.tokenId!;
  const labelBytes = new TextEncoder().encode(parsed.label).length;
  const [fee, premium] = await Promise.all([
    client.readContract({
      address: contract,
      abi: NAME_NFT_ABI,
      functionName: "getFee",
      args: [BigInt(labelBytes)],
    }),
    // Renewals do not charge premium; still read for clarity / future-proofing.
    client.readContract({
      address: contract,
      abi: NAME_NFT_ABI,
      functionName: "getPremium",
      args: [tokenId],
    }),
  ]);
  void premium;
  return tx(
    "renew",
    contract,
    encodeFunctionData({
      abi: NAME_NFT_ABI,
      functionName: "renew",
      args: [tokenId],
    }),
    fee
  );
}

export function prepareTransfer(opts: {
  parsed: ParsedName;
  ownership: NameOwnership;
  from: Address;
  to: Address;
  role: TransferRole;
}): PreparedTx[] {
  const { parsed, ownership, from, to, role } = opts;
  if (parsed.protocol !== "ens") {
    if (role === "manager") {
      throw new Error(
        `${parsed.protocol.toUpperCase()} has no separate manager role — use --role owner (NFT transfer).`
      );
    }
    const contract = nftContract(parsed.protocol);
    return [
      tx(
        "transfer-owner",
        contract,
        encodeFunctionData({
          abi: NAME_NFT_ABI,
          functionName: "safeTransferFrom",
          args: [from, to, ownership.tokenId!],
        })
      ),
    ];
  }

  if ((role === "manager" || role === "both") && ownership.wrapped && role === "manager") {
    throw new Error(
      "Wrapped ENS names have no separate registry manager (NameWrapper is the registry owner). " +
        "Use --role owner to transfer the wrapped NFT."
    );
  }

  const txs: PreparedTx[] = [];
  if (role === "owner" || role === "both") {
    if (ownership.wrapped) {
      txs.push(
        tx(
          "transfer-owner",
          ENS_NAME_WRAPPER,
          encodeFunctionData({
            abi: ENS_NAME_WRAPPER_ABI,
            functionName: "safeTransferFrom",
            args: [from, to, BigInt(ownership.node), 1n, "0x"],
          })
        )
      );
    } else {
      txs.push(
        tx(
          "transfer-owner",
          ENS_BASE_REGISTRAR,
          encodeFunctionData({
            abi: ENS_BASE_REGISTRAR_ABI,
            functionName: "safeTransferFrom",
            args: [from, to, ensLabelTokenId(parsed.label)],
          })
        )
      );
    }
  }
  if (role === "manager" || role === "both") {
    // Wrapped transfer already moves control with the NFT.
    if (role === "both" && ownership.wrapped) {
      return txs;
    }
    txs.push(
      tx(
        "transfer-manager",
        ENS_REGISTRY,
        encodeFunctionData({
          abi: ENS_REGISTRY_ABI,
          functionName: "setOwner",
          args: [ownership.node, to],
        })
      )
    );
  }
  return txs;
}

export async function prepareSetText(opts: {
  client: KohakuPublicClient;
  parsed: ParsedName;
  ownership: NameOwnership;
  key: string;
  value: string;
}): Promise<PreparedTx> {
  const { client, parsed, ownership, key, value } = opts;
  if (parsed.protocol !== "ens") {
    return tx(
      "set-text",
      nftContract(parsed.protocol),
      encodeFunctionData({
        abi: NAME_NFT_ABI,
        functionName: "setText",
        args: [ownership.tokenId!, key, value],
      })
    );
  }
  if (ownership.wrapped) {
    return tx(
      "set-text",
      ENS_NAME_WRAPPER,
      encodeFunctionData({
        abi: ENS_NAME_WRAPPER_ABI,
        functionName: "setText",
        args: [ownership.node, key, value],
      })
    );
  }
  const resolver = await client.readContract({
    address: ENS_REGISTRY,
    abi: ENS_REGISTRY_ABI,
    functionName: "resolver",
    args: [ownership.node],
  });
  if (resolver === "0x0000000000000000000000000000000000000000") {
    throw new Error(`ENS name "${parsed.name}" has no resolver set.`);
  }
  return tx(
    "set-text",
    getAddress(resolver),
    encodeFunctionData({
      abi: ENS_RESOLVER_ABI,
      functionName: "setText",
      args: [ownership.node, key, value],
    })
  );
}

export async function prepareSetWebsite(opts: {
  client: KohakuPublicClient;
  parsed: ParsedName;
  ownership: NameOwnership;
  contenthash: Hex;
}): Promise<PreparedTx> {
  const { client, parsed, ownership, contenthash } = opts;
  if (parsed.protocol !== "ens") {
    return tx(
      "set-website",
      nftContract(parsed.protocol),
      encodeFunctionData({
        abi: NAME_NFT_ABI,
        functionName: "setContenthash",
        args: [ownership.tokenId!, contenthash],
      })
    );
  }
  if (ownership.wrapped) {
    return tx(
      "set-website",
      ENS_NAME_WRAPPER,
      encodeFunctionData({
        abi: ENS_NAME_WRAPPER_ABI,
        functionName: "setContenthash",
        args: [ownership.node, contenthash],
      })
    );
  }
  const resolver = await client.readContract({
    address: ENS_REGISTRY,
    abi: ENS_REGISTRY_ABI,
    functionName: "resolver",
    args: [ownership.node],
  });
  if (resolver === "0x0000000000000000000000000000000000000000") {
    throw new Error(`ENS name "${parsed.name}" has no resolver set.`);
  }
  return tx(
    "set-website",
    getAddress(resolver),
    encodeFunctionData({
      abi: ENS_RESOLVER_ABI,
      functionName: "setContenthash",
      args: [ownership.node, contenthash],
    })
  );
}

export function prepareSetReverse(opts: {
  parsed: ParsedName;
  ownership: NameOwnership;
}): PreparedTx {
  const { parsed, ownership } = opts;
  if (parsed.protocol !== "ens") {
    return tx(
      "set-reverse",
      nftContract(parsed.protocol),
      encodeFunctionData({
        abi: NAME_NFT_ABI,
        functionName: "setPrimaryName",
        args: [ownership.tokenId!],
      })
    );
  }
  return tx(
    "set-reverse",
    ENS_REVERSE_REGISTRAR,
    encodeFunctionData({
      abi: ENS_REVERSE_REGISTRAR_ABI,
      functionName: "setName",
      args: [parsed.name],
    })
  );
}

export function defaultDurationSeconds(years: number | undefined): bigint {
  const y = years ?? 1;
  if (!Number.isFinite(y) || y < 1 || !Number.isInteger(y)) {
    throw new Error("--years must be a positive integer.");
  }
  return BigInt(y) * ONE_YEAR_SECONDS;
}
