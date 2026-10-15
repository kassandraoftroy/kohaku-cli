use serde_json::Value;

/// How a fallback Ethereum JSON-RPC call should be sent over Tor.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum CircuitChoice {
    /// Reuse the shared Tor client (bulk / non-linkable work).
    Shared,
    /// Fresh isolated client keyed by `key` (typically an EOA address).
    Isolated {
        /// Isolation group key (lowercase 0x-address, or `"_anon"`).
        key: String,
    },
}

/// Decides shared vs isolated Tor circuits for fallback RPC methods.
pub trait IsolationPolicy: Send + Sync {
    /// Choose a circuit for one fallback JSON-RPC call.
    fn circuit_for(&self, method: &str, params: &Value) -> CircuitChoice;
}

/// Default policy: shared for logs/metadata; isolated-by-address otherwise.
#[derive(Clone, Debug, Default)]
pub struct DefaultIsolationPolicy;

impl IsolationPolicy for DefaultIsolationPolicy {
    fn circuit_for(&self, method: &str, params: &Value) -> CircuitChoice {
        if is_shared_safe(method) {
            return CircuitChoice::Shared;
        }
        match extract_address(method, params) {
            Some(addr) => CircuitChoice::Isolated { key: addr },
            None => CircuitChoice::Isolated {
                key: "_anon".into(),
            },
        }
    }
}

fn is_shared_safe(method: &str) -> bool {
    matches!(
        method,
        "eth_getLogs"
            | "eth_blockNumber"
            | "eth_chainId"
            | "eth_gasPrice"
            | "eth_maxPriorityFeePerGas"
            | "eth_feeHistory"
            | "net_version"
            | "web3_clientVersion"
            | "eth_syncing"
            | "eth_getBlockByNumber"
            | "eth_getBlockByHash"
    )
}

/// Best-effort primary address extraction for isolation grouping.
fn extract_address(method: &str, params: &Value) -> Option<String> {
    let arr = params.as_array()?;
    match method {
        "eth_getBalance"
        | "eth_getTransactionCount"
        | "eth_getCode"
        | "eth_getStorageAt"
        | "eth_getProof" => normalize_address(arr.first()?.as_str()?),
        "eth_call" | "eth_estimateGas" => {
            let obj = arr.first()?;
            normalize_address(obj.get("from").or_else(|| obj.get("to"))?.as_str()?)
        }
        _ => None,
    }
}

fn normalize_address(s: &str) -> Option<String> {
    let raw = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    let bytes = hex::decode(raw).ok()?;
    if bytes.len() != 20 {
        return None;
    }
    Some(format!("0x{}", hex::encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn logs_are_shared() {
        let p = DefaultIsolationPolicy;
        assert_eq!(
            p.circuit_for("eth_getLogs", &json!([{}])),
            CircuitChoice::Shared
        );
    }

    #[test]
    fn balance_is_isolated_by_address() {
        let p = DefaultIsolationPolicy;
        let addr = "0x0000000000000000000000000000000000000001";
        assert_eq!(
            p.circuit_for("eth_getBalance", &json!([addr, "0x10"])),
            CircuitChoice::Isolated {
                key: addr.to_string()
            }
        );
    }

    #[test]
    fn different_addresses_get_different_keys() {
        let p = DefaultIsolationPolicy;
        let a = p.circuit_for(
            "eth_call",
            &json!([{ "to": "0x0000000000000000000000000000000000000001", "data": "0x" }]),
        );
        let b = p.circuit_for(
            "eth_call",
            &json!([{ "to": "0x0000000000000000000000000000000000000002", "data": "0x" }]),
        );
        assert_ne!(a, b);
    }
}
