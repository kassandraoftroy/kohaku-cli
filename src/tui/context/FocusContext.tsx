import React, { createContext, useContext, useState } from "react";
import { useInput } from "ink";

export type FocusPane = "koi" | "main" | "balances";

const PANES: FocusPane[] = ["koi", "main", "balances"];

type FocusContextValue = {
  focusPane: FocusPane;
  focusKoi: boolean;
  focusMain: boolean;
  focusBalances: boolean;
};

const defaultValue: FocusContextValue = {
  focusPane: "main",
  focusKoi: false,
  focusMain: true,
  focusBalances: false,
};

const FocusContext = createContext<FocusContextValue>(defaultValue);

export function FocusProvider({ children }: { children: React.ReactNode }) {
  const [focusPane, setFocusPane] = useState<FocusPane>("main");

  useInput((_, key) => {
    const idx = PANES.indexOf(focusPane);
    if (key.leftArrow) {
      setFocusPane(PANES[(idx - 1 + PANES.length) % PANES.length]!);
    }
    if (key.rightArrow) {
      setFocusPane(PANES[(idx + 1) % PANES.length]!);
    }
  });

  return (
    <FocusContext.Provider
      value={{
        focusPane,
        focusKoi: focusPane === "koi",
        focusMain: focusPane === "main",
        focusBalances: focusPane === "balances",
      }}
    >
      {children}
    </FocusContext.Provider>
  );
}

export function useFocus(): FocusContextValue {
  return useContext(FocusContext);
}
