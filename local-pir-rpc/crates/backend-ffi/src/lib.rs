//! Safe Rust wrappers over the inspire-gpu `ipir_*` C ABI.
//!
//! The client half ([`Params`], [`ClientQuery`]) is always available and
//! needs no GPU. The server half ([`GpuServer`]) is behind the `gpu` feature
//! and links the CMake-built libraries (see build.rs).

pub mod raw;

use pir_keyword::manifest::PirManifest;

/// The published service parameters (mirror of `ipir_params`).
#[derive(Clone, Copy)]
pub struct Params(pub raw::ipir_params);

impl Params {
    /// u64 count of one flat query.
    pub fn query_u64s(&self) -> usize {
        unsafe { raw::ipir_query_u64s(&self.0) }
    }

    /// u64 count of one query's response.
    pub fn response_u64s(&self) -> usize {
        unsafe { raw::ipir_response_u64s(&self.0) }
    }

    /// u16 plaintext slots per entry.
    pub fn entry_slots(&self) -> usize {
        unsafe { raw::ipir_entry_slots(&self.0) }
    }

    /// True if the C library accepts these parameters (also catches a
    /// client/server built from incompatible library versions).
    pub fn valid(&self) -> bool {
        self.query_u64s() != 0
    }

    pub fn to_manifest(&self) -> PirManifest {
        PirManifest {
            n_entries: self.0.n_entries,
            entry_bytes: self.0.entry_bytes,
            db_rows: self.0.db_rows,
            db_cols: self.0.db_cols,
            n_packed: self.0.n_packed,
            interp_d: self.0.interp_d,
            num_cts: self.0.num_cts,
            ring_n: self.0.ring_n,
            d_eff: self.0.d_eff,
            crs_seed_hex: hex::encode(self.0.seed),
        }
    }

    pub fn from_manifest(m: &PirManifest) -> Result<Params, String> {
        let p = Params(raw::ipir_params {
            n_entries: m.n_entries,
            entry_bytes: m.entry_bytes,
            db_rows: m.db_rows,
            db_cols: m.db_cols,
            n_packed: m.n_packed,
            interp_d: m.interp_d,
            num_cts: m.num_cts,
            ring_n: m.ring_n,
            d_eff: m.d_eff,
            seed: m.crs_seed()?,
        });
        if !p.valid() {
            return Err("parameters rejected by the backend library".into());
        }
        Ok(p)
    }
}

/// One built query: the per-query secret state plus the flat wire bytes.
/// Keep it until the response is extracted; a fresh secret is drawn per build.
pub struct ClientQuery {
    handle: *mut raw::ipir_client_query,
    /// Flat query in the canonical wire layout (`query_u64s` values).
    pub flat: Vec<u64>,
}

// The handle is a heap object only this struct touches.
unsafe impl Send for ClientQuery {}

impl ClientQuery {
    /// Build a query for PIR entry `idx` under a fresh secret.
    pub fn build(params: &Params, idx: u64) -> Result<ClientQuery, String> {
        let mut flat = vec![0u64; params.query_u64s()];
        let handle = unsafe { raw::ipir_query_build(&params.0, idx, flat.as_mut_ptr()) };
        if handle.is_null() {
            return Err(format!("ipir_query_build failed (idx={})", idx));
        }
        Ok(ClientQuery { handle, flat })
    }

    /// Decrypt this query's response (`response_u64s` values) into plaintext
    /// slots (`entry_slots` u16 values in [0, P)).
    pub fn extract(&self, params: &Params, resp: &[u64]) -> Result<Vec<u16>, String> {
        if resp.len() != params.response_u64s() {
            return Err(format!(
                "response length {} != expected {}",
                resp.len(),
                params.response_u64s()
            ));
        }
        let mut slots = vec![0u16; params.entry_slots()];
        let rc = unsafe {
            raw::ipir_extract(&params.0, self.handle, resp.as_ptr(), slots.as_mut_ptr())
        };
        if rc != 0 {
            return Err(format!("ipir_extract failed rc={}", rc));
        }
        Ok(slots)
    }
}

