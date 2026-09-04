// engine.hpp: the sweep engine (PLAN.md 3, 4). One instance owns the USRP; threads rx / dsp / ctl / watchdog.
#pragma once
#include "cal.hpp"
#include "common.hpp"
#include "dsp.hpp"
#include "profile.hpp"
#include "protocol.hpp"
#include "ring.hpp"
#include "stitch.hpp"
#include "sweep_planner.hpp"
#include "usrp.hpp"
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>
#include <vector>

namespace scanner {

struct EngineOptions {
    std::string deviceArgs = "type=b200";
    std::string profile = "auto";      // initial profile name (plan.profile overrides)
    std::string eqDir;                 // directory with <profile>.eq.json tables (optional)
    double guardMs = 1.2;              // settle after an LO hop before capturing
    double ddcGuardMs = 0.3;           // settle after a timed DDC retune
    bool timedDdc = true;              // pre-schedule sub-window DDC retunes as timed commands
    double captureTimeoutS = 0.4;      // ctl waits this long beyond the expected capture end
    int openAttempts = 10;
    double openBackoffS = 1.0;
    bool disableWatchdogExit = false;  // tests
};

struct Chunk {
    static constexpr size_t kSamples = 16384;
    alignas(16) int16_t iq[2 * kSamples];
    uint32_t n = 0;
    double t0 = 0;
    bool overflow = false;
    bool hasTime = false;
};

struct CaptureRequest {
    uint64_t id = 0;
    uint32_t sweepId = 0;
    int loIndex = 0, loCount = 0, subIndex = 0;
    double tStartS = 0;
    size_t nSamples = 0;
    SubWindow sw;
    double loHz = 0;
    bool firstInSweep = false, lastInSweep = false, lastSubOfLo = false;
    uint16_t flags = 0;
    float gainDb = 0, kDbm = 0;
    std::shared_ptr<const SweepPlan> plan;
};

class Engine {
public:
    explicit Engine(EngineOptions opt);
    ~Engine();
    bool open(std::string& err);
    const DeviceInfo& info() const { return usrp_.info(); }
    void setFrameSink(std::function<void(std::vector<uint8_t>&&)> sink) { sink_ = std::move(sink); }
    void start();      // spawns threads; streaming begins; sweeping waits for a "start" command
    void shutdown();   // stops threads, closes the device
    void command(const nlohmann::json& cmd);            // thread-safe
    void commandLine(const std::string& jsonLine);      // parses then enqueues
    nlohmann::json statusJson();                        // thread-safe snapshot
    uint32_t completedSweeps() const { return completedSweeps_.load(); }
    bool waitSweeps(uint32_t n, double timeoutS);
    bool running() const { return running_.load(); }
    std::vector<float> lastFinePsd();                   // fine-bin PSD of the last analysed window (eqcap)
    std::shared_ptr<const SweepPlan> currentPlan() { std::lock_guard<std::mutex> lk(stateMu_); return plan_; }

private:
    void rxLoop();
    void dspLoop();
    void ctlLoop();
    void watchdogLoop();
    void handleCommands();
    void applyPlan();
    void reconfigure(const Profile& p, const PlanRequest& req);
    void plant();
    void runSweep();
    void emitStatus(const char* type = "status");
    void emitLog(LogLevel lvl, const std::string& msg);
    void emitFrame(std::vector<uint8_t>&& f);
    void pauseRx();
    void resumeRx();
    void processCapture(const CaptureRequest& r, const int16_t* iq, size_t n, SegmentStats& st);
    void emitTrace(const CaptureRequest& r, bool complete);

    EngineOptions opt_;
    Usrp usrp_;
    uhd::rx_streamer::sptr streamer_;
    std::function<void(std::vector<uint8_t>&&)> sink_;
    std::atomic<uint32_t> seq_{0};

    SpscRing<Chunk> ring_{512};
    SpscRing<CaptureRequest> requests_{4096};
    std::atomic<uint64_t> capturedId_{0};
    std::mutex capMu_; std::condition_variable capCv_;
    uint64_t nextReqId_ = 0;

    std::thread rxThread_, dspThread_, ctlThread_, wdThread_;
    std::atomic<bool> running_{false}, rxPaused_{false}, rxIdle_{true};
    std::mutex rxMu_; std::condition_variable rxCv_;
    std::atomic<uint32_t> rxTimeouts_{0}, rxConsecutiveTimeouts_{0}, rxOverflows_{0}, ringFull_{0};
    std::atomic<bool> peerClosed_{false};

    std::mutex cmdMu_; std::condition_variable cmdCv_; std::deque<nlohmann::json> cmds_;

    std::mutex stateMu_;
    PlanRequest desired_;
    std::shared_ptr<const SweepPlan> plan_;
    const Profile* activeProfile_ = nullptr;
    double activeAnalogBw_ = -1;
    std::string activeAntenna_;
    std::unique_ptr<CalModel> cal_;
    std::string calInfo_;
    EqTable eq_;
    bool planDirty_ = true, needPlant_ = true, sweepingWanted_ = false, single_ = false;
    std::vector<double> plantedCentres_;
    double gainDb_ = 50, kDbm_ = -40;
    int cleanSweeps_ = 0;
    bool gainChanged_ = false, recalFlag_ = false;
    uint32_t sweepId_ = 0;
    std::atomic<uint32_t> completedSweeps_{0};
    std::atomic<bool> sweepingNow_{false};

    Stats hopStats_, sweepStats_, ddcStats_;
    std::vector<double> hopMsRecent_;
    double lastSweepMs_ = 0, sweepsPerSec_ = 0, lastStatusS_ = 0, lastReplantS_ = 0, tempC_ = 0, lastTempS_ = 0, uptime0_ = 0;
    uint64_t captureTimeouts_ = 0, recalsInSweep_ = 0;
    std::atomic<double> lastClipFrac_{0}, lastPeakDbfs_{-300};
    std::atomic<uint32_t> lastZeroRuns_{0}, lastOverflow_{0};
    double lastTDevice_ = 0;

    std::unique_ptr<SubWindowAnalyzer> analyzer_;
    std::shared_ptr<const SweepPlan> dspPlan_;
    SweepGrid grid_;
    std::vector<int16_t> capBuf_;
    std::vector<float> avg_, peak_, minv_, sample_, dbA_, dbP_, dbM_, dbS_;
    std::mutex psdMu_; std::vector<float> lastPsd_;
};

} // namespace scanner
