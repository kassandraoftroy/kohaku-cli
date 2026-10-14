//! Cuckoo hashing with multi-cell buckets.
//!
//! Keys hash to 2 candidate buckets (SipHash); each bucket holds
//! `bucket_capacity` cells (default 2) — the Ethereum deployment uses
//! key 20 + value 40 = 60-byte cells.
//! Capacity 2 lifts the feasible load factor from 0.5 to ~0.897 without
//! adding a third query: one PIR entry = one 120-byte bucket, so a lookup
//! is still 2 queries and the client matches the key against the bucket's
//! cells locally.
//!
//! The DB-matrix conversion lives in `slots` and targets the inspire-gpu
//! backend's row-major 15-bit slot format.

use crate::account::{AccountValue, ACCOUNT_VALUE_SIZE};
use crate::manifest::KeyDerivation;
use rayon::prelude::*;
use sha3::{
    digest::{ExtendableOutput, Update, XofReader},
    Shake256,
};
use siphasher::sip::SipHasher;
use std::fs::File;
use std::hash::Hasher;
use std::io::{self, BufRead, BufReader};
use std::path::Path;
use std::time::Instant;

/// Max cell size for stack-allocated cells (key 20 + value 40).
const MAX_CELL_SIZE: usize = 64;

/// Hex with or without 0x. An odd digit count is a big-endian integer missing
/// its leading zero, which hex::decode would reject, so it gets one back.
fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let digits = s.strip_prefix("0x").unwrap_or(s);
    if digits.len() % 2 == 1 {
        hex::decode(format!("0{digits}")).ok()
    } else {
        hex::decode(digits).ok()
    }
}

/// Deterministic address from index: SHAKE-256(i as u64 LE) → first 20 bytes.
pub fn address_from_index(i: usize) -> Vec<u8> {
    let mut hasher = Shake256::default();
    hasher.update(&(i as u64).to_le_bytes());
    let mut reader = hasher.finalize_xof();
    let mut buf = vec![0u8; 20];
    XofReader::read(&mut reader, &mut buf);
    buf
}

/// Trivial address: index encoded as 20-byte big-endian (for identity hash testing).
pub fn trivial_address_from_index(i: usize) -> Vec<u8> {
    let mut buf = vec![0u8; 20];
    buf[12..20].copy_from_slice(&(i as u64).to_be_bytes());
    buf
}

/// Initial value for account i: 32B balance = i as u128 BE padded, 8B nonce = 0.
pub fn initial_value(i: usize) -> Vec<u8> {
    let mut value = vec![0u8; 40];
    let balance_bytes = (i as u128).to_be_bytes(); // 16 bytes
    value[16..32].copy_from_slice(&balance_bytes);
    // nonce = 0 (already zeroed)
    value
}

// ============================================================================
// Canary entry for freshness verification
// ============================================================================

/// Canary address: "InspirePIR" encoded in the last 10 bytes. The canary is a
/// reserved key the client knows; its value carries the snapshot block number,
/// so retrieving it proves which generation answered.
pub const CANARY_ADDRESS: [u8; 20] = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x49, 0x6e, 0x73, 0x70, 0x69, 0x72,
    0x65, 0x50, 0x49, 0x52,
];

/// Build a canary value: balance = block_number, nonce = block_number.
pub fn canary_value(block_number: u64) -> Vec<u8> {
    let mut value = vec![0u8; 40];
    value[16..32].copy_from_slice(&(block_number as u128).to_be_bytes());
    value[32..40].copy_from_slice(&block_number.to_be_bytes());
    value
}

// ============================================================================
// Cuckoo hash parameters
// ============================================================================

pub const DETERMINISTIC_SEED: [u8; 16] = [
    0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE, 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF,
];

/// Trivial seed: when used, hash becomes identity (key bytes → bucket index directly).
pub const TRIVIAL_SEED: [u8; 16] = [0u8; 16];

#[derive(Clone, Debug)]
pub struct CuckooParams {
    pub num_buckets: usize,
    pub key_size: usize,        // 20
    pub value_size: usize,      // 40
    pub bucket_capacity: usize, // 2: cells per bucket
    pub num_hashes: usize,      // 2
    pub max_evictions: usize,   // 10000
    pub seed: [u8; 16],
    /// What the keys in this table are. Set from the snapshot that filled it,
    /// and published in the manifest so a client derives keys the same way.
    pub key_derivation: KeyDerivation,
    /// For a storage table, the contracts whose slots it holds. Also set from
    /// the snapshot, and published alongside the key derivation.
    pub contracts: Vec<[u8; 20]>,
    /// What the values mean when the key does not say, published in the
    /// manifest: `names` for a table of primary names. Empty otherwise.
    pub content: String,
}

impl CuckooParams {
    pub fn new(num_buckets: usize, key_size: usize, value_size: usize, seed: [u8; 16]) -> Self {
        CuckooParams {
            num_buckets,
            key_size,
            value_size,
            bucket_capacity: 2,
            num_hashes: 2,
            max_evictions: 10_000,
            seed,
            key_derivation: KeyDerivation::Address,
            contracts: Vec::new(),
            content: String::new(),
        }
    }

    /// One cell: key + value (60 B for accounts).
    pub fn cell_size(&self) -> usize {
        self.key_size + self.value_size
    }

    /// One bucket = one PIR entry: capacity cells back to back (120 B for
    /// accounts — exactly 64 slots of 15 bits in the backend's encoding).
    pub fn bucket_bytes(&self) -> usize {
        self.bucket_capacity * self.cell_size()
    }
}

