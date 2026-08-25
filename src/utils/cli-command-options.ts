/**
 * Shared Commander `--help` strings for options repeated across commands.
 * Keeps wording in one place without dictating `.option()` call order.
 */
export const cliOptions = {
  password: "Wallet password (required with --non-interactive; else prompted)",
  rpcUrl: "RPC URL (or set RPC_URL in env; default: http://localhost:8545)",
  dataDir: "Kohaku data directory (default: ~/.kohaku-cli)",
  walletPickList: "Wallet name (omit to choose interactively from the list)",
  walletBalancesOptional:
    "Wallet name (optional without --non-interactive; omit to pick from the list)",
  nonInteractiveShieldLike:
    "Agent mode: JSON where applicable, no confirmations or spinners; requires --password and --wallet",
  nonInteractiveBalances:
    "Agent mode: JSON only, no prompts or spinners; requires --password and --wallet",
  nonInteractiveCompact:
    "Agent mode: no prompts or spinners; requires --password and --wallet",
  nonInteractiveListWallets:
    "Agent mode: print JSON instead of human-readable output (no prompts)",
  withoutTor:
    "Disable Tor for non-RPC HTTP (default: Tor on). RPC stays clearnet. Or set KOHAKU_WITHOUT_TOR=1",
  withoutTorArtifactsFetch:
    "Download proving artifacts over clearnet (default: Tor). Reveals that this IP fetched kohaku circuits; later shield/unshield stay Tor-only from the local cache. Or set KOHAKU_WITHOUT_TOR=1",
  withoutTorSyncCacheFetch:
    "Download snapshot chunks over clearnet (default: Tor). Much faster, and reveals only that this IP fetched public Railgun/Tornado pool data. Or set KOHAKU_WITHOUT_TOR=1",
  stealthStartBlock:
    "Start ERC-5564 announcement scan at this block (decimal or 0x-hex); skips older history on first/full scan. Does not skip the scan itself (use --skip-stealth-scan). balances also reads `.stealth-start-block` from the wallet when this flag is omitted",
} as const;
