#![cfg(test)]

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use alloy::{
    primitives::{U256, hex},
    rpc::json_rpc::{
        Id, Request, RequestPacket, Response, ResponsePacket, ResponsePayload, SerializedRequest,
    },
    sol_types::SolCall,
    transports::{TransportError, TransportErrorKind},
};
use async_trait::async_trait;
use serde_json::{Value, json};
use url::Url;

use crate::TorRpcBackend;
use crate::multicall::{MULTICALL3, Multicall3, encode_aggregate3_results};

#[derive(Default)]
pub struct MockTorRpc {
    pub shared_batches: Mutex<Vec<Vec<String>>>,
    pub isolated_batches: Mutex<Vec<Vec<String>>>,
    pub http_posts: Mutex<Vec<(String, Vec<u8>)>>,
    /// method → result for JSON-RPC (used for siblings and as eth_call return data)
    pub results: Mutex<HashMap<String, Value>>,
    /// PIR key hex (no 0x) → value bytes for `/lookup` over Tor HTTP
    pub pir_entries: Mutex<HashMap<String, Vec<u8>>>,
}

impl MockTorRpc {
    pub fn set(&self, method: impl Into<String>, result: Value) {
        self.results
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(method.into(), result);
    }

    pub fn set_pir(&self, key: impl AsRef<[u8]>, value: impl AsRef<[u8]>) {
        self.pir_entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(hex::encode(key.as_ref()), value.as_ref().to_vec());
    }

    pub fn shared_batches(&self) -> Vec<Vec<String>> {
        self.shared_batches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn isolated_batches(&self) -> Vec<Vec<String>> {
        self.isolated_batches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn http_post_count(&self) -> usize {
        self.http_posts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    pub fn http_post_urls(&self) -> Vec<String> {
        self.http_posts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|(u, _)| u.clone())
            .collect()
    }

    async fn answer(&self, packet: RequestPacket) -> Result<ResponsePacket, TransportError> {
        let reqs: Vec<SerializedRequest> = match packet {
            RequestPacket::Single(r) => vec![r],
            RequestPacket::Batch(rs) => rs,
        };
        let mut out = Vec::with_capacity(reqs.len());
        for req in reqs {
            let method = req.method().to_string();
            let id = req.id().clone();
            let params: Value = req
                .params()
                .map(|raw| serde_json::from_str(raw.get()).unwrap_or(Value::Null))
                .unwrap_or(Value::Null);

            let value = if method == "eth_call" && is_multicall3(&params) {
                answer_multicall(&self.results, &params)?
            } else {
                self.results
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(&method)
                    .cloned()
                    .unwrap_or_else(|| json!("0xmock"))
            };
            let raw =
                serde_json::value::to_raw_value(&value).map_err(TransportErrorKind::custom)?;
            out.push(Response {
                id,
                payload: ResponsePayload::Success(raw),
            });
        }
        if out.len() == 1 {
            Ok(ResponsePacket::Single(out.pop().expect("len")))
        } else {
            Ok(ResponsePacket::Batch(out))
        }
    }

    fn answer_pir_lookup(&self, body: &[u8]) -> Result<Vec<u8>, String> {
        let req: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
        let keys = req
            .get("keys")
            .and_then(Value::as_array)
            .ok_or_else(|| "missing keys".to_string())?;
        let entries = self
            .pir_entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let values: Vec<Value> = keys
            .iter()
            .map(|k| {
                let s = k.as_str().unwrap_or("");
                let raw = s
                    .strip_prefix("0x")
                    .or_else(|| s.strip_prefix("0X"))
                    .unwrap_or(s);
                match entries.get(raw) {
                    Some(v) => Value::String(format!("0x{}", hex::encode(v))),
                    None => Value::Null,
                }
            })
            .collect();
        serde_json::to_vec(&json!({ "values": values })).map_err(|e| e.to_string())
    }
}

fn is_multicall3(params: &Value) -> bool {
    let Some(obj) = params.as_array().and_then(|a| a.first()) else {
        return false;
    };
    let Some(to) = obj.get("to").and_then(Value::as_str) else {
        return false;
    };
    let raw = to
        .strip_prefix("0x")
        .or_else(|| to.strip_prefix("0X"))
        .unwrap_or(to);
    let Ok(bytes) = hex::decode(raw) else {
        return false;
    };
    bytes.as_slice() == MULTICALL3.as_slice()
}

fn answer_multicall(
    results: &Mutex<HashMap<String, Value>>,
    params: &Value,
) -> Result<Value, TransportError> {
    let data_hex = params
        .as_array()
        .and_then(|a| a.first())
        .and_then(|o| o.get("data").or_else(|| o.get("input")))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            TransportErrorKind::custom(crate::PrivacyError::Transport(
                "multicall missing data".into(),
            ))
        })?;
    let raw = data_hex
        .strip_prefix("0x")
        .or_else(|| data_hex.strip_prefix("0X"))
        .unwrap_or(data_hex);
    let bytes = hex::decode(raw).map_err(TransportErrorKind::custom)?;
    let decoded = Multicall3::aggregate3Call::abi_decode(&bytes).map_err(|e| {
        TransportErrorKind::custom(crate::PrivacyError::Transport(format!(
            "mock multicall decode: {e}"
        )))
    })?;

