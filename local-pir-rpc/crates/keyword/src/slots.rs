//! Byte ↔ slot packing for the inspire-gpu backend, and the cuckoo-table →
//! slot-matrix conversion.
//!
//! The backend's plaintext modulus is P = 65535 and each slot carries 15 bits
//! of raw data (value in [0, 32768)). A 120-byte bucket (two 60-byte account
//! cells) is exactly 960 bits = 64 slots. Buckets are laid out ROW-MAJOR to
//! match the backend: PIR entry index b maps to row b % db_rows, column block
//! (b / db_rows) * slots — the same decomposition `ipir_query_build` uses, so
//! bucket index = PIR index.

use crate::cuckoo::CuckooTable;
use rayon::prelude::*;

/// Backend plaintext modulus (matches inspire-gpu params.h).
pub const P: u16 = 65535;
/// Raw data bits per slot.
pub const SLOT_BITS: usize = 15;
/// Backend ring degree (params.h N). The backend rounds db_cols up to a
/// multiple of this; the host matrix must be exactly that wide or the
/// backend's preprocess reads past the buffer.
pub const RING_N: usize = 2048;

/// Number of slots for an entry of `entry_bytes` bytes (matches the backend's
/// `ipir_entry_slots`).
pub fn entry_slots(entry_bytes: usize) -> usize {
    (entry_bytes * 8 + SLOT_BITS - 1) / SLOT_BITS
}

/// Pack bytes into 15-bit slots: the bytes are read as one big-endian bit
/// stream, 15 bits per slot; the last slot is zero-padded on the right.
/// Every produced value is < 32768 < P.
pub fn pack_bytes(bytes: &[u8]) -> Vec<u16> {
    let mut out = Vec::with_capacity(entry_slots(bytes.len()));
    let mut acc: u64 = 0;
    let mut nbits: u32 = 0;
    for &b in bytes {
        acc = (acc << 8) | b as u64;
        nbits += 8;
        while nbits >= 15 {
            nbits -= 15;
            out.push(((acc >> nbits) & 0x7FFF) as u16);
            acc &= (1u64 << nbits) - 1;
        }
    }
    if nbits > 0 {
        out.push(((acc << (15 - nbits)) & 0x7FFF) as u16);
    }
    out
}

/// Inverse of `pack_bytes`.
pub fn unpack_bytes(slots: &[u16], entry_bytes: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(entry_bytes);
    let mut acc: u64 = 0;
    let mut nbits: u32 = 0;
    for &s in slots {
        acc = (acc << 15) | (s as u64 & 0x7FFF);
        nbits += 15;
        while nbits >= 8 && out.len() < entry_bytes {
            nbits -= 8;
            out.push(((acc >> nbits) & 0xFF) as u8);
            acc &= if nbits == 0 { 0 } else { (1u64 << nbits) - 1 };
        }
    }
    out
}

/// Column count of the slot matrix for a table laid out over `db_rows` rows.
pub fn slot_db_cols(table: &CuckooTable, db_rows: usize) -> usize {
    let nb = table.params.num_buckets;
    assert!(nb % db_rows == 0, "num_buckets must be a multiple of db_rows");
    let cols = (nb / db_rows) * entry_slots(table.params.bucket_bytes());
    // Mirror the backend (params.cpp): db_cols is rounded up to a multiple
    // of the ring degree. Without this, geometries where buckets/db_rows is
    // not a multiple of 32 hand the backend a narrower matrix than it reads.
    (cols + RING_N - 1) / RING_N * RING_N
}

/// Convert the cuckoo table to the backend's row-major slot matrix
/// (db_rows * db_cols u16 values in [0, P)); empty buckets stay zero.
/// Feed the result straight to `ipir_server_create(num_buckets,
/// bucket_bytes, db_rows, ...)`.
pub fn to_slot_db(table: &CuckooTable, db_rows: usize) -> Vec<u16> {
    let bb = table.params.bucket_bytes();
    let cpe = entry_slots(bb);
    let db_cols = slot_db_cols(table, db_rows);

    let mut slot_db = vec![0u16; db_rows * db_cols];
    let dst_addr = slot_db.as_mut_ptr() as usize;

    // Each bucket writes a disjoint [base, base+cpe) range, so the parallel
    // writes never alias.
    (0..table.params.num_buckets).into_par_iter().for_each(|b| {
        if table.used[b] == 0 {
            return;
        }
        let row = b % db_rows;
        let block = b / db_rows;
        let base = row * db_cols + block * cpe;
        let packed = pack_bytes(table.bucket_slice(b));
        let dst = dst_addr as *mut u16;
        for (j, &v) in packed.iter().enumerate() {
            unsafe { *dst.add(base + j) = v };
        }
    });

    slot_db
}

