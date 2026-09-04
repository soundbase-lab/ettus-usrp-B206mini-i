#include "dsp.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>

#if defined(__aarch64__) || defined(__arm64__)
#include <arm_neon.h>
#define SCANNER_NEON 1
#endif

namespace scanner {

WindowCoefs WindowCoefs::make(int N, WindowType t) {
    WindowCoefs c;
    c.w.resize(N);
    const double twoPi = 2.0 * M_PI;
    for (int n = 0; n < N; ++n) {
        double x = twoPi * n / N;
        double v;
        if (t == WindowType::Hann) v = 0.5 - 0.5 * std::cos(x);
        else v = 0.35875 - 0.48829 * std::cos(x) + 0.14128 * std::cos(2 * x) - 0.01168 * std::cos(3 * x);
        c.w[n] = float(v);
        c.S1 += v; c.S2 += v * v;
    }
    return c;
}

CellMap buildCellMap(double centreHz, double keptLoHz, double keptHiHz, int N, double fs,
                     double gridStartHz, double stepHz, double rbwHz, uint32_t binCount) {
    CellMap m; m.fftN = N;
    const double df = fs / N;
    // cells with centre in [keptLo, keptHi]
    long jLo = long(std::ceil((keptLoHz - gridStartHz) / stepHz - 1e-6));
    long jHi = long(std::floor((keptHiHz - gridStartHz) / stepHz + 1e-6));
    jLo = std::max(jLo, 0L); jHi = std::min(jHi, long(binCount) - 1);
    if (jHi < jLo) return m;
    m.firstCell = uint32_t(jLo); m.nCells = uint32_t(jHi - jLo + 1);
    m.i0.resize(m.nCells); m.i1.resize(m.nCells); m.w0.resize(m.nCells); m.w1.resize(m.nCells);
    // bin i covers baseband [(i - N/2 - 0.5) df, (i - N/2 + 0.5) df]
    for (uint32_t j = 0; j < m.nCells; ++j) {
        double fc = gridStartHz + double(jLo + j) * stepHz;
        double lo = (fc - rbwHz / 2 - centreHz) / df + N / 2.0 + 0.5; // in bin units, bin i spans [i, i+1) here
        double hi = (fc + rbwHz / 2 - centreHz) / df + N / 2.0 + 0.5;
        int i0 = int(std::floor(lo)), i1 = int(std::floor(hi));
        if (hi == std::floor(hi)) i1--; // exact boundary: last bin fully excluded
        double w0 = (i0 + 1) - lo;      // fraction of bin i0 inside the cell
        double w1 = hi - i1;            // fraction of bin i1 inside the cell
        if (i0 == i1) { w0 = hi - lo; w1 = 0; }
        i0 = std::clamp(i0, 0, N - 1); i1 = std::clamp(i1, 0, N - 1);
        m.i0[j] = i0; m.i1[j] = i1; m.w0[j] = float(w0); m.w1[j] = float(w1);
    }
    return m;
}

void scanSamples(const int16_t* iq, size_t n, SegmentStats& st) {
    uint32_t run = 0, maxRun = st.zeroRunMax;
    uint64_t clips = 0;
    int16_t peak = st.peakAbs;
    for (size_t i = 0; i < n; ++i) {
        int16_t a = iq[2 * i], b = iq[2 * i + 1];
        if (a == 0 && b == 0) { if (++run > maxRun) maxRun = run; } else run = 0;
        int16_t aa = int16_t(a < 0 ? -a : a), bb = int16_t(b < 0 ? -b : b);
        if (a == std::numeric_limits<int16_t>::min()) aa = 32767;
        if (b == std::numeric_limits<int16_t>::min()) bb = 32767;
        int16_t mx = aa > bb ? aa : bb;
        if (mx > peak) peak = mx;
        if (mx >= kClipThreshold) { if (st.firstClip < 0) st.firstClip = int64_t(st.sampleCount + i); st.lastClip = int64_t(st.sampleCount + i); clips++; }
    }
    st.sampleCount += n; st.clipCount += clips; st.zeroRunMax = maxRun; st.peakAbs = peak;
}

SubWindowAnalyzer::SubWindowAnalyzer(int N, double fs, WindowType wt) : n_(N), fs_(fs), win_(WindowCoefs::make(N, wt)) {
    fft_ = Fft::create(N);
    frame_ = Fft::alignedAlloc(2 * N);
    power_ = Fft::alignedAlloc(N);
    psdAvg_ = Fft::alignedAlloc(N);
    const double fullScale = 32768.0;
    scale_ = float(1.0 / (fs * win_.S2) / (fullScale * fullScale));
}

SubWindowAnalyzer::~SubWindowAnalyzer() {
    Fft::alignedFree(frame_); Fft::alignedFree(power_); Fft::alignedFree(psdAvg_);
}

static inline void windowConvert(const int16_t* iq, const float* w, float* out, int N) {
#ifdef SCANNER_NEON
    int n = 0;
    for (; n + 4 <= N; n += 4) {
        int16x8_t s = vld1q_s16(iq + 2 * n);                 // i0 q0 i1 q1 i2 q2 i3 q3
        float32x4_t lo = vcvtq_f32_s32(vmovl_s16(vget_low_s16(s)));   // i0 q0 i1 q1
        float32x4_t hi = vcvtq_f32_s32(vmovl_s16(vget_high_s16(s)));  // i2 q2 i3 q3
        float32x4_t wv = vld1q_f32(w + n);                    // w0 w1 w2 w3
        float32x4_t w01 = vzip1q_f32(wv, wv);                 // w0 w0 w1 w1
        float32x4_t w23 = vzip2q_f32(wv, wv);                 // w2 w2 w3 w3
        vst1q_f32(out + 2 * n, vmulq_f32(lo, w01));
        vst1q_f32(out + 2 * n + 4, vmulq_f32(hi, w23));
    }
    for (; n < N; ++n) { out[2 * n] = iq[2 * n] * w[n]; out[2 * n + 1] = iq[2 * n + 1] * w[n]; }
#else
    for (int n = 0; n < N; ++n) { out[2 * n] = iq[2 * n] * w[n]; out[2 * n + 1] = iq[2 * n + 1] * w[n]; }
#endif
}

void SubWindowAnalyzer::analyze(const int16_t* iq, size_t M, int nAvg, const CellMap& map,
                                float* avg, float* peak, float* minv, float* sample, SegmentStats& st) {
    const int N = n_, H = N / 2;
    const uint32_t C = map.nCells;
    cellFrame_.assign(C, 0.f);
    std::fill(psdAvg_, psdAvg_ + N, 0.f);
    for (uint32_t j = 0; j < C; ++j) { avg[j] = 0; peak[j] = 0; minv[j] = std::numeric_limits<float>::max(); sample[j] = 0; }
    int frames = 0;
    const float df = float(fs_ / N);
    for (int f = 0; f < nAvg; ++f) {
        size_t off = size_t(f) * H;
        if (off + N > M) break;
        windowConvert(iq + 2 * off, win_.w.data(), frame_, N);
        fft_->forwardPower(frame_, power_);
        for (int i = 0; i < N; ++i) psdAvg_[i] += power_[i];
        // per-frame cell integration for peak/min/sample detectors
        for (uint32_t j = 0; j < C; ++j) {
            int i0 = map.i0[j], i1 = map.i1[j];
            float s = map.w0[j] * power_[i0];
            if (i1 > i0) { s += map.w1[j] * power_[i1]; for (int i = i0 + 1; i < i1; ++i) s += power_[i]; }
            s *= df * scale_;
            cellFrame_[j] = s;
            if (s > peak[j]) peak[j] = s;
            if (s < minv[j]) minv[j] = s;
            if (f == 0) sample[j] = s;
        }
        frames++;
    }
    st.framesUsed = frames;
    if (!frames) { st.valid = false; for (uint32_t j = 0; j < C; ++j) minv[j] = 0; return; }
    const float inv = 1.f / frames;
    for (int i = 0; i < N; ++i) psdAvg_[i] *= inv * scale_;
    for (uint32_t j = 0; j < C; ++j) {
        int i0 = map.i0[j], i1 = map.i1[j];
        float s = map.w0[j] * psdAvg_[i0];
        if (i1 > i0) { s += map.w1[j] * psdAvg_[i1]; for (int i = i0 + 1; i < i1; ++i) s += psdAvg_[i]; }
        avg[j] = s * df;
    }
}

} // namespace scanner
