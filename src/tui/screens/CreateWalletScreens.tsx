import React, { useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { existsSync } from "node:fs";

import PageLayout from "../widgets/PageLayout.js";
import { SelectList } from "../components/SelectList.js";
import { TextPrompt } from "../components/TextPrompt.js";
import {
  createWalletOnDisk,
  generateMnemonic,
} from "../../lib/create-wallet.js";
import { normalizeValidatedMnemonic } from "../../utils/mnemonic.js";
import { resolveWalletDir } from "../../utils/wallets-util.js";
import { makeEthersProvider } from "../../utils/rpc.js";

const CREAM = "#f5efe0";
const WARN = "#ffb000";

export type CreateWalletResult = {
  walletName: string;
  password: string;
};

type Mode = "generate" | "import";

type Step =
  | "name"
  | "network"
  | "mnemonic-show"
  | "mnemonic-import"
  | "password"
  | "password-confirm"
  | "creating"
  | "done"
  | "error";

export function CreateWalletWizard({
  dataDir,
  mode,
  rpcUrl,
  onDone,
  onBack,
}: {
  dataDir: string;
  mode: Mode;
  rpcUrl?: string;
  onDone: (result: CreateWalletResult) => void;
  onBack: () => void;
}) {
  const [step, setStep] = useState<Step>("name");
  const [walletName, setWalletName] = useState("");
  const [testnet, setTestnet] = useState(false);
  const [mnemonic, setMnemonic] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((_, key) => {
    if (key.escape && step !== "creating") onBack();
  });

  function submitName() {
    const name = nameInput.trim();
    if (!name) {
      setError("Wallet name is required.");
      return;
    }
    try {
      const dir = resolveWalletDir(dataDir, name);
      if (existsSync(dir)) {
        setError(`Wallet "${name}" already exists.`);
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setError(null);
    setWalletName(name);
    setStep("network");
  }

  function pickNetwork(isTestnet: boolean) {
    setTestnet(isTestnet);
    if (mode === "generate") {
      const phrase = generateMnemonic();
      setMnemonic(phrase);
      setStep("mnemonic-show");
    } else {
      setStep("mnemonic-import");
    }
  }

  function submitMnemonicImport() {
    try {
      const phrase = normalizeValidatedMnemonic(mnemonicInput);
      setMnemonic(phrase);
      setError(null);
      if (!rpcUrl?.trim()) {
        setError("RPC URL is required when importing (set RPC_URL or enter RPC first).");
        return;
      }
      setStep("password");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid mnemonic.");
    }
  }

  function submitPassword() {
    const pw = password.trim();
    if (!pw) {
      setError("Password cannot be empty.");
      return;
    }
    setError(null);
    setPassword(pw);
    setStep("password-confirm");
  }

  function submitPasswordConfirm() {
    if (passwordConfirm.trim() !== password) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    void createWallet();
  }

  async function createWallet() {
    setStep("creating");
    try {
      if (mode === "import") {
        if (!rpcUrl?.trim()) {
          throw new Error("RPC URL is required when importing a wallet.");
        }
        const rpc = await makeEthersProvider(rpcUrl);
        await rpc.getNetwork();
        rpc.destroy();
      }
      await createWalletOnDisk({
        dataDir,
        walletName,
        mnemonic,
        password,
        testnet,
        rpcUrl: mode === "import" ? rpcUrl : undefined,
      });
      setStep("done");
      onDone({ walletName, password });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("error");
    }
  }

  if (step === "name") {
    return (
      <PageLayout title="New wallet" subtitle="name">
        <TextPrompt
          label="Wallet name (letters, digits, . _ -):"
          value={nameInput}
          onChange={setNameInput}
          onSubmit={submitName}
          placeholder="my-wallet"
        />
        {error ? <Text color="#c92a2a">{error}</Text> : null}
      </PageLayout>
    );
  }

  if (step === "network") {
    return (
      <PageLayout title="New wallet" subtitle="network">
        <Text dimColor>RPC chain must match this choice later.</Text>
        <SelectList
          items={[
            { label: "Mainnet (chain 1)", value: false },
            { label: "Sepolia testnet (11155111)", value: true },
          ]}
          onSelect={pickNetwork}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  if (step === "mnemonic-show") {
    return (
      <PageLayout title="New wallet" subtitle="seed phrase">
        <Text color={WARN} bold>
          Write these words down offline. Anyone with them can take your funds.
        </Text>
        <Box marginY={1} borderStyle="round" borderColor="#0f2a3f" paddingX={1}>
          <Text color={CREAM} bold>
            {mnemonic}
          </Text>
        </Box>
        <SelectList
          items={[{ label: "I have saved this phrase — continue", value: "ok" }]}
          onSelect={() => setStep("password")}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  if (step === "mnemonic-import") {
    return (
      <PageLayout title="Import wallet" subtitle="mnemonic">
        <Text dimColor>Paste your 12 or 24-word phrase (masked).</Text>
        {!rpcUrl?.trim() ? (
          <Text color={WARN}>
            Set RPC_URL or complete RPC setup before importing (needed to scan used addresses).
          </Text>
        ) : null}
        <TextPrompt
          label="Mnemonic:"
          value={mnemonicInput}
          onChange={setMnemonicInput}
          onSubmit={submitMnemonicImport}
          mask="*"
        />
        {error ? <Text color="#c92a2a">{error}</Text> : null}
      </PageLayout>
    );
  }

  if (step === "password") {
    return (
      <PageLayout title="New wallet" subtitle="encrypt">
        <TextPrompt
          label="Password to encrypt wallet on disk:"
          value={password}
          onChange={setPassword}
          onSubmit={submitPassword}
          mask="*"
        />
        {error ? <Text color="#c92a2a">{error}</Text> : null}
      </PageLayout>
    );
  }

  if (step === "password-confirm") {
    return (
      <PageLayout title="New wallet" subtitle="confirm password">
        <TextPrompt
          label="Confirm password:"
          value={passwordConfirm}
          onChange={setPasswordConfirm}
          onSubmit={submitPasswordConfirm}
          mask="*"
        />
        {error ? <Text color="#c92a2a">{error}</Text> : null}
      </PageLayout>
    );
  }

  if (step === "creating") {
    return (
      <PageLayout title="New wallet" subtitle="saving…">
        <Text color={CREAM}>Encrypting seed and writing wallet…</Text>
      </PageLayout>
    );
  }

  if (step === "error") {
    return (
      <PageLayout title="New wallet" subtitle="error">
        <Text color="#c92a2a">{error}</Text>
        <SelectList
          items={[{ label: "Back", value: "back" }]}
          onSelect={onBack}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  return null;
}
