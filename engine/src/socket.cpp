#include "socket.hpp"
#include "common.hpp"
#include <cerrno>
#include <chrono>
#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace scanner {

UdsClient::~UdsClient() { close(); }

bool UdsClient::connect(const std::string& path, int attempts, double backoffS) {
    for (int i = 1; i <= attempts; ++i) {
        int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0) return false;
        sockaddr_un addr{}; addr.sun_family = AF_UNIX;
        std::strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);
        if (::connect(fd, (sockaddr*)&addr, sizeof addr) == 0) {
            fd_ = fd;
            int sz = 4 << 20; setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sz, sizeof sz);
            LOGI("connected to %s", path.c_str());
            return true;
        }
        LOGW("connect %s failed (%s), attempt %d/%d", path.c_str(), strerror(errno), i, attempts);
        ::close(fd);
        if (i < attempts) std::this_thread::sleep_for(std::chrono::duration<double>(backoffS));
    }
    return false;
}

bool UdsClient::sendFrame(const std::vector<uint8_t>& frame) {
    std::lock_guard<std::mutex> lk(wmu_);
    if (fd_ < 0) return false;
    uint32_t len = uint32_t(frame.size());
    uint8_t hdr[4]; std::memcpy(hdr, &len, 4);
    auto writeAll = [&](const uint8_t* p, size_t n) {
        while (n) {
            ssize_t w = ::send(fd_, p, n, 0);
            if (w < 0) { if (errno == EINTR) continue; return false; }
            p += w; n -= size_t(w);
        }
        return true;
    };
    if (!writeAll(hdr, 4) || !writeAll(frame.data(), frame.size())) {
        LOGW("socket write failed: %s", strerror(errno));
        return false;
    }
    return true;
}

void UdsClient::startReader(std::function<void(const std::string&)> onLine, std::function<void()> onClose) {
    reader_ = std::thread([this, onLine, onClose] {
        std::string acc; char buf[4096];
        while (!closing_) {
            ssize_t n = ::recv(fd_, buf, sizeof buf, 0);
            if (n <= 0) { if (n < 0 && errno == EINTR) continue; break; }
            acc.append(buf, size_t(n));
            size_t pos;
            while ((pos = acc.find('\n')) != std::string::npos) {
                std::string line = acc.substr(0, pos); acc.erase(0, pos + 1);
                if (!line.empty()) onLine(line);
            }
        }
        if (!closing_) onClose();
    });
}

void UdsClient::close() {
    closing_ = true;
    if (fd_ >= 0) { ::shutdown(fd_, SHUT_RDWR); ::close(fd_); fd_ = -1; }
    if (reader_.joinable()) { if (reader_.get_id() == std::this_thread::get_id()) reader_.detach(); else reader_.join(); }
}

} // namespace scanner
