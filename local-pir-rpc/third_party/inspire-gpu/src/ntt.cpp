#include "ntt.h"
#include <stdexcept>

namespace inspire {

namespace {

inline uint64_t mod_add(uint64_t a, uint64_t b, uint64_t q) {
    uint64_t s = a + b;
    return (s >= q) ? s - q : s;
}

inline uint64_t mod_sub(uint64_t a, uint64_t b, uint64_t q) {
    return (a >= b) ? a - b : a + q - b;
}

inline uint64_t mod_mul(uint64_t a, uint64_t b, uint64_t q) {
    return (uint64_t)((__uint128_t)a * b % q);
}

uint64_t mod_pow(uint64_t base, uint64_t exp, uint64_t q) {
    uint64_t result = 1;
    base %= q;
    while (exp) {
        if (exp & 1) result = mod_mul(result, base, q);
        base = mod_mul(base, base, q);
        exp >>= 1;
    }
    return result;
}

// q prime → use Fermat's little theorem
uint64_t mod_inv(uint64_t a, uint64_t q) {
    if (a == 0) return 0;
    return mod_pow(a, q - 2, q);
}

constexpr int log2_n() {
    // log2(N) at compile time; assumes N is a power of two.
    int r = 0; size_t n = N;
    while (n > 1) { n >>= 1; ++r; }
    return r;
}

inline size_t bit_reverse(size_t x, int bits) {
    size_t r = 0;
    for (int i = 0; i < bits; ++i) {
        if (x & (1ULL << i)) r |= 1ULL << (bits - 1 - i);
    }
    return r;
}

// Find the smallest g >= 2 such that psi := g^((q-1)/(2N)) is a primitive 2N-th
// root of unity in Z_q, i.e. psi^N ≡ -1 (mod q). This deterministically picks
// the same psi every run.
uint64_t find_primitive_2n_root(uint64_t q) {
    if ((q - 1) % (2 * N) != 0) {
        throw std::runtime_error("modulus q does not satisfy q ≡ 1 (mod 2N)");
    }
    uint64_t exp = (q - 1) / (2 * N);
    for (uint64_t g = 2; g < q; ++g) {
        uint64_t psi = mod_pow(g, exp, q);
        // Must be a primitive 2N-th root: psi^N = q-1 (= -1 mod q).
        if (mod_pow(psi, N, q) == q - 1) {
            return psi;
        }
    }
    throw std::runtime_error("no primitive 2N-th root found (shouldn't happen for prime q)");
}

NttTables build_tables(uint64_t q) {
    NttTables t{};
    t.q = q;
    t.psi = find_primitive_2n_root(q);
    constexpr int LOG_N = log2_n();
    for (size_t i = 0; i < N; ++i) {
        t.fwd_twiddles[i] = mod_pow(t.psi, bit_reverse(i, LOG_N), q);
    }
    t.inv_twiddles[0] = 1;
    for (size_t i = 1; i < N; ++i) {
        t.inv_twiddles[i] = mod_inv(t.fwd_twiddles[i], q);
    }
    t.inv_n = mod_inv(N, q);

    // Shoup primes: w_prime = floor(w * 2^32 / q). For our 27-bit primes,
    // w * 2^32 fits in 60 bits, so the calculation is exact in u64.
    auto shoup_prime = [q](uint64_t w) -> uint64_t {
        return (w << 32) / q;  // floor(w * 2^32 / q)
    };
    for (size_t i = 0; i < N; ++i) {
        t.fwd_primes[i] = shoup_prime(t.fwd_twiddles[i]);
        t.inv_primes[i] = shoup_prime(t.inv_twiddles[i]);
    }
    t.inv_n_prime = shoup_prime(t.inv_n);
    return t;
}

} // anonymous namespace

const NttTables& ntt_tables(int limb) {
    // Built once per process. Function-local static is thread-safe in C++11+.
    static const NttTables t0 = build_tables(Q0);
    static const NttTables t1 = build_tables(Q1);
    return (limb == 0) ? t0 : t1;
}

void ntt_forward(uint64_t* data, int limb) {
    const NttTables& t = ntt_tables(limb);
    const uint64_t q = t.q;
    // Cooley-Tukey DIT. Mirrors gpu.cu's ntt_fwd_kernel butterfly exactly.
    for (size_t m = 1; m < N; m <<= 1) {
        const size_t stride = N / (2 * m);
        for (size_t idx = 0; idx < N / 2; ++idx) {
            const size_t group_idx = idx / stride;
            const size_t pair_idx  = idx % stride;
            const size_t j = group_idx * 2 * stride + pair_idx;
            const size_t k = j + stride;
            const uint64_t w = t.fwd_twiddles[m + group_idx];
            const uint64_t u = data[j];
            const uint64_t v = mod_mul(data[k], w, q);
            data[j] = mod_add(u, v, q);
            data[k] = mod_sub(u, v, q);
        }
    }
}

void ntt_inverse(uint64_t* data, int limb) {
    const NttTables& t = ntt_tables(limb);
    const uint64_t q = t.q;
    // Gentleman-Sande, reverse stage order. Mirrors gpu.cu's ntt_inv_kernel.
    for (size_t m = N / 2; m >= 1; m >>= 1) {
        const size_t stride = N / (2 * m);
        for (size_t idx = 0; idx < N / 2; ++idx) {
            const size_t group_idx = idx / stride;
            const size_t pair_idx  = idx % stride;
            const size_t j = group_idx * 2 * stride + pair_idx;
            const size_t k = j + stride;
            const uint64_t w = t.inv_twiddles[m + group_idx];
            const uint64_t u = data[j];
            const uint64_t v = data[k];
            data[j] = mod_add(u, v, q);
            data[k] = mod_mul(mod_sub(u, v, q), w, q);
        }
        if (m == 1) break; // unsigned: cannot decrement below 1 without underflow
    }
    for (size_t i = 0; i < N; ++i) {
        data[i] = mod_mul(data[i], t.inv_n, q);
    }
}

} // namespace inspire
