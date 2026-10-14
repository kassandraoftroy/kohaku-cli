#include "ring.h"
#include "ntt.h"
#include <openssl/evp.h>
#ifdef __AVX512F__
#include <immintrin.h>
#endif
#include <cassert>
#include <cstring>
#include <cmath>

namespace inspire {

namespace {

inline uint64_t mod_add_u(uint64_t a, uint64_t b, uint64_t q) {
    uint64_t s = a + b;
    return (s >= q) ? s - q : s;
}
inline uint64_t mod_sub_u(uint64_t a, uint64_t b, uint64_t q) {
    return (a >= b) ? a - b : a + q - b;
}
inline uint64_t mod_mul_u(uint64_t a, uint64_t b, uint64_t q) {
    return (uint64_t)((__uint128_t)a * b % q);
}

inline void eltwise_add_inplace(uint64_t* x, const uint64_t* y, uint64_t q) {
    for (size_t i = 0; i < N; ++i) x[i] = mod_add_u(x[i], y[i], q);
}
inline void eltwise_sub_inplace(uint64_t* x, const uint64_t* y, uint64_t q) {
    for (size_t i = 0; i < N; ++i) x[i] = mod_sub_u(x[i], y[i], q);
}
inline void eltwise_mul_into(uint64_t* dst, const uint64_t* a, const uint64_t* b, uint64_t q) {
    for (size_t i = 0; i < N; ++i) dst[i] = mod_mul_u(a[i], b[i], q);
}
inline void eltwise_mul_inplace(uint64_t* x, const uint64_t* y, uint64_t q) {
    for (size_t i = 0; i < N; ++i) x[i] = mod_mul_u(x[i], y[i], q);
}

} // anonymous namespace

// ============================================================
// RnsPoly
// ============================================================

RnsPoly::RnsPoly() {
    for (auto& l : limbs) l.resize(N, 0);
}

RnsPoly RnsPoly::zero() { return RnsPoly(); }

void RnsPoly::to_ntt() {
    if (is_ntt) return;
    ntt_forward(limbs[0].data(), 0);
    ntt_forward(limbs[1].data(), 1);
    is_ntt = true;
}

void RnsPoly::to_coeff() {
    if (!is_ntt) return;
    ntt_inverse(limbs[0].data(), 0);
    ntt_inverse(limbs[1].data(), 1);
    is_ntt = false;
}

void RnsPoly::add_inplace(const RnsPoly& o) {
    eltwise_add_inplace(limbs[0].data(), o.limbs[0].data(), Q0);
    eltwise_add_inplace(limbs[1].data(), o.limbs[1].data(), Q1);
}

void RnsPoly::sub_inplace(const RnsPoly& o) {
    eltwise_sub_inplace(limbs[0].data(), o.limbs[0].data(), Q0);
    eltwise_sub_inplace(limbs[1].data(), o.limbs[1].data(), Q1);
}

void RnsPoly::mul_inplace(const RnsPoly& o) {
    assert(is_ntt && o.is_ntt);
    eltwise_mul_inplace(limbs[0].data(), o.limbs[0].data(), Q0);
    eltwise_mul_inplace(limbs[1].data(), o.limbs[1].data(), Q1);
}

void RnsPoly::scalar_mul_inplace(uint64_t s0, uint64_t s1) {
    for (size_t i = 0; i < N; i++) {
        limbs[0][i] = ((__uint128_t)limbs[0][i] * s0) % Q0;
        limbs[1][i] = ((__uint128_t)limbs[1][i] * s1) % Q1;
    }
}

void RnsPoly::mul_sub_inplace(const RnsPoly& a, const RnsPoly& b) {
    assert(is_ntt && a.is_ntt && b.is_ntt);
    thread_local std::vector<uint64_t> scratch0(N), scratch1(N);
    eltwise_mul_into(scratch0.data(), a.limbs[0].data(), b.limbs[0].data(), Q0);
    eltwise_mul_into(scratch1.data(), a.limbs[1].data(), b.limbs[1].data(), Q1);
    eltwise_sub_inplace(limbs[0].data(), scratch0.data(), Q0);
    eltwise_sub_inplace(limbs[1].data(), scratch1.data(), Q1);
}

// Single-pass AVX-512 fused inner-product-subtract:
// dst[i] -= sum_{j=0}^{d-1} a[j][i] * b[j][i]  (mod q)
// Uses _mm512_mul_epu32 for 32×32→64 lazy products, reduce once at end.
static void fused_ip_sub_limb(uint64_t* dst,
                               const uint64_t* const* a_ptrs,
                               const uint64_t* const* b_ptrs,
                               int d, size_t n, uint64_t q) {
#ifdef __AVX512F__
    __m512i vq = _mm512_set1_epi64(q);
    for (size_t i = 0; i + 7 < n; i += 8) {
        // Lazy accumulate products (no mod between terms)
        __m512i sum = _mm512_setzero_si512();
        for (int j = 0; j < d; j++) {
            __m512i va = _mm512_loadu_si512((__m512i*)(a_ptrs[j] + i));
            __m512i vb = _mm512_loadu_si512((__m512i*)(b_ptrs[j] + i));
            sum = _mm512_add_epi64(sum, _mm512_mul_epu32(va, vb));
        }
        // Reduce sum mod q (scalar — native % is fast on modern x86)
        uint64_t s[8];
        _mm512_storeu_si512((__m512i*)s, sum);
        s[0] %= q; s[1] %= q; s[2] %= q; s[3] %= q;
        s[4] %= q; s[5] %= q; s[6] %= q; s[7] %= q;
        __m512i vs = _mm512_loadu_si512((__m512i*)s);
        // dst -= sum mod q
        __m512i vdst = _mm512_loadu_si512((__m512i*)(dst + i));
        // (dst + q - sum) mod q
        __m512i result = _mm512_add_epi64(vdst, _mm512_sub_epi64(vq, vs));
        // Conditional subtract if result >= q
        __mmask8 ge = _mm512_cmpge_epu64_mask(result, vq);
        result = _mm512_mask_sub_epi64(result, ge, result, vq);
        _mm512_storeu_si512((__m512i*)(dst + i), result);
    }
    for (size_t i = (n / 8) * 8; i < n; i++) {
        uint64_t sum = 0;
        for (int j = 0; j < d; j++) sum += a_ptrs[j][i] * b_ptrs[j][i];
        dst[i] = (dst[i] + q - sum % q) % q;
    }
#else
    for (size_t i = 0; i < n; i++) {
        uint64_t sum = 0;
        for (int j = 0; j < d; j++) sum += a_ptrs[j][i] * b_ptrs[j][i];
        dst[i] = (dst[i] + q - sum % q) % q;
    }
#endif
}

void RnsPoly::inner_product_sub(const RnsPoly* a, const RnsPoly* b, int d) {
    assert(is_ntt);
    // Build pointer arrays for the fused kernel
    const uint64_t* a0[4], *b0[4], *a1[4], *b1[4];
    assert(d <= 4);
    for (int j = 0; j < d; j++) {
        a0[j] = a[j].limbs[0].data();
        b0[j] = b[j].limbs[0].data();
        a1[j] = a[j].limbs[1].data();
        b1[j] = b[j].limbs[1].data();
    }
    fused_ip_sub_limb(limbs[0].data(), a0, b0, d, N, Q0);
    fused_ip_sub_limb(limbs[1].data(), a1, b1, d, N, Q1);
}

void RnsPoly::negate_inplace() {
    for (size_t i = 0; i < N; i++) {
        if (limbs[0][i] != 0) limbs[0][i] = Q0 - limbs[0][i];
        if (limbs[1][i] != 0) limbs[1][i] = Q1 - limbs[1][i];
    }
}

void RnsPoly::set_coeff(size_t idx, uint64_t v0, uint64_t v1) {
    limbs[0][idx] = v0 % Q0;
    limbs[1][idx] = v1 % Q1;
}

// ============================================================
// Automorphism: tau_k(f(X)) = f(X^k) mod (X^n+1)
// ============================================================

RnsPoly automorphism(const RnsPoly& f, uint64_t k) {
    assert(!f.is_ntt);
    RnsPoly result;
    for (size_t j = 0; j < N; j++) {
        size_t dest = ((uint64_t)j * k) % (2 * N);
        if (dest < N) {
            result.limbs[0][dest] = (result.limbs[0][dest] + f.limbs[0][j]) % Q0;
            result.limbs[1][dest] = (result.limbs[1][dest] + f.limbs[1][j]) % Q1;
        } else {
            size_t d = dest - N;
            result.limbs[0][d] = (result.limbs[0][d] + Q0 - f.limbs[0][j]) % Q0;
            result.limbs[1][d] = (result.limbs[1][d] + Q1 - f.limbs[1][j]) % Q1;
        }
    }
    result.is_ntt = false;
    return result;
}

RnsPoly automorphism_ntt(const RnsPoly& f_ntt, uint64_t k) {
    RnsPoly f = f_ntt;
    f.to_coeff();
    RnsPoly g = automorphism(f, k);
    g.to_ntt();
    return g;
}

// ============================================================
// Approximate Gadget Decomposition (Algorithm 5: Decomp)
// CRT lift → center → extract d digits → drop digit 0
// ============================================================

std::vector<RnsPoly> decomp(const RnsPoly& f) {
    assert(!f.is_ntt);

    static uint64_t Q1_inv_Q0 = mod_inv(Q1, Q0);
    static uint64_t Q0_inv_Q1 = mod_inv(Q0, Q1);
    __uint128_t Q_full = (__uint128_t)Q0 * Q1;

    std::vector<RnsPoly> digits(D_EFF);

    for (size_t i = 0; i < N; i++) {
        uint64_t a0 = f.limbs[0][i], a1 = f.limbs[1][i];

        // CRT lift to [0, Q)
        __uint128_t x = (__uint128_t)((__uint128_t)a0 * Q1_inv_Q0 % Q0) * Q1
                      + (__uint128_t)((__uint128_t)a1 * Q0_inv_Q1 % Q1) * Q0;
        uint64_t val = (uint64_t)(x % Q_full);

        // Center to [-Q/2, Q/2)
        int64_t r = (val <= Q_full / 2) ? (int64_t)val : (int64_t)(val - (uint64_t)Q_full);

        // Extract d digits using arithmetic shift (leanpir-style)
        constexpr int K = 64 - BASE_LOG;
        int64_t digs[D_GSW];
        for (int j = 0; j < D_GSW; j++) {
            int64_t d = (r << K) >> K; // extract lowest BASE_LOG bits, sign-extended
            digs[j] = d;
            r = (r - d) >> BASE_LOG;
        }

        // Store digits 1..d-1 (skip digit 0)
        for (int j = 0; j < D_EFF; j++) {
            int64_t d = digs[j + 1];
            uint64_t v0 = (d >= 0) ? (uint64_t)d : Q0 + d;
            uint64_t v1 = (d >= 0) ? (uint64_t)d : Q1 + d;
            digits[j].limbs[0][i] = v0 % Q0;
            digits[j].limbs[1][i] = v1 % Q1;
        }
    }

    for (auto& d : digits) d.is_ntt = false;
    return digits;
}

// ============================================================
// Seed Expansion: SHAKE-256
// ============================================================

RnsPoly expand_seed(const uint8_t seed[SEED_BYTES],
                    const char* domain, uint64_t index) {
    RnsPoly result;

    std::vector<uint8_t> input(SEED_BYTES);
    memcpy(input.data(), seed, SEED_BYTES);
    size_t dlen = strlen(domain);
    input.insert(input.end(), domain, domain + dlen);
    for (int i = 0; i < 8; i++)
        input.push_back((index >> (8 * i)) & 0xFF);

    size_t outlen = 2 * N * sizeof(uint64_t);
    std::vector<uint8_t> out(outlen);

    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    EVP_DigestInit_ex(ctx, EVP_shake256(), nullptr);
    EVP_DigestUpdate(ctx, input.data(), input.size());
    EVP_DigestFinalXOF(ctx, out.data(), outlen);
    EVP_MD_CTX_free(ctx);

    const uint64_t* raw = reinterpret_cast<const uint64_t*>(out.data());
    for (size_t i = 0; i < N; i++) {
        result.limbs[0][i] = raw[i] % Q0;
        result.limbs[1][i] = raw[N + i] % Q1;
    }
    result.is_ntt = false;
    return result;
}

// ============================================================
// Sampling
// ============================================================

RnsPoly sample_ternary(std::mt19937_64& rng) {
    RnsPoly result;
    std::uniform_int_distribution<int> dist(-1, 1);
    for (size_t i = 0; i < N; i++) {
        int v = dist(rng);
        result.limbs[0][i] = (v >= 0) ? (uint64_t)v : Q0 + v;
        result.limbs[1][i] = (v >= 0) ? (uint64_t)v : Q1 + v;
    }
    result.is_ntt = false;
    return result;
}

// CDT sampling for discrete Gaussian (following OpenFHE)
RnsPoly sample_error(std::mt19937_64& rng) {
    // Precompute CDT for sigma=SIGMA, range [-19, 19]
    static auto cdt = []() {
        std::vector<double> table;
        double sigma = SIGMA;
        double cumsum = 0.0;
        for (int x = 0; x <= 19; x++) {
            double prob = std::exp(-(double)x * x / (2.0 * sigma * sigma));
            if (x == 0) prob *= 0.5; // half weight at 0
            cumsum += prob;
            table.push_back(cumsum);
        }
        // Normalize
        double total = 2.0 * cumsum; // symmetric
        for (auto& v : table) v /= total;
        return table;
    }();

    RnsPoly result;
    std::uniform_real_distribution<double> udist(0.0, 0.5);
    std::uniform_int_distribution<int> sign_dist(0, 1);

    for (size_t i = 0; i < N; i++) {
        double u = udist(rng);
        int x = 0;
        for (size_t j = 0; j < cdt.size(); j++) {
            if (u >= cdt[j]) x = j + 1;
            else break;
        }
        if (sign_dist(rng) && x > 0) x = -x;

        result.limbs[0][i] = (x >= 0) ? (uint64_t)x : Q0 + x;
        result.limbs[1][i] = (x >= 0) ? (uint64_t)x : Q1 + x;
    }
    result.is_ntt = false;
    return result;
}

// ============================================================
// Galois group helpers
// ============================================================

uint64_t galois_power(uint64_t g, size_t k) {
    uint64_t two_n = 2 * N;
    uint64_t result = 1, base = g % two_n;
    size_t exp = k;
    while (exp > 0) {
        if (exp & 1) result = (result * base) % two_n;
        base = (base * base) % two_n;
        exp >>= 1;
    }
    return result;
}

const std::vector<uint64_t>& gen_powers() {
    static auto gp = []() {
        std::vector<uint64_t> v(N);
        for (size_t i = 0; i < N; i++)
            v[i] = galois_power(AUTO_GEN, i);
        return v;
    }();
    return gp;
}

uint64_t mod_inv(uint64_t a, uint64_t m) {
    int64_t old_r = (int64_t)a, r = (int64_t)m;
    int64_t old_s = 1, s = 0;
    while (r != 0) {
        int64_t q = old_r / r;
        int64_t tmp = r; r = old_r - q * r; old_r = tmp;
        tmp = s; s = old_s - q * s; old_s = tmp;
    }
    return (old_s % (int64_t)m + (int64_t)m) % (int64_t)m;
}

// ============================================================
// GPU NTT twiddle factor export
// ============================================================

void get_ntt_twiddles(int limb,
                      std::vector<uint32_t>& fwd_twiddles,
                      std::vector<uint32_t>& inv_twiddles,
                      uint32_t& inv_n_val) {
    const auto& t = ntt_tables(limb);
    fwd_twiddles.resize(N);
    inv_twiddles.resize(N);
    for (size_t i = 0; i < N; i++) {
        fwd_twiddles[i] = (uint32_t)t.fwd_twiddles[i];
        inv_twiddles[i] = (uint32_t)t.inv_twiddles[i];
    }
    inv_n_val = (uint32_t)t.inv_n;
}

void get_ntt_twiddles_and_primes(int limb,
                                  std::vector<uint32_t>& fwd_twiddles,
                                  std::vector<uint32_t>& fwd_primes,
                                  std::vector<uint32_t>& inv_twiddles,
                                  std::vector<uint32_t>& inv_primes,
                                  uint32_t& inv_n_val,
                                  uint32_t& inv_n_prime_val) {
    const auto& t = ntt_tables(limb);
    fwd_twiddles.resize(N); fwd_primes.resize(N);
    inv_twiddles.resize(N); inv_primes.resize(N);
    for (size_t i = 0; i < N; i++) {
        fwd_twiddles[i] = (uint32_t)t.fwd_twiddles[i];
        inv_twiddles[i] = (uint32_t)t.inv_twiddles[i];
        fwd_primes[i]   = (uint32_t)t.fwd_primes[i];
        inv_primes[i]   = (uint32_t)t.inv_primes[i];
    }
    inv_n_val       = (uint32_t)t.inv_n;
    inv_n_prime_val = (uint32_t)t.inv_n_prime;
}

} // namespace inspire
