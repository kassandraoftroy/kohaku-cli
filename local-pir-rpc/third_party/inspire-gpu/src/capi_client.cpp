// C ABI client half: query building and response extraction over the flat
// layouts in capi.h. Pure CPU — lives in the core library so client-only
// consumers link no CUDA. See capi.cu for the server half.
#include "capi.h"
#include "protocol.h"
#include <algorithm>
#include <cstring>
#include <new>

using namespace inspire;

struct ipir_client_query {
    QueryState st;
};

// The compile-time ring constants must match the published params (a mismatch
// means incompatible library versions), and — since the client receives this
// struct over the network — every field is bounds- and consistency-checked so
// hostile parameters cannot divide by zero, overflow the size helpers, or
// index past a response.
static bool params_ok(const ipir_params* p) {
    if (!p || p->ring_n != N || p->d_eff != (size_t)D_EFF) return false;
    if (p->db_rows == 0 || p->db_rows > (1ULL << 26)) return false;
    if (p->n_entries == 0 || p->entry_bytes == 0 || p->entry_bytes > (1ULL << 20))
        return false;
    if (p->n_packed == 0 || p->n_packed > (1ULL << 20)) return false;
    if (p->interp_d == 0 || p->interp_d > (1ULL << 20)) return false;
    if (p->num_cts == 0 || p->num_cts > (1ULL << 16)) return false;
    // Mirror setup()'s geometry constraints.
    size_t cpe = (p->entry_bytes * 8 + P_BITS - 1) / P_BITS;
    if (N % cpe != 0) return false;
    if (p->db_cols != p->n_packed * N) return false;
    size_t d_actual = std::min(p->interp_d, p->n_packed);
    if ((2 * N) % d_actual != 0) return false;
    if (p->n_packed > p->interp_d && p->n_packed % p->interp_d != 0) return false;
    if (p->num_cts != std::max<size_t>(1, p->n_packed / p->interp_d)) return false;
    return true;
}

static PublicParams pp_from(const ipir_params* p) {
    PublicParams pp;
    pp.N_entries = p->n_entries;
    pp.w         = p->entry_bytes;
    pp.db_rows   = p->db_rows;
    pp.db_cols   = p->db_cols;
    pp.n_packed  = p->n_packed;
    pp.D         = p->interp_d;
    pp.num_cts   = p->num_cts;
    static_assert(SEED_BYTES == sizeof(p->seed), "seed size mismatch");
    std::memcpy(pp.seed.data(), p->seed, SEED_BYTES);
    return pp;
}

// [digit][limb][coeff] flatten of a KSK / RGSW part vector (see capi.h).
static uint64_t* flatten_parts(uint64_t* dst, const std::vector<RnsPoly>& parts,
                               bool want_ntt) {
    for (const RnsPoly& p0 : parts) {
        RnsPoly p = p0;
        if (want_ntt && !p.is_ntt) p.to_ntt();
        if (!want_ntt && p.is_ntt) p.to_coeff();
        for (size_t i = 0; i < N; i++) *dst++ = p.limbs[0][i];
        for (size_t i = 0; i < N; i++) *dst++ = p.limbs[1][i];
    }
    return dst;
}

