#pragma once
#include <cstdint>
#include <stdexcept>
#include <string>

namespace shader {
inline unsigned quad2Connector(unsigned index) {
    if (index >= 8) throw std::invalid_argument("Invalid Quad 2 subdevice");
    return index < 4 ? index * 2 + 1 : (index - 4) * 2 + 2;
}
inline uint32_t fourCC(std::string code) {
    if (code.size() == 3) code += ' ';
    if (code.size() != 4) throw std::invalid_argument("Expected a four-character video mode");
    uint32_t value = 0;
    for (unsigned char c : code) {
        if (!(c == ' ' || (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')))
            throw std::invalid_argument("Invalid video mode");
        value = (value << 8) | c;
    }
    return value;
}
inline std::string fourCC(uint32_t value) {
    std::string code(4, ' ');
    for (int i = 3; i >= 0; --i) { code[i] = char(value & 255); value >>= 8; }
    while (!code.empty() && code.back() == ' ') code.pop_back();
    return code;
}
}
