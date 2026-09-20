#include "sweep_planner.hpp"
#include "common.hpp"
#include <algorithm>
#include <cmath>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace scanner {

// Auto gain starts here (or at the cap if lower) and creeps +3 dB per 3 clean sweeps. Measured 2026-09-10 on a bare
// antenna next to strong DTV: starting at the 50 dB cap clipped for ~10 sweeps (peak 0 dBFS) before settling at 23-26 dB.
constexpr double kAutoGainStartDb = 30.0;
// Minimum distance between any LO and an internal spur (n x 40 MHz reference harmonic or n x MCR).
constexpr double kLoSpurClearHz = 2.5e6;

double spurDistanceHz(double loHz, double mcrHz) {
    double d = 1e300;
    for (double f : {40e6, mcrHz}) {
        double n = std::round(loHz / f);
        d = std::min(d, std::fabs(loHz - n * f));
    }
    return d;
}

const char* dwellName(Dwell d) { return d == Dwell::Fast ? "fast" : d == Dwell::Hq ? "hq" : "coordination"; }
const char* gainModeName(GainMode g) { return g == GainMode::Auto ? "auto" : "manual"; }
const char* sweepModeName(SweepMode m) { return m == SweepMode::Single ? "single" : "continuous"; }
const char* detectorName(proto::Detector d) {
    switch (d) { case proto::DetPeak: return "peak"; case proto::DetSample: return "sample"; case proto::DetMin: return "min"; default: return "rms"; }
}
const char* windowName(WindowType w) { return w == WindowType::Hann ? "hann" : "bh4"; }

std::vector<std::string> PlanRequest::applyJson(const json& j) {
    std::vector<std::string> warn;
    if (!j.is_object()) { warn.push_back("plan must be an object"); return warn; }
    for (auto& [k, v] : j.items()) {
        try {
            if (k == "startHz") startHz = v.get<double>();
            else if (k == "stopHz") stopHz = v.get<double>();
            else if (k == "rbwHz") rbwHz = v.get<double>();
            else if (k == "vbwHz") vbwHz = v.get<double>();
            else if (k == "gainDb") gainDb = v.get<double>();
            else if (k == "refLevelDbm") refLevelDbm = v.get<double>();
            else if (k == "profile") profile = v.get<std::string>();
            else if (k == "antenna") antenna = v.get<std::string>();
            else if (k == "interleave") interleave = v.get<bool>();
            else if (k == "imageReject") imageReject = v.get<bool>();
            else if (k == "analogBwHz") analogBwHz = v.get<double>();
            else if (k == "loGridOffsetHz") loGridOffsetHz = v.get<double>();
            else if (k == "dwell") { auto s = v.get<std::string>(); dwell = s == "fast" ? Dwell::Fast : s == "hq" ? Dwell::Hq : Dwell::Coordination; }
            else if (k == "gainMode") gainMode = v.get<std::string>() == "manual" ? GainMode::Manual : GainMode::Auto;
            else if (k == "mode") mode = v.get<std::string>() == "single" ? SweepMode::Single : SweepMode::Continuous;
            else if (k == "window") window = v.get<std::string>() == "hann" ? WindowType::Hann : WindowType::BH4;
            else if (k == "detector") {
                auto s = v.get<std::string>();
                detector = s == "peak" ? proto::DetPeak : s == "sample" ? proto::DetSample : s == "min" ? proto::DetMin : proto::DetRms;
            } else warn.push_back("unknown plan field '" + k + "' ignored");
        } catch (std::exception& e) { warn.push_back("bad value for '" + k + "': " + e.what()); }
    }
    return warn;
}