extern "C" {

size_t ipir_query_u64s(const ipir_params* params) {
    if (!params_ok(params)) return 0;
    return 2 * params->db_rows + 6 * (params->d_eff * 2 * params->ring_n);
}

size_t ipir_response_u64s(const ipir_params* params) {
    if (!params_ok(params)) return 0;
    return params->num_cts * 4 * params->ring_n;
}

size_t ipir_entry_slots(const ipir_params* params) {
    if (!params_ok(params)) return 0;
    return (params->entry_bytes * 8 + P_BITS - 1) / P_BITS;
}

int ipir_query_view_from_flat(const ipir_params* params, const uint64_t* flat,
                              ipir_query_view* out_view) {
    if (!params_ok(params) || !flat || !out_view) return 1;
    const size_t blk = params->d_eff * 2 * params->ring_n;
    out_view->lwe_b_limb0 = flat;
    out_view->lwe_b_limb1 = flat + params->db_rows;
    out_view->ksk5_b      = flat + 2 * params->db_rows;
    out_view->kskneg1_b   = flat + 2 * params->db_rows + blk;
    out_view->rgsw        = flat + 2 * params->db_rows + 2 * blk;
    return 0;
}

ipir_client_query* ipir_query_build(const ipir_params* params, uint64_t idx,
                                    uint64_t* out_query) {
    if (!params_ok(params) || !out_query || idx >= params->n_entries)
        return nullptr;
    try {
    PublicParams pp = pp_from(params);
    auto [qst, qry] = query(pp, (size_t)idx);
    auto* cq = new (std::nothrow) ipir_client_query;
    if (!cq) return nullptr;
    cq->st = std::move(qst);

    uint64_t* w = out_query;
    std::memcpy(w, qry.lwe.b_limb0.data(), params->db_rows * sizeof(uint64_t));
    w += params->db_rows;
    std::memcpy(w, qry.lwe.b_limb1.data(), params->db_rows * sizeof(uint64_t));
    w += params->db_rows;
    w = flatten_parts(w, qry.ksk_5.b_parts,      /*want_ntt=*/false);
    w = flatten_parts(w, qry.ksk_neg1.b_parts,   /*want_ntt=*/false);
    w = flatten_parts(w, qry.rgsw.top.a_parts,    /*want_ntt=*/true);
    w = flatten_parts(w, qry.rgsw.top.b_parts,    /*want_ntt=*/true);
    w = flatten_parts(w, qry.rgsw.bottom.a_parts, /*want_ntt=*/true);
    w = flatten_parts(w, qry.rgsw.bottom.b_parts, /*want_ntt=*/true);
    return cq;
    } catch (...) {
        return nullptr;  // exceptions must not cross the C ABI
    }
}

int ipir_extract(const ipir_params* params, const ipir_client_query* q,
                 const uint64_t* resp, uint16_t* out_slots) {
    if (!params_ok(params) || !q || !resp || !out_slots) return 1;
    try {
    PublicParams pp = pp_from(params);
    std::vector<RlweCt> cts(pp.num_cts);
    const uint64_t* r = resp;
    for (size_t g = 0; g < pp.num_cts; g++) {
        cts[g].a = RnsPoly::zero();
        cts[g].b = RnsPoly::zero();
        for (size_t k = 0; k < N; k++) cts[g].a.limbs[0][k] = *r++;
        for (size_t k = 0; k < N; k++) cts[g].a.limbs[1][k] = *r++;
        for (size_t k = 0; k < N; k++) cts[g].b.limbs[0][k] = *r++;
        for (size_t k = 0; k < N; k++) cts[g].b.limbs[1][k] = *r++;
        cts[g].a.is_ntt = true;
        cts[g].b.is_ntt = true;
    }

    std::vector<uint16_t> slots = extract(pp, q->st, cts);
    if (slots.size() != ipir_entry_slots(params)) return 2;
    std::memcpy(out_slots, slots.data(), slots.size() * sizeof(uint16_t));
    return 0;
    } catch (...) {
        return 3;  // exceptions must not cross the C ABI
    }
}

void ipir_client_query_destroy(ipir_client_query* q) {
    delete q;
}

// ============================================================
// Wire packing: CRT-combine the two 27-bit limbs of each coefficient into
// one value mod q and bit-pack at BETA bits/value. See capi.h.
// ============================================================

static uint64_t q1_inv_q0() {
    // (Q1 mod Q0)^{-1} mod Q0, extended Euclid; computed once.
    static const uint64_t inv = [] {
        int64_t old_r = (int64_t)(Q1 % Q0), r = (int64_t)Q0, old_s = 1, s = 0;
        while (r != 0) {
            int64_t q = old_r / r, t = r;
            r = old_r - q * r; old_r = t;
            t = s; s = old_s - q * s; old_s = t;
        }
        return (uint64_t)((old_s % (int64_t)Q0 + (int64_t)Q0) % (int64_t)Q0);
    }();
    return inv;
}

static inline uint64_t crt_combine(uint64_t v0, uint64_t v1) {
    // Garner: v = v1 + Q1 * ((v0 - v1) * Q1^{-1} mod Q0), in [0, Q0*Q1) < 2^BETA.
    uint64_t diff = (v0 + Q0 - (v1 % Q0)) % Q0;
    uint64_t h = (uint64_t)(((__uint128_t)diff * q1_inv_q0()) % Q0);
    return v1 + Q1 * h;
}

namespace {
constexpr int WIRE_BITS = BETA;  // ceil(log2(Q0*Q1))

struct BitWriter {
    uint8_t* p;
    uint64_t acc = 0;
    int nbits = 0;
    explicit BitWriter(uint8_t* out) : p(out) {}
    // acc holds < 8 bits between calls, so acc << WIRE_BITS stays below 2^62.
    void put(uint64_t v) {
        acc = (acc << WIRE_BITS) | v;
        nbits += WIRE_BITS;
        while (nbits >= 8) {
            nbits -= 8;
            *p++ = (uint8_t)(acc >> nbits);
        }
        acc &= (1ULL << nbits) - 1;
    }
    void flush() {
        if (nbits > 0) {
            *p++ = (uint8_t)(acc << (8 - nbits));
            nbits = 0;
        }
    }
};

struct BitReader {
    const uint8_t* p;
    uint64_t acc = 0;
    int nbits = 0;
    explicit BitReader(const uint8_t* in) : p(in) {}
    uint64_t get() {
        while (nbits < WIRE_BITS) {
            acc = (acc << 8) | *p++;
            nbits += 8;
        }
        nbits -= WIRE_BITS;
        uint64_t v = acc >> nbits;
        acc &= (1ULL << nbits) - 1;
        return v;
    }
};

// The flat query = [lwe_limb0 : R][lwe_limb1 : R] then 6*D_EFF polys of
// [limb0 : N][limb1 : N]; the response = num_cts * { a, b } polys likewise.
// Both walks pair limb0[i] with limb1[i].

size_t query_values(const ipir_params* p) {
    return p->db_rows + 6 * p->d_eff * p->ring_n;
}
size_t response_values(const ipir_params* p) {
    return p->num_cts * 2 * p->ring_n;
}
}  // namespace

size_t ipir_query_packed_bytes(const ipir_params* params) {
    if (!params_ok(params)) return 0;
    return (query_values(params) * WIRE_BITS + 7) / 8;
}

size_t ipir_response_packed_bytes(const ipir_params* params) {
    if (!params_ok(params)) return 0;
    return (response_values(params) * WIRE_BITS + 7) / 8;
}

int ipir_query_pack(const ipir_params* params, const uint64_t* flat,
                    uint8_t* out) {
    if (!params_ok(params) || !flat || !out) return 1;
    const size_t R = params->db_rows, n = params->ring_n;
    BitWriter w(out);
    for (size_t i = 0; i < R; i++) w.put(crt_combine(flat[i], flat[R + i]));
    const uint64_t* poly = flat + 2 * R;
    for (size_t j = 0; j < 6 * params->d_eff; j++, poly += 2 * n)
        for (size_t i = 0; i < n; i++) w.put(crt_combine(poly[i], poly[n + i]));
    w.flush();
    return 0;
}

int ipir_query_unpack(const ipir_params* params, const uint8_t* in,
                      uint64_t* out_flat) {
    if (!params_ok(params) || !in || !out_flat) return 1;
    const size_t R = params->db_rows, n = params->ring_n;
    BitReader r(in);
    for (size_t i = 0; i < R; i++) {
        uint64_t v = r.get();
        out_flat[i] = v % Q0;
        out_flat[R + i] = v % Q1;
    }
    uint64_t* poly = out_flat + 2 * R;
    for (size_t j = 0; j < 6 * params->d_eff; j++, poly += 2 * n)
        for (size_t i = 0; i < n; i++) {
            uint64_t v = r.get();
            poly[i] = v % Q0;
            poly[n + i] = v % Q1;
        }
    return 0;
}

int ipir_response_pack(const ipir_params* params, const uint64_t* flat,
                       uint8_t* out) {
    if (!params_ok(params) || !flat || !out) return 1;
    const size_t n = params->ring_n;
    BitWriter w(out);
    const uint64_t* poly = flat;  // num_cts * 2 polys (a then b), 2N each
    for (size_t j = 0; j < params->num_cts * 2; j++, poly += 2 * n)
        for (size_t i = 0; i < n; i++) w.put(crt_combine(poly[i], poly[n + i]));
    w.flush();
    return 0;
}

int ipir_response_unpack(const ipir_params* params, const uint8_t* in,
                         uint64_t* out_flat) {
    if (!params_ok(params) || !in || !out_flat) return 1;
    const size_t n = params->ring_n;
    BitReader r(in);
    uint64_t* poly = out_flat;
    for (size_t j = 0; j < params->num_cts * 2; j++, poly += 2 * n)
        for (size_t i = 0; i < n; i++) {
            uint64_t v = r.get();
            poly[i] = v % Q0;
            poly[n + i] = v % Q1;
        }
    return 0;
}

// ============================================================
// Compressed responses (modulus switching to q'; see capi.h)
// ============================================================

namespace {
constexpr int MASK_BITS = 28;  // log2(Q_PRIME_1)
constexpr int BODY_BITS = 20;  // log2(Q_PRIME_0)

// Same accumulator scheme as the wire-bits writer, narrower fields.
struct SmallBitWriter {
    uint8_t* p;
    uint64_t acc = 0;
    int nbits = 0;
    explicit SmallBitWriter(uint8_t* out) : p(out) {}
    void put(uint32_t v, int bits) {
        acc = (acc << bits) | v;
        nbits += bits;
        while (nbits >= 8) {
            nbits -= 8;
            *p++ = (uint8_t)(acc >> nbits);
        }
        acc &= (1ULL << nbits) - 1;
    }
    void flush() {
        if (nbits > 0) {
            *p++ = (uint8_t)(acc << (8 - nbits));
            nbits = 0;
        }
    }
};

struct SmallBitReader {
    const uint8_t* p;
    uint64_t acc = 0;
    int nbits = 0;
    explicit SmallBitReader(const uint8_t* in) : p(in) {}
    uint32_t get(int bits) {
        while (nbits < bits) {
            acc = (acc << 8) | *p++;
            nbits += 8;
        }
        nbits -= bits;
        uint32_t v = (uint32_t)(acc >> nbits);
        acc &= (1ULL << nbits) - 1;
        return v;
    }
};
}  // namespace

size_t ipir_response_compressed_bytes(const ipir_params* params) {
    if (!params_ok(params)) return 0;
    return params->num_cts * (params->ring_n * (MASK_BITS + BODY_BITS)) / 8;
}

int ipir_response_compress(const ipir_params* params, const uint64_t* flat,
                           uint8_t* out) {
    if (!params_ok(params) || !flat || !out) return 1;
    try {
    SmallBitWriter w(out);
    const uint64_t* r = flat;
    for (size_t g = 0; g < params->num_cts; g++) {
        RlweCt ct;
        ct.a = RnsPoly::zero();
        ct.b = RnsPoly::zero();
        for (size_t k = 0; k < N; k++) ct.a.limbs[0][k] = *r++;
        for (size_t k = 0; k < N; k++) ct.a.limbs[1][k] = *r++;
        for (size_t k = 0; k < N; k++) ct.b.limbs[0][k] = *r++;
        for (size_t k = 0; k < N; k++) ct.b.limbs[1][k] = *r++;
        ct.a.is_ntt = true;
        ct.b.is_ntt = true;
        CompressedCt cct = compress_ct(ct);
        for (size_t i = 0; i < N; i++) w.put(cct.a[i], MASK_BITS);
        for (size_t i = 0; i < N; i++) w.put(cct.b[i], BODY_BITS);
        w.flush();
    }
    return 0;
    } catch (...) {
        return 2;
    }
}

int ipir_extract_compressed(const ipir_params* params,
                            const ipir_client_query* q, const uint8_t* in,
                            uint16_t* out_slots) {
    if (!params_ok(params) || !q || !in || !out_slots) return 1;
    try {
    PublicParams pp = pp_from(params);
    std::vector<CompressedCt> cts(pp.num_cts);
    SmallBitReader r(in);
    for (size_t g = 0; g < pp.num_cts; g++) {
        cts[g].a.resize(N);
        cts[g].b.resize(N);
        for (size_t i = 0; i < N; i++) cts[g].a[i] = r.get(MASK_BITS);
        for (size_t i = 0; i < N; i++) cts[g].b[i] = r.get(BODY_BITS);
    }

    std::vector<uint16_t> slots = extract_compressed(pp, q->st, cts);
    if (slots.size() != ipir_entry_slots(params)) return 2;
    std::memcpy(out_slots, slots.data(), slots.size() * sizeof(uint16_t));
    return 0;
    } catch (...) {
        return 3;
    }
}

}  // extern "C"
