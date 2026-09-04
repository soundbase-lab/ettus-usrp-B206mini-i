// fft.hpp: 3-function FFT backend interface. The only implementation today is pffft (fft_pffft.cpp).
#pragma once
#include <cstdint>
#include <memory>

namespace scanner {

class Fft {
public:
    virtual ~Fft() = default;
    virtual int size() const = 0;
    // Forward complex FFT of `in` (N interleaved re,im floats, 16-byte aligned) and write |X|^2 for each
    // bin into `powerOut` (N floats) in fft-shifted order: index i <-> frequency (i - N/2) * fs / N.
    virtual void forwardPower(const float* in, float* powerOut) = 0;
    // Same but also leaves the complex spectrum (shifted, interleaved) in `specOut` when non-null.
    virtual void forwardSpectrum(const float* in, float* specOut) = 0;

    static std::unique_ptr<Fft> create(int N);
    static bool legalSize(int N);        // multiple of 32, prime factors 2/3/5 only, 64..65536
    static int chooseSize(double fsHz, double rbwHz); // PLAN.md 5.2 rule
    static int simdWidth();              // pffft_simd_size(); must be 4 on arm64/x86-64
    static float* alignedAlloc(size_t floats);
    static void alignedFree(float* p);
};

} // namespace scanner
