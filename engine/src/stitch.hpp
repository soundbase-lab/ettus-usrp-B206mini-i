// stitch.hpp: places sub-window results onto the output grid; spur/hole/image masks; equalisation tables.
#pragma once
#include "dsp.hpp"
#include "protocol.hpp"
#include "sweep_planner.hpp"
#include <string>
#include <vector>

namespace scanner {

struct SpurTable {
    std::vector<double> freqsHz;
    double halfWidthHz = 6e3;
    // n x 40 MHz reference harmonics and n x MCR within [lo, hi].
    static SpurTable forMcr(double mcrHz, double loHz, double hiHz);
};

// Per-profile flatness correction measured on a 50 ohm load (engine --eqcap). Indexed by sub-window k and
// cell offset from the sub-window centre. Stored as dB, applied as a linear gain.
struct EqTable {
    bool loaded = false;
    std::string profile;
    double stepHz = 25e3;
    int halfCells = 0;
    std::vector<std::vector<float>> gainLin; // [k][offset + halfCells]
    float factor(int k, int cellOffset) const {
        if (!loaded || k >= int(gainLin.size())) return 1.f;
        int i = cellOffset + halfCells;
        if (i < 0 || i >= int(gainLin[k].size())) return 1.f;
        return gainLin[k][i];
    }
    static EqTable load(const std::string& path);
    bool save(const std::string& path) const;
};

class SweepGrid {
public:
    void configure(double startHz, double stepHz, uint32_t binCount, double rbwHz, const SpurTable& spurs);
    void beginSweep();
    // Adds one analysed sub-window. Arrays are per map cell (linear power).
    void addSegment(const CellMap& map, const float* avg, const float* peak, const float* minv, const float* sample,
                    const SegmentStats& st, const SubWindow& sw, const EqTable* eq, bool loHole, double loHz);
    // Cells [0, filledBins) have data (or are known holes) so far; used for partial frames.
    uint32_t filledBins() const { return filled_; }
    // Resolves overlaps, applies the image heuristic, masks spurs, fills holes from the previous sweep.
    void finalize();
    // dB output (dBFS); NaN where no data at all. upTo = number of leading cells to convert.
    void toDb(float* avgDb, float* peakDb, float* minDb, float* sampleDb, uint32_t upTo) const;
    const uint8_t* mask() const { return mask_.data(); }
    uint32_t binCount() const { return n_; }
    bool overflowSeen() const { return overflow_; }
    bool clipped() const { return clipFrac_ > 1e-4 || peakDbfs_ > -3.0; }
    double clipFraction() const { return clipFrac_; }
    double peakDbfs() const { return peakDbfs_; }
    uint32_t zeroRuns() const { return zeroRuns_; }
private:
    double start_ = 0, step_ = 25e3, rbw_ = 25e3;
    uint32_t n_ = 0, filled_ = 0;
    std::vector<float> v1_, v2_, pk_, mn_, sm_;   // per cell: first/second overlapping avg, peak, min, sample
    std::vector<uint8_t> cnt_, mask_;
    std::vector<float> lastAvg_, lastPk_;           // last valid values (hole fill across sweeps)
    std::vector<uint32_t> spurCells_;
    bool overflow_ = false; double clipFrac_ = 0, peakDbfs_ = -300; uint64_t clipN_ = 0, sampN_ = 0; uint32_t zeroRuns_ = 0;
};

} // namespace scanner
