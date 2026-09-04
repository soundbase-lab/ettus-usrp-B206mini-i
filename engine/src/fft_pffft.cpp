#include "fft.hpp"
#include "pffft.h"
#include <cmath>
#include <stdexcept>
#include <vector>

namespace scanner {

namespace {
class PffftBackend : public Fft {
public:
    explicit PffftBackend(int N) : n_(N) {
        setup_ = pffft_new_setup(N, PFFFT_COMPLEX);
        if (!setup_) throw std::runtime_error("pffft_new_setup failed for N=" + std::to_string(N));
        work_ = (float*)pffft_aligned_malloc(sizeof(float) * 2 * N);
        tmp_ = (float*)pffft_aligned_malloc(sizeof(float) * 2 * N);
        // Precompute the unordered -> shifted-ordered permutation: transform an index-encoded array through
        // pffft_zreorder (unordered -> canonical order) and read back where each unordered element landed.
        std::vector<float> enc(2 * N), ord(2 * N);
        for (int i = 0; i < 2 * N; ++i) enc[i] = float(i);
        pffft_zreorder(setup_, enc.data(), ord.data(), PFFFT_FORWARD);
        // ord[c] = index in the unordered array that holds canonical element c (c = 2*bin + {0 re, 1 im}).
        // pffft keeps 4 real parts then 4 imaginary parts per SIMD block, so re/im of a bin are NOT adjacent:
        // gather both indices per shifted bin.
        perm_.assign(2 * N, 0); reIdx_.assign(N, 0); imIdx_.assign(N, 0);
        for (int c = 0; c < 2 * N; ++c) {
            int u = int(ord[c]);
            int bin = c / 2, comp = c & 1;
            int shifted = (bin + N / 2) % N;
            perm_[u] = 2 * shifted + comp;
            if (comp == 0) reIdx_[shifted] = u; else imIdx_[shifted] = u;
        }
    }
    ~PffftBackend() override {
        pffft_destroy_setup(setup_);
        pffft_aligned_free(work_);
        pffft_aligned_free(tmp_);
    }
    int size() const override { return n_; }
    void forwardPower(const float* in, float* out) override {
        pffft_transform(setup_, in, tmp_, work_, PFFFT_FORWARD);
        for (int b = 0; b < n_; ++b) {
            float re = tmp_[reIdx_[b]], im = tmp_[imIdx_[b]];
            out[b] = re * re + im * im;
        }
    }
    void forwardSpectrum(const float* in, float* spec) override {
        pffft_transform(setup_, in, tmp_, work_, PFFFT_FORWARD);
        for (int u = 0; u < 2 * n_; ++u) spec[perm_[u]] = tmp_[u];
    }
private:
    int n_;
    PFFFT_Setup* setup_;
    float* work_;
    float* tmp_;
    std::vector<int> perm_, reIdx_, imIdx_;
};
} // namespace

std::unique_ptr<Fft> Fft::create(int N) {
    if (!legalSize(N)) throw std::invalid_argument("illegal FFT size " + std::to_string(N));
    return std::make_unique<PffftBackend>(N);
}

bool Fft::legalSize(int N) {
    if (N < 64 || N > 65536 || N % 32) return false;
    int m = N;
    for (int f : {2, 3, 5}) while (m % f == 0) m /= f;
    return m == 1;
}

// PLAN.md 5.2 (tightened): N legal with df = fs/N <= rbw/16. Among those, take the smallest N whose nominal
// bin count k = round(rbw/df) reproduces the RBW within 2 % (|k*df - rbw| <= 0.02 rbw); if none does, minimise the
// error. >= 16 fine bins per cell keeps the BH4 main lobe (+-4 bins) inside a cell, so a tone up to ~3 kHz from a
// 25 kHz cell edge reads within 0.4 dB (with 8 bins the loss was 3 dB). Cells integrate power density with
// fractional edge weights anyway, so the realised RBW is exact regardless of k.
int Fft::chooseSize(double fs, double rbw) {
    int best = 0, bestSmall = 0; double bestErr = 1e300;
    for (int N = 64; N <= 65536; N += 32) {
        if (!legalSize(N)) continue;
        double df = fs / N;
        if (df > rbw / 16.0 + 1e-9) continue;
        int k = int(std::lround(rbw / df));
        double err = std::fabs(k * df - rbw);
        if (!bestSmall && err <= 0.02 * rbw) bestSmall = N;
        if (err < bestErr - 1e-9) { bestErr = err; best = N; }
    }
    if (bestSmall) return bestSmall;
    return best ? best : 65536;
}

int Fft::simdWidth() { return pffft_simd_size(); }
float* Fft::alignedAlloc(size_t floats) { return (float*)pffft_aligned_malloc(sizeof(float) * floats); }
void Fft::alignedFree(float* p) { pffft_aligned_free(p); }

} // namespace scanner
