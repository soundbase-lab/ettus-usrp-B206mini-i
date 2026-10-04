#include "sweep_planner.hpp"
#include <cmath>
#include <cstdio>
#include <nlohmann/json.hpp>
using namespace scanner;
static int fails = 0;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)
int main() {
    DefaultCal cal; PlanRequest r; r.profile = "usb2-simple";
    auto pl = makePlan(r, *findProfile("usb2-simple"), cal, true);
    CHECK(pl.binCount == 5521 && pl.stepHz == 25e3);
    CHECK(pl.fftN == 5120 && pl.kBins == 16);
    CHECK(pl.nAvg >= 10);              // coordination dwell: 10 ms at 8 MS/s with N=5120 -> 31 frames
    CHECK(pl.grid[0].size() == 22);    // 138 MHz + rbw / 6.5 MHz step with 6.8 MHz kept
    CHECK(pl.grid[1].size() == 23);
    CHECK(pl.segCentres.size() == 1);
    // LO sits 6 MHz above each window centre and outside the kept band; baseband centre = lo - dsp
    for (auto& lp : pl.grid[0]) {
        CHECK(lp.sub.size() == 1);
        const auto& sw = lp.sub[0];
        CHECK(std::fabs((lp.loHz - sw.dspHz) - sw.rfCentreHz) < 1e-3);
        CHECK(std::fabs(sw.dspHz - 6e6) < 1e-3);
        CHECK(lp.loHz > sw.keptHiHz + 2e6);
    }
    // coverage: first kept lo <= 470 - rbw/2, last kept hi >= 608 + rbw/2
    CHECK(pl.grid[0].front().sub[0].keptLoHz <= 470e6 - 12.5e3 + 1);
    CHECK(pl.grid[0].back().sub[0].keptHiHz >= 608e6 + 12.5e3 - 1);
    // gain cap from ref level: -50 dBm -> K^-1(-40) = 50 dB
    CHECK(pl.gainCapDb == 50 && pl.req.gainDb == 50);
    CHECK(pl.gainStartDb == 30);       // auto mode starts below the cap and creeps up
    // 4-window profile: LO on the boundary between sub-windows 1 and 2, offsets +-3.4 / +-10.2 MHz
    PlanRequest r2; r2.profile = "usb2"; auto p2 = makePlan(r2, *findProfile("usb2"), cal, true);
    CHECK(p2.grid[0].size() == 6);
    auto& lp = p2.grid[0][0];
    CHECK(lp.sub.size() == 4);
    CHECK(std::fabs(lp.sub[0].dspHz - 10.2e6) < 1 && std::fabs(lp.sub[1].dspHz - 3.4e6) < 1 && std::fabs(lp.sub[2].dspHz + 3.4e6) < 1 && std::fabs(lp.sub[3].dspHz + 10.2e6) < 1);
    for (auto& sw : lp.sub) CHECK(!(lp.loHz > sw.keptLoHz + 1 && lp.loHz < sw.keptHiHz - 1)); // LO never strictly inside a kept band
    // interleave: the odd grid is the even grid shifted down by Profile::altGridShiftHz — half a hop for a profile with sub-windows — (one extra position), and still covers the span
    CHECK(p2.grid[1].size() >= p2.grid[0].size() && p2.grid[1].size() <= p2.grid[0].size() + 1);
    for (auto& lp : p2.grid[1]) {   // every odd LO sits that shift off the even pitch
        double k = (lp.loHz - (p2.grid[0].front().loHz - p2.prof.altGridShiftHz())) / p2.prof.hopStepHz();
        CHECK(std::fabs(k - std::round(k)) < 1e-6);
    }
    CHECK(p2.grid[1].front().sub.front().keptLoHz <= 470e6 - 12.5e3 + 1);
    CHECK(p2.grid[1].back().sub.back().keptHiHz >= 608e6 + 12.5e3 - 1);
    for (size_t i = 1; i < p2.grid[1].size(); ++i) CHECK(p2.grid[1][i].sub.front().keptLoHz < p2.grid[1][i - 1].sub.back().keptHiHz); // adjacent blocks overlap
    // LOs are kept clear of internal spurs: usb3-56 on 470-616 MHz would park an LO at 519.15 (13 x 40 = 520) and
    // 614.55 (11 x 56 = 616); the planner shifts the grid instead
    PlanRequest r5; r5.startHz = 470e6; r5.stopHz = 616e6; r5.profile = "usb3-56";
    auto p5 = makePlan(r5, *findProfile("usb3-56"), cal, true);
    CHECK(p5.loGridAutoShiftHz != 0 && std::fabs(p5.loGridAutoShiftHz) <= 22e6);
    for (int g = 0; g < 2; ++g) for (auto& lp : p5.grid[g]) CHECK(spurDistanceHz(lp.loHz, 56e6) >= 2.5e6);
    CHECK(p5.grid[0].size() == 4);   // the shift fits in the slack: no extra hop
    // Where the LO sits inside the kept band the second grid is 5/16 of a hop off the first, which is
    // what gives every cell a clean reading: no LO of one grid falls near an edge of the other's
    // blocks, which is where exactly half a hop would put it.
    CHECK(std::fabs(p5.prof.altGridShiftHz() - p5.prof.hopStepHz() * 5 / 16) < 1);
    for (int a = 0; a < 2; ++a)
        for (auto& lo : p5.grid[a])
            for (auto& other : p5.grid[1 - a]) {
                const double lowEdge = other.sub.front().keptLoHz, highEdge = other.sub.back().keptHiHz, clear = p5.prof.hopStepHz() / 8;
                CHECK(std::fabs(lo.loHz - lowEdge) > clear && std::fabs(lo.loHz - highEdge) > clear);
            }
    CHECK(p5.grid[0].front().sub[0].keptLoHz <= 470e6 - 12.5e3 + 1 && p5.grid[0].back().sub[0].keptHiHz >= 616e6 + 12.5e3 - 1);
    // usb2 on 470-608 cannot get 13 LOs 2.5 MHz clear of spurs every 32 and 40 MHz; the free shift must still lift
    // the worst case (an odd LO right on 512 MHz) to >= 1.5 MHz without adding hops
    CHECK(p2.grid[0].size() == 6);
    { double m = 1e300; for (int g = 0; g < 2; ++g) for (auto& lp : p2.grid[g]) m = std::min(m, spurDistanceHz(lp.loHz, 32e6)); CHECK(m >= 1.5e6); }
    // wide span needs several segments
    PlanRequest r3; r3.startHz = 470e6; r3.stopHz = 952e6; r3.profile = "usb2";
    auto p3 = makePlan(r3, *findProfile("usb2"), cal, true);
    CHECK(p3.segCentres.size() == 3);
    // JSON round trip / patch
    nlohmann::json patch = {{"rbwHz", 12500}, {"detector", "peak"}, {"bogus", 1}};
    PlanRequest r4; auto w = r4.applyJson(patch);
    CHECK(r4.rbwHz == 12500 && r4.detector == proto::DetPeak && w.size() == 1);
    auto p4 = makePlan(r4, *findProfile("usb2-simple"), cal, false);
    CHECK(p4.stepHz == 12500 && p4.binCount == 11041 && p4.fftN == 10240);
    fprintf(stderr, "usb2-simple predicted %.0f ms (nAvg %d), usb2 %.0f ms\n", pl.predictedSweepMs, pl.nAvg, p2.predictedSweepMs);
    if (!fails) printf("planner: ok\n");
    return fails ? 1 : 0;
}