json PlanRequest::toJson() const {
    return json{{"startHz", startHz}, {"stopHz", stopHz}, {"rbwHz", rbwHz}, {"vbwHz", vbwHz},
                {"dwell", dwellName(dwell)}, {"gainMode", gainModeName(gainMode)}, {"gainDb", gainDb},
                {"refLevelDbm", refLevelDbm}, {"profile", profile}, {"detector", detectorName(detector)},
                {"antenna", antenna}, {"interleave", interleave}, {"imageReject", imageReject}, {"mode", sweepModeName(mode)},
                {"window", windowName(window)}, {"analogBwHz", analogBwHz}, {"loGridOffsetHz", loGridOffsetHz}};
}

json SweepPlan::toJson() const {
    json j = req.toJson();
    j["profile"] = prof.name; j["profileId"] = prof.id;
    j["stepHz"] = stepHz; j["binCount"] = binCount; j["fftN"] = fftN; j["dfHz"] = dfHz; j["kBins"] = kBins;
    j["nAvg"] = nAvg; j["loHops"] = grid[0].size(); j["loHopsOdd"] = grid[1].size(); j["subWindows"] = prof.subWindows;
    j["segments"] = segCentres.size(); j["gainCapDb"] = gainCapDb; j["gainStartDb"] = gainStartDb; j["loGridAutoShiftHz"] = loGridAutoShiftHz;
    j["predictedSweepMs"] = predictedSweepMs; j["predictedSigmaDb"] = predictedSigmaDb;
    j["mcrHz"] = prof.mcrHz; j["rateHz"] = prof.rateHz;
    return j;
}

static std::vector<LoPosition> layoutGrid(const Profile& p, double spanLo, double spanHi, double shift, int& segments,
                                          std::vector<double>& segCentres) {
    std::vector<LoPosition> out;
    const double kept = p.keptHz, step = p.hopStepHz(), W = p.subWidthHz();
    const int K = p.subWindows;
    double width = spanHi - spanLo;
    int M = std::max(1, int(std::ceil((width - kept) / step - 1e-9)) + 1);
    double covered = kept + (M - 1) * step;
    double c0 = spanLo - (covered - width) / 2 + kept / 2;   // unshifted grid, centred on the span
    // Shifted grids (interleave = half a step, or the loGridOffsetHz test hook) keep the same pitch and add a
    // position at either end as needed; end positions whose neighbour already covers the span edge are dropped.
    // (Previously the shifted grid was re-centred with M + 1 positions, which moved it by exactly one full step:
    // odd sweeps reused the even LO frequencies plus one wasted hop below the span, so nothing was interleaved.)
    std::vector<double> centres;
    for (int m = -1; m <= M; ++m) centres.push_back(c0 + shift + m * step);
    while (centres.size() > 1 && centres[1] - kept / 2 <= spanLo + 1e-6) centres.erase(centres.begin());
    while (centres.size() > 1 && centres[centres.size() - 2] + kept / 2 >= spanHi - 1e-6) centres.pop_back();
    for (double c : centres) {                       // c = centre of the kept block
        LoPosition lp;
        lp.loHz = (K == 1) ? c + p.loOffsetHz : c;   // K>1: LO at the block centre (a sub-window boundary)
        for (int k = 0; k < K; ++k) {
            SubWindow sw; sw.index = k;
            double off = (k - (K - 1) / 2.0) * W;    // sub-window centre offset from block centre
            sw.rfCentreHz = c + off;
            sw.dspHz = lp.loHz - sw.rfCentreHz;      // RX: baseband centre = rf - dsp
            sw.keptLoHz = sw.rfCentreHz - W / 2; sw.keptHiHz = sw.rfCentreHz + W / 2;
            lp.sub.push_back(sw);
        }
        out.push_back(lp);
    }
    // Segments: LO travel <= 200 MHz per planted calibration point.
    if (!out.empty()) {
        double loMin = out.front().loHz, loMax = out.back().loHz;
        segments = std::max(1, int(std::ceil((loMax - loMin) / 200e6 - 1e-9)));
        if (segCentres.empty()) {
            double segW = (loMax - loMin) / segments;
            for (int s = 0; s < segments; ++s) segCentres.push_back(loMin + segW * (s + 0.5));
        }
        for (auto& lp : out) {
            int best = 0; double bd = 1e300;
            for (size_t s = 0; s < segCentres.size(); ++s) { double d = std::fabs(lp.loHz - segCentres[s]); if (d < bd) { bd = d; best = int(s); } }
            lp.segment = best;
        }
    }
    return out;
}