// ============================================================================
// SipHash-based bucket hash
// ============================================================================

#[derive(Clone, Debug)]
pub struct CuckooHash {
    pub seed: [u8; 16],
    pub num_buckets: usize,
    pub num_hashes: usize,
}

impl CuckooHash {
    pub fn new(params: &CuckooParams) -> Self {
        CuckooHash {
            seed: params.seed,
            num_buckets: params.num_buckets,
            num_hashes: params.num_hashes,
        }
    }

    pub fn new_from_seed(seed: [u8; 16], num_hashes: usize, num_buckets: usize) -> Self {
        CuckooHash {
            seed,
            num_buckets,
            num_hashes,
        }
    }

    /// Hash a key to a bucket index.
    /// With TRIVIAL_SEED: identity hash (key → index directly, no collisions).
    /// Otherwise: SipHash-2-4 with keys derived from seed + hash_idx.
    pub fn hash(&self, hash_idx: u8, key: &[u8]) -> usize {
        if self.seed == TRIVIAL_SEED {
            let mut buf = [0u8; 8];
            let start = if key.len() >= 8 { key.len() - 8 } else { 0 };
            buf[..key.len().min(8)].copy_from_slice(&key[start..]);
            let idx = u64::from_be_bytes(buf) as usize;
            let half = self.num_buckets / 2;
            match hash_idx {
                0 => idx % half,
                _ => half + (idx % half),
            }
        } else {
            let k0 = u64::from_le_bytes(self.seed[..8].try_into().unwrap()) ^ (hash_idx as u64);
            let k1 = u64::from_le_bytes(self.seed[8..16].try_into().unwrap())
                ^ ((hash_idx as u64) << 32);
            let mut hasher = SipHasher::new_with_keys(k0, k1);
            hasher.write(key);
            let val = hasher.finish();
            (val % self.num_buckets as u64) as usize
        }
    }

    /// Return all possible bucket positions for a key.
    pub fn all_positions(&self, key: &[u8]) -> Vec<usize> {
        (0..self.num_hashes as u8)
            .map(|i| self.hash(i, key))
            .collect()
    }

    /// Fast 2-hash version (avoids Vec allocation in hot path).
    #[inline]
    pub fn positions_2(&self, key: &[u8]) -> [usize; 2] {
        [self.hash(0, key), self.hash(1, key)]
    }
}

// ============================================================================
// Cuckoo table
// ============================================================================

#[derive(Clone)]
pub struct CuckooTable {
    pub params: CuckooParams,
    pub hasher: CuckooHash,
    /// Flat buffer: bucket i at data[i*bucket_bytes .. (i+1)*bucket_bytes],
    /// cell j of a bucket at offset j*cell_size. The first `used[i]` cells
    /// are occupied (kept compact); the rest are zero.
    pub data: Vec<u8>,
    /// Occupied cell count per bucket (0..=bucket_capacity).
    pub used: Vec<u8>,
    pub stash: Vec<Vec<u8>>,
}

impl CuckooTable {
    pub fn new(params: CuckooParams) -> Self {
        assert!(params.cell_size() <= MAX_CELL_SIZE);
        assert!(params.bucket_capacity >= 1 && params.bucket_capacity <= 255);
        let num_buckets = params.num_buckets;
        let bb = params.bucket_bytes();
        let hasher = CuckooHash::new(&params);
        CuckooTable {
            params,
            hasher,
            data: vec![0u8; num_buckets * bb],
            used: vec![0u8; num_buckets],
            stash: Vec::new(),
        }
    }

    /// One bucket's raw bytes (capacity cells) — what the PIR matrix stores.
    #[inline]
    pub fn bucket_slice(&self, b: usize) -> &[u8] {
        let bb = self.params.bucket_bytes();
        &self.data[b * bb..(b + 1) * bb]
    }

    #[inline]
    fn cell_slice_mut(&mut self, b: usize, cell: usize) -> &mut [u8] {
        let bb = self.params.bucket_bytes();
        let cs = self.params.cell_size();
        let off = b * bb + cell * cs;
        &mut self.data[off..off + cs]
    }

    #[inline]
    fn cell_slice(&self, b: usize, cell: usize) -> &[u8] {
        let bb = self.params.bucket_bytes();
        let cs = self.params.cell_size();
        let off = b * bb + cell * cs;
        &self.data[off..off + cs]
    }

    /// Find (bucket, cell) of a key among its candidate buckets.
    fn find(&self, key: &[u8]) -> Option<(usize, usize)> {
        let ks = self.params.key_size;
        for b in self.hasher.positions_2(key) {
            for c in 0..self.used[b] as usize {
                if &self.cell_slice(b, c)[..ks] == key {
                    return Some((b, c));
                }
            }
        }
        None
    }

    /// Place a cell (raw 60 B) into a bucket with a free cell; returns false
    /// if the bucket is full.
    #[inline]
    fn try_place(&mut self, b: usize, cell_bytes: &[u8]) -> bool {
        let u = self.used[b] as usize;
        if u >= self.params.bucket_capacity {
            return false;
        }
        let cs = self.params.cell_size();
        self.cell_slice_mut(b, u)[..cs].copy_from_slice(&cell_bytes[..cs]);
        self.used[b] = (u + 1) as u8;
        true
    }

