import React, { createContext, useContext } from "react";

type SessionUiContextValue = {
  walletName: string;
  networkLabel: string;
  onSwitchWallet: () => void;
  onQuit: () => void;
};

const SessionUiContext = createContext<SessionUiContextValue | null>(null);

export function SessionUiProvider({
  walletName,
  networkLabel,
  onSwitchWallet,
  onQuit,
  children,
}: SessionUiContextValue & { children: React.ReactNode }) {
  return (
    <SessionUiContext.Provider
      value={{ walletName, networkLabel, onSwitchWallet, onQuit }}
    >
      {children}
    </SessionUiContext.Provider>
  );
}

export function useSessionUi(): SessionUiContextValue | null {
  return useContext(SessionUiContext);
}
