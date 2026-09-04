#include "stitch.hpp"
#include "common.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace scanner {

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
    v1_.assign(n_, 0); v2_.assign(n_, 0); pk_.assign(n_, 0); mn_.assign(n_, 0); sm_.assign(n_, 0);
    cnt_.assign(n_, 0); mask_.assign(n_, proto::MaskHole);
    if (!sameGrid) { lastAvg_.assign(n_, std::numeric_limits<float>::quiet_NaN()); lastPk_ = lastAvg_; }
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
    std::fill(mn_.begin(), mn_.end(), 0.f);
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
        if (cnt_[c] == 0) { v1_[c] = a; pk_[c] = peak[j] * g; mn_[c] = minv[j] * g; sm_[c] = sample[j] * g; }
        else { v2_[c] = a; pk_[c] = std::max(pk_[c], peak[j] * g); mn_[c] = std::min(mn_[c], minv[j] * g); }
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
            if (ratioDb > 6.f) { v1_[c] = std::min(a, b); mask_[c] |= proto::MaskImage; }
            else v1_[c] = 0.5f * (a + b);
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
