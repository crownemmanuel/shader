#pragma once
#include "json.hpp"
#include <cstdint>
#include <cstring>
#include <limits>
#include <regex>
#include <stdexcept>
using Json = nlohmann::json;
inline size_t width(uint32_t type) {
  auto base = type & 0xfff;
  return base >= 1 && base <= 4 ? size_t(1) << (base - 1) : 0;
}
inline Json numberValue(uint64_t raw, uint32_t type) {
  const auto n = width(type);
  if (!n)
    throw std::runtime_error("Unsupported SDK numeric type");
  if (type & 0x1000) {
    int64_t v = n == 1   ? int8_t(raw)
                : n == 2 ? int16_t(raw)
                : n == 4 ? int32_t(raw)
                         : int64_t(raw);
    return n == 8 ? Json(std::to_string(v)) : Json(v);
  }
  uint64_t v = n == 8 ? raw : raw & ((uint64_t(1) << (n * 8)) - 1);
  return n == 8 ? Json(std::to_string(v)) : Json(v);
}
inline uint64_t nativeValue(const Json &value, uint32_t type) {
  const size_t n = width(type);
  if (!n)
    throw std::runtime_error("Unsupported SDK numeric type");
  std::string s;
  if (value.is_string())
    s = value.get<std::string>();
  else if (value.is_number_integer())
    s = value.dump();
  else
    throw std::runtime_error(
        "Expected an integer (64-bit values use decimal strings)");
  if (!std::regex_match(s, std::regex("-?[0-9]+")))
    throw std::runtime_error("Invalid decimal integer");
  if (type & 0x1000) {
    const int64_t v = std::stoll(s);
    if (n < 8 && (v < -(int64_t(1) << (n * 8 - 1)) ||
                  v > (int64_t(1) << (n * 8 - 1)) - 1))
      throw std::runtime_error("Signed SDK value out of range");
    return uint64_t(v);
  }
  if (s[0] == '-')
    throw std::runtime_error("Unsigned SDK value cannot be negative");
  const uint64_t v = std::stoull(s);
  if (n < 8 && v > ((uint64_t(1) << (n * 8)) - 1))
    throw std::runtime_error("Unsigned SDK value out of range");
  return v;
}
inline Json valuesList(const uint8_t *bytes, size_t size, uint32_t type) {
  Json values = Json::array();
  const auto n = width(type);
  if (!bytes || !n || type == 0xffff)
    return values;
  if (size > 1024 * 1024 || size % n)
    throw std::runtime_error("Invalid SDK value buffer");
  for (size_t i = 0; i < size; i += n) {
    uint64_t raw = 0;
    std::memcpy(&raw, bytes + i, n);
    values.push_back(numberValue(raw, type));
  }
  return values;
}
inline void validateNative(const Json &v, uint32_t type, const Json &allowed) {
  const auto raw = nativeValue(v, type);
  const auto canonical = numberValue(raw, type);
  if ((type & 0x4000) &&
      allowed.size() >= 3) { // SDK range order is minimum, maximum, step.
    if (type & 0x1000) {
      const auto x = int64_t(raw), lo = int64_t(nativeValue(allowed[0], type)),
                 hi = int64_t(nativeValue(allowed[1], type)),
                 step = int64_t(nativeValue(allowed[2], type));
      if (x < lo || x > hi ||
          (step > 0 && (uint64_t(x) - uint64_t(lo)) % uint64_t(step)))
        throw std::runtime_error("Value is outside the camera's current range");
    } else {
      const auto lo = nativeValue(allowed[0], type),
                 hi = nativeValue(allowed[1], type),
                 step = nativeValue(allowed[2], type);
      if (raw < lo || raw > hi || (step && (raw - lo) % step))
        throw std::runtime_error("Value is outside the camera's current range");
    }
  } else if ((type & 0x2000) && !allowed.empty() &&
             std::find(allowed.begin(), allowed.end(), canonical) ==
                 allowed.end())
    throw std::runtime_error("Value is not currently offered by this camera");
}
