#![cfg(test)]

use std::sync::Arc;

use alloy::rpc::json_rpc::{RequestPacket, ResponsePacket, ResponsePayload};
use kohaku_pir_rpc::{
    CallPath, LookupBackend, MapFallback, MapLookup, PIR_TOKENS, PirProviderError, PirRouter,
    StealthBroadcast, StealthEntry, balance_of_data_hex,
};
use serde_json::{Value, json};
use tower::Service;
use url::Url;

use crate::{
    DefaultIsolationPolicy, PrivacyBuilder, PrivacyTransport, SyncLookupAdapter, TorPirLookup,
    mock::{MockTorRpc, account_bytes, addr, addr_hex, serialize_req, storage_cell},
};

fn router() -> Arc<PirRouter> {
    Arc::new(PirRouter::mock(
        MapLookup::default(),
        MapFallback::default(),
        Vec::new(),
    ))
}

fn transport_with_sync_pir(lookup: MapLookup, tor: Arc<MockTorRpc>) -> PrivacyTransport {
    let async_lookup = Arc::new(SyncLookupAdapter::new(Arc::new(lookup)));
    PrivacyTransport::new(
        router(),
        Some(async_lookup.clone()),
        Some(async_lookup),
        None,
        tor,
        Url::parse("https://eth.example").unwrap(),
        Arc::new(DefaultIsolationPolicy),
        None,
    )
}

fn transport_with_dual_sync(
    accounts: MapLookup,
    tokens: MapLookup,
    tor: Arc<MockTorRpc>,
) -> PrivacyTransport {
    PrivacyTransport::new(
        router(),
        Some(Arc::new(SyncLookupAdapter::new(Arc::new(accounts)))),
        Some(Arc::new(SyncLookupAdapter::new(Arc::new(tokens)))),
        None,
        tor,
        Url::parse("https://eth.example").unwrap(),
        Arc::new(DefaultIsolationPolicy),
        None,
    )
}

fn transport_with_tor_pir(tor: Arc<MockTorRpc>) -> PrivacyTransport {
    let lookup = Arc::new(TorPirLookup::new(Arc::clone(&tor) as _, "https://pir.example").unwrap());
    PrivacyTransport::new(
        router(),
        Some(lookup.clone()),
        Some(lookup),
        None,
        tor,
        Url::parse("https://eth.example").unwrap(),
        Arc::new(DefaultIsolationPolicy),
        None,
    )
}

async fn call(mut t: PrivacyTransport, packet: RequestPacket) -> ResponsePacket {
    Service::call(&mut t, packet).await.unwrap()
}

fn success_values(packet: ResponsePacket) -> Vec<Value> {
    let resps = match packet {
        ResponsePacket::Single(r) => vec![r],
        ResponsePacket::Batch(rs) => rs,
    };
    resps
        .into_iter()
        .map(|r| match r.payload {
            ResponsePayload::Success(raw) => serde_json::from_str(raw.get()).unwrap(),
            ResponsePayload::Failure(err) => panic!("rpc failure: {err:?}"),
        })
        .collect()
}

#[tokio::test]
async fn pir_items_never_hit_ethereum_tor_rpc() {
    let lookup = MapLookup::default();
    lookup.insert(addr(1), account_bytes(99, 1));
    let tor = Arc::new(MockTorRpc::default());
    tor.set("eth_getBalance", json!("0xdead"));
    let t = transport_with_sync_pir(lookup, Arc::clone(&tor));
    let packet = RequestPacket::Single(serialize_req(
        "eth_getBalance",
        1,
        json!([addr_hex(1), "latest"]),
    ));
    let values = success_values(call(t, packet).await);
    assert_eq!(values[0], json!("0x63"));
    assert!(tor.shared_batches().is_empty());
    assert!(tor.isolated_batches().is_empty());
}

#[tokio::test]
async fn pir_over_tor_uses_shared_http_post() {
    let tor = Arc::new(MockTorRpc::default());
    tor.set_pir(addr(1), account_bytes(99, 1));
    tor.set("eth_getBalance", json!("0xdead"));
    let t = transport_with_tor_pir(Arc::clone(&tor));
    let packet = RequestPacket::Single(serialize_req(
        "eth_getBalance",
        1,
        json!([addr_hex(1), "latest"]),
    ));
    let values = success_values(call(t, packet).await);
    assert_eq!(values[0], json!("0x63"));
    assert_eq!(tor.http_post_count(), 1);
    assert!(
        tor.http_post_urls()[0].ends_with("/lookup"),
        "posts go to PIR /lookup"
    );
    assert!(tor.shared_batches().is_empty());
    assert!(tor.isolated_batches().is_empty());
}

