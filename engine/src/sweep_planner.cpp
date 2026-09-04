#include "sweep_planner.hpp"
#include "common.hpp"
#include <algorithm>
#include <cmath>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace scanner {

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
                {"antenna", antenna}, {"interleave", interleave}, {"mode", sweepModeName(mode)},
                {"window", windowName(window)}, {"analogBwHz", analogBwHz}, {"loGridOffsetHz", loGridOffsetHz}};
}

json SweepPlan::toJson() const {
    json j = req.toJson();
    j["profile"] = prof.name; j["profileId"] = prof.id;
    j["stepHz"] = stepHz; j["binCount"] = binCount; j["fftN"] = fftN; j["dfHz"] = dfHz; j["kBins"] = kBins;
    j["nAvg"] = nAvg; j["loHops"] = grid[0].size(); j["loHopsOdd"] = grid[1].size(); j["subWindows"] = prof.subWindows;
    j["segments"] = segCentres.size(); j["gainCapDb"] = gainCapDb;
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
    if (shift != 0) M += 1;
    double covered = kept + (M - 1) * step;
    double c0 = spanLo - (covered - width) / 2 + kept / 2 + shift;
    for (int m = 0; m < M; ++m) {
        LoPosition lp;
        double c = c0 + m * step;                    // centre of the kept block
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
        if (r.gainDb > pl.gainCapDb) r.gainDb = pl.gainCapDb;
        if (r.gainDb < gMin) r.gainDb = gMin;
    } else {
        pl.gainCapDb = gMax;
        double g = clampv(std::round(in.gainDb), gMin, gMax);
        if (g != in.gainDb) warn("gainDb clamped to " + std::to_string(g));
        r.gainDb = g;
    }
    if (prof.minGainDb > 0 && r.gainDb < prof.minGainDb) { r.gainDb = prof.minGainDb; warn("profile enforces gain >= 55 dB (sc8)"); }

    // LO grids (RF coverage must include half an RBW beyond the outer cells).
    double spanLo = s0 - r.rbwHz / 2, spanHi = s1 + r.rbwHz / 2;
    int segments = 1;
    pl.grid[0] = layoutGrid(prof, spanLo, spanHi, r.loGridOffsetHz, segments, pl.segCentres);
    pl.grid[1] = layoutGrid(prof, spanLo, spanHi, r.loGridOffsetHz - prof.hopStepHz() / 2, segments, pl.segCentres);
    if (pl.segCentres.size() > 1) warn("span needs " + std::to_string(pl.segCentres.size()) + " calibration segments (in-sweep recals)");

    // Predictions (PLAN.md 4.3 constants)
    const double hopDeadMs = 6.1, ddcGuardMs = 0.3;
    double captureMs = 1e3 * double(pl.samplesPerWindow) / prof.rateHz;
    double perLo = hopDeadMs + prof.subWindows * (captureMs + ddcGuardMs) + 0.8 /* rx latency */;
    double recals = double(std::max<size_t>(0, pl.segCentres.size() - 1)) * (prof.mcrHz > 40e6 ? 55.0 : 107.0);
    pl.predictedSweepMs = perLo * pl.grid[0].size() + recals + (planChanged ? 220.0 : 0.0);
    double kEff = 0.39 * pl.kBins;
    pl.predictedSigmaDb = 4.34 / std::sqrt(pl.nAvg * std::max(1.0, kEff));
    return pl;
}

} // namespace scanner
