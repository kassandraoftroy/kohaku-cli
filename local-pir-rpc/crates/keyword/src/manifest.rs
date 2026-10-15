//! The service manifest: the static configuration a cold client needs to
//! build queries — cuckoo-hashing parameters and PIR parameters, including
//! the fixed CRS seed. Published by the server (JSON), fetched once at
//! client setup; it does NOT change at generation flips, so a client never
//! re-fetches it in steady state. Per-generation state (snapshot block,
//! stash) travels in the sidecar broadcast instead.

use crate::cuckoo::CuckooHash;
use serde::{Deserialize, Serialize};

/// How a lookup key is derived from what the client is asking about. A client
/// has to agree with the table it is querying, so the server publishes which
/// one is in use rather than leaving it to be configured on both sides.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KeyDerivation {
    /// The address itself.
    #[default]
    Address,
    /// keccak256 of the address, cut to the key size. A snapshot read out of a
    /// node's state trie arrives this way, because the trie is keyed by that
    /// hash and a hash cannot be turned back into an address. It costs the
    /// client nothing, since it knows the address it is asking about.
    Keccak,
    /// A contract storage slot: keccak256(keccak256(contract) ‖
    /// keccak256(slot)), cut to the key size, for the same reason (see
    /// [`crate::storage`]).
    Storage,
}

impl KeyDerivation {
    /// The lookup key for `input` under this derivation. `input` is an address
    /// for `Address` and `Keccak`, and the contract's address followed by the
    /// 32-byte slot for `Storage`.
    pub fn key(&self, input: &[u8], key_size: usize) -> Vec<u8> {
        match self {
            KeyDerivation::Address => input.to_vec(),
            KeyDerivation::Keccak => {
                use sha3::Digest;
                sha3::Keccak256::digest(input)[..key_size.min(32)].to_vec()
            }
            KeyDerivation::Storage => {
                assert_eq!(input.len(), 52, "a storage key is derived from contract ‖ slot");
                let (contract, slot) = input.split_at(20);
                crate::storage::storage_key(
                    contract.try_into().unwrap(),
                    slot.try_into().unwrap(),
                    key_size,
                )
            }
        }
    }
}

/// Cuckoo-hashing side: lets the client map an address to its two candidate
/// bucket indices (= PIR entry indices).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CuckooManifest {
    pub num_buckets: usize,
    pub key_size: usize,
    pub value_size: usize,
    /// Cells (key-value pairs) per bucket; one PIR entry = one bucket.
    pub bucket_capacity: usize,
    pub num_hashes: usize,
    /// 16-byte SipHash seed, hex.
    pub seed_hex: String,
    /// Absent in a manifest written before this was published, which could
    /// only have been an address-keyed table.
    #[serde(default)]
    pub key_derivation: KeyDerivation,
    /// The contracts whose storage a `storage`-keyed table holds, as 0x-hex.
    /// A slot of any other contract is simply not in the table, and would
    /// read as empty, so a client checks this list before looking one up.
    /// Empty, and left out of the JSON, for an account table.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contracts: Vec<String>,
    /// What the values mean, when the key alone does not say: `names` for a
    /// table of primary names keyed by address, which would otherwise look
    /// like an address-keyed account table. Empty, and left out of the JSON,
    /// for account and storage tables.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub content: String,
}

impl CuckooManifest {
    pub fn seed(&self) -> Result<[u8; 16], String> {
        let raw = hex::decode(&self.seed_hex).map_err(|e| e.to_string())?;
        raw.try_into().map_err(|_| "seed must be 16 bytes".into())
    }

    pub fn hasher(&self) -> Result<CuckooHash, String> {
        Ok(CuckooHash::new_from_seed(
            self.seed()?,
            self.num_hashes,
            self.num_buckets,
        ))
    }
}

/// PIR side: mirror of the backend's `ipir_params` (capi.h). The client feeds
/// these to `ipir_query_build`; `crs_seed_hex` is the 64-byte CRS seed, fixed
/// for the lifetime of the service (queries stay valid across database
/// rebuilds — privacy rests on the fresh per-query secret, not on CRS
/// freshness).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PirManifest {
    pub n_entries: usize,
    pub entry_bytes: usize,
    pub db_rows: usize,
    pub db_cols: usize,
    pub n_packed: usize,
    pub interp_d: usize,
    pub num_cts: usize,
    pub ring_n: usize,
    pub d_eff: usize,
    pub crs_seed_hex: String,
}

