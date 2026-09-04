// cal.hpp: amplitude scale K(gain, freq) = input power (dBm) that yields 0 dBFS (PLAN.md 5.5).
#pragma once
#include <memory>
#include <string>
#include <vector>

namespace scanner {

class CalModel {
public:
    virtual ~CalModel() = default;
    virtual double kDbm(double gainDb, double freqHz) const = 0;
    // Inverse: gain that gives K == kTargetDbm at freqHz (continuous, caller rounds/clamps).
    virtual double gainForK(double kTargetDbm, double freqHz) const = 0;
    virtual bool calibrated() const = 0;
    virtual std::string source() const = 0;
};

// Built-in estimate K(g) = +10 - g dBm (PLAN.md: derived from clean floors, +-5 dB, valid 45..76 dB).
class DefaultCal : public CalModel {
public:
    double kDbm(double g, double) const override { return 10.0 - g; }
    double gainForK(double k, double) const override { return 10.0 - k; }
    bool calibrated() const override { return false; }
    std::string source() const override { return "default"; }
};

// Table-driven model loaded from UHD's power-cal database (cal_uhd.cpp). Piecewise-linear in gain and freq.
struct CalPoint { double freqHz; double gainDb; double kDbm; };
class TableCal : public CalModel {
public:
    explicit TableCal(std::vector<CalPoint> pts, std::string src);
    double kDbm(double g, double f) const override;
    double gainForK(double k, double f) const override;
    bool calibrated() const override { return !pts_.empty(); }
    std::string source() const override { return src_; }
private:
    std::vector<CalPoint> pts_;
    std::vector<double> freqs_;
    std::string src_;
    double kAtFreq(size_t fi, double g) const;
};

} // namespace scanner
