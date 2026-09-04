// usrp.hpp: thin owner of the multi_usrp handle. All control calls happen on the engine's control thread.
#pragma once
#include "profile.hpp"
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <uhd/usrp/multi_usrp.hpp>
#include <vector>

namespace scanner {

struct DeviceInfo {
    std::string serial, product, mboard, fpgaVersion, fwVersion, deviceArgs;
    int usbVersion = 0;          // 2 or 3 (0 = unknown)
    double linkMaxRateBps = 0;
    double gainMin = 0, gainMax = 76;
    std::vector<std::string> antennas, sensors;
    double mcrHz = 0, rateHz = 0, tempC = 0;
    std::string antenna;
};

struct TuneOutcome {
    double rfHz = 0, dspHz = 0;
    double callMs = 0;
    bool recal = false;          // blocked > 50 ms: RF DC calibration ran
};

class Usrp {
public:
    // Opens with retries (PLAN.md 2: key_error / assertion_error for 2-10 s after a previous close).
    bool open(const std::string& args, int maxAttempts, double backoffS, std::string& err);
    void close();
    bool isOpen() const { return bool(usrp_); }
    DeviceInfo readInfo();
    const DeviceInfo& info() const { return info_; }

    // Pins MCR, sets and asserts the rate, re-applies the analog bandwidth (0 = leave UHD's default).
    void configureRates(const Profile& p, double analogBwHz);
    double setGain(double g);
    void setAntenna(const std::string& a);
    // Plain tune (tune_request_t(f)): used for calibration-point planting.
    TuneOutcome tunePlain(double fHz);
    // LO + DDC tune with MANUAL policies. rfHz must be the exact double reused for the same LO position.
    TuneOutcome tuneManual(double rfHz, double dspHz);
    // Timed DDC-only retune at device time atS (LO unchanged, exact rf double).
    TuneOutcome tuneManualAt(double atS, double rfHz, double dspHz);
    double timeNowS();
    void setTimeNow(double s);
    double tempC();
    bool loLocked();
    uhd::rx_streamer::sptr makeStreamer(const std::string& otw);
    void streamStart(uhd::rx_streamer::sptr s);
    void streamStop(uhd::rx_streamer::sptr s);
    // UHD power calibration: returns true and fills k when a cal table exists for this unit/antenna.
    bool powerReference(double& kDbm);
    uhd::usrp::multi_usrp::sptr raw() { return usrp_; }

    // Watchdog: steady-clock ns when a UHD call began, 0 when idle.
    std::atomic<int64_t> inCallSinceNs{0};
    uint64_t recals = 0;
private:
    struct CallGuard { Usrp& u; explicit CallGuard(Usrp& uu); ~CallGuard(); };
    uhd::usrp::multi_usrp::sptr usrp_;
    DeviceInfo info_;
};

} // namespace scanner
