#include "profile.hpp"

namespace scanner {

const std::vector<Profile>& allProfiles() {
    static const std::vector<Profile> v = {
        // name          id  mcr    rate  otw     kept     K  loOff  hole  minG  usb3
        {"usb2",         1, 32e6,  8e6,  "sc16", 27.2e6, 4, 0,     false, 0,  false},
        {"usb2-simple",  2, 32e6,  8e6,  "sc16", 6.8e6,  1, 6e6,   false, 0,  false},
        {"usb2-turbo",   3, 40e6,  20e6, "sc8",  34e6,   2, 0,     false, 55, false},
        {"usb3-16",      4, 32e6,  16e6, "sc16", 27.2e6, 2, 0,     false, 0,  true},
        {"usb3-28",      5, 56e6,  28e6, "sc16", 47.6e6, 2, 0,     false, 0,  true},
        {"usb3-32",      6, 32e6,  32e6, "sc16", 27.2e6, 1, 0,     true,  0,  true},
        {"usb3-56",      7, 56e6,  56e6, "sc16", 48e6,   1, 0,     true,  0,  true},
    };
    return v;
}

const Profile* findProfile(const std::string& name) {
    for (auto& p : allProfiles()) if (p.name == name) return &p;
    return nullptr;
}
const Profile* profileById(uint16_t id) {
    for (auto& p : allProfiles()) if (p.id == id) return &p;
    return nullptr;
}
const Profile& autoProfile(int usbVersion) {
    return *findProfile(usbVersion >= 3 ? "usb3-56" : "usb2");
}
std::string deviceArgsFor(const std::string& userArgs) {
    std::string a = userArgs.empty() ? "type=b200" : userArgs;
    if (a.find("recv_frame_size") == std::string::npos) a += ",recv_frame_size=16360";
    if (a.find("num_recv_frames") == std::string::npos) a += ",num_recv_frames=256";
    return a;
}

} // namespace scanner
