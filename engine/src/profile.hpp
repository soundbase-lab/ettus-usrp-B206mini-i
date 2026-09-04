// profile.hpp: rate / clock / sub-window profiles (PLAN.md section 4.1).
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace scanner {

struct Profile {
    std::string name;
    uint16_t id = 0;
    double mcrHz = 32e6;      // master clock rate (pinned)
    double rateHz = 8e6;      // sample rate (asserted after set)
    std::string otw = "sc16"; // wire format
    double keptHz = 6.8e6;    // total kept RF per LO position (K * subWidthHz)
    int subWindows = 1;       // K
    double loOffsetHz = 0;    // K == 1 only: LO = window centre + loOffsetHz (LO outside the kept band)
    bool loHole = false;      // decim-1 profiles: LO sits inside the kept region, blank +-10 kHz
    double minGainDb = 0;     // sc8 profiles need >= 55 dB
    bool needsUsb3 = false;
    double subWidthHz() const { return keptHz / subWindows; }
    double overlapHz() const { return 300e3; }                  // overlap between adjacent LO positions
    double hopStepHz() const { return keptHz - overlapHz(); }   // LO grid step
};

const std::vector<Profile>& allProfiles();
const Profile* findProfile(const std::string& name);
const Profile* profileById(uint16_t id);
// Pick the best profile for a link (usbVersion 2 or 3). Never returns a sc8 profile automatically.
const Profile& autoProfile(int usbVersion);
// Device args needed for USB 3 rates (frame tuning, PLAN.md 4.1). Harmless on USB 2.
std::string deviceArgsFor(const std::string& userArgs);

} // namespace scanner
