// socket.hpp: Unix-domain-socket client. Frames out (u32 length + body), JSON lines in.
#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace scanner {

class UdsClient {
public:
    ~UdsClient();
    bool connect(const std::string& path, int attempts, double backoffS);
    bool connected() const { return fd_ >= 0; }
    // Thread-safe; returns false when the peer is gone.
    bool sendFrame(const std::vector<uint8_t>& frame);
    // Starts a reader thread; onLine is called for each newline-terminated line; onClose once at EOF/error.
    void startReader(std::function<void(const std::string&)> onLine, std::function<void()> onClose);
    void close();
private:
    int fd_ = -1;
    std::mutex wmu_;
    std::thread reader_;
    std::atomic<bool> closing_{false};
};

} // namespace scanner
