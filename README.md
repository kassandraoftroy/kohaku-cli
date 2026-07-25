# kohaku-cli

> [!IMPORTANT]
> NOTICE: this CLI has **NOT BEEN AUDITED** and **IS UNDER ACTIVE DEVELOPMENT** and **HAS BEEN WRITTEN WITH HELP FROM CLAUDE** et al. **DO NOT USE ON MAINNET** without understanding **YOU RISK CATASTROPHIC LOSS OF FUNDS**.

A terminal wallet for moving funds between **public** Ethereum accounts (derived from your seed) and **private** balances on Tornado Cash, Railgun and Privacy Pools (V1). The CLI encrypts your seed on disk, walks you through shield / unshield with prompts, and can run headlessly with `--non-interactive` for scripts and agents.

**Requirements:** Node.js 22+, an Ethereum RPC URL (`RPC_URL` or `--rpc-url`).

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
| **`--non-interactive`** | Available on every command below. Skips prompts and spinners; prints **JSON** where applicable. Requires flags documented per command (`--password`, `--wallet`, amounts, `--from`, `--to` / `--next`, etc.). Use for CI, agents, and piping output. |
| **`--password`** | Wallet unlock password. In non-interactive mode, required where the wallet is encrypted. Value can be a literal string or a path to a file containing the password. |

---

### `create-wallet <name>`

Create a BIP-39 seed wallet encrypted on disk.

| Option | Description |
|--------|-------------|
| `--testnet` | Tag wallet for Sepolia instead of mainnet. |
| `--import` | Restore from mnemonic instead of generating a new one. |
| `--rpc-url <url>` | Required with `--import` (or `RPC_URL`) to scan used addresses. |
| `--mnemonic <phrase>` | Mnemonic (required with `--non-interactive --import`). |
| `--password <password>` | Encryption password (required with `--non-interactive`). |
| `--non-interactive` | No prompts; no mnemonic box on create. |
| `--dataDir <path>` | Data root. |

**Interactive:** encryption password (twice); for `--import`, masked mnemonic entry. New wallets display the mnemonic once in a warning box.

**Examples:**

```bash
kohaku create-wallet myWallet --testnet
kohaku create-wallet restored --testnet --import --rpc-url "$RPC_URL"
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

### `balances`

Show aggregated **public** balances (ETH + default ERC-20s for the chain, plus any private tokens discovered), and **private** balances for the protocols you select.

By default, private balances are included only for `DEFAULT_PRIVACY_PROTOCOL` (if set). Otherwise only public balances are shown, with a short warning. Pass `--include` to sync one or more protocols explicitly (required for multiple protocols at once, or for any private balance when the env is unset).

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet (optional in interactive mode). |
| `--password <password>` | Unlock password. |
| `--rpc-url <url>` | RPC endpoint. |
| `--include <protocols>` | Comma-separated private protocols to sync (`railgun`, `privacy-pools`, `tornado`). Default: `DEFAULT_PRIVACY_PROTOCOL` only, or none if unset. |
| `--verbose` | Human: per-address public breakdown + private note list for included protocols. JSON: adds `public_account_indexes_by_address` and `private_notes`. |
| `--tokensList <addrs>` | Extra ERC-20 addresses (comma- or space-separated), merged with chain defaults. |
| `--non-interactive` | JSON only; requires `--wallet` and `--password`. |
| `--dataDir <path>` | Data root. |

**Interactive:** wallet picker, password, loading spinner, formatted tables.

Default Sepolia ERC-20s include USDC and WETH; mainnet adds USDC, USDT, DAI, WETH.

**Examples:**

```bash
kohaku balances --wallet testWallet --include tornado
kohaku balances --wallet testWallet --include railgun,tornado --verbose
kohaku balances --wallet testWallet --verbose --include privacy-pools --tokensList 0xYourToken
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

Simulate or submit one or more raw contract calls from a public account. Calls are processed sequentially in the order supplied.

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
| `--broadcast` | Sign and submit each call on-chain. Omit to simulate and print transaction payloads. |
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
| `--from <address-or-index>` | Sender public account (address or HD index). |
| `--from-priv` | With `--broadcast`: derive private key by index from mnemonic if account not yet in stored public list. |
| `--token <address\|eth>` | Token (default: `eth`). |
| `--amount-wei <n>` | Amount in base units. |
| `--amount-formatted <decimal>` | Human amount (uses token decimals). |
| `--rpc-url <url>` | RPC endpoint. |
| `--broadcast` | Sign and send on-chain. **Omit** for dry-run (transaction JSON only). |
| `--base-fee-gwei`, `--priority-fee-gwei` | Optional fee overrides (reserved; auto fees used today). |
| `--non-interactive` | JSON output; requires `--wallet`, `--password`, `--from`, and an amount flag. |
| `--dataDir <path>` | Data root. |

