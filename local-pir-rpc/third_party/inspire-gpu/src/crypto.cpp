#include "crypto.h"
#include <cassert>

namespace inspire {

// ============================================================
// Algorithm 1: SKGen
// ============================================================

RnsPoly sk_gen(std::mt19937_64& rng) {
    return sample_ternary(rng);
}

// ============================================================
// Algorithm 2: RLWE.Dec
// v(X) = [b(X) - a(X)*s(X)]_q, return round(v*p/q) mod p
// ============================================================

std::vector<uint64_t> rlwe_dec(const RnsPoly& s_ntt, const RlweCt& ct) {
    // v = b - a*s (both in NTT, then INTT)
    RnsPoly v = ct.b;
    RnsPoly as = ct.a;
    if (!as.is_ntt) as.to_ntt();
    RnsPoly s_copy = s_ntt;
    as.mul_inplace(s_copy);
    if (!v.is_ntt) {
        RnsPoly v_ntt = v;
        v_ntt.to_ntt();
        v_ntt.sub_inplace(as);
        v_ntt.to_coeff();
        v = v_ntt;
    } else {
        v.sub_inplace(as);
        v.to_coeff();
    }

    // CRT reconstruct each coefficient and round
    static uint64_t Q1_inv_Q0 = mod_inv(Q1, Q0);
    static uint64_t Q0_inv_Q1 = mod_inv(Q0, Q1);

    std::vector<uint64_t> result(N);
    for (size_t i = 0; i < N; i++) {
        __uint128_t x = (__uint128_t)((__uint128_t)v.limbs[0][i] * Q1_inv_Q0 % Q0) * Q1
                      + (__uint128_t)((__uint128_t)v.limbs[1][i] * Q0_inv_Q1 % Q1) * Q0;
        uint64_t val = (uint64_t)(x % ((__uint128_t)Q0 * Q1));

        // Center to [-Q/2, Q/2)
        __uint128_t Q_full = (__uint128_t)Q0 * Q1;
        int64_t centered = (val > Q_full / 2) ? (int64_t)(val - (uint64_t)Q_full) : (int64_t)val;

        // Round: round(v * p / q) mod p
        // = round(centered * P / Q_full)
        double ratio = (double)centered * (double)P / (double)(uint64_t)Q_full;
        int64_t rounded = (int64_t)std::round(ratio);
        result[i] = ((rounded % (int64_t)P) + P) % P;
    }
    return result;
}

// ============================================================
// Algorithm 3: LWE.Enc_b
// b_r(X) = a_r(X)*s(X) + e_r(X) + m_r(X)
// ============================================================

LweQuery lwe_enc_b(const RnsPoly& s, size_t i_star, size_t ell,
                   const uint8_t seed[SEED_BYTES], std::mt19937_64& rng) {
    size_t n_r = ell / N;
    LweQuery lwe;
    lwe.b_limb0.resize(ell);
    lwe.b_limb1.resize(ell);

    RnsPoly s_ntt = s;
    s_ntt.to_ntt();

    for (size_t r = 0; r < n_r; r++) {
        RnsPoly a = expand_seed(seed, "rlwe", r);
        RnsPoly e = sample_error(rng);

        // Message: Delta * X^{i* mod n} if r == floor(i*/n), else 0
        RnsPoly m = RnsPoly::zero();
        if (r == i_star / N) {
            size_t pos = i_star % N;
            m.set_coeff(pos, DELTA_MOD_Q0, DELTA_MOD_Q1);
        }

        // b = a*s + e + m
        a.to_ntt();
        RnsPoly b = a;
        b.mul_inplace(s_ntt);
        b.to_coeff();
        b.add_inplace(e);
        b.add_inplace(m);

        // Append coefficients
        for (size_t j = 0; j < N; j++) {
            lwe.b_limb0[r * N + j] = b.limbs[0][j];
            lwe.b_limb1[r * N + j] = b.limbs[1][j];
        }
    }
    return lwe;
}

// ============================================================
// Algorithm 4: KskGen_b
// b_j = a_j*s + e_j + tau_k(s)*B^j  (positive a*s, matching doubledown)
// ============================================================

Ksk ksk_gen_b(const RnsPoly& s, uint64_t k,
              const uint8_t seed[SEED_BYTES], std::mt19937_64& rng) {
    Ksk ksk;
    ksk.b_parts.resize(D_EFF);

    RnsPoly s_ntt = s;
    s_ntt.to_ntt();

    // tau_k(s)
    RnsPoly s_auto = automorphism(s, k);

    for (int j = 0; j < D_EFF; j++) {
        int digit_idx = j + 1; // digits 1, 2
        RnsPoly a = expand_seed(seed, "ksk", k * 100 + digit_idx);
        RnsPoly e = sample_error(rng);

        // a*s in coeff form
        RnsPoly a_ntt = a;
        a_ntt.to_ntt();
        RnsPoly as = a_ntt;
        as.mul_inplace(s_ntt);
        as.to_coeff();

        // tau_k(s) * B^{digit_idx}
        uint64_t Bj = 1;
        for (int t = 0; t < digit_idx; t++) Bj *= BASE;
        RnsPoly s_scaled = s_auto;
        s_scaled.scalar_mul_inplace(Bj % Q0, Bj % Q1);

        // b = a*s + e + s_auto*B^j
        RnsPoly b = as;
        b.add_inplace(e);
        b.add_inplace(s_scaled);

        ksk.b_parts[j] = b; // store in coefficient form
    }
    return ksk;
}

// ============================================================
// Algorithm 6: RGSW.Enc_b
// ============================================================

RgswCt rgsw_enc_b(const RnsPoly& s, const RnsPoly& mu,
                  const uint8_t seed[SEED_BYTES], std::mt19937_64& rng) {
    RgswCt rgsw;
    rgsw.top.a_parts.resize(D_EFF);
    rgsw.top.b_parts.resize(D_EFF);
    rgsw.bottom.a_parts.resize(D_EFF);
    rgsw.bottom.b_parts.resize(D_EFF);

    RnsPoly s_ntt = s;
    s_ntt.to_ntt();

    for (int j = 0; j < D_EFF; j++) {
        int digit_idx = j + 1;
        uint64_t Bj = 1;
        for (int t = 0; t < digit_idx; t++) Bj *= BASE;

        // s * B^j * mu (for top row: -s*B^j*mu)
        RnsPoly s_Bj_mu = s;
        s_Bj_mu.scalar_mul_inplace(Bj % Q0, Bj % Q1);
        // Multiply by mu in NTT
        RnsPoly mu_ntt = mu;
        mu_ntt.to_ntt();
        RnsPoly s_Bj_mu_ntt = s_Bj_mu;
        s_Bj_mu_ntt.to_ntt();
        s_Bj_mu_ntt.mul_inplace(mu_ntt);
        s_Bj_mu_ntt.to_coeff();

        // B^j * mu (for bottom row)
        RnsPoly Bj_mu = mu;
        Bj_mu.scalar_mul_inplace(Bj % Q0, Bj % Q1);

        // Top row: b = a*s + e - s*B^j*mu
        {
            RnsPoly a = expand_seed(seed, "rgsw0", digit_idx);
            RnsPoly e = sample_error(rng);
            RnsPoly a_ntt = a; a_ntt.to_ntt();
            RnsPoly as = a_ntt; as.mul_inplace(s_ntt); as.to_coeff();
            RnsPoly b = as;
            b.add_inplace(e);
            b.sub_inplace(s_Bj_mu_ntt); // -s*B^j*mu

            rgsw.top.a_parts[j] = a; a.to_ntt(); rgsw.top.a_parts[j] = a;
            b.to_ntt();
            rgsw.top.b_parts[j] = b;
        }

        // Bottom row: b = a*s + e + B^j*mu
        {
            RnsPoly a = expand_seed(seed, "rgsw1", digit_idx);
            RnsPoly e = sample_error(rng);
            RnsPoly a_ntt = a; a_ntt.to_ntt();
            RnsPoly as = a_ntt; as.mul_inplace(s_ntt); as.to_coeff();
            RnsPoly b = as;
            b.add_inplace(e);
            b.add_inplace(Bj_mu); // +B^j*mu

            rgsw.bottom.a_parts[j] = a; a.to_ntt(); rgsw.bottom.a_parts[j] = a;
            b.to_ntt();
            rgsw.bottom.b_parts[j] = b;
        }
    }
    return rgsw;
}

// ============================================================
// Algorithm 7: ExtProd (RGSW x RLWE)
// ============================================================

RlweCt ext_prod(const RgswCt& rgsw, const RlweCt& ct) {
    // Decompose b and a components
    RnsPoly b_coeff = ct.b;
    if (b_coeff.is_ntt) b_coeff.to_coeff();
    RnsPoly a_coeff = ct.a;
    if (a_coeff.is_ntt) a_coeff.to_coeff();

    auto db = decomp(b_coeff); // d-1 digits of b
    auto da = decomp(a_coeff); // d-1 digits of a

    // Convert digits to NTT
    for (auto& d : db) d.to_ntt();
    for (auto& d : da) d.to_ntt();

    // result = sum da[j] * RGSW.top[j] + sum db[j] * RGSW.bottom[j]
    // (digits of a multiply top row with msg -s*mu*B^j;
    //  digits of b multiply bottom row with msg +mu*B^j)
    RlweCt result;
    result.a = RnsPoly::zero(); result.a.to_ntt();
    result.b = RnsPoly::zero(); result.b.to_ntt();

    for (int j = 0; j < D_EFF; j++) {
        // Top row: da[j] * (a_top[j], b_top[j])
        {
            RnsPoly ta = da[j]; ta.mul_inplace(rgsw.top.a_parts[j]);
            result.a.add_inplace(ta);
            RnsPoly tb = da[j]; tb.mul_inplace(rgsw.top.b_parts[j]);
            result.b.add_inplace(tb);
        }
        // Bottom row: db[j] * (a_bottom[j], b_bottom[j])
        {
            RnsPoly ta = db[j]; ta.mul_inplace(rgsw.bottom.a_parts[j]);
            result.a.add_inplace(ta);
            RnsPoly tb = db[j]; tb.mul_inplace(rgsw.bottom.b_parts[j]);
            result.b.add_inplace(tb);
        }
    }
    return result;
}

// ============================================================
// Algorithm 19: HornerEval
// acc = ct[D-1]; for i=D-2 down to 0: acc = ExtProd(rgsw, acc) + ct[i]
// ============================================================

RlweCt horner_eval(const std::vector<RlweCt>& cts, const RgswCt& rgsw, size_t D) {
    assert(cts.size() >= D);
    RlweCt acc = cts[D - 1];
    if (!acc.a.is_ntt) acc.a.to_ntt();
    if (!acc.b.is_ntt) acc.b.to_ntt();

    for (int i = (int)D - 2; i >= 0; i--) {
        acc = ext_prod(rgsw, acc);
        RlweCt ct_i = cts[i];
        if (!ct_i.a.is_ntt) ct_i.a.to_ntt();
        if (!ct_i.b.is_ntt) ct_i.b.to_ntt();
        acc.a.add_inplace(ct_i.a);
        acc.b.add_inplace(ct_i.b);
    }
    return acc;
}

// ============================================================
// Response compression (modulus switching to q'; see crypto.h)
// ============================================================

CompressedCt compress_ct(const RlweCt& ct) {
    static uint64_t Q1_inv_Q0 = mod_inv(Q1, Q0);
    static uint64_t Q0_inv_Q1 = mod_inv(Q0, Q1);
    const __uint128_t Q_full = (__uint128_t)Q0 * Q1;

    RnsPoly a = ct.a, b = ct.b;
    if (a.is_ntt) a.to_coeff();
    if (b.is_ntt) b.to_coeff();

    auto lift = [&](const RnsPoly& p, size_t i) -> uint64_t {
        __uint128_t x = (__uint128_t)((__uint128_t)p.limbs[0][i] * Q1_inv_Q0 % Q0) * Q1
                      + (__uint128_t)((__uint128_t)p.limbs[1][i] * Q0_inv_Q1 % Q1) * Q0;
        return (uint64_t)(x % Q_full);
    };
    // round(v * qp / Q) mod qp, exactly in integers.
    auto down = [&](uint64_t v, uint64_t qp) -> uint32_t {
        __uint128_t num = (__uint128_t)v * qp + (uint64_t)(Q_full / 2);
        return (uint32_t)((uint64_t)(num / Q_full) % qp);
    };

    CompressedCt out;
    out.a.resize(N);
    out.b.resize(N);
    for (size_t i = 0; i < N; i++) {
        out.a[i] = down(lift(a, i), Q_PRIME_1);
        out.b[i] = down(lift(b, i), Q_PRIME_0);
    }
    return out;
}

std::vector<uint64_t> dec_compressed(const RnsPoly& s, const CompressedCt& cct) {
    assert(!s.is_ntt);
    // Recover s_i in {-1, 0, +1} from its mod-Q0 residue.
    std::array<int8_t, N> sk;
    for (size_t i = 0; i < N; i++)
        sk[i] = s.limbs[0][i] == 0 ? 0 : (s.limbs[0][i] == 1 ? 1 : -1);

    // c = a' * s negacyclic over the integers (|c_i| < N * 2^28 fits i64),
    // walking only the nonzero key coefficients.
    std::vector<int64_t> c(N, 0);
    for (size_t j = 0; j < N; j++) {
        if (sk[j] == 0) continue;
        int64_t sj = sk[j];
        for (size_t i = 0; i < N; i++) {
            size_t k = i + j;
            int64_t t = sj * (int64_t)cct.a[i];
            if (k < N) c[k] += t;
            else c[k - N] -= t;
        }
    }

    // m_i = round(P * (b'_i/q0' - c_i/q1')) mod P, over the common modulus
    // Q' = q0' * q1'.
    const __int128 QP = (__int128)Q_PRIME_0 * Q_PRIME_1;
    std::vector<uint64_t> m(N);
    for (size_t i = 0; i < N; i++) {
        __int128 num = (__int128)cct.b[i] * Q_PRIME_1 - (__int128)c[i] * Q_PRIME_0;
        num %= QP;
        if (num < 0) num += QP;
        // Center to [-Q'/2, Q'/2), then round(num * P / Q').
        if (num >= QP / 2) num -= QP;
        __int128 scaled = num * (__int128)P;
        __int128 rounded = scaled >= 0 ? (scaled + QP / 2) / QP : -((-scaled + QP / 2) / QP);
        int64_t r = (int64_t)(rounded % (__int128)P);
        m[i] = (uint64_t)((r % (int64_t)P + (int64_t)P) % (int64_t)P);
    }
    return m;
}

} // namespace inspire
