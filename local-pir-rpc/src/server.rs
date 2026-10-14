use std::borrow::Cow;
use std::sync::Arc;
use std::time::{Duration, Instant};

use alloy::rpc::json_rpc::{
    ErrorPayload, Id, Request, RequestPacket, Response, ResponsePacket, ResponsePayload,
};
use alloy::transports::TransportError;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use kohaku_pir_rpc::{CallPath, CallTrace, PirTransport};
use kohaku_privacy_rpc::PrivacyTransport;
use serde_json::{json, Value};
use tracing::info;

/// JSON-RPC backend: Tor+PIR orchestrator or clearnet pir-rpc.
#[derive(Clone)]
pub enum Backend {
    /// All egress via Tor ([`PrivacyTransport`]).
    Tor(PrivacyTransport),
    /// Clearnet PIR + clearnet fallback RPC ([`PirTransport`]).
    Clearnet(PirTransport),
}

impl Backend {
    async fn call(
        &self,
        packet: RequestPacket,
    ) -> Result<(ResponsePacket, Vec<CallTrace>), TransportError> {
        match self {
            Self::Tor(t) => t.call_logged(packet).await,
            Self::Clearnet(t) => t.call_logged(packet).await,
        }
    }
}

pub type AppState = Arc<Backend>;

pub async fn handle_rpc(
    State(backend): State<AppState>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    let Json(body) = match body {
        Ok(j) => j,
        Err(e) => {
            return (
                StatusCode::OK,
                Json(json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": format!("parse error: {e}") }
                })),
            )
                .into_response();
        }
    };

    let packet = match json_to_packet(&body) {
        Ok(p) => p,
        Err(msg) => {
            return (
                StatusCode::OK,
                Json(json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32600, "message": msg }
                })),
            )
                .into_response();
        }
    };

    let start = Instant::now();
    let (resp, traces) = match backend.call(packet).await {
        Ok(out) => out,
        Err(e) => {
            let elapsed = start.elapsed();
            info!("error  {}  {e}", format_elapsed(elapsed));
            return (
                StatusCode::OK,
                Json(json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32603, "message": e.to_string() }
                })),
            )
                .into_response();
        }
    };

    log_traces(&traces, &call_hints(&body), start.elapsed());

    (StatusCode::OK, Json(packet_to_json(resp))).into_response()
}

fn log_traces(traces: &[CallTrace], hints: &[String], elapsed: Duration) {
    let hint = |i: usize| hints.get(i).map(String::as_str).unwrap_or("");
    if traces.len() <= 1 {
        for (i, trace) in traces.iter().enumerate() {
            info!(
                "{}  {}  {}{}",
                trace.method,
                path_word(trace.path),
                format_elapsed(elapsed),
                hint(i)
            );
        }
        return;
    }
    info!("batch {}  {}", traces.len(), format_elapsed(elapsed));
    for (i, trace) in traces.iter().enumerate() {
        info!("  {}  {}{}", trace.method, path_word(trace.path), hint(i));
    }
}

/// One hint per JSON-RPC item. Empty except for `eth_call`, which names the
/// function and the contract so a lone fallback can be told apart.
fn call_hints(body: &Value) -> Vec<String> {
    let items: Vec<&Value> = match body.as_array() {
        Some(items) => items.iter().collect(),
        None => vec![body],
    };
    items.into_iter().map(eth_call_hint).collect()
}

fn eth_call_hint(item: &Value) -> String {
    if item.get("method").and_then(Value::as_str) != Some("eth_call") {
        return String::new();
    }
    let Some(call) = item
        .get("params")
        .and_then(Value::as_array)
        .and_then(|params| params.first())
    else {
        return String::new();
    };
    let to = call.get("to").and_then(Value::as_str).unwrap_or("?");
    let data = call.get("data").and_then(Value::as_str).unwrap_or("");
    let calldata = decode_hex(data);
    let selector = calldata.get(..4).unwrap_or(&[]);
    let mut hint = format!("  {}  {to}", selector_name(selector));
    if let Some(extra) = call_extra(selector, &calldata) {
        hint = format!("  {}  {extra}  {to}", selector_name(selector));
    }
    hint
}

fn selector_name(selector: &[u8]) -> String {
    match selector {
        [0x70, 0xa0, 0x82, 0x31] => "balanceOf".to_string(),
        [0xb7, 0xd6, 0xca, 0x64] => "reverseWithGateways".to_string(),
        [0x9a, 0xf8, 0xb7, 0xaa] => "reverseResolve".to_string(),
        [0xfb, 0x02, 0x19, 0x39] => "computeId".to_string(),
        [0x4f, 0x89, 0x6d, 0x4f] => "resolve".to_string(),
        [0xa1, 0x47, 0x28, 0x44] => "resolveWithGateways".to_string(),
        [0x59, 0xd1, 0xd4, 0x3c] | [0x30, 0x8e, 0x33, 0x86] => "text".to_string(),
        [0x7a, 0xa8, 0xb5, 0xad] => "stealthMetaAddressOf".to_string(),
        other => format!("0x{}", hex::encode(other)),
    }
}

fn call_extra(selector: &[u8], calldata: &[u8]) -> Option<String> {
    match selector {
        [0x59, 0xd1, 0xd4, 0x3c] | [0x30, 0x8e, 0x33, 0x86] => abi_string_arg(calldata),
        [0xa1, 0x47, 0x28, 0x44] => resolve_gateways_extra(calldata),
        _ => None,
    }
}