**Interactive (no amount / from flags):** lists public accounts with balances for the token → amount prompt → account picker → dry-run JSON or confirmations with `--broadcast`.

**Protocols:**

- **privacy-pools** — Native ETH shield; non-ETH tokens must be on the protocol whitelist for your chain.
- **railgun** — ETH and ERC-20; non-ETH may need an approval transaction before shield.
- **tornado** — ETH only; amount must be an exact multiple of 0.1 ETH (e.g. `1.3` OK, `1.35` not).

**Examples:**

```bash
kohaku shield --protocol tornado --wallet testWallet --from 0 --amount-formatted 0.1 --broadcast
kohaku shield --protocol railgun --wallet testWallet --from 0 --token 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 --amount-formatted 10 --broadcast
```

---

### `unshield`

Withdraw **private** balance to a **public** address via the protocol broadcaster / relayer.

| Option | Description |
|--------|-------------|
| `--protocol <railgun\|privacy-pools\|tornado>` | Required unless `DEFAULT_PRIVACY_PROTOCOL` is set to one of those values. |
| `--wallet <name>` | Wallet. |
| `--password <password>` | Unlock password. |
| `--to <address>` | Recipient public address. |
| `--next` | Create and use the next fresh public account (mutually exclusive with `--to`). |
| `--token <address\|eth>` | Token (default: `eth`). |
| `--amount-wei <n>` | Amount in base units. |
| `--amount-formatted <decimal>` | Human amount. |
| `--amount-max` | Maximum spendable amount (Privacy Pools: largest single note; Tornado: sum of unspent notes). |
| `--tail-calls <target:calldata[:value],...>` | Ordered calls appended after the Tornado payout call. Optional third field is `msg.value` (hex or decimal wei). Currently Tornado-only. |
| `--rpc-url <url>` | RPC endpoint. |
| `--broadcast` | Submit via the protocol broadcaster, relayer, or paymaster. **Omit** to print prepared private operation JSON only. |
| `--non-interactive` | JSON; requires `--wallet`, `--password`, `--to` or `--next`, and an amount flag. |
| `--dataDir <path>` | Data root. |

**Interactive:** recipient menu (next fresh / custom address / existing account) → amount (shows max; Privacy Pools capped by largest single note; Tornado by total unspent notes) → prepared op or broadcast confirmation.

**Tornado amounts:** shields and unshields must be an exact multiple of 0.1 ETH (e.g. `1.3` OK, `1.35` not). Unshield can combine multiple notes in one UserOp to reach that total (e.g. `0.2` or `1.2`).

**Examples:**

```bash
kohaku unshield --protocol tornado --wallet testWallet --next --amount-max
kohaku unshield --protocol tornado --wallet testWallet --next --amount-formatted 0.1 --broadcast
kohaku unshield --protocol tornado --wallet testWallet --next --amount-formatted 1 --tail-calls 0x1111111111111111111111111111111111111111:0x1234,0x2222222222222222222222222222222222222222:0xabcd:0x2386f26fc10000 --broadcast
kohaku unshield --protocol railgun --wallet testWallet --to 0xStoredWalletAddress --token USDC --amount-formatted 25 --broadcast
```

---

### `see-decrypted-storage <type>`

Debug helper: decrypt and print wallet storage JSON.

| Argument | `public` \| `railgun` \| `privacy-pools` |
|--------|-------------------------------------------|
| Options | Same wallet / password / `--non-interactive` / `--dataDir` as other commands. |

Files: `public-accounts.json`, `rg-storage.json`, `ppv1-storage.json`.

---

## Tips

- **Dry run vs broadcast:** `transfer`, `transact-raw`, `shield`, and `unshield` default to *prepare or simulate only*. Always read the printed transaction data before adding `--broadcast`.
- **Fresh addresses:** Use `next-fresh-address` before funding, and `unshield --next` when you want withdrawals to land on a new public key that was not your shield source. Use `next-fresh-address --peek` to see the next address without persisting it (e.g. when building `--tail-calls`).
- **Privacy Pools note size:** Each unshield uses one note; large shields may require multiple unshields if balances are split across notes.
- **Private key exports:** `export-private-key` prints raw key material to stdout. Avoid terminal logs, shell history, and shared environments.
- **Agents:** Pass `--non-interactive --password … --wallet …` and parse JSON stdout; set `RPC_URL` in the environment to avoid repeating `--rpc-url`.
