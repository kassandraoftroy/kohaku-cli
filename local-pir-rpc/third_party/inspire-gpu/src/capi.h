// C ABI facade for FFI consumers (e.g. a Rust service wrapper).
//
// Two halves share this header but live in different libraries:
//   server (create → caps → answer_batch → destroy) — GPU library (capi.cu)
//   client (query_build → extract → destroy)        — CPU library
//                                                     (capi_client.cpp)
// so a client-only consumer links the CPU library and needs no CUDA. The
// boundary exchanges flat little-endian u64/u16 arrays with documented
// layouts; no C++ types cross it. Values are residues mod the two 27-bit
// primes carried in full u64s — any wire compression is the caller's.
//
// Thread-safety: one ipir_server is single-threaded (do not call
// ipir_answer_batch concurrently on the same handle). Different handles are
// independent; a database generation = one handle (see gpu_protocol.h).
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ipir_server ipir_server;  // opaque

// Public parameters of the created server. The client needs every field
// (including the CRS seed) to build queries against this database.
typedef struct {
    size_t n_entries;
    size_t entry_bytes;
    size_t db_rows;       // query vector length
    size_t db_cols;
    size_t n_packed;      // pack groups
    size_t interp_d;      // interpolation degree D
    size_t num_cts;       // ciphertexts per response
    size_t ring_n;        // RLWE ring degree N
    size_t d_eff;         // effective gadget digits per KSK / RGSW part
    uint8_t seed[64];     // CRS seed (SEED_BYTES)
} ipir_params;

typedef struct {
    size_t max_batch;
    size_t resident_bytes;
    size_t device_free_bytes;
    size_t num_cts;
} ipir_caps;

// One query, as views into caller-owned flat u64 arrays:
//   lwe_b_limb0/1 : db_rows values (mod q0 / q1)
//   ksk5_b, kskneg1_b : d_eff * 2 * ring_n values, [digit][limb][coeff],
//                       coefficient form
//   rgsw : 4 * d_eff * 2 * ring_n values,
//          [top_a | top_b | bot_a | bot_b][digit][limb][coeff], NTT form
// Every query is fully self-contained; key material must never be shared
// across queries (fixed CRS + a reused secret leaks the queried indices).
typedef struct {
    const uint64_t* lwe_b_limb0;
    const uint64_t* lwe_b_limb1;
    const uint64_t* ksk5_b;
    const uint64_t* kskneg1_b;
    const uint64_t* rgsw;
} ipir_query_view;

// Build a server for one database generation.
//   db : db_rows * db_cols u16 values in [0, P), row-major
//             (db[row*db_cols + col]); with db_rows_or_zero == 0 the default
//             geometry (db_rows = 32768) picks db_rows.
//   max_batch : answer-batch slot pool size (>= 1)
//   crs_seed_or_null : 64-byte CRS seed, or NULL to draw one fresh
//             (out_params->seed reports it either way). A fixed CRS keeps
//             queries valid across database rebuilds, and lets several
//             servers (replicas, or the two sides of a rolling swap)
//             accept the same queries. The CRS is public randomness:
//             privacy rests on the fresh per-query secret, never on CRS
//             freshness.
// On success returns the handle and fills *out_params; returns NULL on error.
ipir_server* ipir_server_create(size_t n_entries, size_t entry_bytes,
                                size_t db_rows_or_zero, size_t max_batch,
                                const uint16_t* db,
                                const uint8_t* crs_seed_or_null,
                                ipir_params* out_params);

void ipir_server_caps(const ipir_server* srv, ipir_caps* out);

// Answer `count` (<= max_batch) queries. Blocking; all-or-nothing.
//   out_resp : count * num_cts * 4 * ring_n u64s,
//              [query][ct][a | b][limb][coeff], NTT form.
// Returns 0 on success, nonzero on validation failure (nothing written).
int ipir_answer_batch(ipir_server* srv, const ipir_query_view* queries,
                      size_t count, uint64_t* out_resp);

void ipir_server_destroy(ipir_server* srv);

// ============================================================
// Client side (CPU library; no CUDA needed)
// ============================================================

// Per-query client state: the fresh secret plus the target offsets inside the
// response. Keep it until the response is extracted, then destroy it.
typedef struct ipir_client_query ipir_client_query;  // opaque

