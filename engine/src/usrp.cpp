#include "usrp.hpp"
#include "common.hpp"
#include <chrono>
#include <cmath>
#include <thread>
#include <uhd/exception.hpp>
#include <uhd/property_tree.hpp>
#include <uhd/utils/thread.hpp>

namespace scanner {

Usrp::CallGuard::CallGuard(Usrp& uu) : u(uu) {
    u.inCallSinceNs.store(std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count());
}
Usrp::CallGuard::~CallGuard() { u.inCallSinceNs.store(0); }

bool Usrp::open(const std::string& args, int maxAttempts, double backoffS, std::string& err) {
    for (int attempt = 1; attempt <= maxAttempts; ++attempt) {
        try {
            auto t0 = Clock::now();
            CallGuard g(*this);
            usrp_ = uhd::usrp::multi_usrp::make(uhd::device_addr_t(args));
            info_.deviceArgs = args;
            LOGI("device open in %.0f ms (attempt %d)", msSince(t0), attempt);
            return true;
        } catch (std::exception& e) {
            err = e.what();
            LOGW("open attempt %d/%d failed: %s", attempt, maxAttempts, e.what());
            if (attempt < maxAttempts) std::this_thread::sleep_for(std::chrono::duration<double>(backoffS));
        }
    }
    return false;
}

void Usrp::close() {
    if (!usrp_) return;
    CallGuard g(*this);
    usrp_.reset();
}

DeviceInfo Usrp::readInfo() {
    CallGuard g(*this);
    auto tree = usrp_->get_tree();
    auto rxinfo = usrp_->get_usrp_rx_info(0);
    info_.serial = rxinfo.get("mboard_serial", "");
    info_.product = rxinfo.get("mboard_id", "");
    info_.mboard = usrp_->get_mboard_name(0);
    const std::string mb = "/mboards/0";
    auto tryStr = [&](const std::string& path) -> std::string {
        try { if (tree->exists(path)) return tree->access<std::string>(path).get(); } catch (...) {}
        return "";
    };
    info_.fpgaVersion = tryStr(mb + "/fpga_version");
    info_.fwVersion = tryStr(mb + "/fw_version");
    // b200_impl publishes usb_version as int (3 or 2); older builds used a string.
    if (tree->exists(mb + "/usb_version")) {
        try { info_.usbVersion = tree->access<int>(mb + "/usb_version").get(); }
        catch (...) { try { info_.usbVersion = std::atoi(tree->access<std::string>(mb + "/usb_version").get().c_str()); } catch (...) {} }
    }
    try { if (tree->exists(mb + "/link_max_rate")) info_.linkMaxRateBps = tree->access<double>(mb + "/link_max_rate").get(); } catch (...) {}
    auto gr = usrp_->get_rx_gain_range(0);
    info_.gainMin = gr.start(); info_.gainMax = gr.stop();
    info_.antennas = usrp_->get_rx_antennas(0);
    info_.sensors = usrp_->get_rx_sensor_names(0);
    info_.mcrHz = usrp_->get_master_clock_rate(0);
    info_.rateHz = usrp_->get_rx_rate(0);
    info_.antenna = usrp_->get_rx_antenna(0);
    info_.tempC = tempC();
    return info_;
}

void Usrp::configureRates(const Profile& p, double analogBwHz) {
    CallGuard g(*this);
    usrp_->set_master_clock_rate(p.mcrHz);
    usrp_->set_rx_rate(p.rateHz);
    double actual = usrp_->get_rx_rate(0), mcr = usrp_->get_master_clock_rate(0);
    if (std::fabs(actual - p.rateHz) > 1.0) throw std::runtime_error("rate not honoured: requested " + std::to_string(p.rateHz) + " got " + std::to_string(actual));
    if (std::fabs(mcr - p.mcrHz) > 1.0) throw std::runtime_error("MCR not honoured: requested " + std::to_string(p.mcrHz) + " got " + std::to_string(mcr));
    if (analogBwHz > 0) usrp_->set_rx_bandwidth(analogBwHz, 0); // must come after the final set_rx_rate (PLAN.md 2)
    info_.mcrHz = mcr; info_.rateHz = actual;
}

double Usrp::setGain(double gdb) {
    CallGuard g(*this);
    usrp_->set_rx_gain(gdb, 0);
    return usrp_->get_rx_gain(0);
}

void Usrp::setAntenna(const std::string& a) {
    CallGuard g(*this);
    usrp_->set_rx_antenna(a, 0);
    info_.antenna = usrp_->get_rx_antenna(0);
}

TuneOutcome Usrp::tunePlain(double f) {
    CallGuard g(*this);
    auto t0 = Clock::now();
    uhd::tune_result_t r = usrp_->set_rx_freq(uhd::tune_request_t(f), 0);
    TuneOutcome o; o.rfHz = r.actual_rf_freq; o.dspHz = r.actual_dsp_freq; o.callMs = msSince(t0);
    o.recal = o.callMs > 50.0; if (o.recal) recals++;
    return o;
}

TuneOutcome Usrp::tuneManual(double rfHz, double dspHz) {
    CallGuard g(*this);
    uhd::tune_request_t tr(rfHz - dspHz);
    tr.rf_freq_policy = uhd::tune_request_t::POLICY_MANUAL; tr.rf_freq = rfHz;
    tr.dsp_freq_policy = uhd::tune_request_t::POLICY_MANUAL; tr.dsp_freq = dspHz;
    auto t0 = Clock::now();
    uhd::tune_result_t r = usrp_->set_rx_freq(tr, 0);
    TuneOutcome o; o.rfHz = r.actual_rf_freq; o.dspHz = r.actual_dsp_freq; o.callMs = msSince(t0);
    o.recal = o.callMs > 50.0; if (o.recal) recals++;
    return o;
}

TuneOutcome Usrp::tuneManualAt(double atS, double rfHz, double dspHz) {
    CallGuard g(*this);
    uhd::tune_request_t tr(rfHz - dspHz);
    tr.rf_freq_policy = uhd::tune_request_t::POLICY_MANUAL; tr.rf_freq = rfHz;
    tr.dsp_freq_policy = uhd::tune_request_t::POLICY_MANUAL; tr.dsp_freq = dspHz;
    auto t0 = Clock::now();
    usrp_->set_command_time(uhd::time_spec_t(atS), 0);
    uhd::tune_result_t r = usrp_->set_rx_freq(tr, 0);
    usrp_->clear_command_time(0);
    TuneOutcome o; o.rfHz = r.actual_rf_freq; o.dspHz = r.actual_dsp_freq; o.callMs = msSince(t0);
    return o;
}

double Usrp::timeNowS() { CallGuard g(*this); return usrp_->get_time_now(0).get_real_secs(); }
void Usrp::setTimeNow(double s) { CallGuard g(*this); usrp_->set_time_now(uhd::time_spec_t(s), 0); }

double Usrp::tempC() {
    try {
        CallGuard g(*this);
        for (auto& s : info_.sensors.empty() ? usrp_->get_rx_sensor_names(0) : info_.sensors)
            if (s == "temp") return usrp_->get_rx_sensor("temp", 0).to_real();
    } catch (...) {}
    return 0;
}

bool Usrp::loLocked() {
    try { CallGuard g(*this); return usrp_->get_rx_sensor("lo_locked", 0).to_bool(); } catch (...) { return false; }
}

uhd::rx_streamer::sptr Usrp::makeStreamer(const std::string& otw) {
    CallGuard g(*this);
    uhd::stream_args_t sa("sc16", otw);
    sa.channels = {0};
    return usrp_->get_rx_stream(sa);
}

void Usrp::streamStart(uhd::rx_streamer::sptr s) {
    CallGuard g(*this);
    uhd::stream_cmd_t c(uhd::stream_cmd_t::STREAM_MODE_START_CONTINUOUS);
    c.stream_now = true;
    s->issue_stream_cmd(c);
}

void Usrp::streamStop(uhd::rx_streamer::sptr s) {
    CallGuard g(*this);
    s->issue_stream_cmd(uhd::stream_cmd_t(uhd::stream_cmd_t::STREAM_MODE_STOP_CONTINUOUS));
}

bool Usrp::powerReference(double& k) {
    try {
        CallGuard g(*this);
        if (!usrp_->has_rx_power_reference(0)) return false;
        k = usrp_->get_rx_power_reference(0);
        return true;
    } catch (...) { return false; }
}

} // namespace scanner
