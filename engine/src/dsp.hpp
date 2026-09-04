// dsp.hpp: per-sub-window spectral analysis (PLAN.md 5.1 / 5.2).
#pragma once
#include "fft.hpp"
#include <cstdint>
#include <memory>
#include <vector>

namespace scanner {

enum class WindowType { BH4, Hann };

struct WindowCoefs {
    std::vector<float> w;
    double S1 = 0, S2 = 0;   // sum w, sum w^2
    double enbwBins() const { return w.size() * S2 / (S1 * S1); }
    static WindowCoefs make(int N, WindowType t);
};

// Fine-bin -> output-cell mapping for one sub-window. Cell c (global index firstCell + j) integrates power
// density over fine bins i0[j]..i1[j] with fractional edge weights w0[j] (bin i0) and w1[j] (bin i1); interior
// bins weigh 1. Weights are in units of bins, so cell power = df * sum(weight * Pd).
struct CellMap {
    uint32_t firstCell = 0;
    uint32_t nCells = 0;
    std::vector<int32_t> i0, i1;
    std::vector<float> w0, w1;
    int fftN = 0;
};

// centreHz: RF at baseband 0. Cells whose centre lies in [keptLo, keptHi] are mapped. Bins outside 0..N-1
// are clipped (cells near the FFT edge are never kept because keptHz << fs).
CellMap buildCellMap(double centreHz, double keptLoHz, double keptHiHz, int N, double fsHz,
                     double gridStartHz, double stepHz, double rbwHz, uint32_t binCount);

struct SegmentStats {
    uint64_t sampleCount = 0;
    uint64_t clipCount = 0;     // |I| or |Q| >= clipThreshold
    int64_t firstClip = -1;     // sample index (within the scanned block) of the first clipped sample
    int64_t lastClip = -1;
    uint32_t zeroRunMax = 0;    // longest run of exact-zero complex samples
    int16_t peakAbs = 0;
    int framesUsed = 0;
    bool overflow = false;
    bool valid = true;
};

constexpr int16_t kClipThreshold = 32000;
constexpr uint32_t kZeroRunLimit = 32; // >= this many consecutive exact zeros = AD9361 ALERT mute

// Scans interleaved sc16 samples for zero runs / clipping / peak.
void scanSamples(const int16_t* iq, size_t n, SegmentStats& st);
inline size_t samplesNeeded(int N, int nAvg) { return size_t(N) + size_t(nAvg - 1) * size_t(N / 2); }

class SubWindowAnalyzer {
public:
    SubWindowAnalyzer(int N, double fsHz, WindowType wt);
    ~SubWindowAnalyzer();
    int fftN() const { return n_; }
    double dfHz() const { return fs_ / n_; }
    double fsHz() const { return fs_; }
    // Analyse M >= samplesNeeded(N, nAvg) interleaved sc16 samples. Outputs per cell (map.nCells) in linear
    // power (full scale = 1.0): avg (mean over frames), peak (max), minv (min), sample (first frame).
    void analyze(const int16_t* iq, size_t M, int nAvg, const CellMap& map,
                 float* avg, float* peak, float* minv, float* sample, SegmentStats& st);
    // Averaged fine-bin power density (shifted order) of the last analyze() call, FS^2/Hz.
    const float* lastFinePsd() const { return psdAvg_; }
private:
    int n_;
    double fs_;
    WindowCoefs win_;
    std::unique_ptr<Fft> fft_;
    float* frame_ = nullptr;   // 2N floats, windowed complex input
    float* power_ = nullptr;   // N floats |X|^2, shifted
    float* psdAvg_ = nullptr;  // N floats
    std::vector<float> cellFrame_;
    float scale_ = 1.f;        // 1/(fs * S2) * (1/32768)^2
};

} // namespace scanner
