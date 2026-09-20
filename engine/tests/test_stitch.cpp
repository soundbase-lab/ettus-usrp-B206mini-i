// SweepGrid combining: two measurements of one cell, and the image heuristic that decides between
// averaging them and keeping the quieter one. This is the seam the two-LO image rejection rests on.
#include "stitch.hpp"
#include <cmath>
#include <cstdio>
#include <vector>
using namespace scanner;
static int fails = 0;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)
#define CHECK_NEAR(a, b, tol) do { double _a = (a), _b = (b); if (std::fabs(_a - _b) > (tol)) { fprintf(stderr, "FAIL %s:%d %s=%g vs %s=%g (tol %g)\n", __FILE__, __LINE__, #a, _a, #b, _b, (double)(tol)); fails++; } } while (0)

namespace {
constexpr uint32_t kCells = 8;
constexpr double kStart = 470e6, kStep = 25e3;

// One measurement covering the whole little grid, flat at `avgLin` with its own peak and sample.
void addFlat(SweepGrid& g, float avgLin, float peakLin, float sampleLin, double loHz) {
    CellMap map; map.firstCell = 0; map.nCells = kCells;
    std::vector<float> avg(kCells, avgLin), peak(kCells, peakLin), minv(kCells, avgLin), sample(kCells, sampleLin);
    SegmentStats st; st.valid = true;
    SubWindow sw; sw.index = 0; sw.rfCentreHz = kStart + (kCells / 2) * kStep;
    g.addSegment(map, avg.data(), peak.data(), minv.data(), sample.data(), st, sw, nullptr, false, loHz);
}

SweepGrid makeGrid() {
    SweepGrid g;
    g.configure(kStart, kStep, kCells, kStep, SpurTable{});
    g.beginSweep();
    return g;
}

struct Out { std::vector<float> avg, peak, minv, sample; };
Out read(SweepGrid& g) {
    Out o; o.avg.resize(kCells); o.peak.resize(kCells); o.minv.resize(kCells); o.sample.resize(kCells);
    g.toDb(o.avg.data(), o.peak.data(), o.minv.data(), o.sample.data(), kCells);
    return o;
}
} // namespace

