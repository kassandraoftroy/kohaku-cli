# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-11-01

First minor version release; no functional changes from 0.0.18.

## [0.0.18] - 2026-11-01

### Added

- `fetch-sync-cache` installs a mainnet v2 snapshot for Railgun history, historical PPOI list leaves, and Tornado and Privacy Pools Saga data under `<dataDir>/sync-cache-v2`. Downloads verify file sizes and SHA-256 hashes, resume after interruption, and activate only after every file verifies. PPOI Merkle-root validation, TXID status, proof submission, and the growing list tip remain live. A first sync still works without the snapshot by fetching history live; Sepolia continues to use its existing sync path.
- Railgun private transfers to a `0zk` recipient stay inside Railgun, without an unshield or tail call. Both `private-transfer --protocol railgun` and `transfer --from railgun` use the ERC-4337 paymaster path; `eth` selects private WETH and the requested amount is delivered to the recipient.
- `balances --include railgun` shows the full wallet `0zk` address beneath the Railgun heading and includes `railgun_address` in non-interactive JSON output.

### Changed

- The v2 cache replaces v1 downloads for this CLI version. Existing `<dataDir>/public-sync-cache` data is left on disk but is no longer read. `clear-tor-cache --public-sync` removes both cache directories.
- Railgun activity entries record the sending `0zk` address and final `0x` or `0zk` recipient. Human output identifies the mined transaction as the bundle transaction and also shows the UserOp hash when available.

## [0.0.17] - 2026-10-31

### Added

- `transfer --from railgun`, `--from tornado`, and `--from privacy-pools` run the corresponding `private-transfer --protocol` flow. Public addresses, HD indexes, and stealth selectors retain the public transfer flow. Tornado's `--exclude-new-pools` option is available through the alias.

## [0.0.16] - 2026-10-31

### Changed

- Railgun uses `kohaku-rg-js-wrapper@0.0.2` and the Rust/WASM Railgun wallet in place of `@kohaku-eth/railgun`. Shields, unshields, tail calls, balance and note reads, and ERC-4337 paymaster submissions use the new adapter.
- Existing Railgun wallets rebuild their history into a separate encrypted checkpoint. The previous `rg-storage.json` is preserved, completed sync windows are saved for resumption, and first-sync progress shows the current Railgun work. Progress output for protocol syncs gives clearer early-stage status and task-level ETA estimates after enough samples.
- Railgun sync attempts to submit recoverable PPOI for past private transactions whose proofs are missing, reports pending and failed submissions, and refreshes status on later syncs. Notes still require valid PPOI before spending. The `KOHAKU_RAILGUN_FORCE_VALID_POI` status override was removed.

### Fixed

- Railgun unshield treasury-fee previews and maximum-withdrawable calculations use the protocol's inclusive rounding, avoiding a one-wei discrepancy for exact amounts.

## [0.0.15] - 2026-10-29

### Added

- Interactive Tornado shields put the fewest-note packing first, followed by explicit denomination exclusions prioritizing individual 3-style sizes, then combinations, before other denominations. Choices show note count, denominations used, and transaction count. Confirmation separates the count-by-denomination breakdown, pool addresses, and fee estimates with line breaks; JSON retains exact values. Repeatable `--exclude-denomination <amount>` excludes specific pool sizes in token units; `--exclude-new-pools` remains available. Non-interactive shields choose the fewest-note exact packing allowed by the exclusions.
- Tornado shields split into transactions of at most five deposit notes, with batching enabled by default. `--disallow-multiple-userops` rejects plans that need multiple transactions before preparing commitments. Approvals do not count as notes; every batch still requires estimation. Single native-note shields retain the EOA path.
- Multi-UserOp shields estimate the full plan before confirmation, then submit sequentially, waiting for each successful UserOp receipt and one on-chain confirmation before starting the next. Partial failures report confirmed/unconfirmed amounts and hashes with a failing exit status. Prepared calls and progress are encrypted under the wallet's `shield-runs` directory. Ambiguous submissions stop the sequence without automatically retrying.
- Invalid interactive Tornado unshield amounts offer the nearest valid lower/higher amounts from available notes, before fees, or another amount. Explicit amounts are never silently rounded. Suggestions respect derivation/pool restrictions and no longer inherit the shield note limit. Confirmation shows the amount forwarded after the prepared paymaster fee for standard unshields.

## [0.0.14] - 2026-10-28

### Changed

- Privacy Pools SDK to `0.1.0-alpha.35` and Tornado Cash SDK to `0.1.0-alpha.32`.
- Tornado preparation allows buffered estimates up to 250,000 gas for account verification and 2,000,000 for paymaster verification. Alpha.32's baseline-derived ceilings of 100,000 and 900,000 rejected a basic single-note EIP-7702 unshield at 204,422 and 1,535,324 respectively. These are ceilings, not fixed budgets; the SDK still estimates and rebuilds the fee, proof and signature. Other SDK gas bounds remain in force.
- Tornado unshields honor the SDK's final gas-estimation status instead of requiring a second estimate. Standard unshields may use the SDK's explicit conservative fallback after eligible estimation availability failures, with a warning before broadcast and `gasEstimation` in JSON. User tail calls, including private transfers, still require successful SDK estimation. Older payloads without metadata retain the CLI gas preflight.
- Tornado fee previews and private-transfer leftover calculations use the fee committed in the prepared proof, including token fees and fallback budgets. Confirmation identifies the actual EIP-7702 executor even for single-note withdrawals, and explains where unused-gas refunds remain. A prepared fee that leaves too little for a private transfer stops before broadcast.
- Privacy Pools historical sync accepts Saga 0.3's record API and rejects derived entity records where raw pool logs are required.

