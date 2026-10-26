#include <cstddef>
#include <cstdint>
#include <iostream>
#include <limits>
#include <vector>

// Time: O(n^2) worst/average, O(n) best when no swaps are needed.
// Space: O(n) for the input values, O(1) auxiliary beyond that.
int main() {
    std::int64_t n = 0;
    if (!(std::cin >> n) || n < 0) {
        return 1;
    }

    if (static_cast<std::uint64_t>(n) >
        std::numeric_limits<std::size_t>::max() / sizeof(std::int32_t)) {
        return 1;
    }

    std::vector<std::int32_t> values(static_cast<std::size_t>(n));
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (!(std::cin >> values[i])) {
            return 1;  // Incomplete or invalid input.
        }
    }

    // Ascending bubble sort with an early exit after a swap-free pass.
    for (std::size_t end = values.size(); end > 1; --end) {
        bool swapped = false;
        for (std::size_t i = 0; i + 1 < end; ++i) {
            if (values[i] > values[i + 1]) {
                std::int32_t temp = values[i];
                values[i] = values[i + 1];
                values[i + 1] = temp;
                swapped = true;
            }
        }
        if (!swapped) {
            break;
        }
    }

    for (std::size_t i = 0; i < values.size(); ++i) {
        if (i != 0) {
            std::cout << ' ';
        }
        std::cout << values[i];
    }
    std::cout << '\n';

    return 0;
}