impl PirManifest {
    pub fn crs_seed(&self) -> Result<[u8; 64], String> {
        let raw = hex::decode(&self.crs_seed_hex).map_err(|e| e.to_string())?;
        raw.try_into().map_err(|_| "CRS seed must be 64 bytes".into())
    }
}

/// One sidecar broadcast entry: a key changed after the serving snapshot.
/// Shared wire type between server and client.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SidecarEntry {
    /// Key (20-byte address), hex.
    pub address_hex: String,
    /// Value (40 bytes), hex.
    pub value_hex: String,
    /// Block that produced this change.
    pub block: u64,
}

/// One entry that overflowed the cuckoo table's eviction bound, living
/// outside the PIR matrix. Served in the clear through the sidecar
/// broadcast: every client downloads the same list, so reading it leaks
/// nothing. Expected empty at sane load factors.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StashEntry {
    /// Key (20-byte address), hex.
    pub address_hex: String,
    /// Value (40 bytes), hex.
    pub value_hex: String,
}

/// The `/sidecar` response body: everything per-generation a lookup needs,
/// in one broadcast fetched per lookup. Identical bytes for every client.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct SidecarBroadcast {
    /// Chain block the serving snapshot reflects; `entries` covers blocks
    /// after this.
    pub snapshot_block: u64,
    /// Cuckoo-overflow entries living outside the PIR matrix this snapshot.
    #[serde(default)]
    pub stash: Vec<StashEntry>,
    /// Changes since the snapshot, oldest first.
    #[serde(default)]
    pub entries: Vec<SidecarEntry>,
    /// Every stealth meta-address in the ERC-6538 registry, as of the latest
    /// block followed, from a name server. The registry is small enough to
    /// send whole, which keeps which registrant a wallet asks about private
    /// without a lookup.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stealth_registry: Vec<StealthEntry>,
    /// Every name's `stealth-address-scheme-1` text record that is set, from
    /// a name server: on-chain ones from the resolvers' events, and those of
    /// the primary names behind a gateway, asked about once an hour. Sent
    /// whole for the same reason as the registry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stealth_texts: Vec<StealthText>,
}

/// One name's `stealth-address-scheme-1` text record. Shared wire type
/// between server and client.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct StealthText {
    /// The name's namehash, 0x-hex, which is also its GNS or WNS id. A text
    /// call carries it, so a middleware matches calls on it.
    pub node: String,
    /// The record, as `text(node, "stealth-address-scheme-1")` returns it.
    pub value: String,
}

/// One registrant's stealth meta-address for one scheme, as
/// `stealthMetaAddressOf(registrant, scheme_id)` on the ERC-6538 registry
/// returns it. Shared wire type between server and client.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct StealthEntry {
    /// The registrant, 0x-hex.
    pub registrant: String,
    /// The stealth address scheme (1 is secp256k1, per ERC-5564).
    pub scheme_id: u64,
    /// The registered bytes, 0x-hex. For scheme 1 that is the compressed
    /// spending and viewing public keys, 66 bytes.
    pub meta: String,
}

impl SidecarBroadcast {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("sidecar broadcast serializes")
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| e.to_string())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Manifest {
    pub cuckoo: CuckooManifest,
    pub pir: PirManifest,
}