    /// Insert a key-value pair. Returns the indices of every bucket whose
    /// contents changed (eviction chain included); the caller re-packs those
    /// buckets into the slot matrix via `bucket_slice`.
    pub fn insert(&mut self, key: &[u8], value: &[u8]) -> Vec<usize> {
        let ks = self.params.key_size;
        let cs = self.params.cell_size();
        let mut modified = Vec::new();

        let mut cell = [0u8; MAX_CELL_SIZE];
        cell[..ks].copy_from_slice(key);
        cell[ks..ks + value.len()].copy_from_slice(value);

        for b in self.hasher.positions_2(key) {
            if self.try_place(b, &cell[..cs]) {
                modified.push(b);
                return modified;
            }
        }

        // Both buckets full — random-walk eviction.
        let mut current = cell;
        for _ in 0..self.params.max_evictions {
            let hash_idx = fastrand::usize(0..self.params.num_hashes) as u8;
            let b = self.hasher.hash(hash_idx, &current[..ks]);
            let victim = fastrand::usize(0..self.params.bucket_capacity);

            // Swap current with the victim cell.
            let mut evicted = [0u8; MAX_CELL_SIZE];
            evicted[..cs].copy_from_slice(self.cell_slice(b, victim));
            self.cell_slice_mut(b, victim)[..cs].copy_from_slice(&current[..cs]);
            modified.push(b);
            current = evicted;

            for nb in self.hasher.positions_2(&current[..ks]) {
                if self.try_place(nb, &current[..cs]) {
                    modified.push(nb);
                    return modified;
                }
            }
        }

        self.stash.push(current[..cs].to_vec());
        modified
    }

    /// Update existing key or insert new. Returns modified bucket indices.
    pub fn upsert(&mut self, key: &[u8], value: &[u8]) -> Vec<usize> {
        let ks = self.params.key_size;
        if let Some((b, c)) = self.find(key) {
            let vs = self.params.value_size;
            self.cell_slice_mut(b, c)[ks..ks + vs].copy_from_slice(value);
            return vec![b];
        }
        let cs = self.params.cell_size();
        for entry in &mut self.stash {
            if &entry[..ks] == key {
                let mut new_cell = vec![0u8; cs];
                new_cell[..ks].copy_from_slice(key);
                new_cell[ks..ks + value.len()].copy_from_slice(value);
                *entry = new_cell;
                return vec![];
            }
        }
        self.insert(key, value)
    }

    /// Delete a key. Returns the bucket index if it was in the main table
    /// (the caller re-packs that bucket).
    pub fn delete(&mut self, key: &[u8]) -> Option<usize> {
        let ks = self.params.key_size;
        if let Some((b, c)) = self.find(key) {
            // Keep cells compact: move the last used cell into the hole.
            let cs = self.params.cell_size();
            let last = self.used[b] as usize - 1;
            if c != last {
                let mut tmp = [0u8; MAX_CELL_SIZE];
                tmp[..cs].copy_from_slice(self.cell_slice(b, last));
                self.cell_slice_mut(b, c)[..cs].copy_from_slice(&tmp[..cs]);
            }
            self.cell_slice_mut(b, last).fill(0);
            self.used[b] = last as u8;
            return Some(b);
        }
        if let Some(idx) = self.stash.iter().position(|e| &e[..ks] == key) {
            self.stash.remove(idx);
        }
        None
    }

    /// Lookup a key. Returns value bytes (without key) if found.
    pub fn lookup(&self, key: &[u8]) -> Option<&[u8]> {
        let ks = self.params.key_size;
        let vs = self.params.value_size;
        if let Some((b, c)) = self.find(key) {
            return Some(&self.cell_slice(b, c)[ks..ks + vs]);
        }
        for entry in &self.stash {
            if &entry[..ks] == key {
                return Some(&entry[ks..ks + vs]);
            }
        }
        None
    }

    /// Bulk-build from deterministic accounts, with parallel address generation.
    pub fn build_accounts_parallel(&mut self, num_accounts: usize) {
        self.build_accounts_parallel_with(num_accounts, false);
    }

    /// Build a cell directly into a stack buffer.
    #[inline]
    fn make_cell_inline(buf: &mut [u8; MAX_CELL_SIZE], i: usize, ks: usize, trivial: bool) {
        *buf = [0u8; MAX_CELL_SIZE];
        if trivial {
            buf[12..20].copy_from_slice(&(i as u64).to_be_bytes());
        } else {
            let mut hasher = Shake256::default();
            hasher.update(&(i as u64).to_le_bytes());
            let mut reader = hasher.finalize_xof();
            XofReader::read(&mut reader, &mut buf[..ks]);
        }
        let balance = (i as u128).to_be_bytes();
        buf[ks + 16..ks + 32].copy_from_slice(&balance);
    }

    /// Fast bulk insert: no heap allocation, no modified-bucket tracking.
    #[inline]
    fn insert_fast(&mut self, cell: &[u8; MAX_CELL_SIZE], rng: &mut fastrand::Rng) {
        let ks = self.params.key_size;
        let cs = self.params.cell_size();

        for b in self.hasher.positions_2(&cell[..ks]) {
            if self.try_place(b, &cell[..cs]) {
                return;
            }
        }

        let mut current = *cell;
        for _ in 0..self.params.max_evictions {
            let hash_idx = (rng.u8(..)) % self.params.num_hashes as u8;
            let b = self.hasher.hash(hash_idx, &current[..ks]);
            let victim = rng.usize(0..self.params.bucket_capacity);

            let mut evicted = [0u8; MAX_CELL_SIZE];
            evicted[..cs].copy_from_slice(self.cell_slice(b, victim));
            self.cell_slice_mut(b, victim)[..cs].copy_from_slice(&current[..cs]);
            current = evicted;

            let positions = self.hasher.positions_2(&current[..ks]);
            let mut placed = false;
            for nb in positions {
                if self.try_place(nb, &current[..cs]) {
                    placed = true;
                    break;
                }
            }
            if placed {
                return;
            }
        }

        self.stash.push(current[..cs].to_vec());
    }

