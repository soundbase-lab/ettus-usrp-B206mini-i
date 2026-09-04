// Synthetic-IQ tests: CW placement and level, noise-floor RBW scaling, zero-run / clip scanning, FFT-size rule.
#include "dsp.hpp"
#include "fft.hpp"
#include "stitch.hpp"
#include <cmath>
#include <cstdio>
#include <random>
#include <vector>
using namespace scanner;
static int fails = 0;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)
#define CHECK_NEAR(a, b, tol) do { double _a = (a), _b = (b); if (std::fabs(_a - _b) > (tol)) { fprintf(stderr, "FAIL %s:%d %s=%g vs %s=%g (tol %g)\n", __FILE__, __LINE__, #a, _a, #b, _b, (double)(tol)); fails++; } } while (0)

static std::vector<int16_t> synth(double fs, size_t M, double toneHz, double toneDbfs, double noiseDbfsPerHz, uint32_t seed) {
    std::vector<int16_t> iq(2 * M);
    std::mt19937 rng(seed); std::normal_distribution<double> nd(0, 1);
    double amp = std::pow(10.0, toneDbfs / 20.0) * 32768.0;          // complex exponential of power amp^2
    double nsig = std::sqrt(std::pow(10.0, noiseDbfsPerHz / 10.0) * fs / 2) * 32768.0; // per component
    for (size_t n = 0; n < M; ++n) {
        double ph = 2 * M_PI * toneHz * n / fs;
        double i = amp * std::cos(ph) + nsig * nd(rng), q = amp * std::sin(ph) + nsig * nd(rng);
        iq[2 * n] = int16_t(std::lround(std::max(-32768.0, std::min(32767.0, i))));
        iq[2 * n + 1] = int16_t(std::lround(std::max(-32768.0, std::min(32767.0, q))));
    }
    return iq;
}