impl Manifest {
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("manifest serializes")
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| e.to_string())
    }

    /// Short fingerprint of the service configuration. Part of every response
    /// stamp, so a client that reaches a server with a DIFFERENT configuration
    /// — another deployment, or an operator reconfiguration — detects it and
    /// re-fetches the manifest.
    ///
    /// For an account table it is the head of the CRS seed, which pins the
    /// rest. A storage table can share its seed with an account table, since
    /// the CRS is public, and the two can even take queries and answers of the
    /// same size. So its fingerprint also covers the contracts it holds, and a
    /// client sent to the wrong table notices instead of reading every slot as
    /// empty. A name table's covers its content tag, for the same reason.
    pub fn config_fp(&self) -> String {
        let seed = &self.pir.crs_seed_hex;
        if self.cuckoo.contracts.is_empty() && self.cuckoo.content.is_empty() {
            return seed[..16.min(seed.len())].to_string();
        }
        use sha3::Digest;
        let mut hasher = sha3::Keccak256::new();
        hasher.update(seed.as_bytes());
        for contract in &self.cuckoo.contracts {
            hasher.update(b",");
            hasher.update(contract.to_ascii_lowercase().as_bytes());
        }
        if !self.cuckoo.content.is_empty() {
            hasher.update(b";");
            hasher.update(self.cuckoo.content.as_bytes());
        }
        hex::encode(&hasher.finalize()[..8])
    }

    /// The X-Snapshot stamp for responses served at `snapshot_block`:
    /// "<snapshot block>:<config fingerprint>". The snapshot block is
    /// globally meaningful (chain height), so stamps stay comparable across
    /// machines in a rolling swap. Lookup responses are internally
    /// consistent by construction; the stamp serves monitoring, and its
    /// fingerprint half tells a client to refetch the manifest after an
    /// operator reconfiguration.
    pub fn stamp_for(&self, snapshot_block: u64) -> String {
        format!("{}:{}", snapshot_block, self.config_fp())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cuckoo::DETERMINISTIC_SEED;

    #[test]
    fn test_manifest_roundtrip() {
        let m = Manifest {
            cuckoo: CuckooManifest {
                num_buckets: 1 << 27,
                key_size: 20,
                value_size: 40,
                bucket_capacity: 2,
                num_hashes: 2,
                seed_hex: hex::encode(DETERMINISTIC_SEED),
                key_derivation: KeyDerivation::Address,
                contracts: vec![],
                content: String::new(),
            },
            pir: PirManifest {
                n_entries: 1 << 27,
                entry_bytes: 120,
                db_rows: 32768,
                db_cols: 262144,
                n_packed: 128,
                interp_d: 512,
                num_cts: 1,
                ring_n: 2048,
                d_eff: 2,
                crs_seed_hex: hex::encode([0x5Au8; 64]),
            },
        };
        let m2 = Manifest::from_json(&m.to_json()).unwrap();
        assert_eq!(m, m2);
        assert_eq!(m2.cuckoo.seed().unwrap(), DETERMINISTIC_SEED);
        assert_eq!(m2.pir.crs_seed().unwrap(), [0x5Au8; 64]);
        let h = m2.cuckoo.hasher().unwrap();
        assert_eq!(h.num_buckets, 1 << 27);
        assert_eq!(m2.stamp_for(42), format!("42:{}", "5a".repeat(8)));

        // A storage table on the same seed gets a fingerprint of its own,
        // while the account table's stays the head of the seed, as clients
        // built before storage tables expect.
        let mut tokens = m2.clone();
        tokens.cuckoo.key_derivation = KeyDerivation::Storage;
        tokens.cuckoo.contracts = vec!["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".into()];
        assert_eq!(tokens.config_fp().len(), 16);
        assert_ne!(tokens.config_fp(), m2.config_fp());
        let mut lower = tokens.clone();
        lower.cuckoo.contracts = vec!["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into()];
        assert_eq!(lower.config_fp(), tokens.config_fp());
        lower.cuckoo.contracts.push("0xdac17f958d2ee523a2206206994597c13d831ec7".into());
        assert_ne!(lower.config_fp(), tokens.config_fp());

        // A name table is keyed by address like an old account table, so only
        // its content tag tells the two apart.
        let mut names = m2.clone();
        names.cuckoo.content = "names".into();
        assert_ne!(names.config_fp(), m2.config_fp());
        assert!(names.to_json().contains("\"content\": \"names\""));
        assert!(!m2.to_json().contains("content"));
    }

    #[test]
    fn test_sidecar_broadcast_roundtrip() {
        let b = SidecarBroadcast {
            snapshot_block: 24_644_657,
            stash: vec![StashEntry {
                address_hex: hex::encode([0x11u8; 20]),
                value_hex: hex::encode([0x22u8; 40]),
            }],
            entries: vec![SidecarEntry {
                address_hex: hex::encode([0x33u8; 20]),
                value_hex: hex::encode([0x44u8; 40]),
                block: 24_644_660,
            }],
            ..Default::default()
        };
        let b2 = SidecarBroadcast::from_json(&b.to_json()).unwrap();
        assert_eq!(b, b2);
    }

    /// The registry rides along only where there is one, and a broadcast
    /// without it still reads.
    #[test]
    fn stealth_registry_is_optional_on_the_wire() {
        let plain = SidecarBroadcast { snapshot_block: 7, ..Default::default() };
        assert!(!plain.to_json().contains("stealth_registry"));
        assert_eq!(SidecarBroadcast::from_json(r#"{"snapshot_block":7}"#).unwrap(), plain);

        let with = SidecarBroadcast {
            snapshot_block: 7,
            stealth_registry: vec![StealthEntry {
                registrant: format!("0x{}", hex::encode([0x55u8; 20])),
                scheme_id: 1,
                meta: format!("0x{}", hex::encode([0x02u8; 66])),
            }],
            ..Default::default()
        };
        assert_eq!(SidecarBroadcast::from_json(&with.to_json()).unwrap(), with);

        let texts = SidecarBroadcast {
            snapshot_block: 7,
            stealth_texts: vec![StealthText {
                node: format!("0x{}", hex::encode([0x8fu8; 32])),
                value: "st:eth:0x03".into(),
            }],
            ..Default::default()
        };
        assert!(!texts.to_json().contains("stealth_registry"));
        assert_eq!(SidecarBroadcast::from_json(&texts.to_json()).unwrap(), texts);
    }

    /// A manifest written before key_derivation existed can only describe an
    /// address-keyed table, and has to keep loading.
    #[test]
    fn a_manifest_without_key_derivation_reads_as_address() {
        let json = r#"{"num_buckets":16,"key_size":20,"value_size":40,
            "bucket_capacity":2,"num_hashes":2,"seed_hex":"00"}"#;
        let c: CuckooManifest = serde_json::from_str(json).unwrap();
        assert_eq!(c.key_derivation, KeyDerivation::Address);
    }

    #[test]
    fn key_derivation_names_are_stable_on_the_wire() {
        assert_eq!(
            serde_json::to_string(&KeyDerivation::Keccak).unwrap(),
            "\"keccak\""
        );
        assert_eq!(
            serde_json::to_string(&KeyDerivation::Address).unwrap(),
            "\"address\""
        );
        assert_eq!(
            serde_json::to_string(&KeyDerivation::Storage).unwrap(),
            "\"storage\""
        );
    }

    /// An account table's manifest stays exactly as it was, and a storage
    /// table's names its contracts.
    #[test]
    fn contracts_appear_only_in_a_storage_manifest() {
        let mut c = CuckooManifest {
            num_buckets: 16,
            key_size: 20,
            value_size: 40,
            bucket_capacity: 2,
            num_hashes: 2,
            seed_hex: "00".into(),
            key_derivation: KeyDerivation::Keccak,
            contracts: vec![],
            content: String::new(),
        };
        assert!(!serde_json::to_string(&c).unwrap().contains("contracts"));
        c.key_derivation = KeyDerivation::Storage;
        c.contracts = vec!["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into()];
        let back: CuckooManifest = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back, c);
    }

    /// The address derivation hands the address back; the keccak one hands back
    /// the hash the state trie is keyed by, cut to the key size.
    #[test]
    fn derivations_produce_the_keys_the_tables_are_built_with() {
        // keccak256 of vitalik.eth's address, as the trie stores it.
        let address = hex::decode("d8da6bf26964af9d7eed9e03e53415d37aa96045").unwrap();
        assert_eq!(KeyDerivation::Address.key(&address, 20), address);
        assert_eq!(
            hex::encode(KeyDerivation::Keccak.key(&address, 20)),
            "06e120c2c3547c60ee47f712d32e5acf38b35d1c"
        );
    }

    /// The storage derivation takes contract ‖ slot and agrees with the
    /// storage module, which the dump and the follower call directly.
    #[test]
    fn the_storage_derivation_is_the_storage_key() {
        let contract: [u8; 20] = [0xa0; 20];
        let slot = [0x1f; 32];
        let input = [&contract[..], &slot[..]].concat();
        assert_eq!(
            KeyDerivation::Storage.key(&input, 20),
            crate::storage::storage_key(&contract, &slot, 20)
        );
    }
}
