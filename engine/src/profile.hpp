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
    // How far below the first LO grid the second one sits (interleave, imageReject). Half a hop is
    // the obvious offset, and where the LO sits inside the kept band it is the wrong one: a block
    // reads noise of its own beside its LO and towards its edges (see the table in stitch.cpp), and
    // half a hop puts each grid's LO exactly on the other's edge, so the cells there have no clean
    // reading in either grid. At 5/16 of a hop each grid's LO and edges fall in the flat part of the
    // other's blocks, and the two LOs stay far enough apart (14.9 MHz at 56 MS/s) that an LO-centred
    // artefact in one grid is never under the other's. Profiles with sub-windows keep half a hop:
    // their LO is already on a sub-window boundary, and their spur clearance was worked out for it.
    double altGridShiftHz() const { return loHole ? hopStepHz() * 5 / 16 : hopStepHz() / 2; }
};

const std::vector<Profile>& allProfiles();
const Profile* findProfile(const std::string& name);
const Profile* profileById(uint16_t id);
// Pick the best profile for a link (usbVersion 2 or 3). Never returns a sc8 profile automatically.
const Profile& autoProfile(int usbVersion);
// Device args needed for USB 3 rates (frame tuning, PLAN.md 4.1). Harmless on USB 2.
std::string deviceArgsFor(const std::string& userArgs);

} // namespace scanner
