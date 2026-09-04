// sweep_planner.hpp: turns a control request into an LO / sub-window / grid plan (PLAN.md 4, 5.2, 5.3).
#pragma once
#include "cal.hpp"
#include "dsp.hpp"
#include "profile.hpp"
#include "protocol.hpp"
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace scanner {

enum class Dwell { Fast, Coordination, Hq };
enum class GainMode { Auto, Manual };
enum class SweepMode { Continuous, Single };

struct PlanRequest {
    double startHz = 470e6, stopHz = 608e6;
    double rbwHz = 25e3, vbwHz = 2.5e3;
    Dwell dwell = Dwell::Coordination;
    GainMode gainMode = GainMode::Auto;
    double gainDb = 50, refLevelDbm = -50;
    std::string profile = "auto";
    proto::Detector detector = proto::DetRms;
    std::string antenna = "RX2";
    bool interleave = false;
    SweepMode mode = SweepMode::Continuous;
    WindowType window = WindowType::BH4;
    double analogBwHz = 0;
    double loGridOffsetHz = 0;   // test hook: shifts the LO grid (milestone-1 pilot placement check)

    // Applies a JSON patch (unknown keys are reported as warnings). Returns warnings.
    std::vector<std::string> applyJson(const nlohmann::json& j);
    nlohmann::json toJson() const;
};

struct SubWindow {
    int index = 0;            // k
    double rfCentreHz = 0;    // RF at baseband 0 Hz  (= lo - dsp)
    double dspHz = 0;         // DDC shift to request (MANUAL policy)
    double keptLoHz = 0, keptHiHz = 0;
};
struct LoPosition {
    double loHz = 0;
    int segment = 0;
    std::vector<SubWindow> sub;
};

struct SweepPlan {
    Profile prof;
    PlanRequest req;                 // quantised / applied values
    double stepHz = 25e3;
    uint32_t binCount = 0;
    int fftN = 0;
    double dfHz = 0;
    int kBins = 0;                   // fine bins per cell (rounded)
    int nAvg = 1;                    // effective averages per sub-window
    size_t samplesPerWindow = 0;
    std::vector<LoPosition> grid[2]; // [0] even sweeps, [1] odd (interleaved) sweeps
    std::vector<double> segCentres;  // calibration-planting centres (one per segment)
    double gainCapDb = 60;           // from refLevel via K^-1 (auto mode)
    double predictedSweepMs = 0;
    double predictedSigmaDb = 0;
    std::vector<std::string> warnings;
    nlohmann::json toJson() const;
    const std::vector<LoPosition>& gridFor(uint32_t sweepId) const { return grid[(req.interleave && (sweepId & 1)) ? 1 : 0]; }
};

// Quantises the request and lays out the sweep. `prof` must already be resolved (auto -> concrete).
SweepPlan makePlan(const PlanRequest& req, const Profile& prof, const CalModel& cal, bool planChanged);

const char* dwellName(Dwell d);
const char* gainModeName(GainMode g);
const char* sweepModeName(SweepMode m);
const char* detectorName(proto::Detector d);
const char* windowName(WindowType w);

} // namespace scanner
