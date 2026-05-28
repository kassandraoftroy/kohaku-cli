import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { join } from "node:path";

import PageLayout from "../widgets/PageLayout.js";
import { SelectList } from "../components/SelectList.js";
import { TextPrompt } from "../components/TextPrompt.js";
import {
  listWalletDirNames,
  walletNetworkKind,
} from "../../utils/wallets-util.js";
import { readSeedKeystore } from "../../utils/mnemonic.js";
import { resolveWalletDir } from "../../utils/wallets-util.js";
import { makeEthersProvider } from "../../utils/rpc.js";

const CREAM = "#f5efe0";

export function WalletPickScreen({
  dataDir,
  initialWallet,
  onDone,
  onQuit,
}: {
  dataDir: string;
  initialWallet?: string;
  onDone: (wallet: string) => void;
  onQuit: () => void;
}) {
  const names = listWalletDirNames(dataDir);

  useEffect(() => {
    if (initialWallet?.trim()) onDone(initialWallet.trim());
  }, [initialWallet, onDone]);

  if (initialWallet?.trim()) return null;

  if (names.length === 0) {
    return (
      <PageLayout title="Kohaku TUI" subtitle="no wallets">
        <Text color="#c92a2a">No wallets in {dataDir}. Run: kohaku create-wallet</Text>
      </PageLayout>
    );
  }
  useEffect(() => {
    if (!initialWallet?.trim() && names.length === 1) onDone(names[0]!);
  }, [initialWallet, names, onDone]);

  if (!initialWallet?.trim() && names.length === 1) return null;

  const items = names.map((name) => {
    const kind = walletNetworkKind(join(dataDir, name));
    return {
      label: `${name} (${kind})`,
      value: name,
    };
  });

  return (
    <PageLayout title="Kohaku TUI" subtitle="pick wallet">
      <SelectList items={items} onSelect={onDone} onCancel={onQuit} />
    </PageLayout>
  );
}

export function RpcScreen({
  initialRpc,
  onDone,
  onBack,
}: {
  initialRpc?: string;
  onDone: (rpc: string) => void;
  onBack: () => void;
}) {
  const [value, setValue] = useState(initialRpc ?? process.env.RPC_URL?.trim() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useInput((_, key) => {
    if (key.escape && !checking) onBack();
  });

  async function submit() {
    const url = value.trim();
    if (!url) {
      setError("RPC URL is required (or set RPC_URL).");
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const rpc = await makeEthersProvider(url);
      await rpc.getNetwork();
      rpc.destroy();
      onDone(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (initialRpc?.trim()) onDone(initialRpc.trim());
  }, [initialRpc, onDone]);

  if (initialRpc?.trim()) return null;

  return (
    <PageLayout title="Kohaku TUI" subtitle="RPC endpoint">
      <TextPrompt
        label="RPC URL (HTTP/S):"
        value={value}
        onChange={setValue}
        onSubmit={() => void submit()}
        placeholder="https://..."
      />
      {checking ? <Text color={CREAM}>Checking RPC…</Text> : null}
      {error ? <Text color="#c92a2a">{error}</Text> : null}
    </PageLayout>
  );
}

export function PasswordScreen({
  walletDir,
  initialPassword,
  onDone,
  onBack,
}: {
  walletDir: string;
  initialPassword?: string;
  onDone: (password: string) => void;
  onBack: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((_, key) => {
    if (key.escape) onBack();
  });

  function submit() {
    const pw = value.trim();
    if (!pw) {
      setError("Password cannot be empty.");
      return;
    }
    try {
      readSeedKeystore(pw, walletDir);
      onDone(pw);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid password.");
    }
  }

  useEffect(() => {
    const raw = initialPassword?.trim();
    if (!raw) return;
    try {
      readSeedKeystore(raw, walletDir);
      onDone(raw);
    } catch {
      // fall through to prompt
    }
  }, [initialPassword, walletDir, onDone]);

  if (initialPassword?.trim()) {
    try {
      readSeedKeystore(initialPassword.trim(), walletDir);
      return null;
    } catch {
      // show prompt
    }
  }

  return (
    <PageLayout title="Kohaku TUI" subtitle="unlock wallet">
      <TextPrompt
        label="Wallet password:"
        value={value}
        onChange={setValue}
        onSubmit={submit}
        mask="*"
      />
      {error ? <Text color="#c92a2a">{error}</Text> : null}
    </PageLayout>
  );
}

export function BootScreen({ message }: { message: string }) {
  return (
    <PageLayout title="Kohaku TUI" subtitle="starting">
      <Box>
        <Text color={CREAM}>{message}</Text>
      </Box>
    </PageLayout>
  );
}
