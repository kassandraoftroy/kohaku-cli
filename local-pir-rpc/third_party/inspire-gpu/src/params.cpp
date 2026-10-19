#include "params.h"
#include <cmath>
#include <random>
#include <algorithm>
#include <stdexcept>

namespace inspire {

// D_max from noise analysis (Section 8.3)
static constexpr size_t D_MAX = 256; // largest power of two <= 264

// Default DB geometry: db_rows = 32768 (tall). Online latency and the precomp
// ("hint") footprint scale with n_packed = db_cols/N, which a tall DB keeps
// small; the trade-off is a larger query. This is the project default for all
// DB sizes (1 GB → n_packed=8, 4 GB → 32, 16 GB → 128). Use the 3-arg overload
// for a different db_rows.
static constexpr size_t DEFAULT_DB_ROWS = 32768;

PublicParams setup(size_t N_entries, size_t w) {
    return setup(N_entries, w, DEFAULT_DB_ROWS);
}

PublicParams setup(size_t N_entries, size_t w, size_t db_rows_override) {
    PublicParams pp;
    pp.N_entries = N_entries;
    pp.w = w;
    pp.D = D_MAX;
    pp.db_rows = db_rows_override;

    // Each entry occupies ceil(w*8 / P_BITS) coefficients (15 raw bits/slot).
    // Must match extract(): using a different count undersizes db_cols, so high
    // indices map past the last column and extract()'s k_star overflows num_cts.
    size_t coeffs_per_entry = (w * 8 + P_BITS - 1) / P_BITS;
    size_t total_coeffs = N_entries * coeffs_per_entry;
    size_t cols = (total_coeffs + pp.db_rows - 1) / pp.db_rows;
    pp.db_cols = ((cols + N - 1) / N) * N;
    if (pp.db_cols == 0) pp.db_cols = N;
    pp.n_packed = pp.db_cols / N;
    pp.num_cts = std::max<size_t>(1, pp.n_packed / pp.D);

    // Geometry constraints the query/extract path relies on; violating them
    // makes some indices silently unretrievable, so reject them here.
    //  - coeffs_per_entry must divide N: an entry straddling an N-column
    //    boundary spills into the next interpolation point, which a single
    //    RGSW query cannot cover.
    if (N % coeffs_per_entry != 0)
        throw std::invalid_argument(
            "setup: ceil(8*w/15) must divide N=2048 (w=120 -> 64 slots is the "
            "supported shape)");
    //  - D_actual = min(D, n_packed) must divide 2N (query()'s omega exponent
    //    is (j* * 2N) / D_actual) — guaranteed when n_packed is a power of two.
    size_t d_actual = std::min(pp.D, pp.n_packed);
    if ((2 * N) % d_actual != 0)
        throw std::invalid_argument(
            "setup: n_packed must be a power of two (choose N_entries/db_rows "
            "accordingly)");
    //  - when n_packed > D, num_cts = n_packed/D must be exact or top indices
    //    get k_star >= num_cts.
    if (pp.n_packed > pp.D && pp.n_packed % pp.D != 0)
        throw std::invalid_argument("setup: n_packed must be a multiple of D");

    // Generate random CRS seed
    std::random_device rd;
    std::mt19937_64 rng(rd());
    for (auto& b : pp.seed) b = rng() & 0xFF;

    return pp;
}

} // namespace inspire
