#pragma once
#include <cstdint>
#include <cstddef>
#include <array>

namespace inspire {

// ============================================================
// Fixed parameters (Tier 1: security, Tier 2: noise analysis)
// ============================================================

// Security: n=2048, q = Q0*Q1 = 2^52.99998, uniform ternary secret,
// sigma = 3.19, unlimited samples -> min attack cost 2^128.8 (bdd),
// lattice-estimator commit 53da598. Both primes are 1 mod 2N (NTT-friendly).
constexpr size_t N = 2048;                  // n: lattice dimension
constexpr uint64_t Q0 = 94519297;           // first RNS prime (27 bits)
constexpr uint64_t Q1 = 95293441;           // second RNS prime (27 bits)
constexpr int NUM_LIMBS = 2;
// Plaintext modulus: P = 65535 = 2^16 - 1 (Mersenne).
// Each slot holds 15 bits of raw data, value in [0, 32767], well below P.
// 16-bit storage (uint16_t) per slot.
// Mersenne reduction: x mod P = (x & 0xFFFF) + (x >> 16); if (r >= P) r -= P.
constexpr uint64_t P = 65535;               // plaintext modulus (Mersenne)
constexpr int P_BITS = 15;                  // bits of raw data per slot
constexpr double SIGMA = 3.19;              // discrete Gaussian std dev
constexpr int D_GSW = 3;                    // d: total gadget digits
constexpr int D_EFF = D_GSW - 1;            // d-1: effective digits (approximate)
constexpr int BASE_LOG = 18;                // ceil(log2(q) / d)
constexpr uint64_t BASE = 1ULL << BASE_LOG; // B = 2^18: gadget base
constexpr int AUTO_GEN = 5;                 // automorphism generator
constexpr size_t SEED_BYTES = 64;           // CRS seed length

// Response compression
constexpr uint64_t Q_PRIME_0 = 1ULL << 20;  // q'_0: body coefficient bits
constexpr uint64_t Q_PRIME_1 = 1ULL << 28;  // q'_1: mask coefficient bits
constexpr int BETA = 53;                     // ceil(log2(q))

// Derived
constexpr uint64_t Q_FULL = (uint64_t)(((__uint128_t)Q0 * Q1));
constexpr uint64_t DELTA = Q_FULL / P;       // floor(q/p)
constexpr uint64_t DELTA_MOD_Q0 = DELTA % Q0;
constexpr uint64_t DELTA_MOD_Q1 = DELTA % Q1;

// ============================================================
// Public parameters (pp)
// Computed by Setup(N_entries, w)
// ============================================================

struct PublicParams {
    size_t N_entries;       // number of database entries
    size_t w;               // entry size in bytes
    size_t db_rows;         // power of two
    size_t db_cols;         // ceil(N_entries*ceil(8w/15)/db_rows), rounded up to a multiple of N
    size_t n_packed;        // db_cols / N
    size_t D;               // interpolation degree (power of two <= D_max)
    size_t num_cts;         // c = n_packed / D
    std::array<uint8_t, SEED_BYTES> seed;  // CRS seed
};

// Compute pp from database shape using the default DB geometry (db_rows=32768,
// tall — keeps n_packed and the precomp/"hint" footprint small at the cost of a
// larger query; see docs/ARCHITECTURE.md §2/§6).
PublicParams setup(size_t N_entries, size_t w);

// Setup with an explicit db_rows (full manual control of the geometry).
PublicParams setup(size_t N_entries, size_t w, size_t db_rows_override);

} // namespace inspire
