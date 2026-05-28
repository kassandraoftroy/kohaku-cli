import React from "react";
import { Text } from "ink";

import PageLayout from "../widgets/PageLayout.js";
import { SelectList } from "../components/SelectList.js";
import type { TuiSession } from "../session.js";

export type MainMenuAction =
  | "balances"
  | "balances-verbose"
  | "shield"
  | "unshield"
  | "quit";

export function MainMenuScreen({
  session,
  onAction,
}: {
  session: TuiSession;
  onAction: (action: MainMenuAction) => void;
}) {
  const items = [
    { label: "Balances (summary)", value: "balances" as const },
    { label: "Balances (verbose — per address + notes)", value: "balances-verbose" as const },
    { label: "Shield (public → private)", value: "shield" as const },
    { label: "Unshield (private → public)", value: "unshield" as const },
    { label: "Quit", value: "quit" as const },
  ];

  return (
    <PageLayout
      title="Kohaku"
      subtitle={`${session.walletName} · chain ${session.chainId.toString()}`}
      koiSize="compact"
    >
      <Text dimColor>
        RPC {session.rpcUrl.length > 48 ? `${session.rpcUrl.slice(0, 44)}…` : session.rpcUrl}
      </Text>
      <SelectList
        items={items}
        onSelect={(v) => onAction(v)}
        onCancel={() => onAction("quit")}
      />
    </PageLayout>
  );
}
