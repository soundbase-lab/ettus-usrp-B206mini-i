#include "stitch.hpp"
#include "common.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace scanner {

namespace {
// How much a reading is worth depends on where in its block the cell was measured. A block reads a
// noise floor that is not the input's in two places, and both grow as the gain falls and the floor
// sinks towards the ADC's own: beside the LO, whose residue leaves a narrow skirt either side of the
// blanked centre cell, and towards the block edges, where noise aliased past the decimation filter
// lifts the floor in a smooth bowl. Measured 2026-10-03 on a B206mini, usb3-56 (48 MHz kept),
// 70-1000 MHz, floor relative to the flat part of the block:
//
//   offset from the LO     gain 30 dB   gain 20 dB   gain 10 dB
//   +-25 kHz                              +1.8 dB      +2.3 dB
//   +-100 kHz                             +0.6 dB      +0.8 dB
//   +-300 kHz                             +0.1 dB      +0.1 dB
//   0.5 .. 8 MHz             0.0 dB       0.0 dB       0.0 dB
//   +-16 MHz                +0.1 dB      +0.3 dB      +0.5 dB
//   +-20 MHz                +0.2 dB      +0.8 dB      +1.3 dB
//   +-22 MHz                +0.3 dB      +1.7 dB      +2.2 dB
//   +-24 MHz (the edge)     +0.5 dB      +2.0 dB      +3.4 dB
//
// It is added noise, not gain: a signal reads the same anywhere in the block. So when two LO grids
// have measured a cell, a weighted mean leaves signals exact while letting the cleaner reading set
// the floor. Averaging them equally left a ripple at the LO pitch — 1.3 dB at 20 dB gain.
constexpr double kLoSkirtHz = 300e3;            // the skirt is a property of the LO: a width in Hz
constexpr double kEdgeTaperFraction = 1.0 / 6;  // the bowl scales with the block: its outer 8 MHz of 48
constexpr float kMinWeight = 1e-3f;             // two readings from equally bad places still average

// 1 in the flat part of the block, falling to nearly nothing at the LO and at either edge.
float readingWeight(double fc, double loHz, const SubWindow& sw) {
    const double taperHz = kEdgeTaperFraction * (sw.keptHiHz - sw.keptLoHz);
    const double edge = taperHz > 0 ? std::clamp(std::min(fc - sw.keptLoHz, sw.keptHiHz - fc) / taperHz, 0.0, 1.0) : 1.0;
    const double lo = std::clamp(std::fabs(fc - loHz) / kLoSkirtHz, 0.0, 1.0);
    return std::max(kMinWeight, float(edge * lo));
}
} // namespace

SpurTable SpurTable::forMcr(double mcr, double lo, double hi) {
    SpurTable t;
    for (double f = std::ceil(lo / 40e6) * 40e6; f <= hi; f += 40e6) t.freqsHz.push_back(f);
    for (double f = std::ceil(lo / mcr) * mcr; f <= hi; f += mcr)
        if (std::find(t.freqsHz.begin(), t.freqsHz.end(), f) == t.freqsHz.end()) t.freqsHz.push_back(f);
    std::sort(t.freqsHz.begin(), t.freqsHz.end());
    return t;
}

EqTable EqTable::load(const std::string& path) {
    EqTable t;
    std::ifstream f(path);
    if (!f) return t;
    try {
        json j; f >> j;
        t.profile = j.value("profile", ""); t.stepHz = j.value("stepHz", 25e3); t.halfCells = j.value("halfCells", 0);
        for (auto& row : j.at("tablesDb")) {
            std::vector<float> g;
            for (double db : row) g.push_back(float(dbToLin(-db)));
            t.gainLin.push_back(std::move(g));
        }
        t.loaded = !t.gainLin.empty();
    } catch (std::exception& e) { LOGW("eq table %s unreadable: %s", path.c_str(), e.what()); }
    return t;
}

bool EqTable::save(const std::string& path) const {
    json j; j["profile"] = profile; j["stepHz"] = stepHz; j["halfCells"] = halfCells;
    json rows = json::array();
    for (auto& g : gainLin) { json r = json::array(); for (float v : g) r.push_back(-linToDb(v)); rows.push_back(r); }
    j["tablesDb"] = rows;
    std::ofstream f(path); if (!f) return false; f << j.dump(1); return true;
}

