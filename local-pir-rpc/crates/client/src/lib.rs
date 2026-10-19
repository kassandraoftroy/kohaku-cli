//! Client for the PIR serving front. Pure CPU (links no CUDA); this is the
//! reference for wallet integration.
//!
//! The service manifest (cuckoo + PIR parameters, fixed CRS seed) is fetched
//! ONCE at setup and never changes at generation flips. A private lookup is
//! then a SINGLE round with a FIXED request shape — the server sees the same
//! traffic no matter which key is looked up, where it is stored, or whether
//! it exists (PIR hides query contents, not query counts):
//!
//!   one POST /lookup carrying exactly 2 self-contained PIR queries, one per
//!   cuckoo candidate bucket (fresh secret each) — always both, never an
//!   early exit.
//!
//! The server answers the queries first and then attaches the sidecar
//! broadcast for the snapshot that answered them (snapshot block, stash,
//! and the changes since that snapshot), so the response is one consistent
//! view by construction — a generation flip mid-lookup changes nothing.
//! The client picks the answer locally: the freshest sidecar entry wins,
//! else the matching cell from either decrypted bucket, else the stash; no
//! match anywhere is a proven non-membership at that snapshot.
//!
//! The CRS is fixed, so queries are valid against every generation; the
//! X-Snapshot stamp ("<snapshot block>:<config fingerprint>") only guards
//! against an operator RECONFIGURATION — a changed fingerprint makes the
//! client refetch the manifest and retry once.

use pir_backend_ffi::{pack_query, ClientQuery, Params};
use pir_keyword::cuckoo::{CuckooHash, CANARY_ADDRESS};
use pir_keyword::manifest::{KeyDerivation, Manifest, SidecarBroadcast, StealthEntry, StealthText};
use pir_keyword::names::{namehash, Names};
use pir_keyword::slots::unpack_bytes;
use pir_keyword::storage::{mapping_slot, parse_storage_value, storage_key};

/// Where a lookup result came from.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    /// Retrieved through PIR (or the stash) from the serving snapshot.
    Snapshot { block: u64 },
    /// Overlaid from the sidecar broadcast (fresher than the snapshot).
    Sidecar { block: u64 },
}

#[derive(Clone, Debug)]
pub struct Lookup {
    pub value: Vec<u8>,
    pub source: Source,
}

pub use pir_keyword::account::AccountValue;

/// Balance, nonce and EIP-7702 delegate of a 40-byte account value
/// ([20B delegate][12B balance BE][8B nonce BE]). `AccountValue::code` gives
/// what `eth_getCode` returns for the address, provided it is an EOA.
pub fn parse_account_value(v: &[u8]) -> Option<AccountValue> {
    AccountValue::unpack(v)
}

/// An ERC-20 token whose balances a storage table can answer for: where its
/// balances mapping sits, and how to read an entry of it.
#[derive(Clone, Copy, Debug)]
pub struct Token {
    pub symbol: &'static str,
    /// The contract, 0x-hex.
    pub address: &'static str,
    /// Storage slot of the balances mapping.
    pub balances_slot: u64,
    pub decimals: u32,
    /// The top bit of a balance entry is a flag rather than part of the
    /// balance. USDC keeps its blacklist there.
    pub flag_in_top_bit: bool,
}

/// The four tokens kohaku-cli syncs by default. Each balances slot was checked
/// against `balanceOf` on mainnet at block 26,128,248. A wallet that asks for
/// one of them asks for all four, every time, so that which tokens it holds
/// does not show in how many lookups it sends.
pub const TOKENS: [Token; 4] = [
    Token {
        symbol: "USDC",
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        balances_slot: 9,
        decimals: 6,
        flag_in_top_bit: true,
    },
    Token {
        symbol: "USDT",
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        balances_slot: 2,
        decimals: 6,
        flag_in_top_bit: false,
    },
    Token {
        symbol: "DAI",
        address: "0x6b175474e89094c44da98b954eedeac495271d0f",
        balances_slot: 2,
        decimals: 18,
        flag_in_top_bit: false,
    },
    Token {
        symbol: "WETH",
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        balances_slot: 3,
        decimals: 18,
        flag_in_top_bit: false,
    },
];

impl Token {
    pub fn contract(&self) -> [u8; 20] {
        let digits = self.address.strip_prefix("0x").unwrap_or(self.address);
        hex::decode(digits).unwrap().try_into().unwrap()
    }

    /// The balance a storage word holds, as `balanceOf` would return it.
    pub fn balance_from_word(&self, mut word: [u8; 32]) -> [u8; 32] {
        if self.flag_in_top_bit {
            word[0] &= 0x7f;
        }
        word
    }
}