int main() {
    CHECK(Fft::simdWidth() == 4);
    CHECK(Fft::legalSize(3840) && Fft::legalSize(2560) && Fft::legalSize(24576) && !Fft::legalSize(3584) && !Fft::legalSize(1000));
    // FFT-size rule: df <= rbw/7, minimal |k df - rbw|, ties -> smaller N
    CHECK(Fft::chooseSize(8e6, 25e3) == 5120);
    CHECK(Fft::chooseSize(8e6, 12.5e3) == 10240);
    CHECK(Fft::chooseSize(16e6, 25e3) == 10240);
    CHECK(Fft::chooseSize(32e6, 25e3) == 20480);
    CHECK(Fft::chooseSize(28e6, 25e3) == 19200);
    CHECK(Fft::chooseSize(56e6, 25e3) == 36000);
    {   // exact CW on a bin centre inside a cell: cell power == tone power (0 dB), neighbours far down
        const double fs = 8e6; const int N = 5120; const int nAvg = 8;
        SubWindowAnalyzer an(N, fs, WindowType::BH4);
        double centre = 500e6, tone = 500.309e6; // pilot 309 kHz above centre
        size_t M = samplesNeeded(N, nAvg);
        auto iq = synth(fs, M, tone - centre, -20.0, -170.0, 1);
        double start = 470e6, step = 25e3; uint32_t bins = 5521;
        CellMap map = buildCellMap(centre, centre - 3.4e6, centre + 3.4e6, N, fs, start, step, 25e3, bins);
        CHECK(map.nCells == 273); // 6.8 MHz / 25 kHz + 1
        std::vector<float> avg(map.nCells), pk(map.nCells), mn(map.nCells), sm(map.nCells);
        SegmentStats st; scanSamples(iq.data(), M, st);
        an.analyze(iq.data(), M, nAvg, map, avg.data(), pk.data(), mn.data(), sm.data(), st);
        // 500.309 lies in the 500.300 cell (covers 500.2875..500.3125)
        uint32_t jTone = uint32_t(std::lround((500.300e6 - start) / step)) - map.firstCell;
        double dbTone = 10 * std::log10(avg[jTone]);
        CHECK_NEAR(dbTone, -20.0, 0.4); // tone is 3.5 kHz inside the cell edge: small main-lobe loss allowed
        double dbNext = 10 * std::log10(avg[jTone + 1]), dbPrev = 10 * std::log10(avg[jTone - 1]);
        fprintf(stderr, "tone cell %.2f dB, next %.2f, prev %.2f\n", dbTone, dbNext, dbPrev);
        CHECK(dbNext < dbTone - 10);                   // tone is 3.5 kHz from this cell's edge: partial main lobe leaks
        CHECK(dbPrev < -70);                           // 21.5 kHz away: BH4 sidelobes only
        CHECK(st.peakAbs > 3000 && st.clipCount == 0 && st.zeroRunMax < kZeroRunLimit);
        CHECK(st.framesUsed == nAvg);
        // peak >= avg >= min for every cell
        for (uint32_t j = 0; j < map.nCells; ++j) CHECK(pk[j] >= avg[j] * 0.999f && mn[j] <= avg[j] * 1.001f);
    }
    {   // white noise: cell power = density * RBW; doubling RBW adds 3 dB; averaging reduces sigma
        const double fs = 8e6; const int N = 5120; const int nAvg = 50;
        SubWindowAnalyzer an(N, fs, WindowType::BH4);
        size_t M = samplesNeeded(N, nAvg);
        auto iq = synth(fs, M, 0, -300.0, -130.0, 2); // -130 dBFS/Hz -> -86 dBFS in 25 kHz
        double centre = 500e6, start = 470e6, step = 25e3; uint32_t bins = 5521;
        for (double rbw : {25e3, 50e3}) {
            CellMap map = buildCellMap(centre, centre - 3e6, centre + 3e6, N, fs, start, step, rbw, bins);
            std::vector<float> avg(map.nCells), pk(map.nCells), mn(map.nCells), sm(map.nCells); SegmentStats st;
            an.analyze(iq.data(), M, nAvg, map, avg.data(), pk.data(), mn.data(), sm.data(), st);
            double mean = 0, m2 = 0; for (float v : avg) { double d = 10 * std::log10(v); mean += d; m2 += d * d; }
            mean /= map.nCells; double sigma = std::sqrt(std::max(0.0, m2 / map.nCells - mean * mean));
            double expect = -130 + 10 * std::log10(rbw);
            CHECK_NEAR(mean, expect, 0.4);
            double kEff = 0.39 * rbw / (fs / N);
            CHECK(sigma < 1.5 * 4.34 / std::sqrt(nAvg * kEff) + 0.05);
            fprintf(stderr, "noise rbw=%.0f mean=%.2f expect=%.2f sigma=%.3f\n", rbw, mean, expect, sigma);
        }
    }
    {   // zero run and clip detection
        std::vector<int16_t> iq(2 * 1000, 100);
        for (int i = 300; i < 340; ++i) iq[2 * i] = iq[2 * i + 1] = 0;
        iq[2 * 900] = 32767;
        SegmentStats st; scanSamples(iq.data(), 1000, st);
        CHECK(st.zeroRunMax == 40 && st.clipCount == 1 && st.peakAbs == 32767);
    }
    {   // stitching: two overlapping windows average in linear power; spur cell masked & filled; holes flagged
        SweepGrid g; SpurTable sp; sp.freqsHz = {480e6};
        g.configure(470e6, 25e3, 5521, 25e3, sp); g.beginSweep();
        CellMap m1; m1.firstCell = 0; m1.nCells = 500; CellMap m2; m2.firstCell = 400; m2.nCells = 500;
        std::vector<float> a(500, 1e-9f), b(500, 2e-9f); SegmentStats st; st.valid = true; st.sampleCount = 1;
        SubWindow sw; sw.index = 0; sw.rfCentreHz = 476e6;
        g.addSegment(m1, a.data(), a.data(), a.data(), a.data(), st, sw, nullptr, false, 0);
        CHECK(g.filledBins() == 500);
        g.addSegment(m2, b.data(), b.data(), b.data(), b.data(), st, sw, nullptr, false, 0);
        g.finalize();
        std::vector<float> A(5521), P(5521), Mn(5521), S(5521); g.toDb(A.data(), P.data(), Mn.data(), S.data(), 5521);
        CHECK_NEAR(A[100], -90.0, 0.01); CHECK_NEAR(A[450], 10 * std::log10(1.5e-9), 0.01); CHECK_NEAR(A[800], 10 * std::log10(2e-9), 0.01);
        uint32_t spurCell = uint32_t((480e6 - 470e6) / 25e3);
        CHECK(g.mask()[spurCell] & proto::MaskSpur); CHECK(!std::isnan(A[spurCell]));
        CHECK(std::isnan(A[2000]) && (g.mask()[2000] & proto::MaskHole));
    }
    if (!fails) printf("dsp: ok\n");
    return fails ? 1 : 0;
}