#[tokio::test]
async fn one_item_batch_stays_a_json_array() {
    let lookup = MapLookup::default();
    lookup.insert(addr(1), account_bytes(99, 1));
    let tor = Arc::new(MockTorRpc::default());
    let t = transport_with_sync_pir(lookup, tor);
    let packet = RequestPacket::Batch(vec![serialize_req(
        "eth_getBalance",
        1,
        json!([addr_hex(1), "latest"]),
    )]);
    let out = call(t, packet).await;
    let ResponsePacket::Batch(items) = out else {
        panic!("one-item batch was returned as a single object");
    };
    assert_eq!(items.len(), 1);
}

#[tokio::test]
async fn account_balance_and_nonce_dedupe_one_lookup() {
    let lookup = MapLookup::default();
    lookup.insert(addr(1), account_bytes(10, 3));
    let tor = Arc::new(MockTorRpc::default());
    let t = transport_with_sync_pir(lookup, Arc::clone(&tor));
    let packet = RequestPacket::Batch(vec![
        serialize_req("eth_getBalance", 1, json!([addr_hex(1), "latest"])),
        serialize_req("eth_getTransactionCount", 2, json!([addr_hex(1), "latest"])),
    ]);
    let values = success_values(call(t, packet).await);
    assert_eq!(values[0], json!("0xa"));
    assert_eq!(values[1], json!("0x3"));
}

#[tokio::test]
async fn pir_over_tor_batches_keys_in_one_post() {
    let tor = Arc::new(MockTorRpc::default());
    tor.set_pir(addr(1), account_bytes(10, 1));
    tor.set_pir(addr(2), account_bytes(20, 2));
    let t = transport_with_tor_pir(Arc::clone(&tor));
    let packet = RequestPacket::Batch(vec![
        serialize_req("eth_getBalance", 1, json!([addr_hex(1), "latest"])),
        serialize_req("eth_getTransactionCount", 2, json!([addr_hex(2), "latest"])),
    ]);
    let values = success_values(call(t, packet).await);
    assert_eq!(values[0], json!("0xa"));
    assert_eq!(values[1], json!("0x2"));
    assert_eq!(
        tor.http_post_count(),
        1,
        "one shared Tor POST for the batch"
    );
}

#[tokio::test]
async fn builder_pir_over_tor_wires_lookup() {
    let tor = Arc::new(MockTorRpc::default());
    tor.set_pir(addr(3), account_bytes(7, 0));
    let transport = PrivacyBuilder::new("https://eth.example")
        .unwrap()
        .tor_backend(Arc::clone(&tor) as _)
        .pir_over_tor("https://pir.example", None, Vec::new())
        .build_transport()
        .unwrap();
    let packet = RequestPacket::Single(serialize_req(
        "eth_getBalance",
        1,
        json!([addr_hex(3), "latest"]),
    ));
    let values = success_values(call(transport, packet).await);
    assert_eq!(values[0], json!("0x7"));
    assert_eq!(tor.http_post_count(), 1);
}

#[tokio::test]
async fn shared_fallbacks_coalesce_to_one_batch() {
    let tor = Arc::new(MockTorRpc::default());
    tor.set("eth_blockNumber", json!("0x10"));
    tor.set("eth_chainId", json!("0x1"));
    let t = transport_with_sync_pir(MapLookup::default(), Arc::clone(&tor));
    let packet = RequestPacket::Batch(vec![
        serialize_req("eth_blockNumber", 1, json!([])),
        serialize_req("eth_chainId", 2, json!([])),
    ]);
    let values = success_values(call(t, packet).await);
    assert_eq!(values, vec![json!("0x10"), json!("0x1")]);
    let shared = tor.shared_batches();
    assert_eq!(shared.len(), 1);
    assert_eq!(shared[0].len(), 2);
    assert!(tor.isolated_batches().is_empty());
}

