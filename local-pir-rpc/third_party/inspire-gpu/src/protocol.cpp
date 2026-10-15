#include "protocol.h"
#include <cassert>
#include <algorithm>

namespace inspire {


// ============================================================
// Algorithm 16: Query
// ============================================================

std::pair<QueryState, QueryMessage> query(const PublicParams& pp, size_t idx) {
    std::mt19937_64 rng(std::random_device{}());

    // Index decomposition. coeffs_per_entry matches setup()'s formula.
    size_t i_star = idx % pp.db_rows;
    size_t coeffs_per_entry = (pp.w * 8 + P_BITS - 1) / P_BITS;
    size_t col = (idx / pp.db_rows) * coeffs_per_entry;
    size_t D_actual = std::min(pp.D, pp.n_packed); // when n_packed < D
    size_t j_star = (col / N) % D_actual;
    size_t k_star = col / (N * D_actual);
    size_t ell_star = col % N;

    // KeyGen
    RnsPoly s = sk_gen(rng);
    RnsPoly s_ntt = s; s_ntt.to_ntt();

    Ksk ksk_5 = ksk_gen_b(s, AUTO_GEN, pp.seed.data(), rng);
    Ksk ksk_neg1 = ksk_gen_b(s, 2 * N - 1, pp.seed.data(), rng);

    // Encrypt
    LweQuery lwe = lwe_enc_b(s, i_star, pp.db_rows, pp.seed.data(), rng);

    // RGSW: mu = omega^{j*} = X^{2n*j*/D_actual}
    // omega = X^{2n/D} is a D-th root of unity in Z[X]/(X^n+1)
    RnsPoly mu = RnsPoly::zero();
    size_t exp = (j_star * 2 * N) / D_actual;
    if (exp == 0) {
        mu.set_coeff(0, 1, 1);
    } else if (exp < N) {
        mu.set_coeff(exp, 1, 1);
    } else {
        // X^exp mod (X^n+1) for exp >= n
        mu.set_coeff(exp - N, Q0 - 1, Q1 - 1);
    }

    RgswCt rgsw = rgsw_enc_b(s, mu, pp.seed.data(), rng);

    QueryState qst = {s, s_ntt, k_star, ell_star};
    QueryMessage qry = {ksk_5, ksk_neg1, lwe, rgsw};
    return {qst, qry};
}

// ============================================================
// Algorithm 20: Extract
// ============================================================

std::vector<uint16_t> extract(const PublicParams& pp,
                              const QueryState& qst,
                              const std::vector<RlweCt>& resp) {
    size_t coeffs_per_entry = (pp.w * 8 + P_BITS - 1) / P_BITS;
    assert(qst.k_star < resp.size());
    auto m = rlwe_dec(qst.s_ntt, resp[qst.k_star]);

    std::vector<uint16_t> slots;
    slots.reserve(coeffs_per_entry);
    for (size_t c = 0; c < coeffs_per_entry && (qst.ell_star + c) < N; c++) {
        slots.push_back((uint16_t)(m[qst.ell_star + c] % P));
    }
    return slots;
}

// ============================================================
// Compressed-response path
// ============================================================

std::vector<CompressedCt> compress_response(const std::vector<RlweCt>& resp) {
    std::vector<CompressedCt> out;
    out.reserve(resp.size());
    for (const RlweCt& ct : resp) out.push_back(compress_ct(ct));
    return out;
}

std::vector<uint16_t> extract_compressed(const PublicParams& pp,
                                         const QueryState& qst,
                                         const std::vector<CompressedCt>& resp) {
    size_t coeffs_per_entry = (pp.w * 8 + P_BITS - 1) / P_BITS;
    assert(qst.k_star < resp.size());
    auto m = dec_compressed(qst.s, resp[qst.k_star]);

    std::vector<uint16_t> slots;
    slots.reserve(coeffs_per_entry);
    for (size_t c = 0; c < coeffs_per_entry && (qst.ell_star + c) < N; c++) {
        slots.push_back((uint16_t)(m[qst.ell_star + c] % P));
    }
    return slots;
}

} // namespace inspire
