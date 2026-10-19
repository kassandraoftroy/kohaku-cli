# kohaku-privacy-rpc

Batch-aware privacy orchestrator that composes **Tor** (`kohaku-tor-rpc`) and
**PIR** (`kohaku-pir-rpc`) into one Alloy JSON-RPC transport.

## Privacy stack

1. **Tor underlay** — PIR server calls and Ethereum RPC both egress through Arti.
2. **Prefer PIR** — allowlisted latest reads go over **shared** Tor HTTP:
   - Account table: `eth_getBalance`, `eth_getTransactionCount`, and `eth_getCode`
     (one lookup; code is `0xef0100 ‖ delegate` or `0x` for an EOA)
   - Token storage table: `balanceOf` for USDC / USDT / DAI / WETH
   - Names table: ENS / GNS / WNS reverse reads, plus the forward check of a
     name just returned. `computeId` is local. A name that did not fit falls
     back to RPC. Each names response also carries the ERC-6538 stealth
     registry and every `stealth-address-scheme-1` text record, and those
     `eth_call`s are answered from that list.
3. **Fallback clear RPC** — everything else (logs, chain metadata, other text
   records, typed names) is plaintext JSON-RPC to the node, still over Tor.
4. **Selective isolation** — bulk/metadata methods share a Tor circuit;
   address-bearing fallbacks are grouped by EOA onto isolated circuits.
5. **Multicall3 packing** — within each circuit group, eligible `eth_call` /
   `eth_getBalance` calls become one Multicall3 `aggregate3`; siblings
   (`eth_getLogs`, …) ride in the same Tor JSON-RPC POST.

## Construction

```rust,ignore
use kohaku_privacy_rpc::{PrivacyBuilder, connect_tor_pir};
use kohaku_tor_rpc::TorRpc;

let tor = TorRpc::connect().await?;
let provider = PrivacyBuilder::new("https://eth.example")?
    .tor(tor.clone())
    .pir_over_tor(
        "http://pir.example:18090",
        Some("http://pir.example:18091"),
        datasets,
    )
    .connect()
    .await?;
```

`pir_lookup(accounts, tokens, names, datasets)` accepts custom inspire crypto pools
(see `local-pir-rpc`). Omit `tokens` to leave ERC-20 `balanceOf` on fallback RPC
(still Multicall-packed). Omit `names` to leave primary-name calls on fallback RPC.

## Batch planning

One Alloy `RequestPacket` (single or batch) is classified once:

1. **Account PIR** — unique keys only; `eth_getBalance`, `eth_getTransactionCount`,
   and `eth_getCode` for the same address share one lookup and decode three fields
   from delegate ‖ balance ‖ nonce.
2. **Token PIR** — if a holder asks for any of the four default tokens, the
   orchestrator pads to **all four** PIR lookups (privacy). Extra tokens stay on
   fallback Multicall. `local-pir-rpc` wraps Tor PIR backends in a short TTL
   cache so sequential per-token HTTP calls reuse the padded results instead of
   re-fetching four Tor PIR lookups each time.
3. **Names PIR** — reverse reads for one address share one lookup. A name that
   did not fit is replayed to fallback RPC. `stealthMetaAddressOf` and
   `stealth-address-scheme-1` text reads use the registry and text list from
   the last names response (one names lookup loads them if none is cached).
   Any other text key, and a name this process did not return and that is not
   in the text list, stays on fallback RPC.
4. **Fallback** — group by isolation policy; each group is one Tor POST with
   Multicall3 + sibling RPCs. Groups run concurrently with the PIR lanes.

`eth_getLogs` is never folded into Multicall3; callers still chunk historical
ranges. Multiple already-chunked `eth_getLogs` can share one Shared Tor POST.

## Isolation policy

[`DefaultIsolationPolicy`](crate::DefaultIsolationPolicy) sends `eth_getLogs`
and chain metadata on the shared client; other fallbacks are
`Isolated { key: address }` (or `"_anon"`). Override with
[`PrivacyBuilder::isolation_policy`](crate::PrivacyBuilder::isolation_policy).

PIR traffic always uses the **shared** Tor client (query privacy is provided by
PIR; Tor anonymizes the client IP).
