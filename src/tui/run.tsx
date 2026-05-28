import React from "react";
import { render } from "ink";

import App, { type TuiLaunchOptions } from "./App.js";

export async function runTui(options: TuiLaunchOptions = {}): Promise<void> {
  const { waitUntilExit } = render(<App options={options} />);
  await waitUntilExit();
}
