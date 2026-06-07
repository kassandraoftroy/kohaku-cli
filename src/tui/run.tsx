import React from "react";
import { render } from "ink";

import App, { type TuiLaunchOptions } from "./App.js";
import { clearTuiExit, registerTuiExit } from "./exit.js";
import { disposeAllRailgunSessions } from "../lib/railgun-session.js";
import TerminalShell, { enterTuiTerminal, leaveTuiTerminal } from "./TerminalShell.js";

export async function runTui(options: TuiLaunchOptions = {}): Promise<void> {
  enterTuiTerminal();

  const restoreTerminalOnExit = () => leaveTuiTerminal();
  process.on("exit", restoreTerminalOnExit);

  try {
    const instance = render(
      <TerminalShell>
        <App options={options} />
      </TerminalShell>,
      { patchConsole: true, exitOnCtrlC: true }
    );

    registerTuiExit(() => instance.unmount());

    // Ensure first frame paints on the alternate screen without waiting for user input.
    setImmediate(() => {
      if (process.stdout.isTTY) {
        process.stdout.emit("resize");
      } else {
        instance.rerender(
          <TerminalShell>
            <App options={options} />
          </TerminalShell>
        );
      }
    });

    await instance.waitUntilExit();
  } finally {
    process.off("exit", restoreTerminalOnExit);
    clearTuiExit();
    disposeAllRailgunSessions();
    leaveTuiTerminal();
  }
}