#[tokio::test]
async fn two_eoas_get_two_isolated_multicalls() {
    let tor = Arc::new(MockTorRpc::default());
    tor.set("eth_call", json!("0x01"));
    let t = transport_with_sync_pir(MapLookup::default(), Arc::clone(&tor));
    let packet = RequestPacket::Batch(vec![
        serialize_req(
            "eth_call",
            1,
            json!([{ "to": addr_hex(1), "data": "0xdeadbeef" }, "latest"]),
        ),
        serialize_req(
            "eth_call",
            2,
            json!([{ "to": addr_hex(2), "data": "0xdeadbeef" }, "latest"]),
        ),
    ]);
    let values = success_values(call(t, packet).await);
    assert_eq!(values[0], json!("0x01"));
    assert_eq!(values[1], json!("0x01"));
    assert!(tor.shared_batches().is_empty());
    assert_eq!(tor.isolated_batches().len(), 2);
    for batch in tor.isolated_batches() {
        assert_eq!(batch, vec!["eth_call".to_string()]);
    }
}

#[tokio::test]
async fn mixed_batch_preserves_order_with_tor_pir() {
    let tor = Arc::new(MockTorRpc::default());
    tor.set_pir(addr(7), account_bytes(5, 0));
    tor.set("eth_getLogs", json!([]));
    tor.set("eth_call", json!("0xabcdef"));
    let t = transport_with_tor_pir(Arc::clone(&tor));
    let packet = RequestPacket::Batch(vec![
        serialize_req("eth_getBalance", 1, json!([addr_hex(7), "latest"])),
        serialize_req("eth_getLogs", 2, json!([{}])),
        serialize_req(
            "eth_call",
            3,
            json!([{ "to": addr_hex(9), "data": "0x00" }, "latest"]),
        ),
    ]);
    let values = success_values(call(t, packet).await);
    assert_eq!(values[0], json!("0x5"));
    assert_eq!(values[1], json!([]));
    assert_eq!(values[2], json!("0xabcdef"));
    assert_eq!(tor.http_post_count(), 1);
    assert_eq!(tor.shared_batches().len(), 1);
    assert_eq!(tor.isolated_batches().len(), 1);
}

#[tokio::test]
async fn without_pir_all_methods_use_tor_rpc() {
    let tor = Arc::new(MockTorRpc::default());
    tor.set("eth_getBalance", json!("0xabc"));
    let t = PrivacyTransport::new(
        router(),
        None,
        None,
        None,
        Arc::clone(&tor) as Arc<dyn crate::TorRpcBackend>,
        Url::parse("https://eth.example").unwrap(),
        Arc::new(DefaultIsolationPolicy),
        None,
    );
    let packet = RequestPacket::Single(serialize_req(
        "eth_getBalance",
        1,
        json!([addr_hex(1), "latest"]),
    ));
    let values = success_values(call(t, packet).await);
    assert_eq!(values[0], json!("0xabc"));
    // eth_getBalance packs into Multicall3 eth_call on isolated circuit
    assert_eq!(tor.isolated_batches().len(), 1);
    assert_eq!(tor.isolated_batches()[0], vec!["eth_call".to_string()]);
    assert_eq!(tor.http_post_count(), 0);
}

#[tokio::test]
async fn usdc_balance_of_uses_token_pir_and_pads_four() {
    let holder = addr(5);
    let accounts = MapLookup::default();
    let tokens = MapLookup::default();
    let mut word = [0u8; 32];
    word[31] = 7;
    for token in &PIR_TOKENS {
        tokens.insert(token.balance_key(&holder).as_slice(), storage_cell(word));
    }
    let tor = Arc::new(MockTorRpc::default());
    tor.set("eth_call", json!("0xdead"));
    let t = transport_with_dual_sync(accounts, tokens, Arc::clone(&tor));

    let data = balance_of_data_hex(&holder);
    let packet = RequestPacket::Single(serialize_req(
        "eth_call",
        1,
        json!([{ "to": PIR_TOKENS[0].address, "data": data }, "latest"]),
    ));
    let values = success_values(call(t, packet).await);
    let mut expected = [0u8; 32];
    expected[31] = 7;
    assert_eq!(values[0], json!(format!("0x{}", hex::encode(expected))));
    // No fallback Tor RPC — padding stays on PIR
    assert!(tor.isolated_batches().is_empty());
    assert!(tor.shared_batches().is_empty());
}

