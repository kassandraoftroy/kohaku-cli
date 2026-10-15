/// Which PIR server / key space an op targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PirLane {
    /// Account table (`eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`).
    Account,
    /// Contract storage table (ERC-20 `balanceOf` for PIR tokens).
    TokenStorage,
    /// Primary names (ENS / GNS / WNS), keyed by address.
    Names,
}

/// Where one JSON-RPC call was answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallPath {
    /// Account, token, or names PIR.
    Pir,
    /// Public Ethereum JSON-RPC.
    Fallback,
    /// Computed locally (`computeId`, or a stealth answer from a cached sidecar).
    Local,
}

/// One call and the path that actually answered it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallTrace {
    /// JSON-RPC method (`eth_call`, `eth_getLogs`, …).
    pub method: String,
    /// Final path, after a too-long name is replayed to fallback.
    pub path: CallPath,
}

/// PIR bytes turned into a JSON-RPC result, or a signal to use fallback RPC.
#[derive(Clone, Debug, PartialEq)]
pub enum Decoded {
    /// JSON-RPC result value.
    Value(serde_json::Value),
    /// The name exists but did not fit in the table. Send the original call to RPC.
    NeedsFallback,
}

/// How to decode PIR value bytes into a JSON-RPC result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PirDecode {
    /// 40-byte account blob → balance quantity hex.
    AccountBalance,
    /// 40-byte account blob → nonce quantity hex.
    AccountNonce,
    /// 40-byte account blob → `eth_getCode` (`0xef0100 ‖ delegate`, or `0x`).
    AccountCode,
    /// Names-table value → one system's reverse record.
    NameReverse {
        /// ENS, GNS, or WNS.
        system: crate::names::NameSystem,
    },
    /// 40-byte storage cell → ABI `uint256` (optional top-bit clear).
    TokenBalance {
        /// Clear bit 255 of the storage word (USDC blacklist).
        flag_in_top_bit: bool,
    },
    /// Dataset value → `value_encoding` (`account` / `bytes` / `uint256`).
    Call {
        /// Encoding from the dataset manifest.
        value_encoding: String,
    },
    /// `stealthMetaAddressOf` answered from the names sidecar, after a lookup
    /// of `registrant` when the sidecar is not cached yet.
    StealthMeta {
        /// Registrant argument.
        registrant: [u8; 20],
        /// Scheme id argument.
        scheme_id: u64,
    },
    /// `stealth-address-scheme-1` text answered from the names sidecar.
    ///
    /// The lookup key is the zero address: it only loads the broadcast.
    StealthText {
        /// ENS, GNS, or WNS.
        system: crate::names::NameSystem,
        /// Namehash carried by the call.
        node: [u8; 32],
    },
}

/// A PIR lookup the orchestrator should run (never silent-fallback to RPC).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PirOp {
    /// Accounts vs token-storage PIR server.
    pub lane: PirLane,
    /// Derived PIR key.
    pub key: Vec<u8>,
    /// Decode rule for the returned bytes.
    pub decode: PirDecode,
    /// Holder address when this is a token `balanceOf` (for four-token padding).
    pub holder: Option<[u8; 20]>,
    /// Index into [`crate::PIR_TOKENS`] when this is a hardcoded token balance.
    pub token_index: Option<usize>,
}

/// Result of classifying one JSON-RPC method against the PIR allowlist.
#[derive(Clone, Debug, PartialEq)]
pub enum PlannedOp {
    /// Answer via PIR lookup.
    Pir(PirOp),
    /// Forward to the fallback Ethereum JSON-RPC endpoint.
    Fallback,
    /// Answer locally, with no PIR lookup and no RPC.
    Local(serde_json::Value),
}
