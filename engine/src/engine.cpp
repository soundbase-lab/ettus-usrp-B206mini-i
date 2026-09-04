#include "engine.hpp"
#include "cal_uhd.hpp"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <uhd/utils/thread.hpp>
#include <unistd.h>

using json = nlohmann::json;

namespace scanner {

Engine::Engine(EngineOptions opt) : opt_(std::move(opt)) {
    cal_ = std::make_unique<DefaultCal>();
    calInfo_ = "default K(g) = 10 - g";
    desired_.profile = opt_.profile;
    uptime0_ = nowS();
}

Engine::~Engine() { shutdown(); }

bool Engine::open(std::string& err) {
    std::string args = deviceArgsFor(opt_.deviceArgs);
    if (!usrp_.open(args, opt_.openAttempts, opt_.openBackoffS, err)) return false;
    const DeviceInfo inf = usrp_.readInfo();
    LOGI("B2xx serial=%s usb=%d link=%.0f MB/s fpga=%s fw=%s antennas=%zu", inf.serial.c_str(), inf.usbVersion,
         inf.linkMaxRateBps / 1e6, inf.fpgaVersion.c_str(), inf.fwVersion.c_str(), inf.antennas.size());
    std::string calInfo;
    if (auto c = loadUhdCal(inf.serial, desired_.antenna, calInfo)) { cal_ = std::move(c); }
    calInfo_ = calInfo;
    LOGI("calibration: %s", calInfo_.c_str());
    return true;
}

void Engine::start() {
    if (running_) return;
    running_ = true;
    ctlThread_ = std::thread([this] { ctlLoop(); });
    dspThread_ = std::thread([this] { dspLoop(); });
    wdThread_ = std::thread([this] { watchdogLoop(); });
}

void Engine::shutdown() {
    if (!running_.exchange(false)) return;
    cmdCv_.notify_all(); capCv_.notify_all(); rxCv_.notify_all();
    if (ctlThread_.joinable()) ctlThread_.join();
    if (rxThread_.joinable()) rxThread_.join();
    if (dspThread_.joinable()) dspThread_.join();
    if (wdThread_.joinable()) wdThread_.join();
    streamer_.reset();
    usrp_.close();
}

void Engine::command(const json& cmd) {
    { std::lock_guard<std::mutex> lk(cmdMu_); cmds_.push_back(cmd); }
    cmdCv_.notify_all();
}

void Engine::commandLine(const std::string& line) {
    try { command(json::parse(line)); }
    catch (std::exception& e) { emitLog(LogLevel::Warn, std::string("bad command json: ") + e.what()); }
}

void Engine::emitFrame(std::vector<uint8_t>&& f) {
    proto::put32(f, 12, seq_.fetch_add(1));
    if (sink_) sink_(std::move(f));
}

void Engine::emitLog(LogLevel lvl, const std::string& msg) {
    const char* l = lvl == LogLevel::Error ? "error" : lvl == LogLevel::Warn ? "warn" : "info";
    json j{{"type", "log"}, {"level", l}, {"msg", msg}, {"tS", nowS()}};
    emitFrame(proto::makeJsonFrame(proto::LogJson, j.dump(), 0, lastTDevice_, activeProfile_ ? activeProfile_->id : 0));
}

// ------------------------------------------------------------------ rx thread

void Engine::rxLoop() {
    uhd::set_thread_priority_safe(1.0, true);
    std::vector<int16_t> scratch(2 * Chunk::kSamples);
    uhd::rx_metadata_t md;
    while (running_) {
        if (rxPaused_) {
            rxIdle_ = true;
            std::unique_lock<std::mutex> lk(rxMu_);
            rxCv_.wait_for(lk, std::chrono::milliseconds(20));
            continue;
        }
        rxIdle_ = false;
        auto s = streamer_;
        if (!s) { std::this_thread::sleep_for(std::chrono::milliseconds(5)); continue; }
        Chunk* c = ring_.beginWrite();
        int16_t* dst = c ? c->iq : scratch.data();
        size_t n = s->recv(dst, Chunk::kSamples, md, 0.5, false);
        if (md.error_code == uhd::rx_metadata_t::ERROR_CODE_TIMEOUT) {
            rxTimeouts_++; rxConsecutiveTimeouts_++;
            continue;
        }
        rxConsecutiveTimeouts_ = 0;
        bool ovf = md.error_code == uhd::rx_metadata_t::ERROR_CODE_OVERFLOW;
        if (ovf) rxOverflows_++;
        if (md.error_code != uhd::rx_metadata_t::ERROR_CODE_NONE && !ovf) {
            LOGW("rx error: %s", md.strerror().c_str());
            if (md.error_code == uhd::rx_metadata_t::ERROR_CODE_BROKEN_CHAIN || md.error_code == uhd::rx_metadata_t::ERROR_CODE_ALIGNMENT) continue;
        }
        if (!c) { ringFull_++; continue; }
        if (n == 0 && !ovf) continue;
        c->n = uint32_t(n); c->t0 = md.time_spec.get_real_secs(); c->hasTime = md.has_time_spec; c->overflow = ovf;
        ring_.commitWrite();
    }
    rxIdle_ = true;
}

void Engine::pauseRx() {
    if (!rxThread_.joinable()) return;
    if (streamer_) { try { usrp_.streamStop(streamer_); } catch (std::exception& e) { LOGW("stream stop: %s", e.what()); } }
    rxPaused_ = true;
    auto t0 = Clock::now();
    while (!rxIdle_ && msSince(t0) < 2000) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    // drain whatever is left in the ring so the dsp does not see stale timestamps
    while (auto* c = ring_.peekRead()) { (void)c; ring_.commitRead(); }
}

void Engine::resumeRx() {
    rxPaused_ = false;
    rxCv_.notify_all();
}

// ------------------------------------------------------------------ dsp thread

void Engine::dspLoop() {
    CaptureRequest cur; bool have = false;
    size_t got = 0; SegmentStats st; double fs = 8e6;
    double deadline = 0;
    auto complete = [&](bool valid) {
        st.valid = valid && !st.overflow;
        capturedId_.store(cur.id); capCv_.notify_all();
        processCapture(cur, capBuf_.data(), got, st);
        have = false; got = 0;
    };
    while (running_) {
        Chunk* c = ring_.peekRead();
        if (!c) { std::this_thread::sleep_for(std::chrono::microseconds(150)); continue; }
        if (!have) {
            CaptureRequest* r = requests_.peekRead();
            if (!r) { ring_.commitRead(); continue; }
            cur = *r; requests_.commitRead();
            have = true; got = 0; st = SegmentStats{};
            fs = cur.plan->prof.rateHz;
            if (capBuf_.size() < 2 * cur.nSamples) capBuf_.resize(2 * cur.nSamples);
            deadline = cur.tStartS + double(cur.nSamples) / fs + 0.25;
        }
        const double t0 = c->t0, tEnd = t0 + double(c->n) / fs;
        if (c->overflow) {
            if (got > 0) { st.overflow = true; ring_.commitRead(); complete(false); continue; }
            st.overflow = false; // before capture start: only a gap, keep waiting for tStart
            ring_.commitRead(); continue;
        }
        if (t0 > deadline) { ring_.commitRead(); complete(false); continue; } // request abandoned (ctl moved on)
        size_t off = 0;
        if (got == 0) {
            if (tEnd <= cur.tStartS) { ring_.commitRead(); continue; }
            if (t0 < cur.tStartS) off = size_t(std::ceil((cur.tStartS - t0) * fs));
            if (off >= c->n) { ring_.commitRead(); continue; }
        }
        size_t avail = c->n - off, need = cur.nSamples - got, take = std::min(avail, need);
        SegmentStats part;
        scanSamples(c->iq + 2 * off, take, part);
        if (part.zeroRunMax >= kZeroRunLimit) {
            // AD9361 ALERT mute inside our window: restart the capture after this chunk (plus guard)
            got = 0; st = SegmentStats{}; st.zeroRunMax = part.zeroRunMax;
            cur.tStartS = tEnd + opt_.guardMs * 1e-3;
            ring_.commitRead(); continue;
        }
        std::memcpy(capBuf_.data() + 2 * got, c->iq + 2 * off, take * 2 * sizeof(int16_t));
        if (part.firstClip >= 0) { if (st.firstClip < 0) st.firstClip = int64_t(got) + part.firstClip; st.lastClip = int64_t(got) + part.lastClip; }
        got += take;
        st.sampleCount += part.sampleCount; st.clipCount += part.clipCount; st.peakAbs = std::max(st.peakAbs, part.peakAbs);
        ring_.commitRead();
        if (got >= cur.nSamples) complete(true);
    }
}

void Engine::processCapture(const CaptureRequest& r, const int16_t* iq, size_t n, SegmentStats& st) {
    auto& pl = *r.plan;
    if (dspPlan_ != r.plan || !analyzer_) {
        if (!analyzer_ || analyzer_->fftN() != pl.fftN || analyzer_->fsHz() != pl.prof.rateHz || dspPlan_ == nullptr || dspPlan_->req.window != pl.req.window)
            analyzer_ = std::make_unique<SubWindowAnalyzer>(pl.fftN, pl.prof.rateHz, pl.req.window);
        grid_.configure(pl.req.startHz, pl.stepHz, pl.binCount, pl.req.rbwHz, SpurTable::forMcr(pl.prof.mcrHz, pl.req.startHz - 1e6, pl.req.stopHz + 1e6));
        dspPlan_ = r.plan;
        dbA_.assign(pl.binCount, 0); dbP_ = dbA_; dbM_ = dbA_; dbS_ = dbA_;
    }
    if (r.firstInSweep) grid_.beginSweep();
    if (st.clipCount > 0 && getenv("SCANNER_CLIP_DEBUG"))
        LOGD("clip: lo %.3f MHz n=%zu clips=%llu first=%lld last=%lld peak=%d", r.loHz / 1e6, n, (unsigned long long)st.clipCount, (long long)st.firstClip, (long long)st.lastClip, st.peakAbs);
    CellMap map = buildCellMap(r.sw.rfCentreHz, r.sw.keptLoHz, r.sw.keptHiHz, pl.fftN, pl.prof.rateHz,
                               pl.req.startHz, pl.stepHz, pl.req.rbwHz, pl.binCount);
    if (map.nCells) {
        avg_.resize(map.nCells); peak_.resize(map.nCells); minv_.resize(map.nCells); sample_.resize(map.nCells);
        if (st.valid && n >= samplesNeeded(pl.fftN, 1)) {
            int nAvg = int((n - pl.fftN) / (pl.fftN / 2)) + 1;
            analyzer_->analyze(iq, n, std::min(nAvg, pl.nAvg), map, avg_.data(), peak_.data(), minv_.data(), sample_.data(), st);
            std::lock_guard<std::mutex> lk(psdMu_);
            lastPsd_.assign(analyzer_->lastFinePsd(), analyzer_->lastFinePsd() + pl.fftN);
        } else st.valid = false;
        grid_.addSegment(map, avg_.data(), peak_.data(), minv_.data(), sample_.data(), st, r.sw,
                         eq_.loaded && eq_.profile == pl.prof.name ? &eq_ : nullptr, pl.prof.loHole, r.loHz);
    }
    if (r.lastInSweep) {
        grid_.finalize();
        lastClipFrac_ = grid_.clipFraction(); lastPeakDbfs_ = grid_.peakDbfs();
        lastZeroRuns_ = grid_.zeroRuns(); lastOverflow_ = grid_.overflowSeen() ? 1 : 0;
        emitTrace(r, true);
        completedSweeps_++;
    } else if (r.lastSubOfLo) emitTrace(r, false);
}

void Engine::emitTrace(const CaptureRequest& r, bool complete) {
    auto& pl = *r.plan;
    proto::Header h;
    h.msgType = complete ? proto::TraceComplete : proto::TracePartial;
    h.flags = r.flags;
    if (complete) h.flags |= proto::FlagSweepComplete;
    if (grid_.overflowSeen()) h.flags |= proto::FlagOverflowSeen;
    if (grid_.clipped()) h.flags |= proto::FlagClipped;
    if (usrp_.info().usbVersion < 3) h.flags |= proto::FlagUsb2;
    if (!cal_->calibrated()) h.flags |= proto::FlagUncalibrated;
    if (pl.req.interleave && (r.sweepId & 1)) h.flags |= proto::FlagInterleaveParity;
    h.sweepId = r.sweepId; h.startHz = pl.req.startHz; h.stepHz = pl.stepHz; h.tDeviceS = r.tStartS;
    h.binCount = pl.binCount; h.rbwHz = float(pl.req.rbwHz); h.gainDb = r.gainDb; h.kDbm = r.kDbm;
    h.navg = uint16_t(std::min(65535, pl.nAvg)); h.profileId = pl.prof.id;
    uint32_t filled = complete ? pl.binCount : grid_.filledBins();
    grid_.toDb(dbA_.data(), dbP_.data(), dbM_.data(), dbS_.data(), filled);
    const float nan = std::numeric_limits<float>::quiet_NaN();
    for (uint32_t c = filled; c < pl.binCount; ++c) { dbA_[c] = dbP_[c] = dbM_[c] = dbS_[c] = nan; }
    proto::FrameBuilder fb(h);
    fb.addTrace(proto::DetRms, proto::KindLiveAvg, uint16_t(std::min(65535, pl.nAvg)), filled, dbA_.data(), pl.binCount);
    switch (pl.req.detector) {
        case proto::DetMin: fb.addTrace(proto::DetMin, proto::KindLiveMin, uint16_t(pl.nAvg), filled, dbM_.data(), pl.binCount); break;
        case proto::DetSample: fb.addTrace(proto::DetSample, proto::KindLiveSample, 1, filled, dbS_.data(), pl.binCount); break;
        default: fb.addTrace(proto::DetPeak, proto::KindLivePeak, uint16_t(pl.nAvg), filled, dbP_.data(), pl.binCount); break;
    }
    fb.addMask(grid_.mask(), pl.binCount, filled);
    lastTDevice_ = r.tStartS;
    emitFrame(fb.finish());
}

std::vector<float> Engine::lastFinePsd() { std::lock_guard<std::mutex> lk(psdMu_); return lastPsd_; }

// ------------------------------------------------------------------ ctl thread

void Engine::ctlLoop() {
    try {
        while (running_) {
            handleCommands();
            if (!running_) break;
            if (planDirty_) applyPlan();
            if (nowS() - lastStatusS_ >= 1.0) emitStatus();
            if (!sweepingWanted_ || !plan_) {
                sweepingNow_ = false;
                std::unique_lock<std::mutex> lk(cmdMu_);
                if (cmds_.empty()) cmdCv_.wait_for(lk, std::chrono::milliseconds(100));
                continue;
            }
            if (needPlant_) plant();
            sweepingNow_ = true;
            runSweep();
            if (single_) { single_ = false; sweepingWanted_ = false; emitStatus(); }
        }
    } catch (std::exception& e) {
        LOGE("control thread fatal: %s", e.what());
        emitLog(LogLevel::Error, std::string("control thread fatal: ") + e.what());
        running_ = false;
    }
    if (streamer_) { try { usrp_.streamStop(streamer_); } catch (...) {} }
    rxPaused_ = true;
    // drain briefly so the FX3 does not keep a half-finished transfer (PLAN.md: graceful stop ~100 ms)
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
}

void Engine::handleCommands() {
    std::deque<json> batch;
    { std::lock_guard<std::mutex> lk(cmdMu_); batch.swap(cmds_); }
    for (auto& c : batch) {
        std::string cmd = c.value("cmd", "");
        if (cmd == "setPlan") {
            std::lock_guard<std::mutex> lk(stateMu_);
            auto warn = desired_.applyJson(c.value("plan", json::object()));
            for (auto& w : warn) emitLog(LogLevel::Warn, w);
            planDirty_ = true;
        } else if (cmd == "start") { sweepingWanted_ = true; single_ = false; }
        else if (cmd == "stop") { sweepingWanted_ = false; single_ = false; }
        else if (cmd == "single") { sweepingWanted_ = true; single_ = true; }
        else if (cmd == "getStatus") emitStatus();
        else if (cmd == "replant") needPlant_ = true;
        else if (cmd == "shutdown") { running_ = false; }
        else emitLog(LogLevel::Warn, "unknown command '" + cmd + "'");
    }
}

void Engine::applyPlan() {
    PlanRequest req;
    { std::lock_guard<std::mutex> lk(stateMu_); req = desired_; }
    const int usb = usrp_.info().usbVersion;
    const Profile* prof = req.profile == "auto" ? &autoProfile(usb) : findProfile(req.profile);
    std::vector<std::string> warnings;
    if (!prof) { warnings.push_back("unknown profile '" + req.profile + "', using auto"); prof = &autoProfile(usb); }
    if (prof->needsUsb3 && usb > 0 && usb < 3) { warnings.push_back("profile " + prof->name + " needs USB 3; falling back to usb2"); prof = findProfile("usb2"); }
    bool ratesChanged = activeProfile_ != prof || activeAnalogBw_ != req.analogBwHz;
    bool antennaChanged = activeAntenna_ != req.antenna;
    if (ratesChanged || antennaChanged) {
        try { reconfigure(*prof, req); }
        catch (std::exception& e) {
            emitLog(LogLevel::Error, std::string("reconfigure failed: ") + e.what());
            if (activeProfile_) prof = activeProfile_; else { running_ = false; return; }
        }
    }
    bool planChanged = true;
    auto pl = std::make_shared<SweepPlan>(makePlan(req, *prof, *cal_, planChanged));
    for (auto& w : warnings) pl->warnings.push_back(w);
    // Gain: manual -> requested; auto -> start at the cap, keep the current value if within the cap
    double newGain = pl->req.gainMode == GainMode::Manual ? pl->req.gainDb : std::min(gainDb_ > 0 ? std::min(gainDb_, pl->gainCapDb) : pl->gainCapDb, pl->gainCapDb);
    if (pl->req.gainMode == GainMode::Auto && (!plan_ || plan_->req.gainMode != GainMode::Auto || plan_->req.refLevelDbm != pl->req.refLevelDbm)) newGain = pl->gainCapDb;
    if (prof->minGainDb > 0) newGain = std::max(newGain, prof->minGainDb);
    if (std::fabs(newGain - gainDb_) > 0.01 || !plan_) { gainDb_ = usrp_.setGain(newGain); gainChanged_ = true; }
    pl->req.gainDb = gainDb_;
    // Re-plant when the calibration segments moved
    if (plantedCentres_.size() != pl->segCentres.size()) needPlant_ = true;
    else for (size_t i = 0; i < plantedCentres_.size(); ++i) if (std::fabs(plantedCentres_[i] - pl->segCentres[i]) > 60e6) needPlant_ = true;
    if (!eq_.loaded || eq_.profile != prof->name) {
        if (!opt_.eqDir.empty()) eq_ = EqTable::load(opt_.eqDir + "/" + prof->name + ".eq.json");
        if (eq_.loaded) LOGI("loaded equalisation table for %s", prof->name.c_str());
    }
    {
        std::lock_guard<std::mutex> lk(stateMu_);
        plan_ = pl; planDirty_ = false;
        desired_.startHz = pl->req.startHz; desired_.stopHz = pl->req.stopHz; desired_.rbwHz = pl->req.rbwHz; desired_.vbwHz = pl->req.vbwHz;
    }
    json applied{{"type", "applied"}, {"requested", req.toJson()}, {"applied", pl->toJson()}, {"warnings", pl->warnings}};
    emitFrame(proto::makeJsonFrame(proto::StatusJson, applied.dump(), 0, lastTDevice_, prof->id));
    LOGI("plan: %s %.3f-%.3f MHz rbw %.1f kHz N=%d nAvg=%d hops=%zu bins=%u gain=%.0f cap=%.0f predicted %.0f ms",
         prof->name.c_str(), pl->req.startHz / 1e6, pl->req.stopHz / 1e6, pl->req.rbwHz / 1e3, pl->fftN, pl->nAvg,
         pl->grid[0].size(), pl->binCount, gainDb_, pl->gainCapDb, pl->predictedSweepMs);
    emitStatus();
}

void Engine::reconfigure(const Profile& p, const PlanRequest& req) {
    LOGI("reconfigure: profile %s (MCR %.0f, %.0f MS/s, %s) antenna %s", p.name.c_str(), p.mcrHz / 1e6, p.rateHz / 1e6, p.otw.c_str(), req.antenna.c_str());
    pauseRx();
    streamer_.reset();
    usrp_.configureRates(p, req.analogBwHz);
    if (activeAntenna_ != req.antenna) {
        usrp_.setAntenna(req.antenna);
        std::string info;
        if (auto c = loadUhdCal(usrp_.info().serial, req.antenna, info)) cal_ = std::move(c); else cal_ = std::make_unique<DefaultCal>();
        calInfo_ = info;
    }
    activeProfile_ = &p; activeAnalogBw_ = req.analogBwHz; activeAntenna_ = req.antenna;
    streamer_ = usrp_.makeStreamer(p.otw);
    usrp_.setTimeNow(0.0);
    usrp_.streamStart(streamer_);
    if (!rxThread_.joinable()) rxThread_ = std::thread([this] { rxLoop(); });
    resumeRx();
    needPlant_ = true; // rate / MCR change re-ran the chip calibration at the current LO
    hopStats_.reset(); sweepStats_.reset(); ddcStats_.reset();
}

void Engine::plant() {
    if (!plan_) return;
    plantedCentres_ = plan_->segCentres;
    for (double c : plantedCentres_) {
        double detour = c + 201e6 <= 6e9 ? c + 201e6 : c - 201e6;
        auto a = usrp_.tunePlain(detour);
        auto b = usrp_.tunePlain(c);
        LOGI("planted cal point at %.3f MHz: detour %.1f ms, return %.1f ms", c / 1e6, a.callMs, b.callMs);
    }
    needPlant_ = false; recalFlag_ = true; lastReplantS_ = nowS();
}

void Engine::runSweep() {
    auto pl = plan_;
    const auto& grid = pl->gridFor(sweepId_ + 1);
    sweepId_++;
    // auto gain: react to the previous sweep's clip statistics
    if (pl->req.gainMode == GainMode::Auto && completedSweeps_ > 0) {
        double g = gainDb_;
        double clip = lastClipFrac_.load(), peak = lastPeakDbfs_.load();
        double gMin = std::max(0.0, pl->prof.minGainDb);
        if (clip > 1e-4 || peak > -3.0) { g = std::max(gMin, g - 3); cleanSweeps_ = 0; }
        else if (peak < -12.0 && g < pl->gainCapDb) { if (++cleanSweeps_ >= 3) { g = std::min(pl->gainCapDb, g + 3); cleanSweeps_ = 0; } }
        else cleanSweeps_ = 0;
        if (g != gainDb_) { gainDb_ = usrp_.setGain(g); gainChanged_ = true; LOGI("auto gain -> %.0f dB (clip %.2e peak %.1f dBFS)", gainDb_, clip, peak); }
    }
    double centre = 0.5 * (pl->req.startHz + pl->req.stopHz);
    double k = cal_->kDbm(gainDb_, centre);
    { double ku; if (cal_->calibrated() && usrp_.powerReference(ku)) k = ku; }
    kDbm_ = k;
    uint16_t flags = 0;
    if (recalFlag_) { flags |= proto::FlagRecalHappened; recalFlag_ = false; }
    if (gainChanged_) { flags |= proto::FlagGainChanged; gainChanged_ = false; }
    const double fs = pl->prof.rateHz, capS = double(pl->samplesPerWindow) / fs;
    const double guardS = opt_.guardMs * 1e-3, ddcGuardS = opt_.ddcGuardMs * 1e-3;
    auto tSweep0 = Clock::now();
    recalsInSweep_ = 0;
    for (size_t i = 0; i < grid.size() && running_; ++i) {
        if (!sweepingWanted_ && !single_) break;
        const auto& lp = grid[i];
        const double loExact = lp.loHz; // the same double is reused for all sub-window DDC retunes
        auto tr = usrp_.tuneManual(loExact, lp.sub[0].dspHz);
        hopStats_.add(tr.callMs); hopMsRecent_.push_back(tr.callMs); if (hopMsRecent_.size() > 256) hopMsRecent_.erase(hopMsRecent_.begin());
        if (tr.recal) { recalsInSweep_++; needPlant_ = true; flags |= proto::FlagRecalHappened; LOGW("LO hop to %.3f MHz took %.0f ms: calibration point moved, will re-plant", loExact / 1e6, tr.callMs); }
        double tAfter = usrp_.timeNowS();
        double tStart0 = tAfter + guardS;
        uint64_t lastId = 0;
        std::vector<uint64_t> ids;
        for (size_t kidx = 0; kidx < lp.sub.size(); ++kidx) {
            const auto& sw = lp.sub[kidx];
            double tStart = tStart0 + double(kidx) * (capS + ddcGuardS);
            TuneOutcome tk = tr;
            if (kidx > 0) {
                if (opt_.timedDdc) {
                    // Measured: the B200 accepts 2 pending timed commands; a 3rd blocks in set_rx_freq until the first
                    // executes (~one capture). Keep at most 2 outstanding by waiting for capture kidx-2 first.
                    if (kidx >= 2) {
                        uint64_t waitId = ids[kidx - 2];
                        std::unique_lock<std::mutex> lk(capMu_);
                        capCv_.wait_for(lk, std::chrono::duration<double>(2 * capS + 0.1), [&] { return capturedId_.load() >= waitId || !running_; });
                    }
                    tk = usrp_.tuneManualAt(tStart - ddcGuardS, loExact, sw.dspHz); ddcStats_.add(tk.callMs);
                }
                else {
                    // untimed fallback: wait for the previous window to be captured, then retune and re-time
                    { std::unique_lock<std::mutex> lk(capMu_); capCv_.wait_for(lk, std::chrono::duration<double>(capS + 0.05), [&] { return capturedId_.load() >= lastId; }); }
                    tk = usrp_.tuneManual(loExact, sw.dspHz);
                    tStart = usrp_.timeNowS() + ddcGuardS;
                }
                if (std::fabs(tk.rfHz - tr.rfHz) > 0.5) LOGW("DDC retune moved the LO (%.1f -> %.1f Hz): rf double mismatch", tr.rfHz, tk.rfHz);
            }
            CaptureRequest* rq = requests_.beginWrite();
            if (!rq) { LOGE("request ring full"); break; }
            rq->id = ++nextReqId_; rq->sweepId = sweepId_; rq->loIndex = int(i); rq->loCount = int(grid.size()); rq->subIndex = int(kidx);
            rq->tStartS = tStart; rq->nSamples = pl->samplesPerWindow;
            rq->sw = sw; rq->sw.rfCentreHz = tk.rfHz - tk.dspHz; // actual RF at baseband 0
            rq->sw.keptLoHz = rq->sw.rfCentreHz - pl->prof.subWidthHz() / 2; rq->sw.keptHiHz = rq->sw.rfCentreHz + pl->prof.subWidthHz() / 2;
            rq->loHz = tk.rfHz;
            rq->firstInSweep = (i == 0 && kidx == 0); rq->lastInSweep = (i + 1 == grid.size() && kidx + 1 == lp.sub.size());
            rq->lastSubOfLo = (kidx + 1 == lp.sub.size());
            rq->flags = flags; rq->gainDb = float(gainDb_); rq->kDbm = float(kDbm_); rq->plan = pl;
            lastId = rq->id; ids.push_back(rq->id);
            requests_.commitWrite();
        }
        flags &= uint16_t(~(proto::FlagRecalHappened | proto::FlagGainChanged));
        // wait until the last sub-window of this LO position has been captured
        double expectS = (tStart0 + lp.sub.size() * (capS + ddcGuardS)) - tAfter;
        std::unique_lock<std::mutex> lk(capMu_);
        bool ok = capCv_.wait_for(lk, std::chrono::duration<double>(expectS + opt_.captureTimeoutS), [&] { return capturedId_.load() >= lastId || !running_; });
        if (!ok) { captureTimeouts_++; LOGW("capture timeout at LO %.3f MHz (waited %.0f ms)", loExact / 1e6, 1e3 * (expectS + opt_.captureTimeoutS)); }
        if (nowS() - lastStatusS_ >= 1.0) { lk.unlock(); emitStatus(); }
    }
    lastSweepMs_ = msSince(tSweep0);
    sweepStats_.add(lastSweepMs_);
    sweepsPerSec_ = 0.7 * sweepsPerSec_ + 0.3 * (1000.0 / std::max(1.0, lastSweepMs_));
    if (nowS() - lastTempS_ > 5.0) { tempC_ = usrp_.tempC(); lastTempS_ = nowS(); }
}

json Engine::statusJson() {
    std::lock_guard<std::mutex> lk(stateMu_);
    const auto& inf = usrp_.info();
    json dev{{"serial", inf.serial}, {"product", inf.product}, {"usbVersion", inf.usbVersion}, {"linkMaxRateBps", inf.linkMaxRateBps},
             {"mcrHz", inf.mcrHz}, {"rateHz", inf.rateHz}, {"fpga", inf.fpgaVersion}, {"fw", inf.fwVersion}, {"antenna", inf.antenna},
             {"tempC", tempC_}, {"gainRange", {inf.gainMin, inf.gainMax}}, {"deviceArgs", inf.deviceArgs}};
    std::vector<double> hops = hopMsRecent_; std::sort(hops.begin(), hops.end());
    double hopMed = hops.empty() ? 0 : hops[hops.size() / 2], hopMax = hops.empty() ? 0 : hops.back();
    json j{{"type", "status"}, {"engineUp", true}, {"device", dev},
           {"profile", activeProfile_ ? activeProfile_->name : "none"}, {"profileId", activeProfile_ ? activeProfile_->id : 0},
           {"plan", plan_ ? plan_->toJson() : json(nullptr)}, {"sweeping", sweepingNow_.load()}, {"sweepId", sweepId_},
           {"sweepsPerSec", sweepsPerSec_}, {"sweepMs", lastSweepMs_}, {"sweepMsMean", sweepStats_.mean()},
           {"hopMsMedian", hopMed}, {"hopMsMax", hopMax}, {"hopMsMean", hopStats_.mean()}, {"hops", hopStats_.n},
           {"ddcMsMean", ddcStats_.mean()}, {"ddcMsMax", ddcStats_.n ? ddcStats_.maxv : 0.0}, {"ddcRetunes", ddcStats_.n},
           {"recals", usrp_.recals}, {"recalsInSweep", recalsInSweep_}, {"overflows", rxOverflows_.load()}, {"timeouts", rxTimeouts_.load()},
           {"captureTimeouts", captureTimeouts_}, {"ringFull", ringFull_.load()}, {"zeroRuns", lastZeroRuns_.load()},
           {"clipFraction", lastClipFrac_.load()}, {"peakDbfs", lastPeakDbfs_.load()}, {"gainDb", gainDb_}, {"kDbm", kDbm_},
           {"calSource", cal_->source()}, {"calInfo", calInfo_}, {"calibrated", cal_->calibrated()},
           {"calCentresHz", plantedCentres_}, {"lastReplantS", lastReplantS_}, {"uptimeS", nowS() - uptime0_},
           {"completedSweeps", completedSweeps_.load()}, {"eqLoaded", eq_.loaded}};
    return j;
}

void Engine::emitStatus(const char*) {
    lastStatusS_ = nowS();
    emitFrame(proto::makeJsonFrame(proto::StatusJson, statusJson().dump(), 0, lastTDevice_, activeProfile_ ? activeProfile_->id : 0));
}

bool Engine::waitSweeps(uint32_t n, double timeoutS) {
    auto t0 = Clock::now();
    while (completedSweeps_ < n && running_) {
        if (msSince(t0) > timeoutS * 1e3) return false;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    return completedSweeps_ >= n;
}

// ------------------------------------------------------------------ watchdog

void Engine::watchdogLoop() {
    while (running_) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        int64_t since = usrp_.inCallSinceNs.load();
        if (since) {
            int64_t now = std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count();
            if (now - since > 5'000'000'000LL) {
                LOGE("watchdog: UHD control call blocked > 5 s (device detached?) - exiting 3");
                if (!opt_.disableWatchdogExit) _exit(3);
            }
        }
        if (rxConsecutiveTimeouts_ > 6 && !rxPaused_) {
            LOGE("watchdog: %u consecutive rx timeouts - exiting 3", rxConsecutiveTimeouts_.load());
            if (!opt_.disableWatchdogExit) _exit(3);
        }
    }
}

} // namespace scanner