## [0.0.13] - 2026-10-28

### Changed

- Tornado shields reject packings of six or more deposit notes before preparing commitments, with smaller-amount suggestions. The five-note limit respects `--exclude-new-pools` and excludes approval calls.
- Tornado unshields show usable whole-note amount examples per derivation scheme and preflight final signed gas budgets before confirmation. Bundler estimation failures and insufficient gas stop before broadcast instead of submitting SDK fallback limits.
- Tornado shields check every call from the plugin against the installed SDK's static `TornadoInstances` catalog intersected with its paymaster support before anything is signed or estimated. Each deposit must be `deposit(bytes32)` to a catalog pool for the asset, with the pool's value. Each approve must be on the asset's token, to a pool the shield deposits into, for exactly those deposits. The deposits must add up to the requested amount. The confirm prompt now lists the destination pools. Pools without SDK paymaster support, including cDAI, are excluded from both shields and unshields. New denominations are included by default; `--exclude-new-pools` also restricts this call validation.

## [0.0.12] - 2026-10-25

### Added

- Extended Tornado ETH denominations enabled by default. `--exclude-new-pools` on shield, unshield, and private-transfer restricts packing and spending to classic pools while keeping complete pool sync and balances.
- Encrypted per-wallet CLI transaction history through `activity --wallet`, including submission status, transaction hashes, and UserOp hashes. Dry runs do not log activity.
- Privacy Pools `ragequit --label` for a full unapproved note exit signed by its original depositor.
- Tornado unshields and private transfers check every selected pool for SDK support, a deployed paymaster, and on-chain pool allowlisting before generating proofs. Unsupported pools produce a clear error.

### Changed

- Privacy Pools SDK to `0.1.0-alpha.33` and Tornado Cash SDK to `0.1.0-alpha.31`. Tornado uses the new direct-paymaster contracts on mainnet and Sepolia for all classic and extended pools; fee estimates match the new SDK gas budgets.
- EOA and UserOp broadcasts detect reverted receipts and retain their activity records.

## [0.0.11] - 2026-10-22

### Changed

- Sepolia Privacy Pools bundled state snapshot now includes chain history through block 11,954,218 (previously 10,460,265). First syncs on Sepolia start from that later tip.
- Sync progress is one bar per step when that step's size is known: saga chunks, RPC windows, and stealth blocks (`scanned/total`). A quiet stretch says still working while the elapsed clock keeps moving.

## [0.0.10] - 2026-10-21

### Changed

- `@kohaku-eth/tornado-cash` and `@kohaku-eth/privacy-pools` `0.1.0-alpha.27`. New Tornado and Privacy Pools shields use signature-derived secrets. Existing BIP-32 notes and imported Tornado note strings stay in their current storage and remain spendable. Balances show the combined total and, when it is non-zero, how much of that total is legacy. Notes and JSON omit derivation labels when the wallet has no legacy notes. An unshield or private transfer spends legacy notes when that scheme covers the amount, otherwise signature notes, and warns only when legacy notes are spent. It errors when neither covers it. One withdrawal never mixes the two. `--amount-max` is the larger single-scheme amount.
- Privacy Pools paymaster unshields pass a wallet delegation path (`--next`, a stored public HD account, or a stored stealth account), the same way Tornado does. The stealth sentinel path stays in the keystore for both protocols.
- Railgun, Tornado, and Privacy Pools proving circuits install with the CLI via the `kohaku-artifacts` package. Prove and unshield read that package and do not download circuits. `fetch-artifacts` is removed.
- `--next` and private-transfer skip a public HD index that already has a nonce, balance, or code. That index is saved in the wallet and the cursor advances. The unused account is still persisted only after a successful broadcast. `balances` checks the next two unstored indexes the same way and includes any it saves.

## [0.0.9] - 2026-10-19

### Added

- `KOHAKU_RAILGUN_FORCE_VALID_POI=1` rewrites PPOI `Missing` statuses to `Valid` in the fetch layer so a Railgun note whose POI submit never landed can still be spent. Off by default. The contract does not consult PPOI; this only lifts the client-side filter.

### Changed

- `@kohaku-eth/privacy-pools` `0.1.0-alpha.26` (faster proving). The plugin keeps the legacy BIP-32 `SecretManager`. The SDK's signature-derived secrets are not used, so existing notes stay spendable.

## [0.0.8] — 2026-10-15

### Added

