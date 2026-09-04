// main.cpp: CLI / socket front end for the engine.
//   engine --probe [--cycles N]                    device bring-up check (milestone 0)
//   engine --find [--args ARGS]                    list attached USRPs as JSON; never claims one
//   engine --socket PATH                           serve the Node supervisor over a Unix socket
//   engine --dump FILE.csv [--sweeps N|--seconds S] sweep from the CLI and write WWB CSV of the last sweep
//   engine --emit-fixtures DIR                     write golden protocol frames
//   engine --eqcap OUT.json                        flatness table on a terminated input (milestone 3)
//   engine --calwrite IN.json                      write UHD power-calibration tables (milestone 3)
//   engine --guardtest OUT.json [--profile P]      settle time after LO hops vs gain (milestone 3 guard table)
#include "cal_uhd.hpp"
#include <uhd/device.hpp>
#include "common.hpp"
#include "engine.hpp"
#include "protocol.hpp"
#include "socket.hpp"
#include <cmath>
#include <csignal>
#include <cstdlib>
#include <fcntl.h>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

using json = nlohmann::json;
using namespace scanner;

namespace {
std::atomic<bool> g_stop{false};
void onSignal(int) { g_stop = true; }

struct Args {
    std::string socket, dump, fixtures, eqcap, calwrite, guardtest, lock = "run/engine.lock", deviceArgs = "type=b200", eqDir = "data/eq";
    bool probe = false, find = false, help = false, noTimed = false, replant = false;
    int cycles = 1, sweeps = 0; double seconds = 0, guardMs = 1.2;
    json plan = json::object();
};

Args parse(int argc, char** argv) {
    Args a;
    auto need = [&](int& i) -> std::string { if (i + 1 >= argc) { fprintf(stderr, "missing value for %s\n", argv[i]); exit(2); } return argv[++i]; };
    for (int i = 1; i < argc; ++i) {
        std::string k = argv[i];
        if (k == "--probe") a.probe = true;
        else if (k == "--find") a.find = true;
        else if (k == "--help" || k == "-h") a.help = true;
        else if (k == "--cycles") a.cycles = atoi(need(i).c_str());
        else if (k == "--socket") a.socket = need(i);
        else if (k == "--dump") a.dump = need(i);
        else if (k == "--emit-fixtures") a.fixtures = need(i);
        else if (k == "--eqcap") a.eqcap = need(i);
        else if (k == "--calwrite") a.calwrite = need(i);
        else if (k == "--guardtest") a.guardtest = need(i);
        else if (k == "--lock") a.lock = need(i);
        else if (k == "--args") a.deviceArgs = need(i);
        else if (k == "--eq-dir") a.eqDir = need(i);
        else if (k == "--sweeps") a.sweeps = atoi(need(i).c_str());
        else if (k == "--seconds") a.seconds = atof(need(i).c_str());
        else if (k == "--guard-ms") a.guardMs = atof(need(i).c_str());
        else if (k == "--no-timed-ddc") a.noTimed = true;
        else if (k == "--profile") a.plan["profile"] = need(i);
        else if (k == "--start") a.plan["startHz"] = atof(need(i).c_str()) * 1e6;
        else if (k == "--stop") a.plan["stopHz"] = atof(need(i).c_str()) * 1e6;
        else if (k == "--rbw") a.plan["rbwHz"] = atof(need(i).c_str()) * 1e3;
        else if (k == "--vbw") a.plan["vbwHz"] = atof(need(i).c_str()) * 1e3;
        else if (k == "--gain") { a.plan["gainDb"] = atof(need(i).c_str()); a.plan["gainMode"] = "manual"; }
        else if (k == "--ref") a.plan["refLevelDbm"] = atof(need(i).c_str());
        else if (k == "--dwell") a.plan["dwell"] = need(i);
        else if (k == "--detector") a.plan["detector"] = need(i);
        else if (k == "--antenna") a.plan["antenna"] = need(i);
        else if (k == "--interleave") a.plan["interleave"] = true;
        else if (k == "--lo-offset") a.plan["loGridOffsetHz"] = atof(need(i).c_str()) * 1e3;
        else if (k == "--window") a.plan["window"] = need(i);
        else if (k == "--plan") a.plan.update(json::parse(need(i)));
        else { fprintf(stderr, "unknown option %s\n", k.c_str()); exit(2); }
    }
    return a;
}

int acquireLock(const std::string& path) {
    if (path.empty()) return -1;
    std::string dir = path.substr(0, path.find_last_of('/'));
    if (!dir.empty()) mkdir(dir.c_str(), 0755);
    int fd = ::open(path.c_str(), O_RDWR | O_CREAT, 0644);
    if (fd < 0) { LOGW("cannot open lock file %s", path.c_str()); return -1; }
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        char buf[64] = {0}; ssize_t n = read(fd, buf, sizeof buf - 1); (void)n;
        fprintf(stderr, "another engine holds %s (pid %s); refusing to touch the device\n", path.c_str(), buf);
        exit(4);
    }
    if (ftruncate(fd, 0) == 0) { std::string pid = std::to_string(getpid()) + "\n"; ssize_t w = write(fd, pid.data(), pid.size()); (void)w; }
    return fd;
}

