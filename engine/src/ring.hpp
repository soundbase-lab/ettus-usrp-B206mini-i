// ring.hpp: lock-free single-producer / single-consumer ring of fixed slots.
#pragma once
#include <atomic>
#include <cstddef>
#include <vector>

namespace scanner {

template <class T>
class SpscRing {
public:
    explicit SpscRing(size_t slots) : slots_(slots), buf_(slots) {}
    size_t capacity() const { return slots_; }
    size_t size() const { return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire); }
    // Producer: slot to fill, or nullptr when full.
    T* beginWrite() {
        size_t h = head_.load(std::memory_order_relaxed);
        if (h - tail_.load(std::memory_order_acquire) >= slots_) return nullptr;
        return &buf_[h % slots_];
    }
    void commitWrite() { head_.store(head_.load(std::memory_order_relaxed) + 1, std::memory_order_release); }
    // Consumer: next slot to read, or nullptr when empty.
    T* peekRead() {
        size_t t = tail_.load(std::memory_order_relaxed);
        if (t == head_.load(std::memory_order_acquire)) return nullptr;
        return &buf_[t % slots_];
    }
    void commitRead() { tail_.store(tail_.load(std::memory_order_relaxed) + 1, std::memory_order_release); }
private:
    size_t slots_;
    std::vector<T> buf_;
    alignas(64) std::atomic<size_t> head_{0};
    alignas(64) std::atomic<size_t> tail_{0};
};

} // namespace scanner
