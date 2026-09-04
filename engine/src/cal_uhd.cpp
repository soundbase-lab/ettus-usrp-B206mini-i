#include "cal_uhd.hpp"
#include "common.hpp"
#include <algorithm>
#include <map>
#include <uhd/cal/database.hpp>
#include <uhd/cal/pwr_cal.hpp>

namespace scanner {

std::string uhdCalKey(const std::string& antenna) {
    std::string a = antenna; std::transform(a.begin(), a.end(), a.begin(), ::tolower);
    if (a == "tx/rx") a = "txrx";
    return "b2xxmini_pwr_rx_" + a;
}

std::unique_ptr<CalModel> loadUhdCal(const std::string& serial, const std::string& antenna, std::string& info) {
    using namespace uhd::usrp::cal;
    const std::string key = uhdCalKey(antenna), ser = serial + "#A";
    try {
        if (!database::has_cal_data(key, ser)) { info = "no UHD cal for " + key + "/" + ser; return nullptr; }
        auto blob = database::read_cal_data(key, ser);
        auto pc = container::make<pwr_cal>(blob);
        // pwr_cal has no frequency enumerator: sample the table on a 10 MHz grid over the UHF range we use.
        std::vector<CalPoint> pts; int nf = 0;
        for (double f = 400e6; f <= 2500e6; f += 10e6) {
            bool any = false;
            for (double g = 0; g <= 76; g += 1.0) {
                try { pts.push_back({f, g, pc->get_power(g, f)}); any = true; } catch (...) {}
            }
            if (any) nf++;
        }
        if (pts.empty()) { info = "UHD cal table empty"; return nullptr; }
        info = "UHD pwr_cal " + key + " (" + std::to_string(nf) + " sampled freqs, temp " + std::to_string(pc->get_temperature()) + " C)";
        return std::make_unique<TableCal>(std::move(pts), "uhd");
    } catch (std::exception& e) { info = std::string("UHD cal read failed: ") + e.what(); return nullptr; }
}

bool writeUhdCal(const std::string& serial, const std::string& antenna, const std::vector<CalMeasurement>& ms, std::string& err) {
    using namespace uhd::usrp::cal;
    const std::string key = uhdCalKey(antenna), ser = serial + "#A";
    try {
        auto pc = pwr_cal::make(key, ser, uint64_t(time(nullptr)));
        std::map<double, std::map<double, double>> byFreq;
        double temp = 0; int nt = 0;
        for (auto& m : ms) { byFreq[m.freqHz][m.gainDb] = m.refDbm - m.measuredDbfs; if (m.tempC > 0) { temp += m.tempC; nt++; } }
        for (auto& [f, tbl] : byFreq) pc->add_power_table(tbl, -200.0, 200.0, f);
        if (nt) pc->set_temperature(int(temp / nt));
        database::write_cal_data(key, ser, pc->serialize());
        return true;
    } catch (std::exception& e) { err = e.what(); return false; }
}

} // namespace scanner