/// A token balance as `balanceOf` returns it (32 bytes, big-endian), and where
/// it came from. No source means the table proved the slot empty, which is a
/// zero balance.
#[derive(Clone, Debug)]
pub struct TokenBalance {
    pub balance: [u8; 32],
    pub source: Option<Source>,
}

/// An address's primary names and where they came from. No source means the
/// table proved it holds nothing for the address, which is no name in any
/// system.
#[derive(Clone, Debug)]
pub struct NamesLookup {
    pub names: Names,
    pub source: Option<Source>,
}

/// Cap on a response body. A lookup carries the whole sidecar broadcast, which
/// grows with every block until the next generation flip folds it in, so the
/// 10 MiB default trips exactly when a server is catching up.
const MAX_RESPONSE_BYTES: u64 = 128 * 1024 * 1024;

pub struct PirClient {
    base: String,
    pub manifest: Manifest,
    params: Params,
    hasher: CuckooHash,
    /// Snapshot block of the last completed lookup (display/monitoring).
    pub last_snapshot_block: u64,
    /// The whole ERC-6538 stealth registry, as the last lookup against a name
    /// server brought it. See `stealth_meta_address_of`.
    pub stealth_registry: Vec<StealthEntry>,
    /// Every set `stealth-address-scheme-1` text record, likewise. See
    /// `stealth_text_of`.
    pub stealth_texts: Vec<StealthText>,
}

impl PirClient {
    /// Fetch the (static) manifest and set up. `base` like
    /// "http://host:8080".
    pub fn connect(base: &str) -> Result<PirClient, String> {
        let base = base.trim_end_matches('/').to_string();
        let (manifest, params, hasher) = Self::fetch_manifest(&base)?;
        Ok(PirClient {
            base,
            manifest,
            params,
            hasher,
            last_snapshot_block: 0,
            stealth_registry: Vec::new(),
            stealth_texts: Vec::new(),
        })
    }

    /// A name's `stealth-address-scheme-1` text record, from the list the
    /// last names lookup brought, empty for none. `name` is normalized as
    /// for any ENS call. The list holds every on-chain record and those of
    /// the primary names behind a gateway, so the answer holds for a name an
    /// address lookup returned. Another name behind a gateway may have a
    /// record the list does not know.
    pub fn stealth_text_of(&self, name: &str) -> Result<String, String> {
        if self.manifest.cuckoo.content != "names" {
            return Err("only a name server sends stealth text records".into());
        }
        let node = format!("0x{}", hex::encode(namehash(name)));
        Ok(self
            .stealth_texts
            .iter()
            .find(|t| t.node == node)
            .map(|t| t.value.clone())
            .unwrap_or_default())
    }

    /// What `stealthMetaAddressOf(registrant, scheme_id)` on the ERC-6538
    /// registry returns, from the registry the last names lookup brought:
    /// the registered bytes, empty for none. Every lookup brings the whole
    /// registry, so answering for any registrant, the user's own or a
    /// recipient's, says nothing about which one was asked.
    pub fn stealth_meta_address_of(&self, registrant: &[u8; 20], scheme_id: u64) -> Result<Vec<u8>, String> {
        if self.manifest.cuckoo.content != "names" {
            return Err("only a name server sends the stealth registry".into());
        }
        let wanted = format!("0x{}", hex::encode(registrant));
        match self
            .stealth_registry
            .iter()
            .find(|e| e.scheme_id == scheme_id && e.registrant.eq_ignore_ascii_case(&wanted))
        {
            Some(e) => hex::decode(e.meta.trim_start_matches("0x")).map_err(|e| e.to_string()),
            None => Ok(Vec::new()),
        }
    }

    fn fetch_manifest(base: &str) -> Result<(Manifest, Params, CuckooHash), String> {
        let mut resp = ureq::get(&format!("{}/manifest", base))
            .call()
            .map_err(|e| format!("manifest fetch failed: {}", e))?;
        let body = resp
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_string()
            .map_err(|e| e.to_string())?;
        let manifest = Manifest::from_json(&body)?;
        let params = Params::from_manifest(&manifest.pir)?;
        let hasher = manifest.cuckoo.hasher()?;
        Ok((manifest, params, hasher))
    }

    /// Re-fetch the manifest. Only needed when the service configuration
    /// changed (the stamp's fingerprint half differs) — never at an
    /// ordinary generation flip.
    pub fn refresh(&mut self) -> Result<(), String> {
        let (m, p, h) = Self::fetch_manifest(&self.base)?;
        self.manifest = m;
        self.params = p;
        self.hasher = h;
        Ok(())
    }

