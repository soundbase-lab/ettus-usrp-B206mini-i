#include "protocol.hpp"

namespace scanner::proto {

void writeHeader(std::vector<uint8_t>& b, const Header& h) {
    if (b.size() < HEADER_BYTES) b.resize(HEADER_BYTES);
    put8(b, 0, MAGIC); put8(b, 1, VERSION); put8(b, 2, h.msgType); put8(b, 3, h.dtype);
    put16(b, 4, h.flags); put8(b, 6, h.traceCount); put8(b, 7, 0);
    put32(b, 8, h.sweepId); put32(b, 12, h.seq);
    putf64(b, 16, h.startHz); putf64(b, 24, h.stepHz); putf64(b, 32, h.tDeviceS);
    put32(b, 40, h.binCount); putf32(b, 44, h.rbwHz); put32(b, 48, h.frameLength);
    putf32(b, 52, h.gainDb); putf32(b, 56, h.kDbm); put16(b, 60, h.navg); put16(b, 62, h.profileId);
}

FrameBuilder::FrameBuilder(const Header& h) { buf_.resize(HEADER_BYTES); writeHeader(buf_, h); }

void FrameBuilder::addTrace(uint8_t detector, uint8_t kind, uint16_t avgCount, uint32_t filledBins, const float* values, size_t n) {
    size_t o = buf_.size();
    buf_.resize(o + TRACE_HEADER_BYTES + n * 4);
    put8(buf_, o, detector); put8(buf_, o + 1, kind); put16(buf_, o + 2, avgCount); put32(buf_, o + 4, filledBins);
    if (n) std::memcpy(&buf_[o + 8], values, n * 4);
    traces_++;
}

void FrameBuilder::addMask(const uint8_t* mask, size_t n, uint32_t filledBins) {
    size_t padded = (n + 3) & ~size_t(3);
    size_t o = buf_.size();
    buf_.resize(o + TRACE_HEADER_BYTES + padded, 0);
    put8(buf_, o, DetNone); put8(buf_, o + 1, KindMask); put16(buf_, o + 2, 0); put32(buf_, o + 4, filledBins);
    if (n) std::memcpy(&buf_[o + 8], mask, n);
    traces_++;
}

std::vector<uint8_t> FrameBuilder::finish() {
    put8(buf_, 6, traces_);
    put32(buf_, 48, uint32_t(buf_.size()));
    return std::move(buf_);
}

std::vector<uint8_t> makeJsonFrame(uint8_t msgType, const std::string& json, uint32_t seq, double tDeviceS, uint16_t profileId) {
    Header h; h.msgType = msgType; h.seq = seq; h.tDeviceS = tDeviceS; h.profileId = profileId;
    h.frameLength = uint32_t(HEADER_BYTES + json.size());
    std::vector<uint8_t> b(HEADER_BYTES + json.size());
    writeHeader(b, h);
    std::memcpy(&b[HEADER_BYTES], json.data(), json.size());
    return b;
}

bool parseHeader(const uint8_t* d, size_t len, Header& h) {
    if (len < HEADER_BYTES || d[0] != MAGIC || d[1] != VERSION) return false;
    h.msgType = d[2]; h.dtype = d[3];
    std::memcpy(&h.flags, d + 4, 2); h.traceCount = d[6];
    std::memcpy(&h.sweepId, d + 8, 4); std::memcpy(&h.seq, d + 12, 4);
    std::memcpy(&h.startHz, d + 16, 8); std::memcpy(&h.stepHz, d + 24, 8); std::memcpy(&h.tDeviceS, d + 32, 8);
    std::memcpy(&h.binCount, d + 40, 4); std::memcpy(&h.rbwHz, d + 44, 4); std::memcpy(&h.frameLength, d + 48, 4);
    std::memcpy(&h.gainDb, d + 52, 4); std::memcpy(&h.kDbm, d + 56, 4); std::memcpy(&h.navg, d + 60, 2); std::memcpy(&h.profileId, d + 62, 2);
    return h.frameLength == len;
}

bool parseTraces(const uint8_t* d, size_t len, const Header& h, std::vector<TraceRef>& out) {
    out.clear();
    size_t o = HEADER_BYTES;
    for (int i = 0; i < h.traceCount; ++i) {
        if (o + TRACE_HEADER_BYTES > len) return false;
        TraceRef t; t.detector = d[o]; t.kind = d[o + 1];
        std::memcpy(&t.avgCount, d + o + 2, 2); std::memcpy(&t.filledBins, d + o + 4, 4);
        size_t bytes = t.kind == KindMask ? ((h.binCount + 3) & ~size_t(3)) : size_t(h.binCount) * 4;
        if (o + TRACE_HEADER_BYTES + bytes > len) return false;
        t.payload = d + o + TRACE_HEADER_BYTES; t.payloadBytes = bytes;
        out.push_back(t);
        o += TRACE_HEADER_BYTES + bytes;
    }
    return o == len;
}

} // namespace scanner::proto
