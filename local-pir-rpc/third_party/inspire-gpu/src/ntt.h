// In-tree negacyclic NTT over Z_q for both RNS primes.
// Portable scalar C++, no SIMD intrinsics.
//
// Convention (matches gpu.cu's ntt_fwd_kernel / ntt_inv_kernel exactly):
//
//   - Cooley-Tukey decimation-in-time (DIT) butterflies for forward NTT.
//   - Gentleman-Sande (GS) for inverse NTT.
//   - Twiddle layout: fwd[i] = psi^{BR(i, log2 N)} mod q, where
//       psi   = primitive 2N-th root of unity in Z_q
//       BR(i) = bit-reverse over log2(N) bits
//     So fwd[0] = 1, fwd[N/2] = psi, fwd[1] = psi^{BR(1)} = psi^{N/2}, etc.
//   - Inverse twiddles are elementwise modular inverses of forward twiddles.
//
// Same algorithm runs on CPU (this file) and GPU (gpu.cu). As long as both
// sides use twiddles emitted by `get_twiddles()` below, their outputs are
// bit-exact.

#pragma once

#include "params.h"
#include <array>
#include <cstdint>
#include <vector>

namespace inspire {

// Precomputed tables for one RNS prime.
struct NttTables {
    uint64_t q;
    std::array<uint64_t, N> fwd_twiddles;   // psi^{BR(i)} mod q
    std::array<uint64_t, N> inv_twiddles;   // modinv(fwd_twiddles[i], q) for i>0; inv[0]=1
    // Shoup-Harvey "primes": precomputed `floor(w * 2^32 / q)` for fast modular
    // multiply without 64-bit divide. Per twiddle w in [0, q): Shoup mul of
    // x * w mod q (result in [0, 2q)) is
    //   q_tmp = (x * w_prime) >> 32
    //   q_new = x * w - q_tmp * q
    // (mathematically equivalent to `x*w % q` but ~3-4x faster on GPU).
    std::array<uint64_t, N> fwd_primes;
    std::array<uint64_t, N> inv_primes;
    uint64_t inv_n;                          // modinv(N, q)
    uint64_t inv_n_prime;                    // Shoup prime for inv_n
    uint64_t psi;                            // chosen primitive 2N-th root
};

// Access tables for limb 0 (Q0) or 1 (Q1). Built once on first call.
const NttTables& ntt_tables(int limb);

// In-place forward NTT on a polynomial of N uint64_t coefficients mod q.
// `limb` selects Q0 (=0) or Q1 (=1).
void ntt_forward(uint64_t* data, int limb);

// In-place inverse NTT (includes the N^{-1} scaling).
void ntt_inverse(uint64_t* data, int limb);

} // namespace inspire