// Enumerate attached devices without opening one. `uhd::device::find` reads USB descriptors
// only, so it is safe to call while another engine is streaming from the same radio — which
// is exactly when the SoundBase plugin polls it during a device-enumeration window.
int findDevices(const std::string& deviceArgs) {
    json out = json::array();
    try {
        for (const auto& addr : uhd::device::find(uhd::device_addr_t(deviceArgs))) {
            json e = json::object();
            for (const auto& k : addr.keys()) e[k] = addr[k];
            out.push_back(e);
        }
    } catch (const std::exception& e) {
        fprintf(stderr, "find failed: %s\n", e.what());
        printf("[]\n");
        return 1;
    }
    printf("%s\n", out.dump().c_str());
    return 0;
}

int probe(Args& a) {
    Stats openMs, closeMs;
    json last;
    for (int c = 0; c < a.cycles && !g_stop; ++c) {
        Usrp u; std::string err;
        auto t0 = Clock::now();
        if (!u.open(deviceArgsFor(a.deviceArgs), 10, 1.0, err)) { fprintf(stderr, "open failed: %s\n", err.c_str()); return 1; }
        auto inf = u.readInfo();
        double tOpen = msSince(t0);
        last = json{{"serial", inf.serial}, {"product", inf.product}, {"mboard", inf.mboard}, {"usbVersion", inf.usbVersion},
                    {"linkMaxRateBps", inf.linkMaxRateBps}, {"fpga", inf.fpgaVersion}, {"fw", inf.fwVersion}, {"mcrHz", inf.mcrHz},
                    {"rateHz", inf.rateHz}, {"gainRange", {inf.gainMin, inf.gainMax}}, {"antennas", inf.antennas},
                    {"sensors", inf.sensors}, {"tempC", inf.tempC}, {"deviceArgs", inf.deviceArgs}, {"openMs", tOpen}};
        auto t1 = Clock::now();
        u.close();
        double tClose = msSince(t1);
        openMs.add(tOpen); closeMs.add(tClose);
        fprintf(stderr, "cycle %d/%d: open %.0f ms, close %.0f ms, usb=%d\n", c + 1, a.cycles, tOpen, tClose, inf.usbVersion);
        if (c + 1 < a.cycles) std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
    last["cycles"] = openMs.n; last["openMsMean"] = openMs.mean(); last["openMsMax"] = openMs.maxv; last["closeMsMax"] = closeMs.maxv;
    printf("%s\n", last.dump(2).c_str());
    return (openMs.maxv > 3000 || last["usbVersion"].get<int>() == 0) ? 1 : 0;
}

int emitFixtures(const std::string& dir) {
    mkdir(dir.c_str(), 0755);
    auto hex = [](const std::vector<uint8_t>& b) { std::string s; char t[3]; for (auto v : b) { snprintf(t, 3, "%02x", v); s += t; } return s; };
    auto write = [&](const std::string& name, const std::vector<uint8_t>& b) { std::ofstream f(dir + "/" + name + ".hex"); f << hex(b) << "\n"; };
    proto::Header h; h.msgType = proto::TraceComplete; h.flags = proto::FlagSweepComplete | proto::FlagUncalibrated; h.sweepId = 7; h.seq = 42;
    h.startHz = 470e6; h.stepHz = 25e3; h.tDeviceS = 1.5; h.binCount = 5; h.rbwHz = 25e3; h.gainDb = 50; h.kDbm = -40; h.navg = 10; h.profileId = 2;
    float avg[5] = {-100.f, -99.5f, -60.25f, -101.f, -100.75f}, pk[5] = {-97.f, -96.f, -58.f, -98.f, -97.5f};
    uint8_t mask[5] = {0, 0, 0, proto::MaskSpur | proto::MaskInterp, 0};
    { proto::FrameBuilder fb(h); fb.addTrace(proto::DetRms, proto::KindLiveAvg, 10, 5, avg, 5); fb.addTrace(proto::DetPeak, proto::KindLivePeak, 10, 5, pk, 5); fb.addMask(mask, 5, 5); write("trace_complete_5bins", fb.finish()); }
    { proto::Header p = h; p.msgType = proto::TracePartial; p.flags = 0; float part[5] = {-100.f, -99.f, NAN, NAN, NAN}; proto::FrameBuilder fb(p); fb.addTrace(proto::DetRms, proto::KindLiveAvg, 10, 2, part, 5); fb.addTrace(proto::DetPeak, proto::KindLivePeak, 10, 2, part, 5); uint8_t m2[5] = {0, 0, 1, 1, 1}; fb.addMask(m2, 5, 2); write("trace_partial_2of5", fb.finish()); }
    write("status_json", proto::makeJsonFrame(proto::StatusJson, R"({"type":"status","engineUp":true,"sweepId":7})", 43, 1.5, 2));
    write("log_json", proto::makeJsonFrame(proto::LogJson, R"({"type":"log","level":"info","msg":"hello","tS":1.0})", 44, 1.5, 2));
    printf("fixtures written to %s\n", dir.c_str());
    return 0;
}

std::string wwbCsv(const proto::Header& h, const float* db, const uint8_t* mask) {
    std::string out; char line[64];
    float last = -140.f;
    for (uint32_t i = 0; i < h.binCount; ++i) {
        float v = db[i];
        if (std::isnan(v)) v = last; else last = v;
        (void)mask;
        snprintf(line, sizeof line, "%.3f,%.1f\n", (h.startHz + i * h.stepHz) / 1e6, v + h.kDbm);
        out += line;
    }
    return out;
}

int runEngine(Args& a) {
    EngineOptions o; o.deviceArgs = a.deviceArgs; o.eqDir = a.eqDir; o.guardMs = a.guardMs; o.timedDdc = !a.noTimed;
    if (a.plan.contains("profile")) o.profile = a.plan["profile"].get<std::string>();
    Engine eng(o);
    UdsClient sock;
    std::ofstream dumpFile;
    std::mutex dumpMu; uint32_t dumped = 0; std::vector<float> lastAvg; proto::Header lastHdr; std::vector<uint8_t> lastMask;
    bool serve = !a.socket.empty();
    if (serve && !sock.connect(a.socket, 30, 1.0)) { fprintf(stderr, "cannot connect to %s\n", a.socket.c_str()); return 5; }
    eng.setFrameSink([&](std::vector<uint8_t>&& f) {
        proto::Header h;
        if (!proto::parseHeader(f.data(), f.size(), h)) return;
        if (serve) { if (!sock.sendFrame(f)) g_stop = true; return; }
        if (h.msgType == proto::StatusJson || h.msgType == proto::LogJson) {
            std::string js((const char*)f.data() + proto::HEADER_BYTES, f.size() - proto::HEADER_BYTES);
            auto j = json::parse(js, nullptr, false);
            if (j.is_object() && j.value("type", "") == "status")
                fprintf(stderr, "status: sweeps=%u sweepMs=%.1f hopMed=%.2f hopMax=%.2f recals=%llu ovf=%u zeroRuns=%u capTO=%llu gain=%.0f peak=%.1f dBFS clip=%.1e temp=%.1f\n",
                        j.value("completedSweeps", 0u), j.value("sweepMs", 0.0), j.value("hopMsMedian", 0.0), j.value("hopMsMax", 0.0),
                        (unsigned long long)j.value("recals", 0ull), j.value("overflows", 0u), j.value("zeroRuns", 0u), (unsigned long long)j.value("captureTimeouts", 0ull),
                        j.value("gainDb", 0.0), j.value("peakDbfs", 0.0), j.value("clipFraction", 0.0), j["device"].value("tempC", 0.0));
            else if (j.is_object() && j.value("type", "") == "applied") fprintf(stderr, "applied: %s\n", j["applied"].dump().c_str());
            else if (j.is_object() && j.value("type", "") == "log") fprintf(stderr, "log[%s]: %s\n", j.value("level", "").c_str(), j.value("msg", "").c_str());
            return;
        }
        if (h.msgType != proto::TraceComplete) return;
        std::vector<proto::TraceRef> tr;
        if (!proto::parseTraces(f.data(), f.size(), h, tr)) return;
        std::lock_guard<std::mutex> lk(dumpMu);
        for (auto& t : tr) {
            if (t.kind == proto::KindLiveAvg) { lastAvg.assign((const float*)t.payload, (const float*)t.payload + h.binCount); lastHdr = h; }
            if (t.kind == proto::KindMask) lastMask.assign(t.payload, t.payload + h.binCount);
        }
        dumped++;
    });
    std::string err;
    if (!eng.open(err)) { fprintf(stderr, "device open failed: %s\n", err.c_str()); return 1; }
    eng.start();
    if (serve) {
        sock.startReader([&](const std::string& line) { eng.commandLine(line); }, [&] { LOGW("server closed the socket"); g_stop = true; });
        // Wait for stdin EOF as well (parent death) while the engine runs.
        if (!a.plan.empty()) eng.command(json{{"cmd", "setPlan"}, {"plan", a.plan}});
        while (!g_stop && eng.running()) std::this_thread::sleep_for(std::chrono::milliseconds(50));
        eng.shutdown();
        return 0;
    }
    eng.command(json{{"cmd", "setPlan"}, {"plan", a.plan}});
    eng.command(json{{"cmd", "start"}});
    auto t0 = Clock::now();
    while (!g_stop && eng.running()) {
        if (a.sweeps > 0 && eng.completedSweeps() >= uint32_t(a.sweeps)) break;
        if (a.seconds > 0 && msSince(t0) > a.seconds * 1e3) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    eng.command(json{{"cmd", "stop"}});
    auto status = eng.statusJson();
    eng.shutdown();
    if (!a.dump.empty()) {
        std::lock_guard<std::mutex> lk(dumpMu);
        if (!lastAvg.empty()) {
            std::ofstream f(a.dump); f << wwbCsv(lastHdr, lastAvg.data(), lastMask.data());
            fprintf(stderr, "wrote %s (%u bins, sweep %u)\n", a.dump.c_str(), lastHdr.binCount, lastHdr.sweepId);
        } else fprintf(stderr, "no complete sweep to dump\n");
    }
    printf("%s\n", status.dump(2).c_str());
    return 0;
}

// eqcap: sweep a terminated input many times and record per-(sub-window, cell offset) deviation from the median.
int eqcap(Args& a) {
    EngineOptions o; o.deviceArgs = a.deviceArgs; o.eqDir = ""; o.timedDdc = !a.noTimed;
    if (a.plan.contains("profile")) o.profile = a.plan["profile"].get<std::string>();
    Engine eng(o);
    // accumulate linear power per (k, offset) from complete frames' live-avg traces; we need per-window attribution,
    // so we use the partial frames: each partial frame adds exactly one LO position (all its sub-windows).
    std::mutex mu; std::vector<std::vector<double>> sum; std::vector<std::vector<uint32_t>> cnt; int K = 1, halfCells = 0; double stepHz = 25e3;
    std::vector<float> prevAvg; uint32_t frames = 0;
    std::shared_ptr<const SweepPlan> plan;
    eng.setFrameSink([&](std::vector<uint8_t>&& f) {
        proto::Header h; if (!proto::parseHeader(f.data(), f.size(), h)) return;
        if (h.msgType != proto::TracePartial && h.msgType != proto::TraceComplete) return;
        std::vector<proto::TraceRef> tr; if (!proto::parseTraces(f.data(), f.size(), h, tr)) return;
        const float* avg = nullptr; for (auto& t : tr) if (t.kind == proto::KindLiveAvg) avg = (const float*)t.payload;
        if (!avg) return;
        std::lock_guard<std::mutex> lk(mu);
        if (!plan) { plan = eng.currentPlan(); if (!plan) return; K = plan->prof.subWindows; stepHz = plan->stepHz; halfCells = int(std::ceil(plan->prof.subWidthHz() / 2 / stepHz)) + 1; sum.assign(K, std::vector<double>(2 * halfCells + 1, 0)); cnt.assign(K, std::vector<uint32_t>(2 * halfCells + 1, 0)); }
        // Attribute cells: for each LO position of the even grid, cells inside each sub-window's kept range.
        const auto& grid = plan->grid[0];
        std::vector<char> seen(h.binCount, 0);
        if (h.msgType == proto::TraceComplete) frames++;
        if (h.msgType != proto::TraceComplete) return;
        for (auto& lp : grid) for (auto& sw : lp.sub) {
            long jLo = long(std::ceil((sw.keptLoHz - h.startHz) / h.stepHz)), jHi = long(std::floor((sw.keptHiHz - h.startHz) / h.stepHz));
            for (long j = std::max(0L, jLo); j <= std::min<long>(h.binCount - 1, jHi); ++j) {
                if (std::isnan(avg[j])) continue;
                int off = int(std::lround((h.startHz + j * h.stepHz - sw.rfCentreHz) / stepHz)) + halfCells;
                if (off < 0 || off >= 2 * halfCells + 1) continue;
                sum[sw.index][off] += std::pow(10.0, avg[j] / 10.0); cnt[sw.index][off]++;
            }
        }
    });
    std::string err;
    if (!eng.open(err)) { fprintf(stderr, "device open failed: %s\n", err.c_str()); return 1; }
    eng.start();
    if (!a.plan.contains("interleave")) a.plan["interleave"] = false;
    eng.command(json{{"cmd", "setPlan"}, {"plan", a.plan}});
    eng.command(json{{"cmd", "start"}});
    int want = a.sweeps > 0 ? a.sweeps : 100;
    eng.waitSweeps(uint32_t(want), 600);
    eng.command(json{{"cmd", "stop"}});
    auto status = eng.statusJson();
    eng.shutdown();
    std::lock_guard<std::mutex> lk(mu);
    if (!plan) { fprintf(stderr, "no data\n"); return 1; }
    // median of all mean cell powers as the reference; table = 10log10(mean/median) per (k, offset)
    std::vector<double> all;
    std::vector<std::vector<double>> meanDb(K, std::vector<double>(2 * halfCells + 1, 0));
    for (int k = 0; k < K; ++k) for (int i = 0; i < 2 * halfCells + 1; ++i) if (cnt[k][i] > 0) { double m = sum[k][i] / cnt[k][i]; meanDb[k][i] = 10 * std::log10(m); all.push_back(meanDb[k][i]); }
    std::sort(all.begin(), all.end()); double med = all.empty() ? 0 : all[all.size() / 2];
    EqTable t; t.loaded = true; t.profile = plan->prof.name; t.stepHz = stepHz; t.halfCells = halfCells;
    double maxDev = 0;
    for (int k = 0; k < K; ++k) { std::vector<float> g; for (int i = 0; i < 2 * halfCells + 1; ++i) { double dev = cnt[k][i] ? meanDb[k][i] - med : 0; maxDev = std::max(maxDev, std::fabs(dev)); g.push_back(float(std::pow(10.0, -dev / 10.0))); } t.gainLin.push_back(g); }
    mkdir(a.eqDir.c_str(), 0755);
    if (!t.save(a.eqcap)) { fprintf(stderr, "cannot write %s\n", a.eqcap.c_str()); return 1; }
    fprintf(stderr, "eqcap: %d sweeps, profile %s, K=%d, %d cells/window, max deviation %.2f dB -> %s\n", eng.completedSweeps(), plan->prof.name.c_str(), K, 2 * halfCells + 1, maxDev, a.eqcap.c_str());
    printf("%s\n", json{{"profile", plan->prof.name}, {"sweeps", eng.completedSweeps()}, {"maxDeviationDb", maxDev}, {"gainDb", status.value("gainDb", 0.0)}}.dump(2).c_str());
    return 0;
}

int calwrite(Args& a) {
    std::ifstream f(a.calwrite); if (!f) { fprintf(stderr, "cannot read %s\n", a.calwrite.c_str()); return 1; }
    json j; f >> j;
    std::vector<CalMeasurement> ms;
    for (auto& m : j.at("measurements")) ms.push_back({m.at("freqHz"), m.at("gainDb"), m.at("refDbm"), m.at("measuredDbfs"), m.value("tempC", 0.0)});
    std::string serial = j.value("serial", ""), antenna = j.value("antenna", "RX2"), err;
    if (serial.empty()) { Usrp u; if (!u.open(deviceArgsFor(a.deviceArgs), 10, 1.0, err)) { fprintf(stderr, "open: %s\n", err.c_str()); return 1; } serial = u.readInfo().serial; u.close(); }
    if (!writeUhdCal(serial, antenna, ms, err)) { fprintf(stderr, "calwrite failed: %s\n", err.c_str()); return 1; }
    printf("wrote %zu points to UHD cal database key %s serial %s#A\n", ms.size(), uhdCalKey(antenna).c_str(), serial.c_str());
    return 0;
}

// guardtest: measure how long after an LO hop the received power is biased, per gain. Hops between two LOs 5 MHz
// apart (both inside a planted window), records power in 0.25 ms blocks relative to the 15-20 ms steady state.
int guardtest(Args& a) {
    const Profile& p = *findProfile(a.plan.value("profile", std::string("usb2-simple")));
    Usrp u; std::string err;
    if (!u.open(deviceArgsFor(a.deviceArgs), 10, 1.0, err)) { fprintf(stderr, "open: %s\n", err.c_str()); return 1; }
    u.readInfo(); u.configureRates(p, 0); u.setAntenna(a.plan.value("antenna", std::string("RX2")));
    auto rx = u.makeStreamer(p.otw); u.setTimeNow(0);
    const double fs = p.rateHz; const size_t blockN = size_t(fs * 0.25e-3); const int blocks = 80; // 20 ms
    std::vector<int16_t> buf(2 * blockN * blocks);
    u.tunePlain(540e6 + 201e6); u.tunePlain(540e6); // plant
    json out; out["profile"] = p.name; out["blockMs"] = 0.25; json perGain = json::array();
    std::vector<double> gains = {30, 40, 50, 60, 70};
    for (double g : gains) {
        u.setGain(g);
        std::vector<double> acc(blocks, 0); std::vector<int> zeroEnd; int reps = 20; double callMs = 0;
        for (int r = 0; r < reps; ++r) {
            double f = (r & 1) ? 545e6 : 540e6;
            uhd::stream_cmd_t c(uhd::stream_cmd_t::STREAM_MODE_START_CONTINUOUS); c.stream_now = true; rx->issue_stream_cmd(c);
            uhd::rx_metadata_t md; rx->recv(buf.data(), blockN * 4, md, 1.0); // let the stream settle
            auto tr = u.tuneManual(f, 6e6); callMs += tr.callMs;
            size_t got = 0; while (got < blockN * blocks) { size_t n = rx->recv(buf.data() + 2 * got, blockN * blocks - got, md, 1.0); if (!n) break; got += n; }
            rx->issue_stream_cmd(uhd::stream_cmd_t(uhd::stream_cmd_t::STREAM_MODE_STOP_CONTINUOUS));
            while (rx->recv(buf.data(), blockN, md, 0.1)) {}
            // zero-run end (ALERT mute) in samples
            int lastZero = -1; int run = 0;
            for (size_t i = 0; i < blockN * blocks; ++i) { if (buf[2*i] == 0 && buf[2*i+1] == 0) { if (++run >= 32) lastZero = int(i); } else run = 0; }
            zeroEnd.push_back(lastZero);
            for (int b = 0; b < blocks; ++b) { double pw = 0; for (size_t i = b * blockN; i < (b + 1) * blockN; ++i) { double I = buf[2*i], Q = buf[2*i+1]; pw += I*I + Q*Q; } acc[b] += pw / blockN; }
        }
        double ref = 0; for (int b = 60; b < 80; ++b) ref += acc[b]; ref /= 20;
        json devDb = json::array(); int settleBlock = -1;
        for (int b = 0; b < blocks; ++b) { double d = 10 * std::log10(std::max(acc[b], 1e-9) / ref); devDb.push_back(std::round(d * 100) / 100); }
        for (int b = 0; b < blocks; ++b) { bool ok = true; for (int k = b; k < std::min(blocks, b + 8); ++k) if (std::fabs(devDb[k].get<double>()) > 0.5) ok = false; if (ok) { settleBlock = b; break; } }
        double zMaxMs = 0; for (int z : zeroEnd) zMaxMs = std::max(zMaxMs, (z + 1) / fs * 1e3);
        perGain.push_back({{"gainDb", g}, {"tuneCallMsMean", callMs / reps}, {"zeroRunEndMsMax", zMaxMs}, {"settleMs", settleBlock < 0 ? -1.0 : settleBlock * 0.25}, {"devDb", devDb}});
        fprintf(stderr, "gain %2.0f: tune %.2f ms, zeros end <= %.2f ms after recv start, |bias|<0.5 dB from %.2f ms; first blocks %s\n", g, callMs / reps, zMaxMs, settleBlock * 0.25, devDb.dump().substr(0, 80).c_str());
    }
    out["perGain"] = perGain;
    std::ofstream f(a.guardtest); f << out.dump(1);
    u.close();
    return 0;
}
} // namespace

int main(int argc, char** argv) {
    setenv("UHD_LOG_FASTPATH_DISABLE", "1", 0);
    Args a = parse(argc, argv);
    if (a.help) { fprintf(stderr, "see header of main.cpp for usage\n"); return 0; }
    signal(SIGINT, onSignal); signal(SIGTERM, onSignal); signal(SIGPIPE, SIG_IGN);
    if (!a.fixtures.empty()) return emitFixtures(a.fixtures);
    if (a.find) return findDevices(a.deviceArgs);
    if (a.lock == "run/engine.lock" && !a.socket.empty()) { auto sl = a.socket.find_last_of('/'); std::string dir = sl == std::string::npos ? std::string(".") : a.socket.substr(0, sl); a.lock = dir + "/engine.lock"; if (a.eqDir == "data/eq") a.eqDir = dir + "/../data/eq"; }
    int lockFd = acquireLock(a.lock);
    (void)lockFd;
    if (a.probe) return probe(a);
    if (!a.calwrite.empty()) return calwrite(a);
    if (!a.guardtest.empty()) return guardtest(a);
    if (!a.eqcap.empty()) return eqcap(a);
    return runEngine(a);
}