    /// Find `key` among the cells of a retrieved bucket; returns the value.
    fn match_cell(&self, bucket: &[u8], key: &[u8]) -> Option<Vec<u8>> {
        let ks = self.manifest.cuckoo.key_size;
        let cs = ks + self.manifest.cuckoo.value_size;
        for c in 0..self.manifest.cuckoo.bucket_capacity {
            let cell = &bucket[c * cs..(c + 1) * cs];
            if &cell[..ks] == key {
                return Some(cell[ks..cs].to_vec());
            }
        }
        None
    }

    /// Private lookup: one POST carrying both bucket queries. Retries once
    /// through a manifest refresh if the server was reconfigured.
    /// Look up an account by address, deriving the key the way the served
    /// table was built. Prefer this over `lookup` unless you already hold a
    /// key: a snapshot read out of a node's state trie is keyed by the hash of
    /// the address, and querying such a table with a raw address quietly finds
    /// nothing rather than failing.
    pub fn lookup_address(&mut self, address: &[u8]) -> Result<Option<Lookup>, String> {
        let cuckoo = &self.manifest.cuckoo;
        if cuckoo.key_derivation == KeyDerivation::Storage {
            return Err("this server holds contract storage, not accounts".into());
        }
        if !cuckoo.content.is_empty() {
            return Err(format!("this server holds {}, not accounts", cuckoo.content));
        }
        let key = cuckoo.key_derivation.key(address, cuckoo.key_size);
        self.lookup(&key)
    }

    /// An address's ENS, GNS and WNS primary names, from a name table, in one
    /// lookup whatever the address holds.
    pub fn names(&mut self, address: &[u8; 20]) -> Result<NamesLookup, String> {
        let cuckoo = &self.manifest.cuckoo;
        if cuckoo.content != "names" {
            return Err("this server does not hold primary names".into());
        }
        let key = cuckoo.key_derivation.key(address, cuckoo.key_size);
        match self.lookup(&key)? {
            Some(l) => Ok(NamesLookup {
                names: Names::unpack(&l.value)?,
                source: Some(l.source),
            }),
            None => Ok(NamesLookup {
                names: Names::default(),
                source: None,
            }),
        }
    }

    /// Look up a storage slot of `contract`. Only a storage table answers, and
    /// only for the contracts its manifest names: a slot of any other contract
    /// is simply not in the table and would read as empty, so asking for one
    /// is an error rather than a zero.
    pub fn lookup_storage(
        &mut self,
        contract: &[u8; 20],
        slot: &[u8; 32],
    ) -> Result<Option<Lookup>, String> {
        let cuckoo = &self.manifest.cuckoo;
        if cuckoo.key_derivation != KeyDerivation::Storage {
            return Err("this server holds accounts, not contract storage".into());
        }
        let listed = format!("0x{}", hex::encode(contract));
        if !cuckoo.contracts.iter().any(|c| c.eq_ignore_ascii_case(&listed)) {
            return Err(format!("this server does not hold the storage of {listed}"));
        }
        let key = storage_key(contract, slot, cuckoo.key_size);
        self.lookup(&key)
    }

    /// `token.balanceOf(holder)`, read privately out of a storage table.
    pub fn token_balance(&mut self, token: &Token, holder: &[u8; 20]) -> Result<TokenBalance, String> {
        let slot = mapping_slot(holder, token.balances_slot);
        match self.lookup_storage(&token.contract(), &slot)? {
            Some(l) => {
                let word = parse_storage_value(&l.value).ok_or("not a storage value")?;
                Ok(TokenBalance {
                    balance: token.balance_from_word(word),
                    source: Some(l.source),
                })
            }
            None => Ok(TokenBalance {
                balance: [0u8; 32],
                source: None,
            }),
        }
    }

    pub fn lookup(&mut self, key: &[u8]) -> Result<Option<Lookup>, String> {
        match self.lookup_once(key)? {
            LookupOutcome::Done(r) => Ok(r),
            LookupOutcome::Reconfigured => {
                self.refresh()?;
                match self.lookup_once(key)? {
                    LookupOutcome::Done(r) => Ok(r),
                    LookupOutcome::Reconfigured => {
                        Err("server configuration kept changing".into())
                    }
                }
            }
        }
    }

