//! Pack fallback JSON-RPC calls into Multicall3 `aggregate3` + sibling RPCs.

use std::borrow::Cow;

use alloy::transports::{TransportError, TransportErrorKind};
use alloy::{
    primitives::{Address, Bytes, U256, address, hex},
    rpc::json_rpc::{
        ErrorPayload, Id, Request, RequestPacket, Response, ResponsePacket, ResponsePayload,
        SerializedRequest,
    },
    sol,
    sol_types::SolCall,
};
use serde_json::{Value, json};

use crate::PrivacyError;

/// Canonical Multicall3 deployment (same address on most EVM chains).
pub const MULTICALL3: Address = address!("0xcA11bde05977b3631167028862bE2a173976CA11");

sol! {
    #[derive(Debug)]
    interface Multicall3 {
        struct Call3 {
            address target;
            bool allowFailure;
            bytes callData;
        }
        struct Result {
            bool success;
            bytes returnData;
        }
        function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData);
        function getEthBalance(address addr) external view returns (uint256 balance);
    }
}

/// One fallback job ready for packing.
pub struct FallbackJob {
    pub idx: usize,
    pub req: SerializedRequest,
    pub method: String,
    pub params: Value,
}

enum WirePart {
    Multicall {
        /// Original job indices in Call3 order.
        indices: Vec<usize>,
        /// Whether each call was `eth_getBalance` (quantity) vs `eth_call` (bytes).
        as_balance: Vec<bool>,
    },
    Sibling {
        idx: usize,
        req: SerializedRequest,
    },
}

/// Build a single Tor POST packet: optional Multicall3 `eth_call` + sibling RPCs.
pub fn pack_circuit_group(
    jobs: Vec<FallbackJob>,
) -> Result<(RequestPacket, PackedGroup), TransportError> {
    let mut multicall_indices = Vec::new();
    let mut as_balance = Vec::new();
    let mut calls = Vec::new();
    let mut siblings = Vec::new();

    for job in jobs {
        match classify_for_multicall(&job.method, &job.params) {
            Some(McCall::EthCall { target, data }) => {
                multicall_indices.push(job.idx);
                as_balance.push(false);
                calls.push(Multicall3::Call3 {
                    target,
                    allowFailure: true,
                    callData: data,
                });
            }
            Some(McCall::EthBalance { addr }) => {
                multicall_indices.push(job.idx);
                as_balance.push(true);
                calls.push(Multicall3::Call3 {
                    target: MULTICALL3,
                    allowFailure: true,
                    callData: Bytes::from(Multicall3::getEthBalanceCall { addr }.abi_encode()),
                });
            }
            None => siblings.push(WirePart::Sibling {
                idx: job.idx,
                req: job.req,
            }),
        }
    }

    let mut wire: Vec<SerializedRequest> = Vec::new();
    let mut parts: Vec<WirePart> = Vec::new();

    if !calls.is_empty() {
        let calldata = Multicall3::aggregate3Call { calls }.abi_encode();
        let to = format!("0x{}", hex::encode(MULTICALL3));
        let params = json!([
            {
                "to": to,
                "data": format!("0x{}", hex::encode(&calldata)),
            },
            "latest"
        ]);
        let req = Request::new("eth_call", Id::Number(u64::MAX / 2), params)
            .serialize()
            .map_err(TransportErrorKind::custom)?;
        parts.push(WirePart::Multicall {
            indices: multicall_indices,
            as_balance,
        });
        wire.push(req);
    }

    for s in siblings {
        if let WirePart::Sibling { idx: _, req } = &s {
            wire.push(req.clone());
        }
        parts.push(s);
    }

    let packet = if wire.len() == 1 {
        RequestPacket::Single(wire.into_iter().next().expect("len"))
    } else {
        RequestPacket::Batch(wire)
    };

    Ok((packet, PackedGroup { parts }))
}

/// Mapping from a Tor response packet back to original job indices.
pub struct PackedGroup {
    parts: Vec<WirePart>,
}

