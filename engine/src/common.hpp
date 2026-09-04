// common.hpp: small shared helpers for the engine (logging, time, clamps).
#pragma once
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <mutex>
#include <string>

namespace scanner {

using Clock = std::chrono::steady_clock;

inline double nowS() {
    static const auto t0 = Clock::now();
    return std::chrono::duration<double>(Clock::now() - t0).count();
}
inline double msSince(Clock::time_point t) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t).count();
}

enum class LogLevel { Debug, Info, Warn, Error };

// Log sink: defaults to stderr; the engine installs a sink that also forwards to the socket.
using LogSink = std::function<void(LogLevel, const std::string&)>;
void setLogSink(LogSink sink);
void logf(LogLevel lvl, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
#define LOGD(...) ::scanner::logf(::scanner::LogLevel::Debug, __VA_ARGS__)
#define LOGI(...) ::scanner::logf(::scanner::LogLevel::Info, __VA_ARGS__)
#define LOGW(...) ::scanner::logf(::scanner::LogLevel::Warn, __VA_ARGS__)
#define LOGE(...) ::scanner::logf(::scanner::LogLevel::Error, __VA_ARGS__)

template <class T> constexpr T clampv(T v, T lo, T hi) { return v < lo ? lo : (v > hi ? hi : v); }

inline float linToDb(float p) { return p > 0.f ? 10.f * std::log10(p) : -300.f; }
inline double linToDb(double p) { return p > 0. ? 10. * std::log10(p) : -300.; }
inline double dbToLin(double db) { return std::pow(10., db / 10.); }

// Running median helper over a small window (hop timing statistics).
struct Stats {
    double sum = 0, sumsq = 0, minv = 1e300, maxv = -1e300;
    uint64_t n = 0;
    void add(double v) { sum += v; sumsq += v * v; n++; if (v < minv) minv = v; if (v > maxv) maxv = v; }
    double mean() const { return n ? sum / double(n) : 0; }
    void reset() { *this = Stats{}; }
};

} // namespace scanner