impl ClientQuery {
    /// Decrypt this query's modulus-switched response
    /// (`response_compressed_bytes` bytes) into plaintext slots.
    pub fn extract_compressed(
        &self,
        params: &Params,
        wire: &[u8],
    ) -> Result<Vec<u16>, String> {
        if wire.len() != params.response_compressed_bytes() {
            return Err(format!(
                "compressed response must be {} bytes, got {}",
                params.response_compressed_bytes(),
                wire.len()
            ));
        }
        let mut slots = vec![0u16; params.entry_slots()];
        let rc = unsafe {
            raw::ipir_extract_compressed(&params.0, self.handle, wire.as_ptr(), slots.as_mut_ptr())
        };
        if rc != 0 {
            return Err(format!("ipir_extract_compressed failed rc={}", rc));
        }
        Ok(slots)
    }
}

impl Drop for ClientQuery {
    fn drop(&mut self) {
        unsafe { raw::ipir_client_query_destroy(self.handle) };
    }
}

/// Wire encodings (capi.h). Queries: lossless 53-bit CRT packing, 371 KB
/// instead of 918 KB of raw u64s (db_rows = 32768). Responses: either the
/// lossless packing (26.5 KB) or the modulus-switched compression (12 KB
/// per ciphertext, the deployed format).
impl Params {
    pub fn query_packed_bytes(&self) -> usize {
        unsafe { raw::ipir_query_packed_bytes(&self.0) }
    }
    pub fn response_packed_bytes(&self) -> usize {
        unsafe { raw::ipir_response_packed_bytes(&self.0) }
    }
    pub fn response_compressed_bytes(&self) -> usize {
        unsafe { raw::ipir_response_compressed_bytes(&self.0) }
    }
}

/// Server side: flat response -> modulus-switched compressed bytes (12 KB
/// per ciphertext).
pub fn compress_response(params: &Params, flat: &[u64]) -> Result<Vec<u8>, String> {
    if flat.len() != params.response_u64s() {
        return Err("bad flat response length".into());
    }
    let mut out = vec![0u8; params.response_compressed_bytes()];
    match unsafe { raw::ipir_response_compress(&params.0, flat.as_ptr(), out.as_mut_ptr()) } {
        0 => Ok(out),
        rc => Err(format!("ipir_response_compress rc={}", rc)),
    }
}

pub fn pack_query(params: &Params, flat: &[u64]) -> Result<Vec<u8>, String> {
    if flat.len() != params.query_u64s() {
        return Err("bad flat query length".into());
    }
    let mut out = vec![0u8; params.query_packed_bytes()];
    match unsafe { raw::ipir_query_pack(&params.0, flat.as_ptr(), out.as_mut_ptr()) } {
        0 => Ok(out),
        rc => Err(format!("ipir_query_pack rc={}", rc)),
    }
}

pub fn unpack_query(params: &Params, wire: &[u8]) -> Result<Vec<u64>, String> {
    if wire.len() != params.query_packed_bytes() {
        return Err(format!(
            "packed query must be {} bytes, got {}",
            params.query_packed_bytes(),
            wire.len()
        ));
    }
    let mut out = vec![0u64; params.query_u64s()];
    match unsafe { raw::ipir_query_unpack(&params.0, wire.as_ptr(), out.as_mut_ptr()) } {
        0 => Ok(out),
        rc => Err(format!("ipir_query_unpack rc={}", rc)),
    }
}

pub fn pack_response(params: &Params, flat: &[u64]) -> Result<Vec<u8>, String> {
    if flat.len() != params.response_u64s() {
        return Err("bad flat response length".into());
    }
    let mut out = vec![0u8; params.response_packed_bytes()];
    match unsafe { raw::ipir_response_pack(&params.0, flat.as_ptr(), out.as_mut_ptr()) } {
        0 => Ok(out),
        rc => Err(format!("ipir_response_pack rc={}", rc)),
    }
}