SweepPlan makePlan(const PlanRequest& in, const Profile& prof, const CalModel& cal, bool planChanged) {
    SweepPlan pl; pl.prof = prof; pl.req = in;
    auto& r = pl.req;
    auto warn = [&](const std::string& s) { pl.warnings.push_back(s); };

    // RBW: 1 kHz .. 1 MHz, must leave >= 7 fine bins in the FFT.
    r.rbwHz = clampv(r.rbwHz, 1e3, 1e6);
    pl.stepHz = std::min(25e3, r.rbwHz);
    // span on the grid: start snapped down, stop snapped up, at least 2 cells
    double s0 = std::floor(in.startHz / pl.stepHz + 1e-9) * pl.stepHz;
    double s1 = std::ceil(in.stopHz / pl.stepHz - 1e-9) * pl.stepHz;
    if (s1 <= s0) s1 = s0 + pl.stepHz;
    s0 = clampv(s0, 70e6, 6e9); s1 = clampv(s1, 70e6 + pl.stepHz, 6e9);
    if (s0 != in.startHz) warn("startHz snapped to " + std::to_string(s0 / 1e6) + " MHz");
    if (s1 != in.stopHz) warn("stopHz snapped to " + std::to_string(s1 / 1e6) + " MHz");
    r.startHz = s0; r.stopHz = s1;
    pl.binCount = uint32_t(std::llround((s1 - s0) / pl.stepHz)) + 1;

    // FFT size and averaging
    pl.fftN = Fft::chooseSize(prof.rateHz, r.rbwHz);
    pl.dfHz = prof.rateHz / pl.fftN;
    pl.kBins = std::max(1, int(std::lround(r.rbwHz / pl.dfHz)));
    if (r.vbwHz <= 0) r.vbwHz = r.rbwHz / 10;
    r.vbwHz = clampv(r.vbwHz, r.rbwHz / 1000, r.rbwHz);
    int nAvg = clampv(int(std::lround(r.rbwHz / r.vbwHz)), 1, 1000);
    double dwellS = r.dwell == Dwell::Fast ? 0 : r.dwell == Dwell::Hq ? 0.025 : 0.010;
    int nDwell = int(std::ceil((dwellS * prof.rateHz - pl.fftN) / (pl.fftN / 2.0))) + 1;
    pl.nAvg = std::max(nAvg, std::max(1, nDwell));
    pl.samplesPerWindow = samplesNeeded(pl.fftN, pl.nAvg);

    // Gain
    double gMin = std::max(0.0, prof.minGainDb), gMax = 76;
    if (r.gainMode == GainMode::Auto) {
        double cap = cal.gainForK(r.refLevelDbm + 10.0, 0.5 * (s0 + s1));
        pl.gainCapDb = clampv(std::round(cap), gMin, std::min(gMax, 60.0));
        pl.gainStartDb = std::min(pl.gainCapDb, kAutoGainStartDb);
        if (r.gainDb > pl.gainCapDb) r.gainDb = pl.gainCapDb;
        if (r.gainDb < gMin) r.gainDb = gMin;
    } else {
        pl.gainCapDb = gMax; pl.gainStartDb = gMax;
        double g = clampv(std::round(in.gainDb), gMin, gMax);
        if (g != in.gainDb) warn("gainDb clamped to " + std::to_string(g));
        r.gainDb = g;
    }
    if (prof.minGainDb > 0 && r.gainDb < prof.minGainDb) { r.gainDb = prof.minGainDb; warn("profile enforces gain >= 55 dB (sc8)"); }

    // LO grids (RF coverage must include half an RBW beyond the outer cells).
    double spanLo = s0 - r.rbwHz / 2, spanHi = s1 + r.rbwHz / 2;
    int segments = 1;
    // Keep every LO clear of the internal spur frequencies (n x 40 MHz reference, n x MCR). An LO parked just below
    // one of them shows intermittent 0.6-0.8 MHz bursts between the LO and the spur (measured 2026-09-10 on
    // usb3-56: LO 519.15 vs 520.0 MHz in 1 sweep of 13, LO 614.55 vs 616.0 MHz). The grid is centred on the span
    // with slack, so a small shift is usually free; beyond the slack it costs one hop.
    auto minSpurDist = [&](double shift) {
        int segs = 1; std::vector<double> centres; double m = 1e300;
        for (int parity = 0; parity < 2; ++parity)
            for (auto& lp : layoutGrid(prof, spanLo, spanHi, shift - (parity ? prof.hopStepHz() / 2 : 0), segs, centres))
                m = std::min(m, spurDistanceHz(lp.loHz, prof.mcrHz));
        return m;
    };
    double shift = r.loGridOffsetHz, best = minSpurDist(shift);
    if (best < kLoSpurClearHz) {
        // Smallest shift that reaches the clearance; failing that, the shift with the largest minimum distance.
        // Shifts within the grid's slack are free (same hop count); larger ones add a hop and are only tried
        // when the free range cannot get every LO at least 1 MHz clear.
        const int M = std::max(1, int(std::ceil(((spanHi - spanLo) - prof.keptHz) / prof.hopStepHz() - 1e-9)) + 1);
        const double slack = prof.keptHz + (M - 1) * prof.hopStepHz() - (spanHi - spanLo);
        for (double limit : {slack / 2, prof.hopStepHz() / 2}) {
            for (double s = 0.5e6; s <= limit + 1e-6 && best < kLoSpurClearHz; s += 0.5e6)
                for (double cand : {s, -s}) {
                    double d = minSpurDist(shift + cand);
                    if (d > best + 1e-3) { best = d; pl.loGridAutoShiftHz = cand; if (best >= kLoSpurClearHz) break; }
                }
            if (best >= 1e6) break;
        }
        shift += pl.loGridAutoShiftHz;
        char buf[160];
        snprintf(buf, sizeof buf, "LO grid shifted %+.1f MHz to keep LOs clear of internal spurs (nearest %.2f MHz)", pl.loGridAutoShiftHz / 1e6, best / 1e6);
        warn(buf);
    }
    pl.grid[0] = layoutGrid(prof, spanLo, spanHi, shift, segments, pl.segCentres);
    pl.grid[1] = layoutGrid(prof, spanLo, spanHi, shift - prof.hopStepHz() / 2, segments, pl.segCentres);
    if (pl.segCentres.size() > 1) warn("span needs " + std::to_string(pl.segCentres.size()) + " calibration segments (in-sweep recals)");

    // Predictions (PLAN.md 4.3 constants)
    const double hopDeadMs = 6.1, ddcGuardMs = 0.3;
    double captureMs = 1e3 * double(pl.samplesPerWindow) / prof.rateHz;
    double perLo = hopDeadMs + prof.subWindows * (captureMs + ddcGuardMs) + 0.8 /* rx latency */;
    double recals = double(std::max<size_t>(0, pl.segCentres.size() - 1)) * (prof.mcrHz > 40e6 ? 55.0 : 107.0);
    // Alternating grids: the cost per sweep is the mean of the two, since they differ by a hop.
    const double hopsPerSweep = r.imageReject ? 0.5 * double(pl.grid[0].size() + pl.grid[1].size())
                                              : double(pl.grid[0].size());
    pl.predictedSweepMs = perLo * hopsPerSweep + recals + (planChanged ? 220.0 : 0.0);
    double kEff = 0.39 * pl.kBins;
    pl.predictedSigmaDb = 4.34 / std::sqrt(pl.nAvg * std::max(1.0, kEff));
    return pl;
}

} // namespace scanner