#[tokio::test]
async fn get_code_comes_from_the_account_lookup() {
    let lookup = MapLookup::default();
    let delegate = [0x11; 20];
    let mut value = account_bytes(4, 2);
    value[..20].copy_from_slice(&delegate);
    lookup.insert(addr(1), value);
    let tor = Arc::new(MockTorRpc::default());
    tor.set("eth_getCode", json!("0x6080"));
    let batches = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recording = Arc::new(CountingLookup {
        inner: lookup,
        batches: Arc::clone(&batches),
    });
    let t = PrivacyTransport::new(
        router(),
        Some(Arc::new(SyncLookupAdapter::new(recording))),
        None,
        None,
        Arc::clone(&tor) as Arc<dyn crate::TorRpcBackend>,
        Url::parse("https://eth.example").unwrap(),
        Arc::new(DefaultIsolationPolicy),
        None,
    );
    let packet = RequestPacket::Batch(vec![
        serialize_req("eth_getBalance", 1, json!([addr_hex(1), "latest"])),
        serialize_req("eth_getTransactionCount", 2, json!([addr_hex(1), "latest"])),
        serialize_req("eth_getCode", 3, json!([addr_hex(1), "latest"])),
    ]);
    let values = success_values(call(t, packet).await);
    assert_eq!(values[0], json!("0x4"));
    assert_eq!(values[1], json!("0x2"));
    let mut code = vec![0xef, 0x01, 0x00];
    code.extend_from_slice(&delegate);
    assert_eq!(values[2], json!(format!("0x{}", hex::encode(code))));
    assert!(tor.isolated_batches().is_empty());
    assert!(tor.shared_batches().is_empty());
    assert_eq!(
        batches.lock().unwrap().as_slice(),
        &[1],
        "balance, nonce, and code share one account lookup"
    );
}

#[tokio::test]
async fn stealth_meta_stays_off_fallback_rpc() {
    let names = MapLookup::default();
    let meta = vec![0x02, 0xab];
    *names.stealth.lock().unwrap() = Some(StealthBroadcast {
        registry: vec![StealthEntry {
            registrant: addr(4),
            scheme_id: 1,
            meta: meta.clone(),
        }],
        texts: vec![],
    });
    let tor = Arc::new(MockTorRpc::default());
    tor.set("eth_call", json!("0xdead"));
    let t = PrivacyTransport::new(
        router(),
        Some(Arc::new(SyncLookupAdapter::new(Arc::new(
            MapLookup::default(),
        )))),
        None,
        Some(Arc::new(SyncLookupAdapter::new(Arc::new(names)))),
        Arc::clone(&tor) as Arc<dyn crate::TorRpcBackend>,
        Url::parse("https://eth.example").unwrap(),
        Arc::new(DefaultIsolationPolicy),
        None,
    );
    let mut data = vec![0x7a, 0xa8, 0xb5, 0xad];
    let mut registrant = [0u8; 32];
    registrant[12..].copy_from_slice(&addr(4));
    data.extend_from_slice(&registrant);
    let mut scheme = [0u8; 32];
    scheme[31] = 1;
    data.extend_from_slice(&scheme);
    let params = json!([{
        "to": "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538",
        "data": format!("0x{}", hex::encode(&data))
    }, "latest"]);
    let (first, traces) = t
        .call_logged(RequestPacket::Single(serialize_req(
            "eth_call",
            1,
            params.clone(),
        )))
        .await
        .unwrap();
    assert_eq!(traces[0].path, CallPath::Pir);
    let (second, traces) = t
        .call_logged(RequestPacket::Single(serialize_req("eth_call", 2, params)))
        .await
        .unwrap();
    assert_eq!(traces[0].path, CallPath::Local);
    let first_values = success_values(first);
    assert_eq!(first_values, success_values(second));
    assert_ne!(first_values[0], json!("0xdead"));
    assert!(tor.isolated_batches().is_empty());
    assert!(tor.shared_batches().is_empty());
}

struct CountingLookup {
    inner: MapLookup,
    batches: Arc<std::sync::Mutex<Vec<usize>>>,
}

impl LookupBackend for CountingLookup {
    fn lookup(&self, key: &[u8]) -> Result<Option<Vec<u8>>, PirProviderError> {
        self.inner.lookup(key)
    }

    fn lookup_batch(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>, PirProviderError> {
        self.batches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(keys.len());
        self.inner.lookup_batch(keys)
    }
}