    let map = results.lock().unwrap_or_else(PoisonError::into_inner);
    let eth_call_default = map
        .get("eth_call")
        .cloned()
        .unwrap_or_else(|| json!("0x01"));
    let eth_bal_default = map
        .get("eth_getBalance")
        .cloned()
        .unwrap_or_else(|| json!("0x0"));

    let get_bal_sel = &Multicall3::getEthBalanceCall::SELECTOR;

    let mut out = Vec::with_capacity(decoded.calls.len());
    for call in &decoded.calls {
        let return_data = if call.target == MULTICALL3
            && call.callData.len() >= 4
            && call.callData[..4] == get_bal_sel[..]
        {
            let qty = eth_bal_default.as_str().unwrap_or("0x0");
            word_from_quantity(qty)
        } else {
            let hex_str = eth_call_default.as_str().unwrap_or("0x");
            let raw = hex_str
                .strip_prefix("0x")
                .or_else(|| hex_str.strip_prefix("0X"))
                .unwrap_or(hex_str);
            hex::decode(raw).unwrap_or_default()
        };
        out.push((true, return_data));
    }
    Ok(Value::String(encode_aggregate3_results(&out)))
}

fn word_from_quantity(qty: &str) -> Vec<u8> {
    let raw = qty
        .strip_prefix("0x")
        .or_else(|| qty.strip_prefix("0X"))
        .unwrap_or(qty);
    let n = U256::from_str_radix(raw, 16).unwrap_or(U256::ZERO);
    n.to_be_bytes::<32>().to_vec()
}

#[async_trait]
impl TorRpcBackend for MockTorRpc {
    async fn send_shared(
        &self,
        _url: Url,
        packet: RequestPacket,
    ) -> Result<ResponsePacket, TransportError> {
        let methods: Vec<String> = packet
            .requests()
            .iter()
            .map(|r| r.method().to_string())
            .collect();
        self.shared_batches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(methods);
        self.answer(packet).await
    }

    async fn send_isolated(
        &self,
        _url: Url,
        packet: RequestPacket,
    ) -> Result<ResponsePacket, TransportError> {
        let methods: Vec<String> = packet
            .requests()
            .iter()
            .map(|r| r.method().to_string())
            .collect();
        self.isolated_batches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(methods);
        self.answer(packet).await
    }

    async fn http_post(
        &self,
        url: &Url,
        _headers: &[(String, String)],
        body: &[u8],
    ) -> Result<Vec<u8>, String> {
        self.http_posts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((url.to_string(), body.to_vec()));
        if url.path().ends_with("/lookup") {
            return self.answer_pir_lookup(body);
        }
        Ok(Vec::new())
    }
}

pub fn serialize_req(method: &'static str, id: u64, params: Value) -> SerializedRequest {
    Request::new(method, Id::Number(id), params)
        .serialize()
        .expect("serialize request")
}

pub fn account_bytes(balance: u128, nonce: u64) -> Vec<u8> {
    let mut v = vec![0u8; 40];
    let be = balance.to_be_bytes();
    v[20..32].copy_from_slice(&be[4..]);
    v[32..40].copy_from_slice(&nonce.to_be_bytes());
    v
}

pub fn storage_cell(word: [u8; 32]) -> Vec<u8> {
    let mut v = vec![0u8; 40];
    v[8..].copy_from_slice(&word);
    v
}

pub fn addr(n: u8) -> [u8; 20] {
    let mut a = [0u8; 20];
    a[19] = n;
    a
}

pub fn addr_hex(n: u8) -> String {
    format!("0x{}", hex::encode(addr(n)))
}
