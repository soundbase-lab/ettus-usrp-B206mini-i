#include "common.hpp"
#include <vector>

namespace scanner {

static std::mutex g_logMutex;
static LogSink g_sink;

void setLogSink(LogSink sink) {
    std::lock_guard<std::mutex> lk(g_logMutex);
    g_sink = std::move(sink);
}

void logf(LogLevel lvl, const char* fmt, ...) {
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    LogSink sink;
    {
        std::lock_guard<std::mutex> lk(g_logMutex);
        sink = g_sink;
        const char* tag = lvl == LogLevel::Debug ? "D" : lvl == LogLevel::Info ? "I" : lvl == LogLevel::Warn ? "W" : "E";
        fprintf(stderr, "[engine %s %9.3f] %s\n", tag, nowS(), buf);
    }
    if (sink) sink(lvl, buf);
}

} // namespace scanner
