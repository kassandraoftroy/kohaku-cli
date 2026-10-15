//! ERC-6538 registry and stealth text records carried on a names sidecar.

use kohaku_pir_rpc::{StealthBroadcast, StealthEntry, StealthText};
use pir_keyword::manifest;

/// Convert the names sidecar lists into the middleware's broadcast.
///
/// # Errors
///
/// Returns when a registrant, meta-address, or namehash is not valid hex of
/// the expected length.
pub fn broadcast_from_lists(
    registry: &[manifest::StealthEntry],
    texts: &[manifest::StealthText],
) -> Result<StealthBroadcast, String> {
    let mut out_registry = Vec::with_capacity(registry.len());
    for entry in registry {
        out_registry.push(StealthEntry {
            registrant: parse_fixed(&entry.registrant)?,
            scheme_id: entry.scheme_id,
            meta: decode_hex(&entry.meta)?,
        });
    }
    let mut out_texts = Vec::with_capacity(texts.len());
    for text in texts {
        out_texts.push(StealthText {
            node: parse_fixed(&text.node)?,
            value: text.value.clone(),
        });
    }
    Ok(StealthBroadcast {
        registry: out_registry,
        texts: out_texts,
    })
}

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    let raw = strip_hex(s);
    hex::decode(raw).map_err(|e| format!("stealth hex: {e}"))
}

fn parse_fixed<const N: usize>(s: &str) -> Result<[u8; N], String> {
    let bytes = decode_hex(s)?;
    bytes
        .try_into()
        .map_err(|got: Vec<u8>| format!("expected {N} stealth bytes, got {}", got.len()))
}

fn strip_hex(s: &str) -> &str {
    s.trim()
        .strip_prefix("0x")
        .or_else(|| s.trim().strip_prefix("0X"))
        .unwrap_or(s.trim())
}

#[cfg(test)]
mod tests {
    use pir_keyword::manifest::SidecarBroadcast;

    use super::*;

    #[test]
    fn sidecar_json_round_trips_stealth_lists() {
        let registrant = "0x1111111111111111111111111111111111111111";
        let node = format!("0x{}", "ab".repeat(32));
        let json = format!(
            r#"{{
                "snapshot_block": 7,
                "stealth_registry": [{{
                    "registrant": "{registrant}",
                    "scheme_id": 1,
                    "meta": "0x0203"
                }}],
                "stealth_texts": [{{
                    "node": "{node}",
                    "value": "st:eth:0x03"
                }}]
            }}"#
        );
        let sc = SidecarBroadcast::from_json(&json).unwrap();
        let got = broadcast_from_lists(&sc.stealth_registry, &sc.stealth_texts).unwrap();
        assert_eq!(got.registry.len(), 1);
        assert_eq!(got.registry[0].scheme_id, 1);
        assert_eq!(got.registry[0].registrant[0], 0x11);
        assert_eq!(got.registry[0].meta, vec![0x02, 0x03]);
        assert_eq!(got.texts.len(), 1);
        assert_eq!(got.texts[0].node[0], 0xab);
        assert_eq!(got.texts[0].value, "st:eth:0x03");

        let plain_sc = SidecarBroadcast::from_json(r#"{"snapshot_block":7}"#).unwrap();
        let plain =
            broadcast_from_lists(&plain_sc.stealth_registry, &plain_sc.stealth_texts).unwrap();
        assert!(plain.registry.is_empty());
        assert!(plain.texts.is_empty());
    }
}