impl PackedGroup {
    /// Unpack Tor JSON-RPC responses into `(original_idx, Response)` pairs.
    pub fn unpack(
        &self,
        resp_packet: ResponsePacket,
    ) -> Result<Vec<(usize, Response)>, TransportError> {
        let responses = match resp_packet {
            ResponsePacket::Single(r) => vec![r],
            ResponsePacket::Batch(rs) => rs,
        };
        if responses.len() != self.parts.len() {
            return Err(TransportErrorKind::custom(PrivacyError::Transport(
                format!(
                    "RPC returned {} responses for {} packed parts",
                    responses.len(),
                    self.parts.len()
                ),
            )));
        }

        let mut out = Vec::new();
        for (part, resp) in self.parts.iter().zip(responses) {
            match part {
                WirePart::Sibling { idx, .. } => {
                    out.push((*idx, resp));
                }
                WirePart::Multicall {
                    indices,
                    as_balance,
                    ..
                } => {
                    out.extend(unpack_multicall(
                        resp,
                        indices.as_slice(),
                        as_balance.as_slice(),
                    )?);
                }
            }
        }
        Ok(out)
    }
}

enum McCall {
    EthCall { target: Address, data: Bytes },
    EthBalance { addr: Address },
}

fn classify_for_multicall(method: &str, params: &Value) -> Option<McCall> {
    match method {
        "eth_call" => {
            let obj = params.as_array()?.first()?;
            let to = parse_address(obj.get("to")?.as_str()?)?;
            let data_hex = obj.get("data").or_else(|| obj.get("input"))?.as_str()?;
            let data = parse_bytes(data_hex)?;
            Some(McCall::EthCall {
                target: Address::from(to),
                data: Bytes::from(data),
            })
        }
        "eth_getBalance" => {
            let addr = parse_address(params.as_array()?.first()?.as_str()?)?;
            Some(McCall::EthBalance {
                addr: Address::from(addr),
            })
        }
        _ => None,
    }
}

fn unpack_multicall(
    resp: Response,
    indices: &[usize],
    as_balance: &[bool],
) -> Result<Vec<(usize, Response)>, TransportError> {
    let id_template = resp.id.clone();
    match resp.payload {
        ResponsePayload::Failure(err) => {
            // Entire multicall failed — fan out the same error.
            Ok(indices
                .iter()
                .map(|&idx| {
                    (
                        idx,
                        Response {
                            id: id_template.clone(),
                            payload: ResponsePayload::Failure(err.clone()),
                        },
                    )
                })
                .collect())
        }
        ResponsePayload::Success(raw) => {
            let hex_str: String =
                serde_json::from_str(raw.get()).map_err(TransportErrorKind::custom)?;
            let bytes = parse_bytes(&hex_str).ok_or_else(|| {
                TransportErrorKind::custom(PrivacyError::Transport(
                    "multicall result is not hex".into(),
                ))
            })?;
            let decoded = Multicall3::aggregate3Call::abi_decode_returns(&bytes).map_err(|e| {
                TransportErrorKind::custom(PrivacyError::Transport(format!(
                    "multicall decode: {e}"
                )))
            })?;
            if decoded.len() != indices.len() {
                return Err(TransportErrorKind::custom(PrivacyError::Transport(
                    format!(
                        "multicall returned {} results for {} calls",
                        decoded.len(),
                        indices.len()
                    ),
                )));
            }
            let mut out = Vec::with_capacity(indices.len());
            for (i, result) in decoded.into_iter().enumerate() {
                let idx = indices[i];
                let resp = if result.success {
                    let value = if as_balance[i] {
                        quantity_from_word(result.returnData.as_ref())
                    } else {
                        format!("0x{}", hex::encode(result.returnData.as_ref()))
                    };
                    let raw = serde_json::value::to_raw_value(&Value::String(value))
                        .map_err(TransportErrorKind::custom)?;
                    Response {
                        id: id_template.clone(),
                        payload: ResponsePayload::Success(raw),
                    }
                } else {
                    Response {
                        id: id_template.clone(),
                        payload: ResponsePayload::Failure(ErrorPayload {
                            code: -32000,
                            message: Cow::Owned(format!(
                                "multicall subcall failed: 0x{}",
                                hex::encode(result.returnData.as_ref())
                            )),
                            data: None,
                        }),
                    }
                };
                out.push((idx, resp));
            }
            Ok(out)
        }
    }
}

