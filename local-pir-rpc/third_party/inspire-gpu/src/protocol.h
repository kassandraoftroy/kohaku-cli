#pragma once
#include "crypto.h"

namespace inspire {

// ============================================================
// Server preprocess output (device-resident). Produced by gpu_preprocess and
// adopted by gpu_setup_server (which frees the buffers in gpu_free_server).
// The caller must NOT free these after passing the struct to gpu_setup_server.
// ============================================================

struct PreprocessData {
    // Per-group precomp, device-resident (NTT form).
    std::vector<uint32_t*> d_precomp_a;          // [n_packed], each 2*N uint32
    std::vector<uint32_t*> d_precomp_D_plus;     // [n_packed], each (N/2-1)*D_EFF*2*N uint32
    std::vector<uint32_t*> d_precomp_D_minus;    // same shape
    std::vector<uint32_t*> d_precomp_D_final;    // [n_packed], each D_EFF*2*N uint32

    // Device-resident encoded DB, ROW-MAJOR (db[row*db_cols+col]), u16
    // (P=65535, 15-bit packing). gpu_setup_server adopts this pointer directly
    // as d_db_rm — no transpose, single resident copy. Ownership transfers to ctx.
    // (Name kept as d_db_col for historical reasons; contents are row-major.)
    uint16_t* d_db_col = nullptr;
};

// ============================================================
// Algorithm 16: Query
// ============================================================

struct QueryState {
    RnsPoly s;          // secret key (coeff form)
    RnsPoly s_ntt;      // secret key (NTT form)
    size_t k_star;      // response ciphertext index
    size_t ell_star;    // coefficient offset
};

struct QueryMessage {
    Ksk ksk_5;
    Ksk ksk_neg1;
    LweQuery lwe;
    RgswCt rgsw;
};

std::pair<QueryState, QueryMessage> query(const PublicParams& pp, size_t idx);

// ============================================================
// Algorithm 20: Extract
// ============================================================

// Decrypt the response and return the coeffs_per_entry plaintext slots (each in
// [0,P)) for the queried entry. The DB is supplied as values in [0,P), so this
// is the retrieved entry directly; any byte<->slot packing is the caller's.
std::vector<uint16_t> extract(const PublicParams& pp,
                              const QueryState& qst,
                              const std::vector<RlweCt>& resp);

// ============================================================
// Compressed-response path (modulus switching to q', crypto.h): the server
// compresses each response ciphertext to 12 KB; extraction is identical to
// extract() but decodes in the q' domain.
// ============================================================

std::vector<CompressedCt> compress_response(const std::vector<RlweCt>& resp);

std::vector<uint16_t> extract_compressed(const PublicParams& pp,
                                         const QueryState& qst,
                                         const std::vector<CompressedCt>& resp);

} // namespace inspire
