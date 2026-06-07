import React from "react";

import PageLayout from "../widgets/PageLayout.js";
import { SelectList } from "../components/SelectList.js";
import type { TuiSession } from "../session.js";

export type MainMenuAction = "shield" | "unshield" | "change-rpc";

export function MainMenuScreen({
  session,
  onAction,
}: {
  session: TuiSession;
  onAction: (action: MainMenuAction) => void;
}) {
  const network =
    session.chainId === 11155111n
      ? "Sepolia"
      : session.chainId === 1n
        ? "mainnet"
        : `chain ${session.chainId}`;

  const items = [
    { label: "Shield", value: "shield" as const },
    { label: "Unshield", value: "unshield" as const },
    { label: "Change RPC", value: "change-rpc" as const },
  ];

  return (
    <PageLayout
      title="Kohaku"
      subtitle={`${network}`}
      koiSize="tiny"
      animateKoi={false}
    >
      <SelectList items={items} onSelect={(v) => onAction(v)} />
    </PageLayout>
  );
}
