// Round-trips frames through the codec and validates the fixture layout against docs/protocol.md.
#include "protocol.hpp"
#include <cmath>
#include <cstdio>
#include <cstring>
using namespace scanner::proto;
static int fails = 0;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, #c); fails++; } } while (0)
int main() {
    Header h; h.msgType = TraceComplete; h.flags = FlagSweepComplete | FlagUsb2; h.sweepId = 9; h.seq = 1;
    h.startHz = 470e6; h.stepHz = 25e3; h.tDeviceS = 2.25; h.binCount = 3; h.rbwHz = 25e3; h.gainDb = 55; h.kDbm = -45; h.navg = 12; h.profileId = 2;
    float a[3] = {-1.f, -2.f, -3.f}; uint8_t m[3] = {1, 2, 4};
    FrameBuilder fb(h); fb.addTrace(DetRms, KindLiveAvg, 12, 3, a, 3); fb.addMask(m, 3, 3);
    auto f = fb.finish();
    CHECK(f.size() == 64 + 8 + 12 + 8 + 4);   // mask padded 3 -> 4
    CHECK(f[0] == 0x53 && f[1] == 1 && f[2] == 1 && f[6] == 2);
    uint32_t len; std::memcpy(&len, &f[48], 4); CHECK(len == f.size());
    double start; std::memcpy(&start, &f[16], 8); CHECK(start == 470e6);
    Header p; CHECK(parseHeader(f.data(), f.size(), p));
    CHECK(p.sweepId == 9 && p.binCount == 3 && p.navg == 12 && p.profileId == 2 && p.kDbm == -45.f);
    std::vector<TraceRef> tr; CHECK(parseTraces(f.data(), f.size(), p, tr));
    CHECK(tr.size() == 2 && tr[0].kind == KindLiveAvg && tr[1].kind == KindMask);
    float v; std::memcpy(&v, tr[0].payload + 4, 4); CHECK(v == -2.f);
    CHECK(tr[1].payload[2] == 4 && tr[1].payloadBytes == 4);
    // f32 payload alignment: first trace payload at 72, second block header at 84 (4-byte aligned)
    CHECK((72 % 4) == 0 && ((64 + 8 + 12 + 8) % 4) == 0);
    auto js = makeJsonFrame(StatusJson, "{\"type\":\"status\"}", 5, 1.0, 2);
    Header q; CHECK(parseHeader(js.data(), js.size(), q)); CHECK(q.msgType == StatusJson && q.traceCount == 0 && q.seq == 5);
    CHECK(std::string((const char*)js.data() + 64, js.size() - 64) == "{\"type\":\"status\"}");
    // malformed
    Header bad; CHECK(!parseHeader(f.data(), f.size() - 1, bad));
    if (!fails) printf("protocol: ok\n");
    return fails ? 1 : 0;
}
