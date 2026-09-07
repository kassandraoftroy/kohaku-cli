import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  WALLET_LIST_KIND,
  compareWalletNamesV1,
  listWalletsV1,
} from "../src/commands/listWallets.js";
import { SEED_FILENAME } from "../src/utils/mnemonic.js";
import { writeWalletType } from "../src/utils/wallets-util.js";

function addWallet(
  dataDir: string,
  name: string,
  network?: "mainnet" | "testnet"
): void {
  const walletDir = join(dataDir, name);
  mkdirSync(walletDir, { recursive: true });
  writeFileSync(join(walletDir, SEED_FILENAME), "{}");
  if (network) writeWalletType(network, walletDir);
}

describe("listWalletsV1", () => {
  it("returns a deterministic, versioned schema with CAIP-2 chain IDs", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kohaku-wallet-list-"));
    try {
      addWallet(dataDir, "sepolia", "testnet");
      addWallet(dataDir, "ethereum", "mainnet");
      addWallet(dataDir, "legacy");

      assert.deepEqual(listWalletsV1(dataDir), {
        kind: WALLET_LIST_KIND,
        version: 1,
        wallets: [
          {
            name: "ethereum",
            network: "mainnet",
            chainId: 1,
            caip2: "eip155:1",
          },
          {
            name: "legacy",
            network: "unknown",
            chainId: null,
            caip2: null,
          },
          {
            name: "sepolia",
            network: "testnet",
            chainId: 11155111,
            caip2: "eip155:11155111",
          },
        ],
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns an empty versioned document when the data directory is absent", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kohaku-wallet-list-"));
    rmSync(dataDir, { recursive: true, force: true });
    assert.deepEqual(
      listWalletsV1(dataDir),
      {
        kind: WALLET_LIST_KIND,
        version: 1,
        wallets: [],
      }
    );
  });

  it("orders case variants without depending on the host locale", () => {
    assert.deepEqual(
      ["alpha", "Alpha", "ALPHA", "beta"].sort(compareWalletNamesV1),
      ["ALPHA", "Alpha", "alpha", "beta"]
    );
  });
});
