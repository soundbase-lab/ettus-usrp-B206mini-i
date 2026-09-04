// cal_uhd.hpp: bridge to UHD's power-calibration database (pwr_cal) for this unit.
#pragma once
#include "cal.hpp"
#include <memory>
#include <string>
#include <vector>

namespace scanner {

// Loads the RX power table for (serial, antenna) from UHD's cal database; nullptr when none exists.
std::unique_ptr<CalModel> loadUhdCal(const std::string& serial, const std::string& antenna, std::string& info);

struct CalMeasurement { double freqHz; double gainDb; double refDbm; double measuredDbfs; double tempC; };
// Writes/merges measurements into the UHD database: K = refDbm - measuredDbfs for each (freq, gain).
bool writeUhdCal(const std::string& serial, const std::string& antenna, const std::vector<CalMeasurement>& m, std::string& err);
std::string uhdCalKey(const std::string& antenna);

} // namespace scanner