/// `text` key inside `resolveWithGateways`, or `addr` when the inner call is `addr`.
fn resolve_gateways_extra(calldata: &[u8]) -> Option<String> {
    if let Some(at) = find_subslice(calldata, &[0x59, 0xd1, 0xd4, 0x3c]) {
        return abi_string_arg(&calldata[at..]).or(Some("text".to_string()));
    }
    if find_subslice(calldata, &[0x3b, 0x3b, 0x57, 0xde]).is_some() {
        return Some("addr".to_string());
    }
    None
}

/// First dynamic `string` argument of a call whose head is `[static][offset]`.
fn abi_string_arg(calldata: &[u8]) -> Option<String> {
    let offset = word_usize(calldata.get(4 + 32..4 + 64)?)?;
    let start = 4 + offset;
    let len = word_usize(calldata.get(start..start + 32)?)?;
    let bytes = calldata.get(start + 32..start + 32 + len)?;
    let text = std::str::from_utf8(bytes).ok()?;
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_graphic() || c == ' ') {
        return None;
    }
    Some(text.to_string())
}

fn word_usize(word: &[u8]) -> Option<usize> {
    if word.len() != 32 || word[..24].iter().any(|b| *b != 0) {
        return None;
    }
    usize::try_from(u64::from_be_bytes(word[24..].try_into().ok()?)).ok()
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len())
        .position(|window| window == needle)
}

fn decode_hex(data: &str) -> Vec<u8> {
    let hex_str = data.strip_prefix("0x").unwrap_or(data);
    if hex_str.len() % 2 != 0 {
        return Vec::new();
    }
    hex::decode(hex_str).unwrap_or_default()
}

fn path_word(path: CallPath) -> &'static str {
    match path {
        CallPath::Pir => "pir",
        CallPath::Fallback => "fallback",
        CallPath::Local => "local",
    }
}

/// `312ms` under a second, otherwise one decimal second (`1.4s`).
fn format_elapsed(elapsed: Duration) -> String {
    let secs = elapsed.as_secs_f64();
    if secs < 1.0 {
        format!("{:.0}ms", secs * 1000.0)
    } else {
        format!("{secs:.1}s")
    }
}

fn json_to_packet(body: &Value) -> Result<RequestPacket, String> {
    if let Some(arr) = body.as_array() {
        let mut reqs = Vec::with_capacity(arr.len());
        for item in arr {
            reqs.push(json_to_serialized(item)?);
        }
        return Ok(RequestPacket::Batch(reqs));
    }
    Ok(RequestPacket::Single(json_to_serialized(body)?))
}

fn json_to_serialized(obj: &Value) -> Result<alloy::rpc::json_rpc::SerializedRequest, String> {
    let method = obj
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing method".to_string())?;
    let id = parse_id(obj.get("id").unwrap_or(&Value::Null))?;
    let params = obj.get("params").cloned().unwrap_or(Value::Array(vec![]));
    let params_raw = serde_json::value::to_raw_value(&params).map_err(|e| e.to_string())?;
    Request::new(Cow::Owned(method.to_string()), id, params_raw)
        .serialize()
        .map_err(|e| e.to_string())
}

fn parse_id(v: &Value) -> Result<Id, String> {
    match v {
        Value::Null => Ok(Id::None),
        Value::Number(n) => n
            .as_u64()
            .map(Id::Number)
            .ok_or_else(|| "id number out of range".to_string()),
        Value::String(s) => Ok(Id::String(s.clone().into())),
        _ => Err("invalid json-rpc id".into()),
    }
}

fn packet_to_json(packet: ResponsePacket) -> Value {
    match packet {
        ResponsePacket::Single(r) => response_to_json(r),
        ResponsePacket::Batch(rs) => Value::Array(rs.into_iter().map(response_to_json).collect()),
    }
}

fn response_to_json(r: Response) -> Value {
    let id = id_to_json(&r.id);
    match r.payload {
        ResponsePayload::Success(raw) => {
            let result: Value = serde_json::from_str(raw.get()).unwrap_or(Value::Null);
            json!({ "jsonrpc": "2.0", "id": id, "result": result })
        }
        ResponsePayload::Failure(ErrorPayload { code, message, .. }) => {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": message.as_ref() }
            })
        }
    }
}

fn id_to_json(id: &Id) -> Value {
    match id {
        Id::None => Value::Null,
        Id::Number(n) => json!(n),
        Id::String(s) => Value::String(s.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(to: &str, data: &str) -> Value {
        json!({
            "method": "eth_call",
            "params": [{ "to": to, "data": data }, "latest"]
        })
    }

    #[test]
    fn names_the_stealth_registry_call() {
        let item = call("0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538", "0x7aa8b5ad");
        assert_eq!(
            eth_call_hint(&item),
            "  stealthMetaAddressOf  0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538"
        );
    }

    #[test]
    fn names_a_text_record_key() {
        let mut data = vec![0x30, 0x8e, 0x33, 0x86];
        data.extend(std::iter::repeat_n(0, 32));
        let mut offset = vec![0u8; 32];
        offset[31] = 0x40;
        data.extend(offset);
        let key = b"stealth-address-scheme-1";
        let mut len = vec![0u8; 32];
        len[31] = u8::try_from(key.len()).unwrap();
        data.extend(len);
        data.extend(key);
        let item = call(
            "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6",
            &format!("0x{}", hex::encode(data)),
        );
        assert_eq!(
            eth_call_hint(&item),
            "  text  stealth-address-scheme-1  0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6"
        );
    }

    #[test]
    fn leaves_other_methods_blank() {
        let body = json!([
            { "method": "eth_getBalance", "params": ["0x1", "latest"] },
            {
                "method": "eth_call",
                "params": [{
                    "to": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                    "data": "0x70a08231"
                }, "latest"]
            }
        ]);
        let hints = call_hints(&body);
        assert_eq!(hints[0], "");
        assert_eq!(
            hints[1],
            "  balanceOf  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
        );
    }
}
