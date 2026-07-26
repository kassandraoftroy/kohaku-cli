import type { JsonRpcProvider } from "ethers";

import { makeEthersProvider, getRpcChainIdMatchingWallet } from "../utils/rpc";
import { resolveWalletDir } from "../utils/wallets-util";
import { readSeedKeystore } from "../utils/mnemonic";

export type TuiSession = {
  dataDir: string;
  walletName: string;
  walletDir: string;
  password: string;
  mnemonic: string;
  rpcUrl: string;
  chainId: bigint;
  withoutTor?: boolean;
};

export type TuiBootstrapInput = {
  dataDir: string;
  walletName: string;
  password: string;
  rpcUrl: string;
  withoutTor?: boolean;
};

export async function buildTuiSession(input: TuiBootstrapInput): Promise<TuiSession> {
  const walletDir = resolveWalletDir(input.dataDir, input.walletName);
  const mnemonic = readSeedKeystore(input.password, walletDir);
  const chainId = await getRpcChainIdMatchingWallet(input.rpcUrl, walletDir);
  return {
    dataDir: input.dataDir,
    walletName: input.walletName,
    walletDir,
    password: input.password,
    mnemonic,
    rpcUrl: input.rpcUrl,
    chainId,
    withoutTor: input.withoutTor,
  };
}

export async function openSessionProvider(session: TuiSession): Promise<JsonRpcProvider> {
  return makeEthersProvider(session.rpcUrl);
}