/// Write one bucket's raw bytes into an existing slot matrix (row-major).
pub fn write_bucket_to_slot_db(
    slot_db: &mut [u16],
    bucket_idx: usize,
    bucket_bytes: &[u8],
    db_rows: usize,
    db_cols: usize,
) {
    let cpe = entry_slots(bucket_bytes.len());
    let row = bucket_idx % db_rows;
    let block = bucket_idx / db_rows;
    let base = row * db_cols + block * cpe;
    let packed = pack_bytes(bucket_bytes);
    slot_db[base..base + cpe].copy_from_slice(&packed);
}

/// Zero one bucket in an existing slot matrix (row-major).
pub fn zero_bucket_in_slot_db(
    slot_db: &mut [u16],
    bucket_idx: usize,
    bucket_size: usize,
    db_rows: usize,
    db_cols: usize,
) {
    let cpe = entry_slots(bucket_size);
    let row = bucket_idx % db_rows;
    let block = bucket_idx / db_rows;
    let base = row * db_cols + block * cpe;
    slot_db[base..base + cpe].fill(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cuckoo::*;

    #[test]
    fn test_pack_roundtrip_120() {
        let bytes: Vec<u8> = (0..120u8).map(|i| i.wrapping_mul(37).wrapping_add(11)).collect();
        let slots = pack_bytes(&bytes);
        assert_eq!(slots.len(), 64); // 960 bits = exactly 64 slots
        assert!(slots.iter().all(|&s| s < 32768));
        assert_eq!(unpack_bytes(&slots, 120), bytes);
    }

    #[test]
    fn test_pack_roundtrip_odd_sizes() {
        for len in [1usize, 7, 15, 20, 40, 59, 60, 61, 64, 119, 121] {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 131 % 256) as u8).collect();
            let slots = pack_bytes(&bytes);
            assert_eq!(slots.len(), entry_slots(len), "len={}", len);
            assert!(slots.iter().all(|&s| s < 32768));
            assert_eq!(unpack_bytes(&slots, len), bytes, "len={}", len);
        }
    }

    #[test]
    fn test_pack_all_ones() {
        let bytes = vec![0xFFu8; 120];
        let slots = pack_bytes(&bytes);
        assert!(slots.iter().all(|&s| s == 0x7FFF));
        assert_eq!(unpack_bytes(&slots, 120), bytes);
    }

    #[test]
    fn test_to_slot_db_locates_entries() {
        // 700 keys into 500 buckets (1000 cells, 70% load — capacity 2).
        let n = 700;
        let db_rows = 250;
        let params = CuckooParams::new(500, 20, 40, DETERMINISTIC_SEED);
        let mut table = CuckooTable::new(params);
        for i in 0..n {
            table.insert(&address_from_index(i), &initial_value(i));
        }
        assert!(table.stash.is_empty());

        let bb = table.params.bucket_bytes();
        let cs = table.params.cell_size();
        let cpe = entry_slots(bb);
        let db_cols = slot_db_cols(&table, db_rows);
        let slot_db = to_slot_db(&table, db_rows);
        assert_eq!(slot_db.len(), db_rows * db_cols);

        // Every inserted key must be recoverable from the matrix in one of
        // its two candidate buckets' cells.
        for i in 0..n {
            let key = address_from_index(i);
            let mut found = false;
            'outer: for pos in table.hasher.positions_2(&key) {
                let row = pos % db_rows;
                let block = pos / db_rows;
                let base = row * db_cols + block * cpe;
                let bucket = unpack_bytes(&slot_db[base..base + cpe], bb);
                for c in 0..table.params.bucket_capacity {
                    let cell = &bucket[c * cs..(c + 1) * cs];
                    if &cell[..20] == key.as_slice() {
                        assert_eq!(&cell[20..60], initial_value(i).as_slice());
                        found = true;
                        break 'outer;
                    }
                }
            }
            assert!(found, "key {} not found in slot matrix", i);
        }
    }

    #[test]
    fn test_incremental_update_matches_rebuild() {
        let params = CuckooParams::new(200, 20, 40, DETERMINISTIC_SEED);
        let mut table = CuckooTable::new(params);
        for i in 0..100 {
            table.insert(&address_from_index(i), &initial_value(i));
        }
        let db_rows = 100;
        let db_cols = slot_db_cols(&table, db_rows);
        let mut slot_db = to_slot_db(&table, db_rows);

        // Apply an upsert both to the table and incrementally to the matrix.
        let key = address_from_index(3);
        let new_value = vec![0xABu8; 40];
        for bucket in table.upsert(&key, &new_value) {
            let bytes = table.bucket_slice(bucket).to_vec();
            write_bucket_to_slot_db(&mut slot_db, bucket, &bytes, db_rows, db_cols);
        }
        // And a delete (bucket may still hold its other cell — rewrite, not zero).
        let key9 = address_from_index(9);
        if let Some(bucket) = table.delete(&key9) {
            let bytes = table.bucket_slice(bucket).to_vec();
            write_bucket_to_slot_db(&mut slot_db, bucket, &bytes, db_rows, db_cols);
        }

        assert_eq!(slot_db, to_slot_db(&table, db_rows));
    }
}
