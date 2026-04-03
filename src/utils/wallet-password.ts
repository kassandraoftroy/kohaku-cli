import { log } from "@clack/prompts";
import { password } from "@inquirer/prompts";
import chalk from "chalk";

/**
 * Resolves wallet unlock password: use --password when set, else prompt (interactive)
 * or error when --non-interactive and flag is missing.
 */
export async function resolveWalletPassword(opts: {
  flagPassword?: string | undefined;
  nonInteractive?: boolean | undefined;
}): Promise<string | null> {
  const fromFlag = opts.flagPassword?.trim();
  if (fromFlag) {
    return fromFlag;
  }
  if (opts.nonInteractive) {
    log.error(chalk.red("✖ --password is required when using --non-interactive."));
    return null;
  }
  for (;;) {
    const pw = await password({
      message: "Wallet password:",
      mask: "*",
    });
    if (pw?.trim()) {
      return pw.trim();
    }
    log.warn("Password cannot be empty.");
  }
}
