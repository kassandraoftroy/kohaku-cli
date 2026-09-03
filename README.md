# kohaku-cli

> [!IMPORTANT]
> NOTICE: this CLI has **NOT BEEN AUDITED** and **IS UNDER ACTIVE DEVELOPMENT** and **HAS BEEN WRITTEN WITH HELP FROM CLAUDE** et al. **DO NOT USE ON MAINNET** unless you know **EXACTLY WHAT YOU ARE DOING** and understand **YOU RISK CATASTROPHIC LOSS OF FUNDS**.

A command line interface wallet for moving funds between **public** Ethereum accounts (derived from your seed) and **private** balances on Tornado Cash, Railgun and Privacy Pools (V1) -- whose credentials also conveniently live on the wallet seed phrase. It also covers **ENS / GNS / WNS** names, **EIP-5564 stealth address** "profile" concept, and Tornado note import/export. The CLI encrypts your seed on disk, walks you through shield / unshield with prompts, and can run headlessly with `--non-interactive` for scripts and agents.

**Requirements:** Node.js 22+, an Ethereum RPC URL (`RPC_URL` or `--rpc-url`).

See [Kohaku CLI Wiki](https://kohaku.gwei.domains) for a practical guide to using kohaku-cli as a wallet solution "in real life"

See README below for quick testnet demo and other technical details.

```bash
npm install
npm run build
# or during development:
npm run dev:prod -- <command> ...
```

After build, run via the bin launcher (registers an ESM resolve hook, then loads `dist/`):

```bash
npm start -- --version
# or link onto PATH (point at bin/, not dist/):
#   ln -sf "$(pwd)/bin/kohaku.mjs" ~/.local/bin/kohaku
```

Examples below use `kohaku`; swap in `npm run dev:prod --` if you have not built yet.

Set your RPC once per shell (Sepolia for `--testnet` wallets):

```bash
export RPC_URL="https://sepolia.infura.io/v3/YOUR_KEY"
```

Optionally set a default privacy protocol so `shield` / `unshield` can omit `--protocol`, and so `balances` includes that protocol’s private balances by default:

```bash
export DEFAULT_PRIVACY_PROTOCOL=tornado   # or railgun | privacy-pools
```

If unset (or set to anything else), `--protocol` is required on shield/unshield, and `balances` shows **public** balances only unless you pass `--include`.

Some commands sync private state by calling `eth_getLogs` in chunks (default: up to **499** blocks per request). If your provider rejects large log ranges or times out, lower the chunk size:

```bash
export KOHAKU_GETLOGS_MAX_BLOCK_SPAN=100
```

Use any positive integer; smaller values mean more RPC calls but fewer failures on strict nodes.

Wallet data lives in `~/.kohaku-cli` by default (`--dataDir` to override).

---

## Getting started

This walkthrough creates a testnet wallet, funds a fresh public address, shields 0.1 ETH with Tornado Cash, checks balances, then unshields that note to a **new** public address.

### 1. Create wallets

**New seed (CLI generates and shows the mnemonic once):**

```bash
kohaku create-wallet testWallet --testnet
```

You will be asked for an encryption password twice. Copy the mnemonic from the boxed output and store it offline; it is not shown again.

**Import an existing seed (scans RPC for used addresses and resumes account index):**

```bash
kohaku create-wallet importTest --testnet --import
```

Paste your 12- or 24-word phrase when prompted (masked). `--rpc-url` or `RPC_URL` is required for import so the CLI can detect which derived addresses already have activity.

### 2. See what you have

```bash
kohaku balances --include tornado
```

Pick `testWallet` if you have more than one wallet, enter the wallet password, then wait for the spinner. You should see **Public** totals (ETH + common ERC-20s on Sepolia) and Tornado private balances (`--include` selects which private protocols to sync; without it, only `DEFAULT_PRIVACY_PROTOCOL` is included, or none if that env is unset).

To pin the wallet and get per-address detail:

```bash
kohaku balances --wallet testWallet --include tornado --verbose
```

### 3. Get a deposit address

```bash
kohaku next-fresh-address --wallet testWallet
```

The command prints a single `0x…` address and saves it as the next public account in your wallet. Send **Sepolia ETH** (and optionally test ERC-20s) to that address from a faucet or another wallet. Run `balances` again until public ETH shows up.

### 4. Shield with Tornado Cash (ETH)

Dry run first (prints transaction JSON, does not send):

```bash
kohaku shield --protocol tornado --wallet testWallet --amount-formatted 0.1
```

Choose a public account that has enough balance and review the planned transaction. Add `--broadcast` when you are ready to sign and submit on-chain:

```bash
kohaku shield --protocol tornado --wallet testWallet --amount-formatted 0.1 --broadcast
```

Tornado shields must be exact multiples of 0.1 ETH. Confirm the shield transaction when asked; spinners show mining status.

Check balances again — public ETH should drop and the Tornado private balance should show a 0.1 ETH note:

```bash
kohaku balances --wallet testWallet --include tornado
```

### 5. Unshield to a fresh public address

Withdraw the private note back to the public chain. The dry run builds the private operation JSON:

```bash
kohaku unshield --protocol tornado --wallet testWallet --next --amount-formatted 0.1
```

`--next` selects a fresh public account from this wallet, which can sign the EIP-7702 delegation required by Tornado. Add `--broadcast` to submit through the paymaster:

```bash
kohaku unshield --protocol tornado --wallet testWallet --next --amount-formatted 0.1 --broadcast
```

Confirm the broadcast prompt (amount + recipient). The CLI syncs private state, prepares the proof, and submits the UserOperation. One Tornado unshield can spend multiple notes in a single paymaster UserOp when the amount needs more than one denomination.

```bash
kohaku balances --wallet testWallet --include tornado
```

You should see the Tornado private balance decrease and the fresh public account receive the unshielded ETH minus the paymaster fee.

---

## Commands list

Global behavior:

| Topic | Detail |
|--------|--------|
| **RPC** | `--rpc-url <url>` or env `RPC_URL` (required for most commands except `create-wallet` without `--import`, and `list-wallets`). |
| **Default privacy protocol** | Env `DEFAULT_PRIVACY_PROTOCOL` (`tornado` \| `railgun` \| `privacy-pools`). When set, `shield` / `unshield` may omit `--protocol`, and `balances` includes that protocol by default. Examples below still pass `--protocol` / `--include` explicitly. |
| **Data directory** | `--dataDir <path>` (default `~/.kohaku-cli`). |
| **Networks** | Wallets created with `--testnet` expect Sepolia (`11155111`); otherwise mainnet (`1`). RPC chain ID must match the wallet. |
| **`--non-interactive`** | Available on every command below. Skips prompts and spinners; prints **JSON** where applicable. Requires flags documented per command (`--password-file` or `--password`, `--wallet`, amounts, `--from`, `--to` / `--next`, etc.). Use for CI, agents, and piping output. |
| **`--password-file <path>`** | Preferred for automation on POSIX. Reads the wallet password from a regular, non-symlink file, so the password is not exposed in process arguments. The file must be owned by the current user with mode `0400` or `0600`. Secure file inputs fail closed on Windows because ACLs are not validated. Mutually exclusive with `--password`. |
| **`--password <password>`** | Legacy wallet unlock input. A literal string or existing file path is accepted for compatibility; prefer the unambiguous `--password-file` form in scripts. |
| **`--without-tor`** | Disable Tor for non-RPC HTTP (default: Tor on for private-protocol and Pimlico-backed commands, including `transfer` / `transact-raw` / names). Or set `KOHAKU_WITHOUT_TOR=1`. Ethereum RPC stays clearnet. Review contacts with `view-network-traffic`. |
| **Proving artifacts** | Railgun/Tornado keys live under `<dataDir>/proving-artifacts`. Pre-warm with `fetch-artifacts`. Remote base: `KOHAKU_ARTIFACTS_BASE_URL` (default `https://artifacts.0000000000.org`). Large Tor GETs: `KOHAKU_TOR_CDN_TIMEOUT_MS` (default `45000`). Debug: `KOHAKU_TOR_DEBUG=1`. |
| **Public-sync cache** | Shared **Railgun Subsquid** and **Tornado saga** HTTP pages live under `<dataDir>/public-sync-cache` and speed up those syncs (`balances`, `shield`, `unshield`). Prefetch with `fetch-sync-cache`. Snapshot base: `KOHAKU_SYNC_CACHE_BASE_URL` (default `https://artifacts.0000000000.org/sync-cache/v1`). Snapshot is historical; live HTTP still fills anything newer. Never evicts — at `KOHAKU_PUBLIC_SYNC_CACHE_MAX_BYTES` (default 1 GiB) new pages stop being stored instead. Privacy Pools is **not** covered (its cold sync is bundled state JSON plus `eth_getLogs`, which is never HTTP-cached). Wipe with `kohaku clear-tor-cache --public-sync`. |

`--password-file` removes one trailing line ending and otherwise preserves password whitespace. When unlocking an existing wallet, it also retries the fully trimmed value for compatibility with the legacy `--password <existing-file>` behavior. New wallets created with `--password-file` use the preserved value exactly.

---

### `create-wallet <name>`

Create a BIP-39 seed wallet encrypted on disk. The `<name>` argument is a single token (no spaces) and cannot be `proving-artifacts` or `public-sync-cache` (those are cache directories under `--dataDir`).

**New seed:** records the current chain tip in `.stealth-start-block` so later `balances` stealth scans do not walk announcement history from before the wallet existed. Uses `--rpc-url` / `RPC_URL` when set; otherwise a public RPC for mainnet or Sepolia (`--testnet`).

**Import (`--import`):** scans used public HD indexes via RPC. Writes the current chain tip to `.stealth-start-block` (same as a new seed) so the first `balances` stealth scan does not walk historical announcements. Pass `--stealth-start-block` with no value to opt into the Kohaku-schema floor (mainnet `25700000`, Sepolia `11455454`), or `--stealth-start-block <block>` for an explicit floor (values below the ERC-5564 announcer deploy are rounded up to that block). Later, `balances --stealth-start-block` can still back-date below whatever was written at import.

| Option | Description |
|--------|-------------|
| `--testnet` | Tag wallet for Sepolia instead of mainnet. |
| `--import` | Restore from mnemonic instead of generating a new one. |
| `--long-seed` | Generate a 24-word (256-bit) mnemonic instead of the default 12-word (128-bit). Ignored with `--import`. |
| `--rpc-url <url>` | Required with `--import` (or `RPC_URL`) to scan used addresses. Optional for new wallets when writing `.stealth-start-block`. |
| `--stealth-start-block [block]` | With `--import`: write `.stealth-start-block`. Omit the flag to record the current tip (same as a new wallet). Bare flag: Kohaku floor (mainnet `25700000`, Sepolia `11455454`). With a number: that block, rounded up to the ERC-5564 announcer deploy if lower. |
| `--mnemonic <phrase>` | Mnemonic (required with `--non-interactive --import`). |
| `--mnemonic-file <path>` | Preferred POSIX import input for automation. Reads the mnemonic from an owner-only regular file without following symlinks; fails closed on Windows. Mutually exclusive with `--mnemonic`. |
| `--password <password>` | Encryption password required with `--non-interactive`. As before, interactive creation prompts instead of consuming this legacy flag. |
| `--password-file <path>` | Preferred POSIX automation input; see global behavior above. Mutually exclusive with `--password`. |
| `--non-interactive` | No prompts; no mnemonic box on create. |
| `--dataDir <path>` | Data root. |

**Interactive:** encryption password (twice); for `--import`, masked mnemonic entry. New wallets display the mnemonic once in a warning box.

**Examples:**

```bash
kohaku create-wallet myWallet --testnet
kohaku create-wallet myWallet24 --testnet --long-seed
kohaku create-wallet restored --testnet --import --rpc-url "$RPC_URL"
kohaku create-wallet restored --testnet --import --rpc-url "$RPC_URL" --stealth-start-block
kohaku create-wallet restored --testnet --import --rpc-url "$RPC_URL" --stealth-start-block 10000000
chmod 600 ./wallet-password ./wallet-mnemonic
kohaku create-wallet restored-safe --testnet --import --rpc-url "$RPC_URL" --password-file ./wallet-password --mnemonic-file ./wallet-mnemonic --non-interactive
```

---

### `list-wallets`

List wallet names and network kind (mainnet / testnet).

| Option | Description |
|--------|-------------|
| `--non-interactive` | Output `{"wallets":{"name":{"mainnet":true|false|null}}}` |
| `--dataDir <path>` | Data root. |

---

### `next-fresh-address`

Derive the next HD public account and print its address. By default the account is also persisted; use `--peek` to inspect it without writing.

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet (prompt if omitted). |
| `--password <password>` | Unlock password. |
| `--peek` | Print the next fresh address without persisting it (e.g. to craft `--tail-calls` before `unshield --next`). |
| `--non-interactive` | Requires `--wallet` and `--password`; prints address only. |
| `--dataDir <path>` | Data root. |

**Interactive:** wallet picker (if needed), wallet password.

**Examples:**

```bash
kohaku next-fresh-address --wallet testWallet
kohaku next-fresh-address --wallet testWallet --peek
kohaku next-fresh-address --wallet testWallet --password "$WALLET_PW" --non-interactive
```

---

### `init-profile`

Publish EIP-5564 stealth viewing/spending keys on the ERC-6538 registry for an HD account. Optionally register (or reuse) a `.eth` / `.gwei` / `.wei` name and set `stealth-address-scheme-1` on it. With a name: commit → wait 60s → one EIP-7702 UserOp for reveal/register + reverse + text + `registerKeys`. With `--no-name`: a single EOA `registerKeys` transaction (no 7702). Creates public account index 0 if missing.

Provide exactly one of `--name` or `--no-name`.

| Option | Description |
|--------|-------------|
| `--name <label-or-name>` | Bare label or full name (`alice` / `alice.gwei`). Existing owned names are reused. |
| `--no-name` | Skip name registration; only register stealth keys for `--index` on ERC-6538. |
| `--protocol <ens\|gns\|wns>` | Required when `--name` is a bare label (no TLD). |
| `--index <n>` | HD account that owns/registers the name and registry entry (default: `0`). |
| `--years <n>` | Registration duration when registering a **new** ENS name (default: `1`). GNS/WNS are always 1 year. |
| `--wallet <name>` | Wallet. |
| `--password <password>` | Unlock password. |
| `--rpc-url <url>` | RPC endpoint. |
| `--broadcast` | Sign and submit on-chain. Omit to simulate / print payloads. |
| `--owner-priv` | Derive `--index` from the seed when that account is not yet in public accounts. |
| `--without-tor` | Disable Tor for non-RPC HTTP (Pimlico when using EIP-7702, etc.). RPC stays clearnet. Or set `KOHAKU_WITHOUT_TOR=1`. |
| `--non-interactive` | JSON where applicable; requires `--wallet` and `--password`. |
| `--dataDir <path>` | Data root. |

**Examples:**

```bash
kohaku init-profile --wallet testWallet --name alice --protocol ens --broadcast
kohaku init-profile --wallet testWallet --name alice.gwei --broadcast
kohaku init-profile --wallet testWallet --no-name --broadcast
```

---

### `export-private-key`

Export the private key for one public account. The key is printed directly to stdout; handle it as sensitive material.

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet (prompt if omitted). |
| `--password <password>` | Unlock password. |
| `--address <address>` | Export a persisted public account by address. |
| `--index <index>` | Export by non-negative HD derivation index, even if the account has not been persisted yet. |
| `--non-interactive` | Skip the reveal confirmation; requires `--wallet` and `--password`. |
| `--dataDir <path>` | Data root. |

Provide exactly one of `--address` or `--index`. Interactive mode confirms before revealing the key.

**Examples:**

```bash
kohaku export-private-key --wallet testWallet --index 0
kohaku export-private-key --wallet testWallet --address 0xYourAddress
```

---

### `reveal-seed-phrase`

Decrypt and print the wallet’s BIP-39 seed phrase. Interactive mode asks you to confirm **twice** before printing (both default to No).

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet (prompt if omitted). |
| `--password <password>` | Unlock password. |
| `--non-interactive` | Skip both reveal confirmations; requires `--wallet` and `--password`. Prints the phrase only (no box). |
| `--dataDir <path>` | Data root. |

**Examples:**

```bash
kohaku reveal-seed-phrase --wallet testWallet
```

---

### `balances`

Show aggregated **public** balances (ETH + default ERC-20s for the chain, plus any private tokens discovered), and **private** balances for the protocols you select. Also prints the wallet **profile** name (reverse-resolved for HD index 0, if any; JSON: `wallet_profile_name`). Use `see-stealth-meta-address` for the stealth meta URI.

By default, private balances are included only for `DEFAULT_PRIVACY_PROTOCOL` (if set). Otherwise only public balances are shown, with a short warning. Pass `--include` to sync one or more protocols explicitly (required for multiple protocols at once, or for any private balance when the env is unset).

`balances` always loads **already-imported** stealth accounts into public totals. It also scans ERC-5564 announcements for new payments (same spinner progress as protocol first-sync). A line of the form `Stealth scan from block {start} · {latest - start} blocks` prints before that progress bar. `--stealth-start-block` sets the history floor (and can back-date below the wallet file, down to the announcer deploy block); use `--skip-stealth-scan` to skip discovery for a faster run.

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet (optional in interactive mode). |
| `--password <password>` | Unlock password. |
| `--rpc-url <url>` | RPC endpoint. |
| `--include <protocols>` | Comma-separated private protocols to sync (`railgun`, `privacy-pools`, `tornado`). Default: `DEFAULT_PRIVACY_PROTOCOL` only, or none if unset. |
| `--verbose` | Human: per-address public breakdown + private note list for included protocols. JSON: adds `public_account_indexes_by_address` and `private_notes`. |
| `--tokensList <addrs>` | Extra ERC-20 addresses (comma- or space-separated), merged with chain defaults. |
| `--without-tor` | Disable Tor for privacy HTTP when syncing private protocols (default: Tor on). Covers Railgun Subsquid/PPOI, Tornado saga/artifacts, Privacy Pools ASP/fastrelay, etc. RPC stays clearnet. Or set `KOHAKU_WITHOUT_TOR=1`. |
| `--stealth-start-block <block>` | Floor for the ERC-5564 announcement **scan** (decimal or `0x`-hex); skips older history on first/full scan. Can back-date below the wallet `.stealth-start-block` (often the creation/import tip; as far as the announcer deploy block). When omitted, uses that file if present, otherwise the Kohaku import default (mainnet `25700000`, Sepolia `11455454`). Not a way to skip scanning. |
| `--skip-stealth-scan` | Skip announcement discovery for this run. **Already-imported** stealth accounts still appear in public balances. |
| `--non-interactive` | JSON only; requires `--wallet` and `--password`. |
| `--dataDir <path>` | Data root. |

**Interactive:** wallet picker, password, loading spinner, formatted tables.

Default Sepolia ERC-20s include USDC, DAI, and WETH; mainnet adds USDC, USDT, DAI, WETH.

**Examples:**

```bash
kohaku balances --wallet testWallet --include tornado
kohaku balances --wallet testWallet --include railgun,tornado --verbose
kohaku balances --wallet testWallet --verbose --include privacy-pools --tokensList 0xYourToken
kohaku balances --wallet testWallet --include tornado --without-tor
kohaku balances --wallet testWallet --skip-stealth-scan
```

---

### `transfer`

Transfer ETH or ERC-20 tokens from one wallet public account to any public address. By default, the command simulates the transfer and prints its transaction payload without submitting it.

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet. |
| `--password <password>` | Unlock password. |
| `--from <address-or-index>` | Sender public account address or HD index. |
| `--from-priv` | With `--broadcast`, derive an indexed sender from the mnemonic if it is not in the stored public account list. |
| `--to <address>` | Recipient address. |
| `--token <address\|symbol\|eth>` | Token address or symbol (default: `eth`). |
| `--amount-wei <n>` | Amount in base units. |
| `--amount-formatted <decimal>` | Human-readable amount using token decimals. |
| `--amount-max` | Send the full ERC-20 balance, or the maximum ETH balance after reserving estimated gas. |
| `--rpc-url <url>` | RPC endpoint. |
| `--broadcast` | Sign and submit on-chain. Omit to simulate and print the transaction payload. |
| `--without-tor` | Disable Tor for non-RPC HTTP (Pimlico UserOps, etc.). RPC stays clearnet. Or set `KOHAKU_WITHOUT_TOR=1`. |
| `--non-interactive` | JSON output; requires `--wallet`, `--password`, `--from`, `--to`, and one amount flag. |
| `--dataDir <path>` | Data root. |

Provide at most one of `--amount-wei`, `--amount-formatted`, or `--amount-max`. In interactive mode, omitted sender, recipient, and amount values are prompted.

**Examples:**

```bash
kohaku transfer --wallet testWallet --from 0 --to 0xRecipient --amount-formatted 0.01
kohaku transfer --wallet testWallet --from 0 --to 0xRecipient --token USDC --amount-max --broadcast
```

---

### `transact-raw`

Simulate or submit one or more raw contract calls from a public account.

- **One call:** processed as a normal EOA transaction.
- **Two or more calls:** batched into a **single EIP-7702 UserOperation** (Simple7702Account `executeBatch`) and submitted via Pimlico. If the sender is not already delegated to `0xe6Cae83BdE06E4c305530e199D7217f42808555B`, the EIP-7702 authorization is included in that same UserOp.

| Option | Description |
|--------|-------------|
| `--targets <addresses>` | **Required.** Comma- or space-separated contract addresses. |
| `--payloads <hex>` | **Required.** Comma- or space-separated calldata values matching `--targets` by position. |
| `--values <wei>` | ETH value in wei for each call (default: `0` for every call). The count must match `--targets`. |
| `--wallet <name>` | Wallet. |
| `--password <password>` | Unlock password. |
| `--from <address-or-index>` | Sender public account address or HD index. |
| `--from-priv` | With `--broadcast`, derive an indexed sender from the mnemonic if it is not in the stored public account list. |
| `--rpc-url <url>` | RPC endpoint. |
| `--broadcast` | Sign and submit on-chain (single EOA tx, or one batched UserOp for 2+ calls). Omit to simulate and print payloads. |
| `--without-tor` | Disable Tor for non-RPC HTTP (Pimlico UserOps, etc.). RPC stays clearnet. Or set `KOHAKU_WITHOUT_TOR=1`. |
| `--non-interactive` | JSON output; requires `--wallet`, `--password`, and `--from`. |
| `--dataDir <path>` | Data root. |

Each target must have one payload and, when provided, one value. Every call is simulated before any transaction is broadcast.

**Examples:**

```bash
kohaku transact-raw --wallet testWallet --from 0 --targets 0xContract --payloads 0xCalldata
kohaku transact-raw --wallet testWallet --from 0 --targets 0xContractA,0xContractB --payloads 0xDataA,0xDataB --values 0,1000000000000000 --broadcast
```

---

### `shield`

Move funds from a **public** account into a private protocol.

| Option | Description |
|--------|-------------|
| `--protocol <railgun\|privacy-pools\|tornado>` | Required unless `DEFAULT_PRIVACY_PROTOCOL` is set to one of those values. |
| `--wallet <name>` | Wallet. |
| `--password <password>` | Unlock password. |
| `--from <address-or-index>` | Sender public account address, HD index, or stealth selector (`s0`). |
| `--from-priv` | With `--broadcast`: derive private key by index from mnemonic if account not yet in stored public list. |
| `--token <address\|eth>` | Token (default: `eth`). |
| `--amount-wei <n>` | Amount in base units. |
| `--amount-formatted <decimal>` | Human amount (uses token decimals). |
| `--amount-max` | Shield the maximum spendable amount. ETH: balance minus estimated gas. ERC-20: full token balance (ETH must still cover gas). Tornado: floored to a multiple of the smallest pool denomination; if gas then knocks the amount below a step, the CLI drops one step and rebuilds. Provide at most one of `--amount-wei`, `--amount-formatted`, or `--amount-max`. |
| `--rpc-url <url>` | RPC endpoint. |
| `--broadcast` | Sign and send on-chain. **Omit** for dry-run (transaction JSON only). |
| `--skip-sim` | Dry-run only: skip `eth_call` / UserOp simulation and fee estimates. `fees` stay in `--non-interactive` JSON but are zeroed. Cannot be combined with `--broadcast`. Use this for counterfactual senders (no balance) so you can still print payloads for later `--tail-calls`. |
| `--base-fee-gwei`, `--priority-fee-gwei` | Optional fee overrides (reserved; auto fees used today). |
| `--without-tor` | Disable Tor for privacy HTTP (Subsquid / PPOI / saga / ASP / etc.). RPC stays clearnet. Or set `KOHAKU_WITHOUT_TOR=1`. |
| `--non-interactive` | JSON output; requires `--wallet`, `--password`, `--from`, and an amount flag (`--amount-wei`, `--amount-formatted`, or `--amount-max`). |
| `--dataDir <path>` | Data root. |

**Interactive (no amount / from flags):** lists public accounts with balances for the token → amount prompt (or `max`) → account picker → dry-run JSON or confirmations with `--broadcast`. `--amount-max` skips the amount prompt and picks the account first.

**Protocols:**

- **privacy-pools** — Native ETH shield; non-ETH tokens must be on the protocol whitelist for your chain.
- **railgun** — ETH and ERC-20; non-ETH may need an approval. Approval + shield (2+ calls) are submitted as **one EIP-7702 UserOp** via Pimlico.
- **tornado** — ETH and ERC-20 tokens in the static pool catalog (`src/utils/tornado-pools.ts`; mainnet and Sepolia differ). Amount must be an exact multiple of the smallest pool denomination for that asset. Multi-denomination deposits (and any ERC-20 approvals) are batched into **one EIP-7702 UserOp**. Approvals are aggregated per pool (e.g. 2×1000 + 5×100 → approve 2000 and 500, not seven separate approves).

When a shield needs more than one on-chain call, the CLI uses EIP-7702 Simple7702Account (`0xe6Cae83B…855B`) the same way as `transact-raw`.

**Examples:**

```bash
kohaku shield --protocol tornado --wallet testWallet --from 0 --amount-formatted 0.1 --broadcast
kohaku shield --protocol tornado --wallet testWallet --from s0 --amount-formatted 0.1 --broadcast
kohaku shield --protocol tornado --wallet testWallet --from 0 --amount-max --broadcast
kohaku shield --protocol railgun --wallet testWallet --from 0 --token 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 --amount-formatted 10 --broadcast
kohaku shield --protocol tornado --wallet testWallet --from 0 --amount-formatted 0.1 --without-tor
# Counterfactual sender: print payloads without simulating (e.g. to compose unshield --tail-calls)
kohaku shield --protocol tornado --wallet testWallet --from 1 --amount-formatted 0.1 --skip-sim --non-interactive
```

---

### `unshield`

Withdraw **private** balance to a **public** address via the protocol broadcaster / relayer.

| Option | Description |
|--------|-------------|
| `--protocol <railgun\|privacy-pools\|tornado>` | Required unless `DEFAULT_PRIVACY_PROTOCOL` is set to one of those values. |
| `--wallet <name>` | Wallet. |
| `--password <password>` | Unlock password. |
| `--to <address>` | Recipient: public address, HD index address, stealth selector (`s0`), or name (`.eth` / `.gwei` / `.wei`). |
| `--next` | Create and use the next fresh public account (mutually exclusive with `--to`). |
| `--token <address\|eth>` | Token (default: `eth`). |
| `--amount-wei <n>` | Amount in base units. |
| `--amount-formatted <decimal>` | Human amount. |
| `--amount-max` | Maximum spendable amount (Privacy Pools: largest single note; Tornado: sum of unspent notes). |
| `--tail-calls <target:calldata[:value],...>` | Ordered calls appended after the Tornado / Railgun payout. Optional third field is `msg.value` (hex or decimal wei) — **ETH unshields only**. Tornado ERC-20 tails work for paymaster FeeAdapter tokens (Sepolia: DAI; mainnet: DAI, USDC, USDT, WBTC). Railgun ERC-20 tails work for any shielded token; bundler gas is paid from a separate shielded WETH balance, not from the unshielded asset. Tornado tails require `--next`, a **stored** public HD `--to`, or a **stored stealth** `--to` (`sN`). Peeked/custom addresses are not allowed. Railgun tails require a wallet-controlled recipient (`--next` / HD `--to` / stealth). |
| `--rpc-url <url>` | RPC endpoint. |
| `--broadcast` | Submit via the protocol broadcaster, relayer, or paymaster. **Omit** to print prepared private operation JSON only. |
| `--without-tor` | Disable Tor for non-RPC HTTP (default: **Tor on** for all private-protocol network calls). Covers Pimlico (via local reverse proxy), Railgun Subsquid/PPOI, Tornado saga CDN + proving artifacts, Privacy Pools ASP/fastrelay, and other `fetch` traffic. Ethereum RPC stays on clearnet. First Tor bootstrap may take several seconds. Or set `KOHAKU_WITHOUT_TOR=1`. |
| `--non-interactive` | JSON; requires `--wallet`, `--password`, `--to` or `--next`, and an amount flag. |
| `--dataDir <path>` | Data root. |

**Interactive:** recipient menu (next fresh / custom address / existing public or stealth account) → amount (shows max; Privacy Pools capped by largest single note; Tornado by total unspent notes) → prepared op or broadcast confirmation.

**Tornado amounts:** shields must be an exact multiple of the smallest denomination for that asset (ETH: 0.1; DAI Sepolia: 100; etc.). Unshield can combine multiple notes in one paymaster UserOp (including ERC-20: fee taken from the first note via `quoteWeiInToken`, remaining notes withdrawn in the execution phase) **only** when the recipient is `--next`, a stored public HD `--to`, or a stored stealth `--to` (`sN`) — otherwise extra notes would land on a note-derived EIP-7702 account this wallet does not store. `--tail-calls` have the same requirement. A custom / peeked `--to` is allowed only for a **single-note** unshield with **no** `--tail-calls` (funds go directly to that address). ERC-20 tails cannot include `msg.value`.

**Railgun amounts:** treasury BPS is added on top of the requested amount so the recipient receives that amount exactly. Bundler / privacy-paymaster gas is always paid from **shielded WETH** (you need a WETH note even when unshielding USDC). `--tail-calls` works for ETH and ERC-20; funds already land at `to` via the privacy paymaster (no leftover-forward baking). ERC-20 tails cannot include `msg.value`.

**Stealth recipients:** `--to s0` (or another stored stealth selector) works for Tornado and Railgun when the stealth private key is in this wallet, including Tornado `--tail-calls` and multi-note amounts (the CLI injects the stored key via a sentinel BIP-32 path). Railgun ERC-20 without `--tail-calls` can also go to a custom (non-wallet) address. Railgun native ETH unshield and `--tail-calls` still need a recipient whose key is in this wallet (`--next`, stored public/stealth address, or `sN`), because unwrap / tails run on that EIP-7702 account.

**Examples:**

```bash
kohaku unshield --protocol tornado --wallet testWallet --next --amount-max
kohaku unshield --protocol tornado --wallet testWallet --next --amount-formatted 0.1 --broadcast
kohaku unshield --protocol tornado --wallet testWallet --to s0 --amount-formatted 0.1 --broadcast
kohaku unshield --protocol tornado --wallet testWallet --to s0 --amount-formatted 1 --tail-calls 0x1111111111111111111111111111111111111111:0x1234 --broadcast
kohaku unshield --protocol tornado --wallet testWallet --next --amount-formatted 1 --tail-calls 0x1111111111111111111111111111111111111111:0x1234,0x2222222222222222222222222222222222222222:0xabcd:0x2386f26fc10000 --broadcast
kohaku unshield --protocol tornado --wallet testWallet --next --token DAI --amount-formatted 100 --broadcast
kohaku unshield --protocol tornado --wallet testWallet --next --token DAI --amount-formatted 100 --tail-calls 0x1111111111111111111111111111111111111111:0x1234 --broadcast
kohaku unshield --protocol railgun --wallet testWallet --to 0xStoredWalletAddress --token USDC --amount-formatted 25 --broadcast
kohaku unshield --protocol railgun --wallet testWallet --next --token USDC --amount-formatted 3 --tail-calls 0x1111111111111111111111111111111111111111:0x1234 --broadcast
kohaku unshield --protocol tornado --wallet testWallet --next --amount-formatted 0.1 --without-tor
```

---

### `import-tornado-note`

Import legacy Tornado Cash note string(s) into this wallet (deposits that were not made from this mnemonic). Notes are synced against chain state and stored for later `unshield` / `export-tornado-note`.

| Argument | Description |
|----------|-------------|
| `<notes...>` | One or more legacy note strings: `tornado-<currency>-<denom>-<chainId>-0x…` |

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet. |
| `--password <password>` | Unlock password. |
| `--rpc-url <url>` | RPC endpoint. |
| `--without-tor` | Disable Tor for privacy HTTP (default: Tor on). |
| `--non-interactive` | No prompts; requires `--wallet` and `--password`. |
| `--dataDir <path>` | Data root. |

**Examples:**

```bash
kohaku import-tornado-note --wallet testWallet 'tornado-eth-0.1-11155111-0x…'
```

---

### `export-tornado-note`

Export unspent Tornado Cash note secret(s) for an **exact** pool denomination (legacy note strings compatible with `import-tornado-note`). Interactive mode confirms before printing secrets; `--non-interactive` skips the confirmation.

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet. |
| `--password <password>` | Unlock password. |
| `--rpc-url <url>` | RPC endpoint. |
| `--token <address\|symbol\|eth>` | Token (default: `eth`). |
| `--amount-wei <n>` | Exact pool denomination in base units. |
| `--amount-formatted <decimal>` | Exact pool denomination as a decimal. |
| `--without-tor` | Disable Tor for privacy HTTP (default: Tor on). |
| `--non-interactive` | No prompts; requires `--wallet` and `--password`. |
| `--dataDir <path>` | Data root. |

Provide exactly one of `--amount-wei` or `--amount-formatted`.

**Examples:**

```bash
kohaku export-tornado-note --wallet testWallet --amount-formatted 0.1
kohaku export-tornado-note --wallet testWallet --token DAI --amount-formatted 100 --non-interactive
```

---

### Names (`.eth` / `.gwei` / `.wei`)

Commands below manage top-level ENS (`.eth`), GNS (`.gwei`), and WNS (`.wei`) names. Shared options:

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet. |
| `--password <password>` | Unlock password. |
| `--rpc-url <url>` | RPC endpoint. |
| `--broadcast` | Sign and submit on-chain. Omit to simulate / print payloads. |
| `--owner-priv` | Derive `--index` from the seed when that account is not yet in public accounts. |
| `--without-tor` | Disable Tor for non-RPC HTTP (Pimlico when broadcasting UserOps, etc.). RPC stays clearnet. Or set `KOHAKU_WITHOUT_TOR=1`. |
| `--non-interactive` | JSON where applicable; requires `--wallet` and `--password`. |
| `--dataDir <path>` | Data root. |

**`--index` on most name commands** is only needed when the required HD account is not stored in the public accounts list yet (the controller is still a specific seed index). **`register-name` is different:** `--index` selects which account will own the new name (default `0`).

ENS has separate **owner** (NFT / registrant) and **manager** (registry owner for records). GNS/WNS have a single NFT owner only.

---

### `register-name`

Register a top-level name: commit → 60s wait → reveal/register.

| Option | Description |
|--------|-------------|
| `--protocol <ens\|gns\|wns>` | **Required.** Naming system. |
| `--name <label-or-name>` | Bare label (`alice`) or full name (`alice.gwei`). TLD must match `--protocol` when present. |
| `--index <n>` | HD account that will own the name (default: `0`). |
| `--years <n>` | Duration in whole years (ENS only; GNS/WNS always 1 year). Default: `1`. |
| `--set-reverse` | Also set this name as the account’s primary reverse record. |

Plus shared name wallet options above.

**Examples:**

```bash
kohaku register-name --wallet testWallet --protocol ens --name alice --years 1 --broadcast
kohaku register-name --wallet testWallet --protocol gns --name bob.gwei --index 2 --set-reverse --broadcast
```

---

### `renew-name`

Extend / renew a top-level name. Anyone may pay on-chain; the CLI prefers the name owner when present in the wallet. Interactive mode prompts for `--years` on ENS (Enter → `1`); GNS/WNS always add 1 year.

| Option | Description |
|--------|-------------|
| `--name <name>` | **Required.** Full name including TLD. |
| `--years <n>` | Extension in whole years (ENS only). Interactive default: `1`. |
| `--index <n>` | Only needed when the payer HD index is not stored in public accounts yet (defaults to name owner when present). |

**Examples:**

```bash
kohaku renew-name --wallet testWallet --name alice.eth --years 1 --broadcast
kohaku renew-name --wallet testWallet --name alice.gwei --broadcast
```

---

### `transfer-name`

Transfer name ownership and/or ENS manager. GNS/WNS only support NFT owner transfer. Interactive mode prompts for `--to` and (ENS) `--role` when omitted; role default is `both`.

| Option | Description |
|--------|-------------|
| `--name <name>` | **Required.** Full name including TLD. |
| `--to <address-or-name>` | Recipient address or `.eth` / `.gwei` / `.wei` name; prompted if omitted. |
| `--role <owner\|manager\|both>` | What to transfer (default: `both`). `manager` / `both` are ENS-only; prompted if omitted. |
| `--index <n>` | Only needed when the required HD index is not stored in public accounts yet. |

**Examples:**

```bash
kohaku transfer-name --wallet testWallet --name alice.eth --to 0xRecipient --role both --broadcast
kohaku transfer-name --wallet testWallet --name alice.gwei --to bob.gwei --broadcast
```

---

### `set-name-text-record`

Set a text record on a top-level name. Interactive mode prompts for `--key` / `--value` when omitted.

| Option | Description |
|--------|-------------|
| `--name <name>` | **Required.** Full name including TLD. |
| `--key <key>` | Text record key (e.g. `url`, `avatar`, `com.twitter`); prompted if omitted. |
| `--value <value>` | Text record value (empty string clears); prompted if omitted. |
| `--index <n>` | Only needed when the required HD index is not stored in public accounts yet. |

**Examples:**

```bash
kohaku set-name-text-record --wallet testWallet --name alice.eth --key url --value https://example.com --broadcast
```

---

### `set-name-website`

Set the contenthash / website for a top-level name (`ipfs://` or `bzz://`). Interactive mode prompts for `--content-hash` when omitted.

| Option | Description |
|--------|-------------|
| `--name <name>` | **Required.** Full name including TLD. |
| `--content-hash <uri>` | Must start with `ipfs://` or `bzz://`; prompted if omitted. |
| `--index <n>` | Only needed when the required HD index is not stored in public accounts yet. |

**Examples:**

```bash
kohaku set-name-website --wallet testWallet --name alice.eth --content-hash ipfs://bafy… --broadcast
```

---

### `set-name-reverse-record`

Set a name as the primary reverse record for the signing account.

| Option | Description |
|--------|-------------|
| `--name <name>` | **Required.** Full name including TLD. |
| `--index <n>` | Only needed when the required HD index is not stored in public accounts yet. |

**Examples:**

```bash
kohaku set-name-reverse-record --wallet testWallet --name alice.eth --broadcast
```

---

### `fetch-artifacts`

Download Railgun + Tornado proving artifacts into `<dataDir>/proving-artifacts` so later **prove / unshield** can load circuits from disk without re-fetching (and without Tor→clearnet fallback). Event sync (`balances`, first shield) does **not** need these files — Tornado cold sync is saga CDN + chain, Railgun is Subsquid, Privacy Pools is bundled state JSON + `eth_getLogs` + ASP.

With no selectors, downloads the **full proving set** (~260 MB). Narrow with `--variant` / `--poi` / `--tornado` / keys. The public-sync snapshot is a separate concern — see [`fetch-sync-cache`](#fetch-sync-cache).

| Option / args | Description |
|---------------|-------------|
| *(none)* | Full Railgun modern `.br` set (transact + POI) + Tornado circuit/key. |
| `--variant <NNxMM>` | Railgun transact variant(s), e.g. `01x03` (repeatable; 3 files each). |
| `--poi <NNxMM>` | POI variant(s): `03x03` or `13x13` (repeatable). |
| `--tornado` | Tornado circuit JSON + proving key only. |
| `[keys...]` | Explicit relative paths, e.g. `railgun/01x03/proving_key.bin.br`. |
| `--without-tor` | Download over clearnet. Reveals that this IP fetched kohaku proving artifacts; subsequent private ops stay Tor-only from the local cache (except RPC). Or set `KOHAKU_WITHOUT_TOR=1`. |
| `--dataDir <path>` | Data root (cache lives at `<dataDir>/proving-artifacts`). |
| `--non-interactive` | JSON summary only. |

Remote proving-artifact base URL: env `KOHAKU_ARTIFACTS_BASE_URL` (default: `https://artifacts.0000000000.org`, same path layout as MacWha `artifacts/`).

**Examples:**

```bash
kohaku fetch-artifacts
kohaku fetch-artifacts --without-tor
kohaku fetch-artifacts --variant 01x03 --poi 03x03 --tornado
kohaku fetch-artifacts railgun/01x03/proving_key.bin.br
```

---

### `fetch-sync-cache`

Download a published snapshot of public protocol-sync HTTP pages into `<dataDir>/public-sync-cache`, so a fresh wallet's first `balances` / `shield` / `unshield` replays **Railgun Subsquid** and **Tornado saga** history from disk instead of paging it over Tor. Anything newer than the snapshot is still fetched live and written through, so the cache stays current as you use it.

Privacy Pools is deliberately **not** in the snapshot: its cold sync is a bundled state JSON plus `eth_getLogs`, and RPC calls never pass through the HTTP cache. Its first sync stays slow.

The snapshot ships as a **manifest plus ~8 MiB chunks** rather than one large archive. Each chunk is fetched one at a time, checked against the `sha256` in the manifest, and extracted on arrival, so a dropped Tor circuit costs one chunk instead of the whole transfer. Re-running skips chunks whose entries are already on disk, which makes an interrupted download resumable and a partial cache repairable.

| Option | Description |
|--------|-------------|
| *(none)* | Fetch the manifest, then download and install every chunk not already present. |
| `--force` | Re-download chunks even when all of their entries are already cached. |
| `--pack <dir>` | Publisher mode: pack `<dataDir>/public-sync-cache` into `chunk-NNN.tar.gz` + `manifest.json` in `<dir>`. |
| `--chunk-bytes <n>` | Target compressed bytes per chunk with `--pack` (default `8388608`). |
| `--without-tor` | Download over clearnet. Much faster, and reveals only that this IP fetched public pool data. Or set `KOHAKU_WITHOUT_TOR=1`. |
| `--dataDir <path>` | Data root (cache lives at `<dataDir>/public-sync-cache`). |
| `--non-interactive` | JSON summary only. |

Snapshot base URL: env `KOHAKU_SYNC_CACHE_BASE_URL` (default: `https://artifacts.0000000000.org/sync-cache/v1`, a versioned prefix so a newer snapshot cannot break clients pinned to an older manifest). Per-chunk time budget: env `KOHAKU_SYNC_CACHE_CHUNK_TIMEOUT_MS` (default `300000`); each chunk gets 3 attempts. Chunk URLs are excluded from proving-artifact routing, so the 45 s `KOHAKU_TOR_CDN_TIMEOUT_MS` cap does not apply to them.

Exits non-zero if any chunk ultimately failed. The entries that did land are still valid and usable — re-run to retry the rest.

**Examples:**

```bash
# Consumers
kohaku fetch-sync-cache
kohaku fetch-sync-cache --without-tor

# Publisher: sync the protocols you want covered on each network first, then pack
RPC_URL=https://mainnet-rpc kohaku balances --wallet snap-main --include railgun,tornado --without-tor
RPC_URL=https://sepolia-rpc kohaku balances --wallet snap-sep --include railgun,tornado --without-tor
kohaku fetch-sync-cache --pack ./sync-cache-v1
```

Then upload everything in `./sync-cache-v1` (chunks **and** `manifest.json`) to `artifacts.0000000000.org/sync-cache/v1/`, serving chunks as `application/gzip` and the manifest as `application/json`. To stage a snapshot before publishing, point `KOHAKU_SYNC_CACHE_BASE_URL` at any host that serves those files.

The cache never evicts: once it reaches `KOHAKU_PUBLIC_SYNC_CACHE_MAX_BYTES` (default 1 GiB) new responses simply stop being stored, so an installed snapshot is never cannibalised to make room for fresher pages. When filling a cache you intend to publish, raise that ceiling for the *sync* runs so later pages are still captured rather than silently dropped.

---

### `view-network-traffic`

Browse the per-wallet network traffic log (what the CLI contacted, when, and whether the request went over Tor). Useful for reviewing anonymity risk.

Traffic is appended to `<dataDir>/<wallet>/network-traffic.ndjson` while you use the wallet (`balances` / `shield` / `unshield` / `transfer` / …). API keys in URLs are redacted before write. Ethereum RPC is always logged as clearnet.

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet (optional interactive picker). |
| `--tor-only` / `--clearnet-only` | Filter by path. |
| `--category <name>` | `pimlico` \| `subsquid` \| `ppoi` \| `saga` \| `asp` \| `fastrelay` \| `artifacts` \| `rpc` \| `other`. |
| `--limit <n>` | Last N events only. |
| `--json` | Print JSON (`summary` + `entries`). |
| `--non-interactive` | Dump the log to stdout (no scroll UI). |
| `--clear` | Delete this wallet's traffic log. |
| `--dataDir <path>` | Data root. |

**Interactive (TTY):** scrollable viewer — `j`/`k` or arrows, space/PgDn, `g`/`G` top/bottom, `q` quit. Tor rows are green; clearnet yellow; errors red.

**Examples:**

```bash
kohaku view-network-traffic --wallet testWallet
kohaku view-network-traffic --wallet testWallet --clearnet-only
kohaku view-network-traffic --wallet testWallet --category rpc --json
kohaku view-network-traffic --wallet testWallet --clear
```

---

### `clear-tor-cache`

Delete the on-disk [tor-js](https://github.com/privacy-ethereum/tor-js) Arti cache (`~/.local/share/tor-js`). Use after Tor bootstrap failures such as corrupted cache / “Unable to bootstrap a working directory”. The next Tor start re-downloads consensus (slower first bootstrap).

| Option | Description |
|--------|-------------|
| `--public-sync` | Also delete `<dataDir>/public-sync-cache` (Railgun Subsquid / Tornado saga HTTP cache). |
| `--non-interactive` | Print JSON `{ cleared, path }` instead of a human message. |

**Examples:**

```bash
kohaku clear-tor-cache
kohaku clear-tor-cache --public-sync
kohaku clear-tor-cache --non-interactive
```

---

### `see-stealth-meta-address`

Print this wallet’s scheme-1 stealth meta-address URI (`st:<network>:0x…`). Derived from the seed; no RPC required.

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet (prompt if omitted). Required with `--non-interactive`. |
| `--password <password>` | Unlock password. |
| `--non-interactive` | Requires `--wallet` and `--password`; prints the URI only. |
| `--dataDir <path>` | Data root. |

**Examples:**

```bash
kohaku see-stealth-meta-address --wallet testWallet
kohaku see-stealth-meta-address --wallet testWallet --password "$WALLET_PW" --non-interactive
```

---

### `see-decrypted-storage <type>`

Debug helper: decrypt and print wallet storage JSON.

| Argument | `public` \| `stealth` \| `railgun` \| `privacy-pools` \| `tornado` |
|----------|---------------------------------------------------------------------|
| Options | Same wallet / password / `--non-interactive` / `--dataDir` as other commands. |

Files include `public-accounts.json`, stealth storage, `rg-storage.json`, `ppv1-storage.json`, and Tornado note storage.

---

## Tips

- **Dry run vs broadcast:** `transfer`, `transact-raw`, `shield`, `unshield`, `init-profile`, and the name commands default to *prepare or simulate only*. Always read the printed transaction data before adding `--broadcast`.
- **Tor (all-but-RPC):** Non-RPC HTTP (Pimlico, Railgun Subsquid/PPOI, Tornado saga/artifacts, Privacy Pools ASP/fastrelay, …) goes through [tor-js](https://github.com/privacy-ethereum/tor-js) by default on `balances` (when syncing private protocols), `shield`, `unshield`, Tornado note import/export, `transfer`, `transact-raw`, and name commands. Ethereum RPC stays clearnet. Use `--without-tor` or `KOHAKU_WITHOUT_TOR=1` to skip. **Saga CDN and proving artifacts are Tor-or-fail** (no clearnet fallback; large GETs time out after `KOHAKU_TOR_CDN_TIMEOUT_MS`, default 45s). First protocol sync (saga / Subsquid / ASP / RPC catch-up) shows live progress on the spinner and does not download proving keys. Artifacts are served from `<dataDir>/proving-artifacts` when cached; otherwise fetched from `KOHAKU_ARTIFACTS_BASE_URL` (default: `https://artifacts.0000000000.org`) on **prove / unshield**. Pre-warm keys with `kohaku fetch-artifacts` (optionally `--without-tor` for a one-shot clearnet download). Prefetch historical Subsquid/saga pages with `kohaku fetch-sync-cache`, which pulls a chunked, `sha256`-verified snapshot one piece at a time. After Tor bootstrap corruption, run `kohaku clear-tor-cache`. Railgun Subsquid and Tornado saga HTTP pages are reused from `<dataDir>/public-sync-cache` (wipe with `kohaku clear-tor-cache --public-sync`); Privacy Pools ASP and RPC are always live. Set `KOHAKU_TOR_DEBUG=1` for per-request Tor logs. A keyed RPC URL still identifies you to that provider regardless of Tor. Review with `view-network-traffic --wallet <name>`.
- **Fresh addresses:** Use `next-fresh-address` before funding, and `unshield --next` when you want withdrawals to land on a new public key that was not your shield source. Use `next-fresh-address --peek` to see the next address without persisting it (e.g. when building `--tail-calls` for a later `unshield --next`). Do not pass a peeked address as Tornado `--to` together with `--tail-calls` — peeked addresses are not stored, so the CLI will refuse rather than 7702 a note-derived key.
- **Profile / stealth:** Prefer `init-profile` to publish ERC-6538 keys (and optionally a name). Unshield to stored stealth accounts with `--to s0`. Print the meta URI with `see-stealth-meta-address`. New wallets and imports store `.stealth-start-block` at the current chain tip so first `balances` stealth scans skip pre-wallet announcer history. Pass `create-wallet --import --stealth-start-block` (bare) for the Kohaku-schema floor (mainnet `25700000` / Sepolia `11455454`), or an explicit block. Later `balances --stealth-start-block` can still back-date below the file.
- **Privacy Pools note size:** Each unshield uses one note; large shields may require multiple unshields if balances are split across notes.
- **Tornado notes:** Use `export-tornado-note` / `import-tornado-note` to move legacy note secrets between wallets for testing or recovery.
- **Private key / seed exports:** `export-private-key`, `reveal-seed-phrase`, and `export-tornado-note` print raw secrets to stdout. Avoid terminal logs, shell history, and shared environments.
- **Agents:** Pass `--non-interactive --password-file … --wallet …` and parse JSON stdout. Set `RPC_URL` in the environment to avoid repeating `--rpc-url`. Secret files must be regular files, cannot be symlinks, and on POSIX must be owned by the current user with mode `0400` or `0600` (`chmod 600`).