// Size helpers (pure functions of the published parameters).
//   query    : 2*db_rows + 6 * (d_eff*2*ring_n) u64s (layout below)
//   response : num_cts * 4 * ring_n u64s (as written by ipir_answer_batch)
//   slots    : u16 plaintext slots per entry ((entry_bytes*8 + 14) / 15)
size_t ipir_query_u64s(const ipir_params* params);
size_t ipir_response_u64s(const ipir_params* params);
size_t ipir_entry_slots(const ipir_params* params);

// Canonical flat query layout, back to back in one u64 buffer — this is the
// suggested wire format:
//   [lwe_b_limb0 : db_rows][lwe_b_limb1 : db_rows]
//   [ksk5_b : blk][kskneg1_b : blk][rgsw : 4*blk],  blk = d_eff*2*ring_n
// ipir_query_view_from_flat points a view at such a buffer (used by a server
// that received the flat bytes). Returns 0 on success.
int ipir_query_view_from_flat(const ipir_params* params, const uint64_t* flat,
                              ipir_query_view* out_view);

// Build a query for entry index `idx` under a FRESH secret (drawn per call —
// reusing a secret across queries leaks the queried indices). Writes the flat
// query into out_query (ipir_query_u64s u64s) and returns the client state
// for ipir_extract. Returns NULL on error (bad args or params from an
// incompatible library build).
ipir_client_query* ipir_query_build(const ipir_params* params, uint64_t idx,
                                    uint64_t* out_query);

// Decrypt this query's slice of the batch response (resp: ipir_response_u64s
// u64s) into out_slots (ipir_entry_slots u16s, values in [0, P)). Returns 0
// on success.
int ipir_extract(const ipir_params* params, const ipir_client_query* q,
                 const uint64_t* resp, uint16_t* out_slots);

void ipir_client_query_destroy(ipir_client_query* q);

// ============================================================
// Wire packing (CPU library; lossless)
// ============================================================
// The flat u64 arrays carry one 27-bit residue per u64. On the wire, the two
// residues of every coefficient are CRT-combined into one value mod q < 2^53
// and bit-packed at 53 bits/value: query 918 KB -> 371 KB (db_rows = 32768),
// response 64 KB -> 26.5 KB per ciphertext pair. Packing is exactly invertible;
// it changes no ciphertext. (The modulus-switching compression below is the
// 12 KB alternative for responses.)

size_t ipir_query_packed_bytes(const ipir_params* params);
size_t ipir_response_packed_bytes(const ipir_params* params);

// flat -> packed bytes (buffer sizes from the helpers above). Return 0 on
// success, nonzero on bad arguments.
int ipir_query_pack(const ipir_params* params, const uint64_t* flat,
                    uint8_t* out);
int ipir_response_pack(const ipir_params* params, const uint64_t* flat,
                       uint8_t* out);

// packed bytes -> flat (ipir_query_u64s / ipir_response_u64s values).
int ipir_query_unpack(const ipir_params* params, const uint8_t* in,
                      uint64_t* out_flat);
int ipir_response_unpack(const ipir_params* params, const uint8_t* in,
                         uint64_t* out_flat);

// ============================================================
// Compressed responses (modulus switching to q'; CPU library)
// ============================================================
// The server rounds each response coefficient down to q' (mask 28 bits,
// body 20 bits): 12 KB per ciphertext instead of 26.5 KB packed / 64 KB flat.
// Lossy but budgeted: the added noise is on the order of the pipeline noise
// and far inside the decode margin (see docs/scheme_description.pdf).
// Layout per ciphertext: N x 28-bit mask values, then N x 20-bit body
// values, big-endian bit stream.

// num_cts * 12288 bytes.
size_t ipir_response_compressed_bytes(const ipir_params* params);

// Server side: flat response (ipir_response_u64s values, as written by
// ipir_answer_batch) -> compressed bytes. Returns 0 on success.
int ipir_response_compress(const ipir_params* params, const uint64_t* flat,
                           uint8_t* out);

// Client side: decrypt this query's compressed response into out_slots
// (ipir_entry_slots u16 values). Returns 0 on success.
int ipir_extract_compressed(const ipir_params* params,
                            const ipir_client_query* q, const uint8_t* in,
                            uint16_t* out_slots);

#ifdef __cplusplus
}
#endif