void SweepGrid::configure(double startHz, double stepHz, uint32_t binCount, double rbwHz, const SpurTable& spurs) {
    bool sameGrid = (start_ == startHz && step_ == stepHz && n_ == binCount);
    start_ = startHz; step_ = stepHz; n_ = binCount; rbw_ = rbwHz;
    v1_.assign(n_, 0); v2_.assign(n_, 0); pk_.assign(n_, 0); pk2_.assign(n_, 0);
    mn_.assign(n_, 0); sm_.assign(n_, 0); sm2_.assign(n_, 0);
    cnt_.assign(n_, 0); mask_.assign(n_, proto::MaskHole);
    wt_.assign(n_, 1.f); prevWt_.assign(n_, 1.f);
    if (!sameGrid) { lastAvg_.assign(n_, std::numeric_limits<float>::quiet_NaN()); lastPk_ = lastAvg_; }
    // A new grid invalidates the sliding comparison: the cells no longer mean the same frequencies.
    prevAvg_.assign(n_, 0); prevPk_.assign(n_, 0); prevSm_.assign(n_, 0); prevOk_.assign(n_, 0);
    havePrev_ = false;
    spurCells_.clear();
    for (double fs : spurs.freqsHz) {
        long jLo = long(std::ceil((fs - spurs.halfWidthHz - rbw_ / 2 - start_) / step_));
        long jHi = long(std::floor((fs + spurs.halfWidthHz + rbw_ / 2 - start_) / step_));
        for (long j = std::max(0L, jLo); j <= std::min<long>(n_ - 1, jHi); ++j) spurCells_.push_back(uint32_t(j));
    }
    filled_ = 0;
}

void SweepGrid::beginSweep() {
    std::fill(cnt_.begin(), cnt_.end(), 0);
    std::fill(mask_.begin(), mask_.end(), proto::MaskHole);
    std::fill(pk_.begin(), pk_.end(), 0.f);
    std::fill(pk2_.begin(), pk2_.end(), 0.f);
    std::fill(mn_.begin(), mn_.end(), 0.f);
    std::fill(wt_.begin(), wt_.end(), 1.f);
    filled_ = 0; overflow_ = false; clipFrac_ = 0; peakDbfs_ = -300; clipN_ = 0; sampN_ = 0; zeroRuns_ = 0;
}

void SweepGrid::addSegment(const CellMap& map, const float* avg, const float* peak, const float* minv, const float* sample,
                           const SegmentStats& st, const SubWindow& sw, const EqTable* eq, bool loHole, double loHz) {
    if (st.overflow) overflow_ = true;
    if (st.zeroRunMax >= kZeroRunLimit) zeroRuns_++;
    clipN_ += st.clipCount; sampN_ += st.sampleCount;
    if (sampN_) clipFrac_ = double(clipN_) / double(sampN_);
    if (st.peakAbs > 0) peakDbfs_ = std::max(peakDbfs_, 20.0 * std::log10(st.peakAbs / 32768.0));
    const bool segClip = st.clipCount > 0;
    for (uint32_t j = 0; j < map.nCells; ++j) {
        uint32_t c = map.firstCell + j;
        if (c >= n_) break;
        if (!st.valid) { mask_[c] |= proto::MaskOverflow; continue; }
        double fc = start_ + c * step_;
        if (loHole && std::fabs(fc - loHz) <= 10e3 + rbw_ / 2) { mask_[c] |= proto::MaskLoHole; continue; }
        int off = int(std::lround((fc - sw.rfCentreHz) / step_));
        float g = eq ? eq->factor(sw.index, off) : 1.f;
        float a = avg[j] * g;
        const float w = readingWeight(fc, loHz, sw);
        if (cnt_[c] == 0) { v1_[c] = a; pk_[c] = peak[j] * g; mn_[c] = minv[j] * g; sm_[c] = sample[j] * g; wt_[c] = w; }
        // The min detector is combined here because min is already the image-rejecting choice.
        else { v2_[c] = a; pk2_[c] = peak[j] * g; sm2_[c] = sample[j] * g; mn_[c] = std::min(mn_[c], minv[j] * g); wt_[c] = std::min(wt_[c], w); }
        if (cnt_[c] < 2) cnt_[c]++;
        mask_[c] &= uint8_t(~proto::MaskHole);
        if (segClip) mask_[c] |= proto::MaskClip;
    }
    // Filled prefix: cells up to the last one touched by this segment (left-to-right progress).
    uint32_t hi = std::min(n_, map.firstCell + map.nCells);
    if (hi > filled_) filled_ = hi;
}

