#include "cal.hpp"
#include <algorithm>
#include <cmath>

namespace scanner {

TableCal::TableCal(std::vector<CalPoint> pts, std::string src) : pts_(std::move(pts)), src_(std::move(src)) {
    std::sort(pts_.begin(), pts_.end(), [](const CalPoint& a, const CalPoint& b) {
        return a.freqHz < b.freqHz || (a.freqHz == b.freqHz && a.gainDb < b.gainDb);
    });
    for (auto& p : pts_) if (freqs_.empty() || freqs_.back() != p.freqHz) freqs_.push_back(p.freqHz);
}

double TableCal::kAtFreq(size_t fi, double g) const {
    double f = freqs_[fi];
    const CalPoint* lo = nullptr; const CalPoint* hi = nullptr;
    for (auto& p : pts_) {
        if (p.freqHz != f) continue;
        if (p.gainDb <= g && (!lo || p.gainDb > lo->gainDb)) lo = &p;
        if (p.gainDb >= g && (!hi || p.gainDb < hi->gainDb)) hi = &p;
    }
    if (lo && hi && hi != lo) {
        double t = (g - lo->gainDb) / (hi->gainDb - lo->gainDb);
        return lo->kDbm + t * (hi->kDbm - lo->kDbm);
    }
    // extrapolate with slope -1 dB/dB beyond the table
    if (lo) return lo->kDbm - (g - lo->gainDb);
    if (hi) return hi->kDbm + (hi->gainDb - g);
    return 10.0 - g;
}

double TableCal::kDbm(double g, double f) const {
    if (freqs_.empty()) return 10.0 - g;
    auto it = std::lower_bound(freqs_.begin(), freqs_.end(), f);
    if (it == freqs_.begin()) return kAtFreq(0, g);
    if (it == freqs_.end()) return kAtFreq(freqs_.size() - 1, g);
    size_t hi = it - freqs_.begin(), lo = hi - 1;
    double t = (f - freqs_[lo]) / (freqs_[hi] - freqs_[lo]);
    return kAtFreq(lo, g) + t * (kAtFreq(hi, g) - kAtFreq(lo, g));
}

double TableCal::gainForK(double k, double f) const {
    // K decreases monotonically with gain; bisection over 0..76.
    double lo = 0, hi = 76;
    for (int i = 0; i < 40; ++i) {
        double mid = 0.5 * (lo + hi);
        if (kDbm(mid, f) > k) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}

} // namespace scanner