fn quantity_from_word(word: &[u8]) -> String {
    let mut buf = [0u8; 32];
    if word.len() >= 32 {
        buf.copy_from_slice(&word[word.len() - 32..]);
    } else if !word.is_empty() {
        buf[32 - word.len()..].copy_from_slice(word);
    }
    let n = U256::from_be_bytes(buf);
    if n.is_zero() {
        "0x0".into()
    } else {
        format!("0x{n:x}")
    }
}

fn parse_address(s: &str) -> Option<[u8; 20]> {
    let raw = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    let bytes = hex::decode(raw).ok()?;
    bytes.try_into().ok()
}

fn parse_bytes(s: &str) -> Option<Vec<u8>> {
    let raw = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    if raw.is_empty() {
        return Some(Vec::new());
    }
    hex::decode(raw).ok()
}

/// Encode a mock `aggregate3` return for tests.
#[cfg(test)]
pub fn encode_aggregate3_results(results: &[(bool, Vec<u8>)]) -> String {
    let encoded: Vec<Multicall3::Result> = results
        .iter()
        .map(|(ok, data)| Multicall3::Result {
            success: *ok,
            returnData: Bytes::from(data.clone()),
        })
        .collect();
    let bytes = Multicall3::aggregate3Call::abi_encode_returns(&encoded);
    format!("0x{}", hex::encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::rpc::json_rpc::Id;

    #[test]
    fn packs_two_eth_calls_into_one_multicall() {
        let jobs = vec![
            FallbackJob {
                idx: 0,
                req: Request::new(
                    "eth_call",
                    Id::Number(1),
                    json!([{ "to": "0x0000000000000000000000000000000000000001", "data": "0x01" }, "latest"]),
                )
                .serialize()
                .unwrap(),
                method: "eth_call".into(),
                params: json!([{ "to": "0x0000000000000000000000000000000000000001", "data": "0x01" }, "latest"]),
            },
            FallbackJob {
                idx: 1,
                req: Request::new(
                    "eth_call",
                    Id::Number(2),
                    json!([{ "to": "0x0000000000000000000000000000000000000002", "data": "0x02" }, "latest"]),
                )
                .serialize()
                .unwrap(),
                method: "eth_call".into(),
                params: json!([{ "to": "0x0000000000000000000000000000000000000002", "data": "0x02" }, "latest"]),
            },
        ];
        let (packet, _) = pack_circuit_group(jobs).unwrap();
        match packet {
            RequestPacket::Single(r) => assert_eq!(r.method(), "eth_call"),
            RequestPacket::Batch(_) => panic!("expected single multicall"),
        }
    }

    #[test]
    fn leaves_get_logs_as_sibling() {
        let jobs = vec![
            FallbackJob {
                idx: 0,
                req: Request::new("eth_getLogs", Id::Number(1), json!([{}]))
                    .serialize()
                    .unwrap(),
                method: "eth_getLogs".into(),
                params: json!([{}]),
            },
            FallbackJob {
                idx: 1,
                req: Request::new("eth_blockNumber", Id::Number(2), json!([]))
                    .serialize()
                    .unwrap(),
                method: "eth_blockNumber".into(),
                params: json!([]),
            },
        ];
        let (packet, _) = pack_circuit_group(jobs).unwrap();
        match packet {
            RequestPacket::Batch(rs) => {
                assert_eq!(rs.len(), 2);
                assert_eq!(rs[0].method(), "eth_getLogs");
                assert_eq!(rs[1].method(), "eth_blockNumber");
            }
            RequestPacket::Single(_) => panic!("expected batch of siblings"),
        }
    }
}