pub fn unpack_response(params: &Params, wire: &[u8]) -> Result<Vec<u64>, String> {
    if wire.len() != params.response_packed_bytes() {
        return Err(format!(
            "packed response must be {} bytes, got {}",
            params.response_packed_bytes(),
            wire.len()
        ));
    }
    let mut out = vec![0u64; params.response_u64s()];
    match unsafe { raw::ipir_response_unpack(&params.0, wire.as_ptr(), out.as_mut_ptr()) } {
        0 => Ok(out),
        rc => Err(format!("ipir_response_unpack rc={}", rc)),
    }
}

/// Build an `ipir_query_view` over a flat query received on the wire.
pub fn view_from_flat(
    params: &Params,
    flat: &[u64],
) -> Result<raw::ipir_query_view, String> {
    if flat.len() != params.query_u64s() {
        return Err(format!(
            "query length {} != expected {}",
            flat.len(),
            params.query_u64s()
        ));
    }
    let mut view = raw::ipir_query_view {
        lwe_b_limb0: std::ptr::null(),
        lwe_b_limb1: std::ptr::null(),
        ksk5_b: std::ptr::null(),
        kskneg1_b: std::ptr::null(),
        rgsw: std::ptr::null(),
    };
    let rc = unsafe { raw::ipir_query_view_from_flat(&params.0, flat.as_ptr(), &mut view) };
    if rc != 0 {
        return Err(format!("ipir_query_view_from_flat failed rc={}", rc));
    }
    Ok(view)
}

#[cfg(feature = "gpu")]
pub use gpu::{Caps, GpuServer};

#[cfg(feature = "gpu")]
mod gpu {
    use super::*;

    #[derive(Clone, Copy, Debug)]
    pub struct Caps {
        pub max_batch: usize,
        pub resident_bytes: usize,
        pub device_free_bytes: usize,
        pub num_cts: usize,
    }

    /// One database generation resident on the GPU. Single-threaded handle:
    /// `answer_batch` takes `&mut self`, and the struct is Send (movable to a
    /// scheduler thread) but not Sync.
    pub struct GpuServer {
        handle: *mut raw::ipir_server,
        params: Params,
    }

    unsafe impl Send for GpuServer {}

    impl GpuServer {
        /// Preprocess `slot_db` (db_rows * db_cols u16 values in [0, P),
        /// row-major) and stand the generation up on the GPU.
        /// `crs_seed`: None draws a fresh CRS; Some pins it, keeping queries
        /// valid across database rebuilds (the CRS is public randomness —
        /// privacy rests on the fresh per-query secret).
        pub fn create(
            n_entries: usize,
            entry_bytes: usize,
            db_rows: usize,
            max_batch: usize,
            slot_db: &[u16],
            crs_seed: Option<&[u8; 64]>,
        ) -> Result<GpuServer, String> {
            let mut p = raw::ipir_params {
                n_entries: 0,
                entry_bytes: 0,
                db_rows: 0,
                db_cols: 0,
                n_packed: 0,
                interp_d: 0,
                num_cts: 0,
                ring_n: 0,
                d_eff: 0,
                seed: [0u8; 64],
            };
            let handle = unsafe {
                raw::ipir_server_create(
                    n_entries,
                    entry_bytes,
                    db_rows,
                    max_batch,
                    slot_db.as_ptr(),
                    crs_seed.map_or(std::ptr::null(), |s| s.as_ptr()),
                    &mut p,
                )
            };
            if handle.is_null() {
                return Err("ipir_server_create failed".into());
            }
            let params = Params(p);
            if slot_db.len() != params.0.db_rows * params.0.db_cols {
                unsafe { raw::ipir_server_destroy(handle) };
                return Err(format!(
                    "slot_db length {} != db_rows*db_cols {}",
                    slot_db.len(),
                    params.0.db_rows * params.0.db_cols
                ));
            }
            Ok(GpuServer { handle, params })
        }

        pub fn params(&self) -> &Params {
            &self.params
        }

