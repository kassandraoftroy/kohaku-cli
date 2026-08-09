import { generateStealthAddress } from "@scopelift/stealth-address-sdk/dist/utils/crypto/generateStealthAddress.js";
import {
  buildMetadataForETH,
  buildMetadataForERC20,
} from "@scopelift/stealth-address-sdk/dist/utils/helpers/buildMetadata.js";
import { encodeFunctionData, type Address, type Hex } from "viem";

import { encodeContractCall } from "../../utils/viem-tx.js";
import { ERC20_ABI } from "../../utils/tokens-util.js";
import {
  STEALTH_ANNOUNCER_ADDRESS,
  STEALTH_SCHEME_ID,
} from "./constants.js";
import { normalizeStealthMetaAddressURI } from "./keys.js";

export type StealthSendPlan = {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: Hex;
  metadata: Hex;
  /** Fund transfer (ETH or ERC-20) to the ephemeral stealth address. */
  transferTx: { to: Address; data: Hex; value: bigint };
  /** Required ERC-5564 announcement on the canonical announcer. */
  announceTx: { to: Address; data: Hex; value: bigint };
};

/**
 * Build transfer + announce payloads for a stealth payment to a meta-address.
 */
export function prepareStealthSend(opts: {
  stealthMetaAddressURI: string;
  chainId: bigint;
  token: { isEth: boolean; tokenAddress: string };
  amount: bigint;
}): StealthSendPlan {
  const uri = normalizeStealthMetaAddressURI(
    opts.stealthMetaAddressURI,
    opts.chainId
  );
  const generated = generateStealthAddress({
    stealthMetaAddressURI: uri,
    schemeId: STEALTH_SCHEME_ID,
  });
  const viewTag = generated.viewTag as Hex;
  const metadata = (
    opts.token.isEth
      ? buildMetadataForETH({ viewTag, amount: opts.amount })
      : buildMetadataForERC20({
          viewTag,
          tokenAddress: opts.token.tokenAddress as Address,
          amount: opts.amount,
        })
  ) as Hex;

  const transferTx = opts.token.isEth
    ? {
        to: generated.stealthAddress as Address,
        data: "0x" as Hex,
        value: opts.amount,
      }
    : {
        to: opts.token.tokenAddress as Address,
        data: encodeContractCall(ERC20_ABI, "transfer", [
          generated.stealthAddress,
          opts.amount,
        ]),
        value: 0n,
      };

  const announceTx = {
    to: STEALTH_ANNOUNCER_ADDRESS,
    data: encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "announce",
          stateMutability: "nonpayable",
          inputs: [
            { name: "schemeId", type: "uint256" },
            { name: "stealthAddress", type: "address" },
            { name: "ephemeralPubKey", type: "bytes" },
            { name: "metadata", type: "bytes" },
          ],
          outputs: [],
        },
      ],
      functionName: "announce",
      args: [
        BigInt(STEALTH_SCHEME_ID),
        generated.stealthAddress as Address,
        generated.ephemeralPublicKey as Hex,
        metadata,
      ],
    }),
    value: 0n,
  };

  return {
    stealthAddress: generated.stealthAddress as Address,
    ephemeralPublicKey: generated.ephemeralPublicKey as Hex,
    viewTag,
    metadata,
    transferTx,
    announceTx,
  };
}
