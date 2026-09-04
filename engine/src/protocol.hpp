// protocol.hpp: binary frame codec (docs/protocol.md, version 1). Little-endian, 64-byte header.
#pragma once
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace scanner::proto {

constexpr uint8_t MAGIC = 0x53;
constexpr uint8_t VERSION = 1;
constexpr size_t HEADER_BYTES = 64;
constexpr size_t TRACE_HEADER_BYTES = 8;

enum MsgType : uint8_t { TraceComplete = 1, TracePartial = 2, StatusJson = 3, LogJson = 4 };
enum Flag : uint16_t {
    FlagSweepComplete = 1, FlagOverflowSeen = 2, FlagClipped = 4, FlagRecalHappened = 8,
    FlagUsb2 = 16, FlagUncalibrated = 32, FlagInterleaveParity = 64, FlagGainChanged = 128
};
enum Detector : uint8_t { DetRms = 0, DetPeak = 1, DetSample = 2, DetMin = 3, DetNone = 255 };
enum Kind : uint8_t { KindLiveAvg = 0, KindLivePeak = 1, KindMaxHold = 2, KindMinHold = 3, KindAvg = 4, KindMask = 5, KindLiveMin = 6, KindLiveSample = 7 };
enum MaskBit : uint8_t { MaskHole = 1, MaskInterp = 2, MaskSpur = 4, MaskOverflow = 8, MaskClip = 16, MaskImage = 32, MaskLoHole = 64 };

struct Header {
    uint8_t msgType = TraceComplete;
    uint8_t dtype = 0;
    uint16_t flags = 0;
    uint8_t traceCount = 0;
    uint32_t sweepId = 0;
    uint32_t seq = 0;
    double startHz = 0, stepHz = 0, tDeviceS = 0;
    uint32_t binCount = 0;
    float rbwHz = 0;
    uint32_t frameLength = 0;
    float gainDb = 0, kDbm = 0;
    uint16_t navg = 0, profileId = 0;
};

inline void put8(std::vector<uint8_t>& b, size_t o, uint8_t v) { b[o] = v; }
inline void put16(std::vector<uint8_t>& b, size_t o, uint16_t v) { std::memcpy(&b[o], &v, 2); }
inline void put32(std::vector<uint8_t>& b, size_t o, uint32_t v) { std::memcpy(&b[o], &v, 4); }
inline void putf32(std::vector<uint8_t>& b, size_t o, float v) { std::memcpy(&b[o], &v, 4); }
inline void putf64(std::vector<uint8_t>& b, size_t o, double v) { std::memcpy(&b[o], &v, 8); }

// Builds one frame: header + trace blocks. finish() patches traceCount and frameLength.
class FrameBuilder {
public:
    explicit FrameBuilder(const Header& h);
    void addTrace(uint8_t detector, uint8_t kind, uint16_t avgCount, uint32_t filledBins, const float* values, size_t n);
    void addMask(const uint8_t* mask, size_t n, uint32_t filledBins);
    std::vector<uint8_t> finish();
private:
    std::vector<uint8_t> buf_;
    uint8_t traces_ = 0;
};

std::vector<uint8_t> makeJsonFrame(uint8_t msgType, const std::string& json, uint32_t seq, double tDeviceS, uint16_t profileId);
void writeHeader(std::vector<uint8_t>& buf, const Header& h);
bool parseHeader(const uint8_t* data, size_t len, Header& out);

struct TraceRef { uint8_t detector, kind; uint16_t avgCount; uint32_t filledBins; const uint8_t* payload; size_t payloadBytes; };
// Splits a frame into trace references (for tests / fixtures). Returns false on malformed input.
bool parseTraces(const uint8_t* data, size_t len, const Header& h, std::vector<TraceRef>& out);

} // namespace scanner::proto