int main() {
    // Two measurements that agree are averaged, and the louder peak is kept: this is the overlap
    // between adjacent LO positions, where both readings are honest.
    {
        SweepGrid g = makeGrid();
        addFlat(g, 1.0f, 2.0f, 1.0f, 494e6);
        addFlat(g, 1.0f, 4.0f, 1.0f, 541.7e6);
        g.finalize();
        Out o = read(g);
        CHECK_NEAR(o.avg[0], 10.0 * std::log10(1.0), 0.01);
        CHECK_NEAR(o.peak[0], 10.0 * std::log10(4.0), 0.01);
        CHECK((g.mask()[0] & proto::MaskImage) == 0);
    }

    // Two measurements that disagree by more than 6 dB: the quieter one wins, because an image moves
    // with the LO and a real signal does not. This is the whole point of sweeping two LO grids.
    {
        SweepGrid g = makeGrid();
        addFlat(g, 100.0f, 200.0f, 150.0f, 494e6);   // contaminated: an image sits on this cell
        addFlat(g, 1.0f, 2.0f, 1.5f, 541.7e6);       // clean
        g.finalize();
        Out o = read(g);
        CHECK_NEAR(o.avg[0], 10.0 * std::log10(1.0), 0.01);
        // The rejected measurement must not survive in the other detectors either.
        CHECK_NEAR(o.peak[0], 10.0 * std::log10(2.0), 0.01);
        CHECK_NEAR(o.sample[0], 10.0 * std::log10(1.5), 0.01);
        CHECK((g.mask()[0] & proto::MaskImage) != 0);
    }

    // The same, with the clean measurement arriving first: order must not matter.
    {
        SweepGrid g = makeGrid();
        addFlat(g, 1.0f, 2.0f, 1.5f, 494e6);
        addFlat(g, 100.0f, 200.0f, 150.0f, 541.7e6);
        g.finalize();
        Out o = read(g);
        CHECK_NEAR(o.avg[0], 10.0 * std::log10(1.0), 0.01);
        CHECK_NEAR(o.peak[0], 10.0 * std::log10(2.0), 0.01);
        CHECK_NEAR(o.sample[0], 10.0 * std::log10(1.5), 0.01);
        CHECK((g.mask()[0] & proto::MaskImage) != 0);
    }

    // A single measurement is passed through untouched and is not flagged as an image.
    {
        SweepGrid g = makeGrid();
        addFlat(g, 4.0f, 8.0f, 4.0f, 494e6);
        g.finalize();
        Out o = read(g);
        CHECK_NEAR(o.avg[0], 10.0 * std::log10(4.0), 0.01);
        CHECK_NEAR(o.peak[0], 10.0 * std::log10(8.0), 0.01);
        CHECK((g.mask()[0] & proto::MaskImage) == 0);
    }

    // Sliding image rejection across sweeps: the second sweep is compared against the first, which
    // was measured at the other LO grid. A cell that is loud in one and quiet in the other is an
    // image, and the quieter reading wins along with its peak.
    {
        SweepGrid g = makeGrid();
        g.beginSweep(); addFlat(g, 1.0f, 2.0f, 1.5f, 494e6); g.finalize(); g.rejectImagesAgainstPrevious(45.0);
        g.beginSweep(); addFlat(g, 100.0f, 200.0f, 150.0f, 541.7e6); g.finalize(); g.rejectImagesAgainstPrevious(45.0);
        Out o = read(g);
        CHECK_NEAR(o.avg[0], 10.0 * std::log10(1.0), 0.01);
        CHECK_NEAR(o.peak[0], 10.0 * std::log10(2.0), 0.01);
        CHECK_NEAR(o.sample[0], 10.0 * std::log10(1.5), 0.01);
        CHECK((g.mask()[0] & proto::MaskImage) != 0);
    }

    // Two sweeps that agree are averaged, so the level does not alternate with the LO grid.
    {
        SweepGrid g = makeGrid();
        g.beginSweep(); addFlat(g, 1.0f, 2.0f, 1.0f, 494e6); g.finalize(); g.rejectImagesAgainstPrevious(45.0);
        g.beginSweep(); addFlat(g, 3.0f, 6.0f, 3.0f, 541.7e6); g.finalize(); g.rejectImagesAgainstPrevious(45.0);
        Out o = read(g);
        CHECK_NEAR(o.avg[0], 10.0 * std::log10(2.0), 0.01);
        CHECK_NEAR(o.peak[0], 10.0 * std::log10(6.0), 0.01);
        CHECK((g.mask()[0] & proto::MaskImage) == 0);
    }

    // A gain change between the two sweeps makes them incomparable: skip the combination rather
    // than take the minimum of two readings that are not referred to the same thing.
    {
        SweepGrid g = makeGrid();
        g.beginSweep(); addFlat(g, 1.0f, 2.0f, 1.0f, 494e6); g.finalize(); g.rejectImagesAgainstPrevious(45.0);
        g.beginSweep(); addFlat(g, 100.0f, 200.0f, 100.0f, 541.7e6); g.finalize(); g.rejectImagesAgainstPrevious(42.0);
        Out o = read(g);
        CHECK_NEAR(o.avg[0], 10.0 * std::log10(100.0), 0.01);
        CHECK((g.mask()[0] & proto::MaskImage) == 0);
    }

    // The first sweep of all has nothing to compare against and must pass through untouched.
    {
        SweepGrid g = makeGrid();
        g.beginSweep(); addFlat(g, 100.0f, 200.0f, 100.0f, 494e6); g.finalize(); g.rejectImagesAgainstPrevious(45.0);
        Out o = read(g);
        CHECK_NEAR(o.avg[0], 10.0 * std::log10(100.0), 0.01);
        CHECK((g.mask()[0] & proto::MaskImage) == 0);
    }

    printf(fails ? "test_stitch: %d failure(s)\n" : "test_stitch: ok\n", fails);
    return fails ? 1 : 0;
}