- `private-transfer` unshields through a fresh public account and tail-calls an exact ETH or token transfer to `--to` on Tornado, Railgun, and Privacy Pools. Tornado unshields the smallest set of notes that covers the transfer plus the paymaster fee (a 0.1 ETH transfer from 0.1 notes unshields 0.2) and leaves the remainder on the fresh account. Railgun and Privacy Pools unshield the exact transfer amount, with fees taken from the private balance. Privacy Pools uses the fresh account as the EIP-7702 delegate and refund recipient, so unused-gas change does not go to `--to`.
- Privacy Pools circuit downloads (`raw.githubusercontent.com/.../packages/circuits/...`) are rewritten to `<KOHAKU_ARTIFACTS_BASE_URL>/privacy-pools/` and cached under `proving-artifacts`, same as Railgun and Tornado. Pre-warm with `fetch-artifacts --privacy-pools`.

## [0.0.7] — 2026-10-14

### Changed

- Privacy Pools unshield is an ERC-4337 paymaster user operation. The typed amount is the net the recipient receives; the paymaster fee is paid from the private balance. Approved notes are spent largest first, and further notes run as execution-phase withdrawals. `--tail-calls` and multi-note withdrawals use `--to` as the EIP-7702 account (`--next`, a stored public HD account, or a stored stealth account). That account runs the tail calls and keeps any change. A custom `--to` is only allowed for a single-note unshield with no `--tail-calls`. Sepolia unshield fails until a paymaster adapter is configured; shield and `balances` still work there. Withdrawals are no longer sent through fastrelay.
- Privacy Pools shield accepts any asset the entrypoint has a pool for, rejects deposits below that pool's minimum, and shows the vetting fee in the shield preview.
- `@kohaku-eth/privacy-pools` `0.0.2-alpha.24`, `@kohaku-eth/tornado-cash` `0.0.2-alpha.25`, `@kohaku-eth/plugins` `0.0.1-alpha.17`.
- Privacy Pools mainnet sync reads history from the saga CDN and uses `eth_getLogs` only for the tip past that coverage. The bundled mainnet state snapshot is no longer seeded. Sepolia has no Privacy Pools saga stream, so it keeps the bundled snapshot and syncs the tip from logs.

## [0.0.6] — 2026-10-06

### Added

- add `list-wallets --format json-v1`, an opt-in versioned discovery schema with network, numeric chain ID, and CAIP-2 chain ID. The existing `--non-interactive` JSON shape remains unchanged.
- add explicit `--password-file` support to every command that unlocks a wallet, and `--mnemonic-file` to `create-wallet --import`. These POSIX inputs are mutually exclusive with their literal counterparts and require owner-only, regular, non-symlink files; they fail closed on Windows where ACLs are not validated.

### Changed

- Public Ethereum RPC client (`makePublicClient`) uses viem HTTP JSON-RPC batching by default, so concurrent reads share HTTP round-trips against any compliant node.
- Public Ethereum RPC HTTP timeout raised from viem's default 10s to 180s so large batched POSTs (e.g. `balances` against slow PIR RPC) do not abort mid-batch.
- `balances` loads public ETH + ERC-20 balances (and unknown token meta) concurrently so independent state reads pack into batched JSON-RPC POSTs.

### Fixed

- `transact-raw --from` now accepts stealth selectors (`s0` / `stealth:0`) like `shield` and `transfer` do. It previously sent them to ENS/GNS/WNS resolution and failed with `"s0" is not a valid Ethereum address`, even though the sender resolver behind it already supported them.

## [0.0.5] — 2026-08-29

### Added

- add `--skip-sim` flag on `shield` dry-runs so counterfactual (unfunded) senders still print call payloads. Cannot be combined with `--broadcast` (we always do simulation on broadcast).
- add `--amount-max` flag on `shield`: spend the account's maximum (ETH minus estimated gas; ERC-20 full balance).
- Default Sepolia token list includes DAI (`0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357`).

### Changed

- Privacy-protocol sync progress logs: omit confusing request counts (timer + phase only). Stealth scan now shows `scanned/total` blocks on the progress log.

### Fixed

- fix `balances --verbose` to no longer sync privacy protocols twice unnecessarily.
- `shield` and `unshield` keep a live progress timer during protocol sync (including Railgun WASM), matching `balances`.
- the `--from` flag on `shield` correctly supports `<stealth address>` or `sN` (stealth address by index)

## [0.0.4] — 2026-08-25

### Added

- `fetch-sync-cache` command to prefetch the public sync snapshot (Railgun Subsquid and Tornado saga HTTP pages) so later `balances` / `shield` / `unshield` syncs can start from disk instead of the network.
- `--tail-calls` on ERC-20 (non-ETH) unshields for Tornado and Railgun.
- `--tail-calls` when unshielding to a stored stealth address (`sN`).

### Changed

- Protocol syncs are substantially faster, using the public-sync cache and tighter log-range work.
- Sync progress is much easier to follow: live spinner updates and clearer logs during first-time and catch-up syncs.

### Fixed

- Unshielding to a custom / ephemeral recipient (`--to` an address that is not a stored HD account) no longer fails or mis-routes funds.
