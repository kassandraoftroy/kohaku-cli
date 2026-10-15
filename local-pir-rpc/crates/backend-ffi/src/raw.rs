//! Direct declarations of the ipir_* C ABI (inspire-gpu src/capi.h).
//! Layouts must match the header field for field.

#![allow(non_camel_case_types)]

#[repr(C)]
pub struct ipir_server {
    _private: [u8; 0],
}

#[repr(C)]
pub struct ipir_client_query {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ipir_params {
    pub n_entries: usize,
    pub entry_bytes: usize,
    pub db_rows: usize,
    pub db_cols: usize,
    pub n_packed: usize,
    pub interp_d: usize,
    pub num_cts: usize,
    pub ring_n: usize,
    pub d_eff: usize,
    pub seed: [u8; 64],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct ipir_caps {
    pub max_batch: usize,
    pub resident_bytes: usize,
    pub device_free_bytes: usize,
    pub num_cts: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ipir_query_view {
    pub lwe_b_limb0: *const u64,
    pub lwe_b_limb1: *const u64,
    pub ksk5_b: *const u64,
    pub kskneg1_b: *const u64,
    pub rgsw: *const u64,
}

extern "C" {
    // Client half (CPU library).
    pub fn ipir_query_u64s(params: *const ipir_params) -> usize;
    pub fn ipir_response_u64s(params: *const ipir_params) -> usize;
    pub fn ipir_entry_slots(params: *const ipir_params) -> usize;
    pub fn ipir_query_view_from_flat(
        params: *const ipir_params,
        flat: *const u64,
        out_view: *mut ipir_query_view,
    ) -> i32;
    pub fn ipir_query_build(
        params: *const ipir_params,
        idx: u64,
        out_query: *mut u64,
    ) -> *mut ipir_client_query;
    pub fn ipir_extract(
        params: *const ipir_params,
        q: *const ipir_client_query,
        resp: *const u64,
        out_slots: *mut u16,
    ) -> i32;
    pub fn ipir_client_query_destroy(q: *mut ipir_client_query);

    // Wire packing (lossless BETA=53-bit CRT packing; see capi.h).
    pub fn ipir_query_packed_bytes(params: *const ipir_params) -> usize;
    pub fn ipir_response_packed_bytes(params: *const ipir_params) -> usize;
    pub fn ipir_query_pack(params: *const ipir_params, flat: *const u64, out: *mut u8) -> i32;
    pub fn ipir_response_pack(params: *const ipir_params, flat: *const u64, out: *mut u8) -> i32;
    pub fn ipir_query_unpack(params: *const ipir_params, input: *const u8, out_flat: *mut u64) -> i32;
    pub fn ipir_response_unpack(params: *const ipir_params, input: *const u8, out_flat: *mut u64) -> i32;

    // Compressed responses (modulus switching to q'; see capi.h).
    pub fn ipir_response_compressed_bytes(params: *const ipir_params) -> usize;
    pub fn ipir_response_compress(params: *const ipir_params, flat: *const u64, out: *mut u8) -> i32;
    pub fn ipir_extract_compressed(
        params: *const ipir_params,
        q: *const ipir_client_query,
        input: *const u8,
        out_slots: *mut u16,
    ) -> i32;
}

// Server half (GPU library).
#[cfg(feature = "gpu")]
extern "C" {
    pub fn ipir_server_create(
        n_entries: usize,
        entry_bytes: usize,
        db_rows_or_zero: usize,
        max_batch: usize,
        slot_db: *const u16,
        crs_seed_or_null: *const u8,
        out_params: *mut ipir_params,
    ) -> *mut ipir_server;
    pub fn ipir_server_caps(srv: *const ipir_server, out: *mut ipir_caps);
    pub fn ipir_answer_batch(
        srv: *mut ipir_server,
        queries: *const ipir_query_view,
        count: usize,
        out_resp: *mut u64,
    ) -> i32;
    pub fn ipir_server_destroy(srv: *mut ipir_server);
}
