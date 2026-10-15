#pragma once
#include "params.h"
#include <vector>
#include <array>
#include <random>

namespace inspire {

// NTT primitives live in ntt.h, implemented in-tree.
// `RnsPoly::to_ntt()` / `to_coeff()` below dispatch to those.

// ============================================================
// RNS polynomial: two limbs of N uint64_t values
// ============================================================

class RnsPoly {
public:
    std::array<std::vector<uint64_t>, NUM_LIMBS> limbs;
    bool is_ntt = false;

    RnsPoly();
    static RnsPoly zero();

    // NTT domain conversion (in-place)
    void to_ntt();
    void to_coeff();

    // Element-wise arithmetic (both must be in same domain)
    void add_inplace(const RnsPoly& other);
    void sub_inplace(const RnsPoly& other);
    void mul_inplace(const RnsPoly& other); // both must be NTT

    // Scalar multiply (works in both domains)
    void scalar_mul_inplace(uint64_t s0, uint64_t s1);

    // Negate
    void negate_inplace();

    // Fused multiply-subtract: this -= a * b (all NTT form)
    void mul_sub_inplace(const RnsPoly& a, const RnsPoly& b);

    // Fused inner-product-subtract: this -= sum_{j=0}^{d-1} a[j] * b[j]
    // All in NTT form. Uses AVX-512 with lazy accumulation.
    void inner_product_sub(const RnsPoly* a, const RnsPoly* b, int d);

    // Coefficient access
    void set_coeff(size_t idx, uint64_t v0, uint64_t v1);
};

// RLWE ciphertext: (a(X), b(X))
struct RlweCt {
    RnsPoly a, b;
};

// ============================================================
// Automorphism: tau_k(f(X)) = f(X^k) mod (X^n+1)
// Input must be in coefficient form.
// ============================================================
RnsPoly automorphism(const RnsPoly& f, uint64_t k);

// Automorphism via NTT roundtrip (input/output in NTT form)
RnsPoly automorphism_ntt(const RnsPoly& f_ntt, uint64_t k);

// ============================================================
// Approximate gadget decomposition (Algorithm 5: Decomp)
// Input: f in coefficient form
// Output: d-1 polynomials with coefficients in [-B/2, B/2)
// ============================================================
std::vector<RnsPoly> decomp(const RnsPoly& f);

// ============================================================
// Seed expansion: H(seed || domain || index) -> RnsPoly (coeff form)
// ============================================================
RnsPoly expand_seed(const uint8_t seed[SEED_BYTES],
                    const char* domain, uint64_t index);

// ============================================================
// Sampling
// ============================================================
RnsPoly sample_ternary(std::mt19937_64& rng);   // chi_sk: {-1, 0, +1}
RnsPoly sample_error(std::mt19937_64& rng);      // chi_err: discrete Gaussian

// ============================================================
// Galois group helpers
// ============================================================

// Compute g^k mod 2n using fast exponentiation
uint64_t galois_power(uint64_t g, size_t k);

// Precomputed generator powers: 5^0, 5^1, ..., 5^{n-1} mod 2n
const std::vector<uint64_t>& gen_powers();

// Modular inverse: a^{-1} mod m
uint64_t mod_inv(uint64_t a, uint64_t m);

// ============================================================
// GPU NTT twiddle factor export
// ============================================================

// Extract NTT twiddle factors as 32-bit values for GPU upload.
// Layout matches both the in-tree CPU NTT and gpu.cu's ntt_fwd_kernel /
// ntt_inv_kernel: fwd[i] = psi^{BR(i, log2 N)} mod q, where psi is the
// primitive 2N-th root chosen in ntt.cpp (deterministic, smallest-g rule).
void get_ntt_twiddles(int limb,                  // 0 or 1 (Q0 or Q1)
                      std::vector<uint32_t>& fwd_twiddles,   // [N] forward
                      std::vector<uint32_t>& inv_twiddles,   // [N] inverse
                      uint32_t& inv_n);           // n^{-1} mod q

// Same as above but also returns Shoup-Harvey "primes" for fast modular
// multiply: w_prime[i] = floor(fwd_twiddles[i] * 2^32 / q), and likewise for
// inv and inv_n. Used by fused kernels that do lazy lazy reductions.
void get_ntt_twiddles_and_primes(int limb,
                                  std::vector<uint32_t>& fwd_twiddles,
                                  std::vector<uint32_t>& fwd_primes,
                                  std::vector<uint32_t>& inv_twiddles,
                                  std::vector<uint32_t>& inv_primes,
                                  uint32_t& inv_n,
                                  uint32_t& inv_n_prime);

} // namespace inspire
