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

// The same, measured by a block that keeps [keptLoHz, keptHiHz]: where a cell sits in that block —
// beside the LO, towards an edge, or in the flat part — is what its reading is worth when two agree.
void addPlaced(SweepGrid& g, float avgLin, float peakLin, float sampleLin, double loHz, double keptLoHz, double keptHiHz) {
    CellMap map; map.firstCell = 0; map.nCells = kCells;
    std::vector<float> avg(kCells, avgLin), peak(kCells, peakLin), minv(kCells, avgLin), sample(kCells, sampleLin);
    SegmentStats st; st.valid = true;
    SubWindow sw; sw.index = 0; sw.rfCentreHz = 0.5 * (keptLoHz + keptHiHz); sw.keptLoHz = keptLoHz; sw.keptHiHz = keptHiHz;
    g.addSegment(map, avg.data(), peak.data(), minv.data(), sample.data(), st, sw, nullptr, false, loHz);
}
// The little grid is 470.000-470.175 MHz. Blocks 48 MHz wide that see it from different places:
void addClear(SweepGrid& g, float a, float p, float s) { addPlaced(g, a, p, s, 482e6, 458e6, 506e6); }        // the flat part
void addAtEdge(SweepGrid& g, float a, float p, float s) { addPlaced(g, a, p, s, 494e6, 470e6, 518e6); }       // cell 0 on the edge
void addHalfTaper(SweepGrid& g, float a, float p, float s) { addPlaced(g, a, p, s, 490e6, 466e6, 514e6); }    // cell 0 is 4 of the 8 MHz taper in
void addAtLo(SweepGrid& g, float a, float p, float s) { addPlaced(g, a, p, s, 470.05e6, 446.05e6, 494.05e6); } // LO on cell 2

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

    // Two sweeps that agree, one of them measured on its LO: the LO's skirt is the receiver's own
    // noise, so that reading is worth nothing and the clear one sets the level — whichever of the two
    // sweeps it arrived in, so the output is the same on both and the level does not alternate.
    {
        SweepGrid g = makeGrid();
        g.beginSweep(); addAtLo(g, 1.5f, 3.0f, 1.6f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        g.beginSweep(); addClear(g, 1.0f, 2.0f, 1.1f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        Out o = read(g);
        CHECK_NEAR(o.avg[2], 10.0 * std::log10(1.0), 0.01);
        CHECK_NEAR(o.peak[2], 10.0 * std::log10(2.0), 0.01);
        CHECK_NEAR(o.sample[2], 10.0 * std::log10(1.1), 0.01);
        CHECK((g.mask()[2] & proto::MaskImage) == 0);
        g.beginSweep(); addAtLo(g, 1.5f, 3.0f, 1.6f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        o = read(g);
        CHECK_NEAR(o.avg[2], 10.0 * std::log10(1.0), 0.01);
        CHECK_NEAR(o.peak[2], 10.0 * std::log10(2.0), 0.01);
        CHECK_NEAR(o.sample[2], 10.0 * std::log10(1.1), 0.01);
        // The skirt tapers: cell 6, 100 kHz from that LO, is worth a third, so (1/3 x 1.5 + 1.0) / (4/3).
        CHECK_NEAR(o.avg[6], 10.0 * std::log10(1.125), 0.01);
    }

    // A block edge carries aliased noise: a reading taken on the edge gives way to a clear one too.
    {
        SweepGrid g = makeGrid();
        g.beginSweep(); addClear(g, 1.0f, 2.0f, 1.0f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        g.beginSweep(); addAtEdge(g, 1.6f, 3.2f, 1.6f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        Out o = read(g);
        CHECK_NEAR(o.avg[0], 10.0 * std::log10(1.0), 0.01);
        CHECK_NEAR(o.peak[0], 10.0 * std::log10(2.0), 0.01);
    }

    // The weight falls off smoothly towards the edge rather than switching, so the trace has no step
    // where it starts: halfway down the taper a reading counts half, (1.0 + 0.5 x 1.6) / 1.5.
    {
        SweepGrid g = makeGrid();
        g.beginSweep(); addClear(g, 1.0f, 2.0f, 1.0f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        g.beginSweep(); addHalfTaper(g, 1.6f, 3.2f, 1.6f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        Out o = read(g);
        CHECK_NEAR(o.avg[0], 10.0 * std::log10(1.2), 0.01);
    }

    // A signal reads the same anywhere in the block, so the weighting leaves it exactly where it was.
    {
        SweepGrid g = makeGrid();
        g.beginSweep(); addAtLo(g, 50.0f, 60.0f, 50.0f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        g.beginSweep(); addHalfTaper(g, 50.0f, 60.0f, 50.0f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        Out o = read(g);
        for (uint32_t c = 0; c < kCells; ++c) CHECK_NEAR(o.avg[c], 10.0 * std::log10(50.0), 0.01);
    }

    // Two readings from equally bad places are still averaged: there is nothing to choose between them.
    {
        SweepGrid g = makeGrid();
        g.beginSweep(); addAtEdge(g, 1.0f, 2.0f, 1.0f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        g.beginSweep(); addAtEdge(g, 3.0f, 6.0f, 3.0f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        Out o = read(g);
        CHECK_NEAR(o.avg[0], 10.0 * std::log10(2.0), 0.01);
        CHECK_NEAR(o.peak[0], 10.0 * std::log10(6.0), 0.01);
    }

    // The weighting only applies where the two agree. A reading more than 6 dB above the other is an
    // image wherever it was measured, and the quieter one wins even from the worse place.
    {
        SweepGrid g = makeGrid();
        g.beginSweep(); addAtLo(g, 1.0f, 2.0f, 1.5f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        g.beginSweep(); addClear(g, 100.0f, 200.0f, 150.0f); g.finalize(); g.rejectImagesAgainstPrevious(20.0);
        Out o = read(g);
        CHECK_NEAR(o.avg[2], 10.0 * std::log10(1.0), 0.01);
        CHECK_NEAR(o.peak[2], 10.0 * std::log10(2.0), 0.01);
        CHECK((g.mask()[2] & proto::MaskImage) != 0);
    }

    printf(fails ? "test_stitch: %d failure(s)\n" : "test_stitch: ok\n", fails);
    return fails ? 1 : 0;
}