        pub fn caps(&self) -> Caps {
            let mut c = raw::ipir_caps::default();
            unsafe { raw::ipir_server_caps(self.handle, &mut c) };
            Caps {
                max_batch: c.max_batch,
                resident_bytes: c.resident_bytes,
                device_free_bytes: c.device_free_bytes,
                num_cts: c.num_cts,
            }
        }

        /// Answer up to `max_batch` flat queries in one GPU pass. Returns the
        /// concatenated responses, `response_u64s` values per query.
        pub fn answer_batch(&mut self, queries: &[&[u64]]) -> Result<Vec<u64>, String> {
            let views: Vec<raw::ipir_query_view> = queries
                .iter()
                .map(|q| view_from_flat(&self.params, q))
                .collect::<Result<_, _>>()?;
            let mut out = vec![0u64; queries.len() * self.params.response_u64s()];
            let rc = unsafe {
                raw::ipir_answer_batch(self.handle, views.as_ptr(), views.len(), out.as_mut_ptr())
            };
            if rc != 0 {
                return Err(format!("ipir_answer_batch failed rc={}", rc));
            }
            Ok(out)
        }
    }

    impl Drop for GpuServer {
        fn drop(&mut self) {
            unsafe { raw::ipir_server_destroy(self.handle) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_params() -> Params {
        // The 524288-entry / db_rows=2048 geometry used by inspire-gpu's
        // test_capi; any 64-byte seed is a valid CRS.
        Params(raw::ipir_params {
            n_entries: 524288,
            entry_bytes: 120,
            db_rows: 2048,
            db_cols: 16384,
            n_packed: 8,
            interp_d: 512,
            num_cts: 1,
            ring_n: 2048,
            d_eff: 2,
            seed: [7u8; 64],
        })
    }

    #[test]
    fn test_sizes() {
        let p = test_params();
        assert!(p.valid());
        assert_eq!(p.query_u64s(), 2 * 2048 + 6 * 2 * 2 * 2048);
        assert_eq!(p.response_u64s(), 4 * 2048);
        assert_eq!(p.entry_slots(), 64);
    }

    #[test]
    fn test_query_build_cpu_only() {
        let p = test_params();
        let q = ClientQuery::build(&p, 12345).unwrap();
        assert_eq!(q.flat.len(), p.query_u64s());
        // The LWE part must not be all zeros (something was written).
        assert!(q.flat[..2048].iter().any(|&v| v != 0));
        // A view over the flat buffer points at the documented offsets.
        let v = view_from_flat(&p, &q.flat).unwrap();
        assert_eq!(v.lwe_b_limb0, q.flat.as_ptr());
        assert_eq!(v.lwe_b_limb1, unsafe { q.flat.as_ptr().add(2048) });
        // Out-of-range index is rejected.
        assert!(ClientQuery::build(&p, 524288).is_err());
    }

    #[test]
    fn test_wire_packing_roundtrip() {
        let p = test_params();
        // BETA = 53 bits per value: db_rows + 6*d_eff*N values.
        assert_eq!(
            p.query_packed_bytes(),
            ((2048 + 6 * 2 * 2048) * 53 + 7) / 8
        );
        // Modulus-switched responses: 12,288 B per ciphertext.
        assert_eq!(p.response_compressed_bytes(), p.0.num_cts * 12288);
        let q = ClientQuery::build(&p, 777).unwrap();
        let wire = pack_query(&p, &q.flat).unwrap();
        assert_eq!(unpack_query(&p, &wire).unwrap(), q.flat);
        // Response path: any reduced-residue array round-trips (values kept
        // below both 27-bit RNS primes).
        let flat: Vec<u64> = (0..p.response_u64s() as u64)
            .map(|i| i * 2654435761 % 90000000)
            .collect();
        let wire = pack_response(&p, &flat).unwrap();
        assert_eq!(unpack_response(&p, &wire).unwrap(), flat);
    }

    #[test]
    fn test_manifest_roundtrip() {
        let p = test_params();
        let m = p.to_manifest();
        let p2 = Params::from_manifest(&m).unwrap();
        assert_eq!(p2.0.n_entries, p.0.n_entries);
        assert_eq!(p2.0.seed, p.0.seed);
    }
}
