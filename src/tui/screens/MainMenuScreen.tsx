import React from "react";
import { Text } from "ink";

import PageLayout from "../widgets/PageLayout.js";
import { SelectList } from "../components/SelectList.js";
import type { TuiSession } from "../session.js";

export type MainMenuAction = "balances" | "shield" | "unshield" | "quit";

function shortenRpc(url: string, max = 52): string {
  if (url.length <= max) return url;
  const head = Math.floor((max - 1) * 0.55);
  const tail = max - 1 - head;
  return `${url.slice(0, head)}…${url.slice(-tail)}`;
}

export function MainMenuScreen({
  session,
  onAction,
}: {
  session: TuiSession;
  onAction: (action: MainMenuAction) => void;
}) {
  const network =
    session.chainId === 11155111n ? "Sepolia" : session.chainId === 1n ? "mainnet" : `chain ${session.chainId}`;

  const items = [
    { label: "Balances", value: "balances" as const },
    { label: "Shield", value: "shield" as const },
    { label: "Unshield", value: "unshield" as const },
    { label: "Quit", value: "quit" as const },
  ];

  return (
    <PageLayout
      title="Kohaku"
      subtitle={`${session.walletName} · ${network}`}
      koiSize="tiny"
      animateKoi={false}
    >
      <Text dimColor>RPC {shortenRpc(session.rpcUrl)}</Text>
      <SelectList
        items={items}
        onSelect={(v) => onAction(v)}
        onCancel={() => onAction("quit")}
      />
    </PageLayout>
  );
}