    pub fn build_accounts_parallel_with(&mut self, num_accounts: usize, trivial: bool) {
        let ks = self.params.key_size;
        let t0 = Instant::now();
        let mut rng = fastrand::Rng::new();

        let entries_per_chunk = 4_000_000;
        let num_chunks = (num_accounts + entries_per_chunk - 1) / entries_per_chunk;

        let mut last_pct_bucket: u32 = 0;
        for chunk_idx in 0..num_chunks {
            let start = chunk_idx * entries_per_chunk;
            let end = (start + entries_per_chunk).min(num_accounts);
            let count = end - start;

            let mut flat_cells = vec![[0u8; MAX_CELL_SIZE]; count];
            flat_cells.par_iter_mut().enumerate().for_each(|(j, buf)| {
                Self::make_cell_inline(buf, start + j, ks, trivial);
            });

            for cell in &flat_cells {
                self.insert_fast(cell, &mut rng);
            }

            let pct = end as f64 / num_accounts as f64 * 100.0;
            let pct_bucket = (pct / 10.0) as u32;
            if pct_bucket > last_pct_bucket || chunk_idx == num_chunks - 1 {
                last_pct_bucket = pct_bucket;
                let elapsed = t0.elapsed().as_secs_f64();
                let rate = end as f64 / elapsed;
                let eta = (num_accounts - end) as f64 / rate;
                eprint!(
                    "\r  Inserting accounts... {:.0}% ({:.0}s remaining)    ",
                    pct, eta
                );
            }
        }
        eprintln!("\r  Inserting accounts... done.                      ");
    }

    // ========================================================================
    // CSV loading (HuggingFace eth snapshot format)
    // ========================================================================

