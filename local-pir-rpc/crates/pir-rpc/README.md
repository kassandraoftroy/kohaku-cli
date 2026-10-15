# kohaku-pir-rpc

Dual-endpoint Ethereum JSON-RPC provider. A small allowlist of
methods is answered via a [`LookupBackend`] (private PIR lookup). Everything
else is forwarded to a normal Ethereum node.

```text
get_balance / get_transaction_count / get_code
        → account LookupBackend (one lookup; delegate ‖ balance ‖ nonce)
balanceOf(USDC|USDT|DAI|WETH)
        → token LookupBackend (inspire storage table), if configured
primary name reverse (ENS / GNS / WNS)
        → names LookupBackend, if configured
computeId
        → local namehash
stealthMetaAddressOf / stealth-address-scheme-1 text
        → last names sidecar (one names lookup if it is not cached yet)
matched eth_call (manifest)
        → account LookupBackend
everything else (eth_getLogs, other eth_call, other text records, …)
        → fallback JSON-RPC
```

This crate does **not** depend on inspire-gpu-serving. Wire `pir_client::PirClient`
in the binary that talks to a remote PIR HTTP API:

```rust,ignore
use std::sync::{Arc, Mutex};
use kohaku_pir_rpc::{LookupBackend, PirConnect, PirProviderError, PirRouter};
use pir_client::PirClient;

struct PirLookup(Mutex<PirClient>);

impl LookupBackend for PirLookup {
    fn lookup(&self, key: &[u8]) -> Result<Option<Vec<u8>>, PirProviderError> {
        let mut client = self.0.lock().unwrap();
        client
            .lookup(key)
            .map(|found| found.map(|l| l.value))
            .map_err(PirProviderError::Client)
    }
}

let client = PirClient::connect("https://pir.example:8080")?;
let router = PirRouter::with_rpc(
    Arc::new(PirLookup(Mutex::new(client))),
    "https://eth.example",
    Vec::new(),
)?;
let provider = ProviderBuilder::default()
    .connect_with(&PirConnect::new(Arc::new(router)))
    .await?;
```

## `eth_call` routing

PIR cannot run the EVM. A matched static call means the client recognizes
`(to, selector)`, derives a PIR key from the dataset advertisement on
`/manifest`, looks the key up, and ABI-encodes the bytes.

Unknown `(to, selector)` stays on the fallback RPC.

## Privacy

A PIR miss is proven non-membership in **this** database. Allowlisted methods
do **not** silently fall back — that would leak the address to the RPC node.
Missing accounts return `0x0`.
