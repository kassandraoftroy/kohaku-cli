import React, { useEffect } from "react";
import { Text } from "ink";
import { join } from "node:path";

import PageLayout from "../widgets/PageLayout.js";
import { SelectList } from "../components/SelectList.js";
import {
  listWalletDirNames,
  walletNetworkKind,
} from "../../utils/wallets-util.js";

export type WalletStartChoice =
  | { kind: "unlock"; walletName: string }
  | { kind: "generate" }
  | { kind: "import" };

export function WalletStartScreen({
  dataDir,
  initialWallet,
  onChoose,
  onQuit,
}: {
  dataDir: string;
  initialWallet?: string;
  onChoose: (choice: WalletStartChoice) => void;
  onQuit: () => void;
}) {
  const names = listWalletDirNames(dataDir);

  useEffect(() => {
    if (initialWallet?.trim()) {
      onChoose({ kind: "unlock", walletName: initialWallet.trim() });
    }
  }, [initialWallet, onChoose]);

  if (initialWallet?.trim()) return null;

  const items: Array<{ label: string; value: WalletStartChoice }> = [];

  if (names.length > 0) {
    for (const name of names) {
      const kind = walletNetworkKind(join(dataDir, name));
      items.push({
        label: `Unlock: ${name} (${kind})`,
        value: { kind: "unlock", walletName: name },
      });
    }
  }

  items.push(
    { label: "Generate new wallet (new seed phrase)", value: { kind: "generate" } },
    { label: "Import existing mnemonic", value: { kind: "import" } }
  );

  return (
    <PageLayout title="Kohaku TUI" subtitle="wallet">
      {names.length === 0 ? (
        <Text dimColor>No wallets yet — create or import one below.</Text>
      ) : (
        <Text dimColor>Unlock a saved wallet, or create / import.</Text>
      )}
      <SelectList items={items} onSelect={onChoose} onCancel={onQuit} />
    </PageLayout>
  );
}