void SweepGrid::finalize() {
    filled_ = n_;
    for (uint32_t c = 0; c < n_; ++c) {
        if (cnt_[c] == 2) {
            float a = v1_[c], b = v2_[c];
            float ratioDb = std::fabs(linToDb(a) - linToDb(b));
            if (ratioDb > 6.f) {
                // Two measurements of one cell that disagree: one of them is carrying an image or a
                // spur, and it is the louder one. Take the quieter measurement whole — its peak and
                // sample too, or a rejected image would survive in the other detectors.
                if (b < a) { v1_[c] = b; pk_[c] = pk2_[c]; sm_[c] = sm2_[c]; }
                mask_[c] |= proto::MaskImage;
            } else {
                v1_[c] = 0.5f * (a + b);
                pk_[c] = std::max(pk_[c], pk2_[c]);
            }
            cnt_[c] = 1; // merged
        }
    }
    // Internal spurs: replace by neighbours' mean, flag.
    for (uint32_t c : spurCells_) {
        if (c >= n_) continue;
        uint32_t l = c, r = c;
        while (l > 0 && std::find(spurCells_.begin(), spurCells_.end(), l) != spurCells_.end()) l--;
        while (r + 1 < n_ && std::find(spurCells_.begin(), spurCells_.end(), r) != spurCells_.end()) r++;
        bool okL = cnt_[l] > 0 && l != c, okR = cnt_[r] > 0 && r != c;
        float fill = okL && okR ? 0.5f * (v1_[l] + v1_[r]) : okL ? v1_[l] : okR ? v1_[r] : v1_[c];
        float fillPk = okL && okR ? std::max(pk_[l], pk_[r]) : okL ? pk_[l] : okR ? pk_[r] : pk_[c];
        if (cnt_[c] == 0) cnt_[c] = 1;
        v1_[c] = fill; pk_[c] = fillPk; mn_[c] = fill; sm_[c] = fill;
        mask_[c] |= proto::MaskSpur | proto::MaskInterp;
        mask_[c] &= uint8_t(~proto::MaskHole);
    }
    // Holes (no data, LO hole, overflow): fill from the previous sweep when available.
    for (uint32_t c = 0; c < n_; ++c) {
        if (cnt_[c] == 0) {
            if (!std::isnan(lastAvg_[c])) { v1_[c] = lastAvg_[c]; pk_[c] = lastPk_[c]; mn_[c] = lastAvg_[c]; sm_[c] = lastAvg_[c]; mask_[c] |= proto::MaskInterp; mask_[c] &= uint8_t(~proto::MaskHole); }
            else mask_[c] |= proto::MaskHole;
        } else { lastAvg_[c] = v1_[c]; lastPk_[c] = pk_[c]; }
    }
}

void SweepGrid::rejectImagesAgainstPrevious(double referenceDb) {
    // A cell counts as measured only if it holds real data: hole fill and spur fill are inventions
    // and comparing against them would reject honest signal.
    constexpr uint8_t kNotMeasured = proto::MaskHole | proto::MaskInterp | proto::MaskLoHole;
    std::vector<float> curAvg(v1_.begin(), v1_.begin() + n_);
    std::vector<float> curPk(pk_.begin(), pk_.begin() + n_);
    std::vector<float> curSm(sm_.begin(), sm_.begin() + n_);
    std::vector<uint8_t> curOk(n_, 0);
    for (uint32_t c = 0; c < n_; ++c) curOk[c] = (mask_[c] & kNotMeasured) ? 0 : 1;

    const bool comparable = havePrev_ && std::fabs(referenceDb - prevRefDb_) < 0.01;
    if (comparable) {
        for (uint32_t c = 0; c < n_; ++c) {
            if (!curOk[c] || !prevOk_[c]) continue;
            const float a = curAvg[c], b = prevAvg_[c];
            if (!(a > 0) || !(b > 0)) continue;
            if (std::fabs(linToDb(a) - linToDb(b)) > 6.f) {
                if (b < a) { v1_[c] = b; pk_[c] = prevPk_[c]; sm_[c] = prevSm_[c]; }
                mask_[c] |= proto::MaskImage;
            } else {
                // The two agree, so both are honest about the signal: take their mean, weighted by
                // how clean a place in its block each was measured at. The weights depend only on
                // the cell and the grid, so the mix is the same on every sweep — doing this on every
                // sweep rather than only on some is what keeps the level steady, and alternating
                // between the two grids' own responses is what a moving floor looks like.
                const float wa = wt_[c], wb = prevWt_[c];
                v1_[c] = (wa * a + wb * b) / (wa + wb);
                // Peak and sample are single readings, not means: from the better-placed sweep when
                // one clearly is, and otherwise the louder peak as before.
                if (wb > 2 * wa) { pk_[c] = prevPk_[c]; sm_[c] = prevSm_[c]; }
                else if (!(wa > 2 * wb)) pk_[c] = std::max(curPk[c], prevPk_[c]);
            }
        }
    }
    prevAvg_.swap(curAvg); prevPk_.swap(curPk); prevSm_.swap(curSm); prevOk_.swap(curOk);
    prevWt_ = wt_;
    prevRefDb_ = referenceDb; havePrev_ = true;
}

void SweepGrid::toDb(float* a, float* p, float* m, float* s, uint32_t upTo) const {
    const float nan = std::numeric_limits<float>::quiet_NaN();
    upTo = std::min(upTo, n_);
    for (uint32_t c = 0; c < upTo; ++c) {
        bool has = cnt_[c] > 0 || (mask_[c] & proto::MaskInterp);
        if (!has) { a[c] = p[c] = m[c] = s[c] = nan; continue; }
        float v = cnt_[c] == 2 ? 0.5f * (v1_[c] + v2_[c]) : v1_[c]; // cnt==2 only before finalize()
        a[c] = linToDb(v); p[c] = linToDb(pk_[c]); m[c] = linToDb(mn_[c]); s[c] = linToDb(sm_[c]);
    }
}

} // namespace scanner