    /// Build cuckoo table from a HuggingFace-format CSV.
    /// Supports both column orders:
    ///   - `address,nonce,balance_wei`
    ///   - `balance_wei,address,nonce`
    /// and an optional `delegate` column, the hex address an account
    /// delegates its code to under EIP-7702, empty for none.
    /// First line should contain `block=NUMBER` metadata.
    /// Returns (block_number, num_accounts_inserted).
    pub fn build_from_csv(&mut self, path: &Path) -> io::Result<(u64, usize)> {
        let reader = BufReader::with_capacity(64 * 1024 * 1024, File::open(path)?);
        let ks = self.params.key_size;
        let t0 = Instant::now();
        let mut rng = fastrand::Rng::new();
        let mut block_number = 0u64;
        let mut num_accounts = 0usize;

        let mut col_addr: usize = 0;
        let mut col_nonce: usize = 1;
        let mut col_balance: usize = 2;
        let mut col_delegate: Option<usize> = None;
        let mut header_parsed = false;

        for line_result in reader.lines() {
            let line = line_result?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            if let Some(pos) = trimmed.find("block=") {
                let after = &trimmed[pos + 6..];
                let num_str: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(n) = num_str.parse::<u64>() {
                    block_number = n;
                }
                continue;
            }

            // Must be read before the header check below, since one of the
            // spellings contains a column name.
            if let Some(pos) = trimmed.find("key_derivation=") {
                let name: String = trimmed[pos + "key_derivation=".len()..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric())
                    .collect();
                self.params.key_derivation = match name.as_str() {
                    "keccak" => KeyDerivation::Keccak,
                    "address" => KeyDerivation::Address,
                    other => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("snapshot declares an unknown key_derivation {other:?}"),
                        ))
                    }
                };
                continue;
            }

            if !header_parsed && (trimmed.contains("balance") || trimmed.contains("address")) {
                let cols: Vec<&str> = trimmed.split(',').collect();
                for (i, col) in cols.iter().enumerate() {
                    let c = col.trim().to_lowercase();
                    if c == "address" {
                        col_addr = i;
                    } else if c == "nonce" {
                        col_nonce = i;
                    } else if c.contains("balance") {
                        col_balance = i;
                    } else if c == "delegate" {
                        col_delegate = Some(i);
                    }
                }
                header_parsed = true;
                continue;
            }

            let parts: Vec<&str> = trimmed.split(',').collect();
            let max_col = *[col_addr, col_nonce, col_balance].iter().max().unwrap();
            if parts.len() <= max_col {
                continue;
            }

            let address_str = parts[col_addr].trim();
            let nonce_str = parts[col_nonce].trim();
            let balance_str = parts[col_balance].trim();

            let addr_hex = address_str.strip_prefix("0x").unwrap_or(address_str);
            if addr_hex.len() != 40 {
                continue;
            }
            let address = match hex::decode(addr_hex) {
                Ok(a) => a,
                Err(_) => continue,
            };

            // A delegate that does not parse stops the load: the file is
            // generated, and reading it as none would serve wrong code.
            let delegate = match col_delegate.and_then(|i| parts.get(i)).map(|d| d.trim()) {
                None | Some("") => None,
                Some(d) => {
                    let parsed = hex::decode(d.strip_prefix("0x").unwrap_or(d))
                        .ok()
                        .and_then(|b| <[u8; 20]>::try_from(b).ok());
                    match parsed {
                        Some(d) => Some(d),
                        None => {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                format!("bad delegate {d:?} for {address_str}"),
                            ))
                        }
                    }
                }
            };
            let value = AccountValue {
                balance: balance_str.parse().unwrap_or(0),
                nonce: nonce_str.parse().unwrap_or(0),
                delegate,
            };

            let mut cell = [0u8; MAX_CELL_SIZE];
            cell[..ks].copy_from_slice(&address);
            cell[ks..ks + ACCOUNT_VALUE_SIZE].copy_from_slice(&value.pack());

            self.insert_fast(&cell, &mut rng);
            num_accounts += 1;

            if num_accounts % 4_000_000 == 0 {
                let elapsed = t0.elapsed().as_secs_f64();
                let rate = num_accounts as f64 / elapsed;
                eprint!(
                    "\r  Loading CSV... {}M accounts ({:.0}k/s)    ",
                    num_accounts / 1_000_000,
                    rate / 1000.0
                );
            }
        }

        eprintln!(
            "\r  CSV loaded: {} accounts from block #{} ({:.1}s)              ",
            num_accounts,
            block_number,
            t0.elapsed().as_secs_f64()
        );

        Ok((block_number, num_accounts))
    }

    /// Build from a storage snapshot CSV, as `ethrex-statedump --storage-of`
    /// writes it: comment lines `# block=N`, `# key_derivation=storage` and
    /// `# contracts=0x…,0x…`, the header `key,value`, then one row per slot
    /// holding its derived key and its value, both hex. The file is generated,
    /// so anything malformed stops the load rather than leaving a table that is
    /// quietly missing slots. Returns (block_number, slots inserted).
    pub fn build_from_storage_csv(&mut self, path: &Path) -> io::Result<(u64, usize)> {
        let reader = BufReader::with_capacity(64 * 1024 * 1024, File::open(path)?);
        let (ks, vs) = (self.params.key_size, self.params.value_size);
        let invalid = |line: usize, what: String| {
            io::Error::new(io::ErrorKind::InvalidData, format!("line {line}: {what}"))
        };
        let t0 = Instant::now();
        let mut rng = fastrand::Rng::new();
        let (mut block_number, mut slots) = (None, 0usize);
        let mut header_seen = false;
        self.params.key_derivation = KeyDerivation::Storage;
        self.params.contracts.clear();

        for (i, line) in reader.lines().enumerate() {
            let line = line?;
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Some(meta) = line.strip_prefix('#') {
                let meta = meta.trim();
                if let Some(n) = meta.strip_prefix("block=") {
                    let n = n.trim().parse().map_err(|_| invalid(i + 1, format!("bad block {n:?}")))?;
                    block_number = Some(n);
                } else if let Some(name) = meta.strip_prefix("key_derivation=") {
                    if name.trim() != "storage" {
                        return Err(invalid(i + 1, format!("not a storage snapshot: {name:?}")));
                    }
                } else if let Some(list) = meta.strip_prefix("contracts=") {
                    for c in list.split(',') {
                        let bytes = decode_hex(c.trim()).filter(|b| b.len() == 20);
                        let contract = bytes.ok_or_else(|| invalid(i + 1, format!("bad contract {c:?}")))?;
                        self.params.contracts.push(contract.try_into().unwrap());
                    }
                }
                continue;
            }
            if !header_seen {
                if line != "key,value" {
                    return Err(invalid(i + 1, format!("expected the header key,value, not {line:?}")));
                }
                header_seen = true;
                continue;
            }

            let (key_hex, value_hex) = line
                .split_once(',')
                .ok_or_else(|| invalid(i + 1, "expected key,value".into()))?;
            let key = decode_hex(key_hex)
                .filter(|k| k.len() == ks)
                .ok_or_else(|| invalid(i + 1, format!("bad key {key_hex:?}")))?;
            let value = decode_hex(value_hex)
                .filter(|v| v.len() <= vs)
                .ok_or_else(|| invalid(i + 1, format!("bad value {value_hex:?}")))?;
            // The value is a big-endian integer, so it sits at the end of the
            // value field, behind zeros.
            let mut cell = [0u8; MAX_CELL_SIZE];
            cell[..ks].copy_from_slice(&key);
            cell[ks + vs - value.len()..ks + vs].copy_from_slice(&value);
            self.insert_fast(&cell, &mut rng);
            slots += 1;

            if slots % 4_000_000 == 0 {
                let rate = slots as f64 / t0.elapsed().as_secs_f64();
                eprint!("\r  Loading storage CSV... {}M slots ({:.0}k/s)    ", slots / 1_000_000, rate / 1000.0);
            }
        }

        let block_number = block_number
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no `# block=` line"))?;
        if self.params.contracts.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "no `# contracts=` line"));
        }
        eprintln!(
            "\r  Storage CSV loaded: {} slots of {} contracts at block #{} ({:.1}s)              ",
            slots,
            self.params.contracts.len(),
            block_number,
            t0.elapsed().as_secs_f64()
        );
        Ok((block_number, slots))
    }

    /// Write a storage table back out in the form `build_from_storage_csv`
    /// reads, stamped at `block`, so a server can save its own state and start
    /// from it again. The canary is left out, being the server's own entry,
    /// and so are slots that went to zero, which a fresh dump would not have
    /// either. Returns the number of slots written.
    pub fn write_storage_csv(&self, path: &Path, block: u64) -> io::Result<usize> {
        use std::io::Write;
        let (ks, cs) = (self.params.key_size, self.params.cell_size());
        let mut out = std::io::BufWriter::with_capacity(16 << 20, File::create(path)?);
        let contracts: Vec<String> =
            self.params.contracts.iter().map(|c| format!("0x{}", hex::encode(c))).collect();
        writeln!(out, "# block={block}")?;
        writeln!(out, "# key_derivation=storage")?;
        writeln!(out, "# contracts={}", contracts.join(","))?;
        writeln!(out, "key,value")?;

        let cells = (0..self.params.num_buckets)
            .flat_map(|b| (0..self.used[b] as usize).map(move |c| (b, c)))
            .map(|(b, c)| self.cell_slice(b, c))
            .chain(self.stash.iter().map(|cell| &cell[..cs]));
        let mut written = 0;
        for cell in cells {
            let (key, value) = cell.split_at(ks);
            let start = value.iter().position(|&b| b != 0);
            match start {
                Some(start) if key != &CANARY_ADDRESS[..] => {
                    writeln!(out, "{},{}", hex::encode(key), hex::encode(&value[start..]))?;
                    written += 1;
                }
                _ => {}
            }
        }
        out.flush()?;
        Ok(written)
    }

    /// Export all occupied cells to CSV format: `address,nonce,balance_wei,delegate`.
    /// First line is `# block=BLOCK_NUMBER`, second line is the header.
    pub fn export_csv(&self, path: &Path, block_number: u64) -> io::Result<usize> {
        use std::io::Write;
        let ks = self.params.key_size;
        let mut writer = std::io::BufWriter::with_capacity(64 * 1024 * 1024, File::create(path)?);
        writeln!(writer, "# block={}", block_number)?;
        writeln!(writer, "address,nonce,balance_wei,delegate")?;

        let t0 = Instant::now();
        let mut count = 0usize;
        for b in 0..self.params.num_buckets {
            for c in 0..self.used[b] as usize {
                let cell = self.cell_slice(b, c);
                let address = &cell[..ks];
                let a = AccountValue::unpack(&cell[ks..ks + ACCOUNT_VALUE_SIZE]).unwrap();
                let delegate = a.delegate.map(|d| format!("0x{}", hex::encode(d))).unwrap_or_default();
                writeln!(writer, "0x{},{},{},{}", hex::encode(address), a.nonce, a.balance, delegate)?;
                count += 1;
                if count % 4_000_000 == 0 {
                    eprint!("\r  Exporting CSV... {}M accounts    ", count / 1_000_000);
                }
            }
        }
        writer.flush()?;
        eprintln!(
            "\r  CSV exported: {} accounts at block #{} ({:.1}s)              ",
            count,
            block_number,
            t0.elapsed().as_secs_f64()
        );
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_address_from_index_deterministic() {
        let a1 = address_from_index(0);
        let a2 = address_from_index(0);
        assert_eq!(a1, a2);
        assert_eq!(a1.len(), 20);

        let a3 = address_from_index(1);
        assert_ne!(a1, a3);
    }

    #[test]
    fn test_cuckoo_basic() {
        let params = CuckooParams::new(100, 20, 40, DETERMINISTIC_SEED);
        assert_eq!(params.bucket_bytes(), 120);
        let mut table = CuckooTable::new(params);

        let key = address_from_index(0);
        let value = initial_value(0);
        table.insert(&key, &value);

        assert_eq!(table.lookup(&key), Some(value.as_slice()));
    }

    #[test]
    fn test_cuckoo_many_inserts_high_load() {
        // Capacity 2 sustains loads impossible for single-cell 2-hash cuckoo:
        // 8000 keys into 5000 buckets = 10000 cells (80% > the 50% threshold).
        let n = 8_000;
        let params = CuckooParams::new(5_000, 20, 40, DETERMINISTIC_SEED);
        let mut table = CuckooTable::new(params);

        for i in 0..n {
            table.insert(&address_from_index(i), &initial_value(i));
        }
        assert!(
            table.stash.len() < 5,
            "stash too large: {}",
            table.stash.len()
        );

        for i in 0..n {
            let key = address_from_index(i);
            if table.stash.iter().any(|e| &e[..20] == key.as_slice()) {
                continue;
            }
            let val = table.lookup(&key).expect(&format!("key {} not found", i));
            assert_eq!(val, initial_value(i).as_slice(), "mismatch at index {}", i);
        }
    }

    #[test]
    fn test_cuckoo_upsert() {
        let params = CuckooParams::new(100, 20, 40, DETERMINISTIC_SEED);
        let mut table = CuckooTable::new(params);

        let key = address_from_index(0);
        let value1 = initial_value(0);
        table.insert(&key, &value1);
        assert_eq!(table.lookup(&key), Some(value1.as_slice()));

        let mut value2 = vec![0xFFu8; 40];
        value2[32..40].copy_from_slice(&42u64.to_be_bytes());
        let modified = table.upsert(&key, &value2);
        assert_eq!(modified.len(), 1);
        assert_eq!(table.lookup(&key), Some(value2.as_slice()));
    }

    #[test]
    fn test_cuckoo_delete_keeps_bucket_compact() {
        let params = CuckooParams::new(50, 20, 40, DETERMINISTIC_SEED);
        let mut table = CuckooTable::new(params);

        // Insert enough that some bucket holds 2 cells.
        for i in 0..60 {
            table.insert(&address_from_index(i), &initial_value(i));
        }
        // Delete and re-check every remaining key still resolves.
        let victim = address_from_index(7);
        assert!(table.lookup(&victim).is_some());
        table.delete(&victim);
        assert!(table.lookup(&victim).is_none());
        for i in 0..60 {
            if i == 7 {
                continue;
            }
            let key = address_from_index(i);
            if table.stash.iter().any(|e| &e[..20] == key.as_slice()) {
                continue;
            }
            assert_eq!(table.lookup(&key), Some(initial_value(i).as_slice()));
        }
    }

    #[test]
    fn test_build_from_csv() {
        let dir = std::env::temp_dir();
        let csv_path = dir.join("test_accounts.csv");
        {
            let mut f = File::create(&csv_path).unwrap();
            use std::io::Write;
            writeln!(f, "# block=24644657").unwrap();
            writeln!(f, "address,nonce,balance_wei").unwrap();
            writeln!(
                f,
                "0x00000000219ab540356cbb839cbe05303d7705fa,5,1000000000000000000"
            )
            .unwrap();
            writeln!(f, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2,0,0").unwrap();
        }

        let params = CuckooParams::new(100, 20, 40, DETERMINISTIC_SEED);
        let mut table = CuckooTable::new(params);
        let (block, n) = table.build_from_csv(&csv_path).unwrap();

        assert_eq!(block, 24644657);
        assert_eq!(n, 2);

        let addr = hex::decode("00000000219ab540356cbb839cbe05303d7705fa").unwrap();
        let val = table.lookup(&addr).expect("address not found");
        let nonce = u64::from_be_bytes(val[32..40].try_into().unwrap());
        assert_eq!(nonce, 5);

        std::fs::remove_file(&csv_path).ok();
    }

    /// A delegate column fills the first twenty bytes, an empty cell leaves
    /// them zero, and the table writes it back out the same way.
    #[test]
    fn build_from_csv_reads_delegates() {
        let path = std::env::temp_dir().join("test_delegates.csv");
        std::fs::write(
            &path,
            "# block=7\naddress,nonce,balance_wei,delegate\n\
             0x1111111111111111111111111111111111111111,3,100,0x63c0c19a282a1b52b07dd5a65b58948a07dae32b\n\
             0x2222222222222222222222222222222222222222,0,5,\n",
        )
        .unwrap();
        let params = CuckooParams::new(100, 20, 40, DETERMINISTIC_SEED);
        let mut table = CuckooTable::new(params.clone());
        assert_eq!(table.build_from_csv(&path).unwrap(), (7, 2));
        let read = |table: &CuckooTable, a: u8| AccountValue::unpack(table.lookup(&[a; 20]).unwrap()).unwrap();
        let delegate = hex::decode("63c0c19a282a1b52b07dd5a65b58948a07dae32b").unwrap();
        assert_eq!(read(&table, 0x11).delegate.map(|d| d.to_vec()), Some(delegate));
        assert_eq!((read(&table, 0x11).balance, read(&table, 0x11).nonce), (100, 3));
        assert_eq!(read(&table, 0x22).delegate, None);

        table.export_csv(&path, 7).unwrap();
        let mut again = CuckooTable::new(params);
        again.build_from_csv(&path).unwrap();
        assert_eq!(read(&again, 0x11), read(&table, 0x11));
        assert_eq!(read(&again, 0x22), read(&table, 0x22));

        std::fs::write(&path, "address,nonce,balance_wei,delegate\n0x1111111111111111111111111111111111111111,0,1,0x12\n").unwrap();
        assert!(CuckooTable::new(CuckooParams::new(100, 20, 40, DETERMINISTIC_SEED)).build_from_csv(&path).is_err());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_csv_roundtrip() {
        let n = 1000;
        let params = CuckooParams::new(800, 20, 40, DETERMINISTIC_SEED); // 62% load
        let mut table = CuckooTable::new(params.clone());
        for i in 0..n {
            table.insert(&address_from_index(i), &initial_value(i));
        }
        assert!(table.stash.is_empty());

        let dir = std::env::temp_dir();
        let csv_path = dir.join("test_roundtrip.csv");
        let exported = table.export_csv(&csv_path, 123).unwrap();
        assert_eq!(exported, n);

        let mut table2 = CuckooTable::new(params);
        let (block, loaded) = table2.build_from_csv(&csv_path).unwrap();
        assert_eq!(block, 123);
        assert_eq!(loaded, n);
        for i in 0..n {
            assert_eq!(
                table2.lookup(&address_from_index(i)),
                Some(initial_value(i).as_slice())
            );
        }
        std::fs::remove_file(&csv_path).ok();
    }

    /// A snapshot says how its keys were made, so the operator cannot set it
    /// wrong on the server. Note the "address" spelling contains a column name,
    /// so it must not be mistaken for the header row.
    #[test]
    fn build_from_csv_reads_the_declared_key_derivation() {
        use std::io::Write;
        for (declared, want) in [("keccak", KeyDerivation::Keccak), ("address", KeyDerivation::Address)] {
            let path = std::env::temp_dir().join(format!("kd_{declared}.csv"));
            {
                let mut f = File::create(&path).unwrap();
                writeln!(f, "# block=42").unwrap();
                writeln!(f, "# key_derivation={declared}").unwrap();
                writeln!(f, "address,nonce,balance_wei").unwrap();
                writeln!(f, "00000000219ab540356cbb839cbe05303d7705fa,7,5").unwrap();
            }
            let mut table = CuckooTable::new(CuckooParams::new(128, 20, 40, DETERMINISTIC_SEED));
            let (block, n) = table.build_from_csv(&path).unwrap();
            assert_eq!((block, n), (42, 1), "{declared}");
            assert_eq!(table.params.key_derivation, want, "{declared}");
        }
    }

    /// A snapshot that declares nothing is address-keyed, as every one written
    /// before this existed was.
    #[test]
    fn build_from_csv_defaults_to_address_keys() {
        use std::io::Write;
        let path = std::env::temp_dir().join("kd_none.csv");
        {
            let mut f = File::create(&path).unwrap();
            writeln!(f, "# block=42").unwrap();
            writeln!(f, "address,nonce,balance_wei").unwrap();
            writeln!(f, "00000000219ab540356cbb839cbe05303d7705fa,7,5").unwrap();
        }
        let mut table = CuckooTable::new(CuckooParams::new(128, 20, 40, DETERMINISTIC_SEED));
        table.build_from_csv(&path).unwrap();
        assert_eq!(table.params.key_derivation, KeyDerivation::Address);
    }

    fn write_storage_csv(name: &str, lines: &[&str]) -> std::path::PathBuf {
        use std::io::Write;
        let path = std::env::temp_dir().join(name);
        let mut f = File::create(&path).unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
        path
    }

    /// A storage snapshot carries its block, its contracts and its keys, and a
    /// value lands right-aligned in the value field, where the client and the
    /// follower put it.
    #[test]
    fn build_from_storage_csv_reads_slots_and_metadata() {
        let path = write_storage_csv(
            "storage_ok.csv",
            &[
                "# block=26128182",
                "# key_derivation=storage",
                "# contracts=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,0xdac17f958d2ee523a2206206994597c13d831ec7",
                "key,value",
                "d6a3e40d689f6d6eec2db745e1a538aac45c7e87,4438f6820aa3",
                "00000000219ab540356cbb839cbe05303d7705fa,ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            ],
        );
        let mut table = CuckooTable::new(CuckooParams::new(128, 20, 40, DETERMINISTIC_SEED));
        assert_eq!(table.build_from_storage_csv(&path).unwrap(), (26128182, 2));
        assert_eq!(table.params.key_derivation, KeyDerivation::Storage);
        assert_eq!(table.params.contracts.len(), 2);
        assert_eq!(hex::encode(table.params.contracts[1]), "dac17f958d2ee523a2206206994597c13d831ec7");

        let key = hex::decode("d6a3e40d689f6d6eec2db745e1a538aac45c7e87").unwrap();
        let mut word = [0u8; 32];
        word[26..].copy_from_slice(&hex::decode("4438f6820aa3").unwrap());
        assert_eq!(table.lookup(&key).unwrap(), crate::storage::storage_value(&word).as_slice());
        let unlimited = hex::decode("00000000219ab540356cbb839cbe05303d7705fa").unwrap();
        assert_eq!(crate::storage::parse_storage_value(table.lookup(&unlimited).unwrap()), Some([0xff; 32]));
    }

    /// A file that is not a storage snapshot, or is cut short of its metadata,
    /// is refused rather than half loaded.
    #[test]
    fn build_from_storage_csv_refuses_what_it_cannot_trust() {
        let cases: [(&str, &[&str]); 4] = [
            ("storage_kd.csv", &["# block=1", "# key_derivation=keccak", "# contracts=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "key,value"]),
            ("storage_nocontracts.csv", &["# block=1", "key,value", "d6a3e40d689f6d6eec2db745e1a538aac45c7e87,01"]),
            ("storage_noblock.csv", &["# contracts=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "key,value"]),
            ("storage_shortkey.csv", &["# block=1", "# contracts=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "key,value", "d6a3,01"]),
        ];
        for (name, lines) in cases {
            let path = write_storage_csv(name, lines);
            let mut table = CuckooTable::new(CuckooParams::new(128, 20, 40, DETERMINISTIC_SEED));
            assert!(table.build_from_storage_csv(&path).is_err(), "{name}");
        }
    }

    /// What a server saves of its storage table loads back as the same table,
    /// without the canary or the slots that went to zero.
    #[test]
    fn a_saved_storage_table_loads_back() {
        let path = write_storage_csv(
            "storage_save_in.csv",
            &[
                "# block=7",
                "# contracts=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                "key,value",
                "d6a3e40d689f6d6eec2db745e1a538aac45c7e87,4438f6820aa3",
                "00000000219ab540356cbb839cbe05303d7705fa,80000000000000000000000000000000000000000000000000000000000000ff",
                "1111111111111111111111111111111111111111,05",
            ],
        );
        let mut table = CuckooTable::new(CuckooParams::new(128, 20, 40, DETERMINISTIC_SEED));
        table.build_from_storage_csv(&path).unwrap();
        let emptied = hex::decode("1111111111111111111111111111111111111111").unwrap();
        table.upsert(&emptied, &[0u8; 40]);
        table.upsert(&CANARY_ADDRESS, &canary_value(9));

        let saved = std::env::temp_dir().join("storage_save_out.csv");
        assert_eq!(table.write_storage_csv(&saved, 9).unwrap(), 2);
        let mut back = CuckooTable::new(CuckooParams::new(128, 20, 40, DETERMINISTIC_SEED));
        assert_eq!(back.build_from_storage_csv(&saved).unwrap(), (9, 2));
        assert_eq!(back.params.contracts, table.params.contracts);
        for key in ["d6a3e40d689f6d6eec2db745e1a538aac45c7e87", "00000000219ab540356cbb839cbe05303d7705fa"] {
            let key = hex::decode(key).unwrap();
            assert_eq!(back.lookup(&key), table.lookup(&key));
        }
        assert_eq!(back.lookup(&emptied), None);
        assert_eq!(back.lookup(&CANARY_ADDRESS), None);
    }
}