    fn lookup_once(&mut self, key: &[u8]) -> Result<LookupOutcome, String> {
        // Build both queries (fresh secret each), concurrently.
        let [p0, p1] = self.hasher.positions_2(key);
        let (q0, q1) = std::thread::scope(|s| {
            let h0 = s.spawn(|| ClientQuery::build(&self.params, p0 as u64));
            let h1 = s.spawn(|| ClientQuery::build(&self.params, p1 as u64));
            (h0.join().unwrap(), h1.join().unwrap())
        });
        let (q0, q1) = (q0?, q1?);
        let mut body = pack_query(&self.params, &q0.flat)?;
        body.extend_from_slice(&pack_query(&self.params, &q1.flat)?);

        let mut resp = ureq::post(&format!("{}/lookup", self.base))
            .send(&body[..])
            .map_err(|e| format!("lookup failed: {}", e))?;
        let stamp = resp
            .headers()
            .get("x-snapshot")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if stamp.split(':').nth(1) != Some(self.manifest.config_fp().as_str()) {
            return Ok(LookupOutcome::Reconfigured);
        }
        let bytes = resp
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_vec()
            .map_err(|e| e.to_string())?;

        // [4B LE json length][SidecarBroadcast JSON][response 0][response 1]
        let rb = self.params.response_compressed_bytes();
        if bytes.len() < 4 {
            return Err("lookup response too short".into());
        }
        let json_len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        if bytes.len() != 4 + json_len + 2 * rb {
            return Err(format!(
                "lookup response is {} bytes, expected 4 + {} + 2x{}",
                bytes.len(),
                json_len,
                rb
            ));
        }
        let sc = SidecarBroadcast::from_json(
            std::str::from_utf8(&bytes[4..4 + json_len]).map_err(|e| e.to_string())?,
        )?;
        let r0 = &bytes[4 + json_len..4 + json_len + rb];
        let r1 = &bytes[4 + json_len + rb..];

        let cs = self.manifest.cuckoo.key_size + self.manifest.cuckoo.value_size;
        let bucket_bytes = self.manifest.cuckoo.bucket_capacity * cs;
        let b0 = unpack_bytes(&q0.extract_compressed(&self.params, r0)?, bucket_bytes);
        let b1 = unpack_bytes(&q1.extract_compressed(&self.params, r1)?, bucket_bytes);

        self.last_snapshot_block = sc.snapshot_block;
        self.stealth_registry = sc.stealth_registry.clone();
        self.stealth_texts = sc.stealth_texts.clone();

        // Pick locally: freshest sidecar entry, else either bucket's
        // matching cell, else the stash — all describing one snapshot.
        if let Some(e) = sc
            .entries
            .iter()
            .rev()
            .find(|e| hex::decode(&e.address_hex).as_deref() == Ok(key))
        {
            return Ok(LookupOutcome::Done(Some(Lookup {
                value: hex::decode(&e.value_hex).map_err(|x| x.to_string())?,
                source: Source::Sidecar { block: e.block },
            })));
        }
        let mut found = self
            .match_cell(&b0, key)
            .or_else(|| self.match_cell(&b1, key));
        if found.is_none() {
            if let Some(e) = sc
                .stash
                .iter()
                .find(|e| hex::decode(&e.address_hex).as_deref() == Ok(key))
            {
                found = Some(hex::decode(&e.value_hex).map_err(|x| x.to_string())?);
            }
        }
        Ok(LookupOutcome::Done(found.map(|value| Lookup {
            value,
            source: Source::Snapshot {
                block: sc.snapshot_block,
            },
        })))
    }

    /// Retrieve the canary entry: proves which snapshot block answered.
    /// Goes through lookup() so even canary checks share the request shape.
    pub fn canary_block(&mut self) -> Result<Option<u64>, String> {
        Ok(self
            .lookup(&CANARY_ADDRESS)?
            .and_then(|l| parse_account_value(&l.value))
            .map(|a| a.nonce))
    }
}

enum LookupOutcome {
    Done(Option<Lookup>),
    /// The stamp's config fingerprint differs from the manifest's: the
    /// service was reconfigured (never a mere flip).
    Reconfigured,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_addresses_parse() {
        for token in TOKENS {
            assert_eq!(format!("0x{}", hex::encode(token.contract())), token.address);
        }
    }

    /// USDC's blacklist bit is not part of the balance, and nobody else's top
    /// bit is touched.
    #[test]
    fn only_a_flagged_top_bit_is_dropped() {
        let mut word = [0u8; 32];
        word[0] = 0x80;
        word[31] = 5;
        let usdc = TOKENS.iter().find(|t| t.symbol == "USDC").unwrap();
        let usdt = TOKENS.iter().find(|t| t.symbol == "USDT").unwrap();
        assert_eq!(usdc.balance_from_word(word)[0], 0);
        assert_eq!(usdc.balance_from_word(word)[31], 5);
        assert_eq!(usdt.balance_from_word(word), word);
    }
}
