import React from "react";
import { render } from "ink";

import App, { type TuiLaunchOptions } from "./App.js";
import { disposeAllRailgunSessions } from "../lib/railgun-session.js";
import TerminalShell, { enterTuiTerminal, leaveTuiTerminal } from "./TerminalShell.js";

export async function runTui(options: TuiLaunchOptions = {}): Promise<void> {
  enterTuiTerminal();
  try {
    const { waitUntilExit } = render(
      <TerminalShell>
        <App options={options} />
      </TerminalShell>,
      { patchConsole: true, exitOnCtrlC: true }
    );
    await waitUntilExit();
  } finally {
    disposeAllRailgunSessions();
    leaveTuiTerminal();
  }
}
