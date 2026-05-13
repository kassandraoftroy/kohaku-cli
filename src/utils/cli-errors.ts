import { log } from "@clack/prompts";
import chalk from "chalk";

/**
 * Standard CLI failure: red ✖ line via clack, `process.exitCode = 1`.
 * Pass the message without a leading `✖` (it is added unless already present).
 */
export function cliError(message: string): void {
  const m = message.trimStart();
  const line = m.startsWith("✖") ? m : `✖ ${m}`;
  log.error(chalk.red(line));
  process.exitCode = 1;
}

export function cliErrorFromCaught(e: unknown): void {
  if (e instanceof Error) {
    cliError(e.message);
  } else if (typeof e === "object" && e !== null) {
    try {
      cliError(JSON.stringify(e, null, 2));
    } catch {
      cliError(String(e));
    }
  } else {
    cliError(String(e));
  }
}
