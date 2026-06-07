import React from "react";

import { BalancesProvider } from "./context/BalancesContext.js";
import { FocusProvider } from "./context/FocusContext.js";
import { SessionUiProvider } from "./context/SessionUiContext.js";
import type { TuiSession } from "./session.js";

export function SessionShell({
  session,
  onSwitchWallet,
  onQuit,
  children,
}: {
  session: TuiSession;
  onSwitchWallet: () => void;
  onQuit: () => void;
  children: React.ReactNode;
}) {
  const networkLabel =
    session.chainId === 11155111n
      ? "Sepolia"
      : session.chainId === 1n
        ? "Mainnet"
        : `Chain ${session.chainId}`;

  return (
    <BalancesProvider session={session}>
      <SessionUiProvider
        walletName={session.walletName}
        networkLabel={networkLabel}
        onSwitchWallet={onSwitchWallet}
        onQuit={onQuit}
      >
        <FocusProvider>{children}</FocusProvider>
      </SessionUiProvider>
    </BalancesProvider>
  );
}
