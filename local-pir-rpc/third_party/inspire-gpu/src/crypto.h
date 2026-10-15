#pragma once
#include "ring.h"

namespace inspire {

// ============================================================
// Algorithm 1: SKGen
// ============================================================
RnsPoly sk_gen(std::mt19937_64& rng);

// ============================================================
// Algorithm 2: RLWE.Dec
// ============================================================
std::vector<uint64_t> rlwe_dec(const RnsPoly& s_ntt, const RlweCt& ct);

// ============================================================
// Response compression (modulus switching to q')
// Per coefficient: a' = round(a * q1'/q) mod q1' (28 bits),
//                  b' = round(b * q0'/q) mod q0' (20 bits).
// Decryption computes b'/q0' - (a' * s)/q1' (mod 1) ~ v/q and rounds to P.
// Noise added: ~2^32 std at q (dominated by the body rounding q/q0'/sqrt(12)),
// on par with the pipeline noise itself; see docs/scheme_description.pdf.
// ============================================================
struct CompressedCt {
    std::vector<uint32_t> a;   // N values < 2^28
    std::vector<uint32_t> b;   // N values < 2^20
};

CompressedCt compress_ct(const RlweCt& ct);
// s in COEFFICIENT form (the ternary key itself, not NTT).
std::vector<uint64_t> dec_compressed(const RnsPoly& s, const CompressedCt& cct);

// ============================================================
// Algorithm 3: LWE.Enc_b
// ============================================================
struct LweQuery {
    std::vector<uint64_t> b_limb0; // ell values mod Q0
    std::vector<uint64_t> b_limb1; // ell values mod Q1
};

LweQuery lwe_enc_b(const RnsPoly& s, size_t i_star, size_t ell,
                   const uint8_t seed[SEED_BYTES], std::mt19937_64& rng);

// ============================================================
// Algorithm 4: KskGen_b
// ============================================================
struct Ksk {
    std::vector<RnsPoly> b_parts; // d-1 polynomials (coeff form)
};

Ksk ksk_gen_b(const RnsPoly& s, uint64_t k,
              const uint8_t seed[SEED_BYTES], std::mt19937_64& rng);

// ============================================================
// Algorithm 6: RGSW.Enc_b
// ============================================================
struct RgswCt {
    // [row][digit]: row 0 = top (-s*B^j*mu), row 1 = bottom (+B^j*mu)
    struct Row {
        std::vector<RnsPoly> a_parts; // d-1 polynomials (NTT)
        std::vector<RnsPoly> b_parts; // d-1 polynomials (NTT)
    };
    Row top, bottom;
};

RgswCt rgsw_enc_b(const RnsPoly& s, const RnsPoly& mu,
                  const uint8_t seed[SEED_BYTES], std::mt19937_64& rng);

// ============================================================
// Algorithm 7: ExtProd (RGSW x RLWE)
// ============================================================
RlweCt ext_prod(const RgswCt& rgsw, const RlweCt& ct);

// ============================================================
// Algorithm 19: HornerEval
// ============================================================
RlweCt horner_eval(const std::vector<RlweCt>& cts, const RgswCt& rgsw, size_t D);

} // namespace inspire
