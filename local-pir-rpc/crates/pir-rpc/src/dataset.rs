use serde::{Deserialize, Serialize};

/// A named key-value dataset advertised by the PIR service so a hybrid RPC
/// router can match `eth_call` (and similar) without executing the EVM.
///
/// Wire-compatible with inspire-gpu-serving `/manifest` `datasets`. An empty
/// list means the service only serves the implicit accounts table.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct DatasetManifest {
    /// Stable id, e.g. `"accounts"` or `"erc20_balances"`.
    pub id: String,
    #[serde(default)]
    pub key_size: usize,
    #[serde(default)]
    pub value_size: usize,
    /// Direct JSON-RPC methods this dataset serves, e.g. `eth_getBalance`.
    #[serde(default)]
    pub routes: Vec<String>,
    /// Optional `eth_call` contract allowlist (`0x`-prefixed, case-insensitive).
    /// Empty means any `to` matches the selectors.
    #[serde(default)]
    pub contracts: Vec<String>,
    /// `eth_call` 4-byte selectors, e.g. `["0x70a08231"]` for `balanceOf`.
    #[serde(default)]
    pub selectors: Vec<String>,
    /// How to build the PIR key from RPC params: `address`, `token_holder`,
    /// or `arg0`. Empty uses a default from the other fields.
    #[serde(default)]
    pub key_scheme: String,
    /// How to encode a lookup as a JSON-RPC result: `account`, `bytes`, or
    /// `uint256`. Empty uses a default from the other fields.
    #[serde(default)]
    pub value_encoding: String,
}
