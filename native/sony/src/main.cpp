#include "CameraRemote_SDK.h"
#include "IDeviceCallback.h"
#include "codec.hpp"
#include "names.hpp"
#include <atomic>
#include <chrono>
#include <codecvt>
#include <condition_variable>
#include <cstdio>
#include <iostream>
#include <locale>
#include <mutex>
#include <sstream>
#include <thread>
#ifdef _WIN32
#include <io.h>
#define fdopen _fdopen
#define dup _dup
#define dup2 _dup2
#define STDOUT_FILENO 1
#define STDERR_FILENO 2
#else
#include <unistd.h>
#endif
namespace SDK = SCRSDK;
using namespace std::chrono_literals;
std::string hexCode(uint64_t x) {
  std::ostringstream s;
  s << "0x" << std::hex << x;
  return s.str();
}
void check(SDK::CrError e, const char *operation) {
  if (e)
    throw std::runtime_error(std::string(operation) + " failed (Sony SDK " +
                             hexCode(e) + ")");
}
std::string safe(const char *s) { return s ? std::string(s) : std::string(); }
#ifdef _WIN32
std::string safe(const wchar_t *s) {
  return s ? std::wstring_convert<std::codecvt_utf8_utf16<wchar_t>>().to_bytes(s) : std::string();
}
#endif
std::string label(uint32_t code, const std::map<uint32_t, std::string> &names) {
  auto it = names.find(code);
  if (it == names.end())
    return "Native " + hexCode(code);
  std::string s = std::regex_replace(it->second, std::regex("_"), " ");
  return std::regex_replace(s, std::regex("([a-z])([A-Z])"), "$1 $2");
}
std::string group(const std::string &name) {
  if (std::regex_search(name, std::regex("white|color|colour|gamma|black|satur|"
                                         "matrix|picture profile|creative",
                                         std::regex::icase)))
    return "Color";
  if (std::regex_search(
          name,
          std::regex("iris|fnumber|f number|shutter|iso|exposure|gain|ndfilter",
                     std::regex::icase)))
    return "Exposure";
  if (std::regex_search(name, std::regex("focus|zoom|lens", std::regex::icase)))
    return "Lens";
  return "Vendor";
}
std::wstring_convert<std::codecvt_utf8_utf16<char16_t>, char16_t> utf16;
std::string currentString(const SDK::CrDeviceProperty &p) {
  auto raw = p.GetCurrentStr();
  if (!raw || raw[0] == 0)
    return "";
  std::u16string text;
  for (size_t i = 1; i < raw[0] && raw[i]; ++i) {
    uint16_t c = raw[i];
    if (p.GetCode() == SDK::CrDeviceProperty_ImageID_String)
      c = (c >> 8) | (c << 8);
    text += char16_t(c);
  }
  return utf16.to_bytes(text);
}
Json currentValue(const SDK::CrDeviceProperty &p) {
  if (p.GetValueType() == SDK::CrDataType_STR)
    return currentString(p);
  if (!width(p.GetValueType()))
    return Json{{"nativeValue", std::to_string(p.GetCurrentValue())}};
  return numberValue(p.GetCurrentValue(), p.GetValueType());
}
Json descriptor(uint32_t code, uint32_t type, const uint8_t *bytes, size_t size,
                bool control) {
  std::string name = label(code, control ? controlNames : propertyNames);
  Json d = {
      {"id", std::string(control ? "cc:" : "dp:") + std::to_string(code)},
      {"label", name},
      {"group", control ? "Vendor" : group(name)},
      {"readable", !control},
      {"writable", true},
      {"type", "number"},
      {"native",
       {{"code", code},
        {"dataType", type},
        {"api", control ? "ExecuteControlCodeValue" : "SetDeviceProperty"}}}};
  if (type == SDK::CrDataType_STR) {
    d["type"] = "string";
    if (control)
      d["native"]["api"] = "ExecuteControlCodeString";
    return d;
  }
  if (!width(type)) {
    d["type"] = "json";
    d["writable"] = false;
    d["note"] =
        "Native data type is visible but not writable through this bridge.";
    return d;
  }
  const auto values = valuesList(bytes, size, type);
  d["native"]["values"] = values;
  if ((type & SDK::CrDataType_ArrayBit) && !values.empty()) {
    d["type"] = "enum";
    d["options"] = Json::array();
    for (const auto &v : values)
      d["options"].push_back(
          {{"label", type == SDK::CrDataType_Button
                         ? (v == 1 ? "Up / release" : "Down / press")
                         : (v.is_string() ? v.get<std::string>() : v.dump())},
           {"value", v}});
  } else if (width(type) == 8) {
    d["type"] = "string";
    d["note"] = "Native 64-bit integer; use an exact decimal string.";
  } else if ((type & SDK::CrDataType_RangeBit) && values.size() >= 3) {
    d["min"] = values[0];
    d["max"] = values[1];
    if (values[2].get<int64_t>() > 0)
      d["step"] = values[2];
  } else {
    const auto n = width(type);
    const bool sign = type & SDK::CrDataType_SignBit;
    d["min"] = sign ? -(int64_t(1) << (n * 8 - 1)) : 0;
    d["max"] =
        sign ? (int64_t(1) << (n * 8 - 1)) - 1 : (int64_t(1) << (n * 8)) - 1;
    d["step"] = 1;
  }
  if (control)
    d["note"] =
        "Native command; consult model semantics. A successful send is not "
        "completion feedback. Button down/up can have different effects.";
  return d;
}
struct Events : SDK::IDeviceCallback {
  std::mutex mutex;
  std::condition_variable changed;
  bool connected = false;
  uint32_t error = 0;
  void OnConnected(SDK::DeviceConnectionVersioin) override {
    std::lock_guard<std::mutex> l(mutex);
    connected = true;
    error = 0;
    changed.notify_all();
  }
  void OnDisconnected(uint32_t e) override {
    std::lock_guard<std::mutex> l(mutex);
    connected = false;
    error = e;
    changed.notify_all();
  }
  void OnError(uint32_t e) override {
    std::lock_guard<std::mutex> l(mutex);
    error = e;
    changed.notify_all();
  }
  void OnPropertyChanged() override { changed.notify_all(); }
  void OnPropertyChangedCodes(uint32_t, uint32_t *) override {
    changed.notify_all();
  }
};
struct Device {
  SDK::ICrCameraObjectInfo *info = nullptr;
  SDK::CrDeviceHandle handle = 0;
  Events events;
  std::string id;
  void close() {
    if (handle) {
      SDK::Disconnect(handle);
      {
        std::unique_lock<std::mutex> l(events.mutex);
        events.changed.wait_for(l, 1500ms, [&] { return !events.connected; });
      }
      SDK::ReleaseDevice(handle);
      handle = 0;
    }
    if (info) {
      info->Release();
      info = nullptr;
    }
  }
  ~Device() { close(); }
  void require(const Json &p) {
    if (!handle || p.value("cameraId", std::string()) != id)
      throw std::runtime_error("Sony camera session not found");
    std::lock_guard<std::mutex> l(events.mutex);
    if (!events.connected)
      throw std::runtime_error("Sony camera disconnected");
  }
};
struct PropertyList {
  SDK::CrDeviceHandle h;
  SDK::CrDeviceProperty *items = nullptr;
  int32_t size = 0;
  PropertyList(SDK::CrDeviceHandle handle) : h(handle) {
    check(SDK::GetDeviceProperties(h, &items, &size), "GetDeviceProperties");
    if (size < 0 || size > 10000)
      throw std::runtime_error("Invalid SDK property count");
  }
  ~PropertyList() {
    if (items)
      SDK::ReleaseDeviceProperties(h, items);
  }
};
struct Controls {
  SDK::CrDeviceHandle h;
  SDK::CrControlCodeInfo *items = nullptr;
  uint32_t size = 0;
  SDK::CrError error;
  Controls(SDK::CrDeviceHandle handle)
      : h(handle), error(SDK::GetSupportedControlCodes(h, &items, &size)) {
    if (size > 10000)
      throw std::runtime_error("Invalid SDK control count");
  }
  ~Controls() {
    if (items)
      SDK::ReleaseControlCodes(h, items);
  }
};
struct Cameras {
  SDK::ICrEnumCameraObjectInfo *list = nullptr;
  Cameras() { check(SDK::EnumCameraObjects(&list, 3), "EnumCameraObjects"); }
  ~Cameras() {
    if (list)
      list->Release();
  }
};
std::string identity(const SDK::ICrCameraObjectInfo *info) {
  std::string id = safe(info->GetGuid());
  if (!id.empty())
    return id;
  std::ostringstream s;
  for (uint32_t n = 0; n < info->GetIdSize(); ++n)
    s << std::hex << int(info->GetId()[n]);
  return s.str();
}
Json discover() {
  Cameras c;
  Json found = Json::array();
  if (c.list)
    for (uint32_t n = 0; n < c.list->GetCount(); ++n) {
      const auto *i = c.list->GetCameraObjectInfo(n);
      auto address = safe(i->GetIPAddressChar());
      if (address.empty())
        address = "usb-" + identity(i);
      found.push_back({{"id", identity(i)},
                       {"address", address},
                       {"model", safe(i->GetModel())},
                       {"name", safe(i->GetName())},
                       {"transport", safe(i->GetConnectionTypeName())},
                       {"ssh", i->GetSSHsupport() != 0},
                       {"pairing", safe(i->GetPairingNecessity())}});
    }
  return found;
}
Json connect(Device &device, const Json &p) {
  device.close();
  const std::string address = p.at("address");
  Cameras cameras;
  const SDK::ICrCameraObjectInfo *match = nullptr;
  if (cameras.list)
    for (uint32_t n = 0; n < cameras.list->GetCount(); ++n) {
      const auto *i = cameras.list->GetCameraObjectInfo(n);
      if (address == safe(i->GetIPAddressChar()) || address == identity(i) ||
          address == "usb-" + identity(i)) {
        match = i;
        break;
      }
    }
  if (!match)
    throw std::runtime_error(
        "Sony SDK did not discover this address. Enable PC Remote and network "
        "discovery/pairing on the camera, then retry.");
  device.info = SDK::CreateCameraObjectInfo(
      match->GetName(), match->GetModel(), match->GetUsbPid(),
      match->GetIdType(), match->GetIdSize(), match->GetId(),
      match->GetConnectionTypeName(), match->GetAdaptorName(),
      match->GetPairingNecessity(), match->GetSSHsupport());
  if (!device.info)
    throw std::runtime_error("Could not create Sony camera object");
  device.id = identity(match);
  std::string fingerprint = p.value("fingerprint", std::string()),
              username = p.value("username", std::string("admin")),
              password = p.value("password", std::string());
  if (match->GetSSHsupport()) {
    char buffer[256] = {};
    uint32_t size = 0;
    check(SDK::GetFingerprint(device.info, buffer, &size), "GetFingerprint");
    if (size > sizeof(buffer))
      throw std::runtime_error("Invalid Sony fingerprint");
    std::string actual(buffer, size);
    while (!actual.empty() && actual.back() == '\0')
      actual.pop_back();
    if (fingerprint.empty())
      throw std::runtime_error(
          "Sony SSH fingerprint confirmation required. Verify on your trusted "
          "network and enter this fingerprint: " +
          actual);
    if (fingerprint != actual)
      throw std::runtime_error(
          "Sony SSH fingerprint does not match the confirmed fingerprint");
  }
  {
    std::lock_guard<std::mutex> l(device.events.mutex);
    device.events.connected = false;
    device.events.error = 0;
  }
  check(SDK::Connect(device.info, &device.events, &device.handle,
                     SDK::CrSdkControlMode_Remote, SDK::CrReconnecting_OFF,
                     username.c_str(), password.c_str(), fingerprint.c_str(),
                     uint32_t(fingerprint.size())),
        "Connect");
  std::unique_lock<std::mutex> l(device.events.mutex);
  if (!device.events.changed.wait_for(l, 8s, [&] {
        return device.events.connected || device.events.error;
      }))
    throw std::runtime_error(
        "Sony connection timed out; check camera pairing confirmation");
  if (!device.events.connected)
    throw std::runtime_error("Sony connection failed: " +
                             hexCode(device.events.error));
  return {{"id", device.id}, {"model", safe(device.info->GetModel())}};
}
Json properties(Device &d) {
  Json result = Json::array();
  PropertyList props(d.handle);
  for (int32_t i = 0; i < props.size; ++i) {
    const auto &p = props.items[i];
    auto item = descriptor(p.GetCode(), p.GetValueType(), p.GetValues(),
                           p.GetValueSize(), false);
    item["readable"] = p.IsGetEnableCurrentValue();
    item["writable"] =
        item["writable"].get<bool>() && p.IsSetEnableCurrentValue();
    if (p.IsGetEnableCurrentValue())
      item["value"] = currentValue(p);
    result.push_back(item);
  }
  Controls codes(d.handle);
  if (!codes.error)
    for (uint32_t i = 0; i < codes.size; ++i) {
      const auto &c = codes.items[i];
      result.push_back(descriptor(c.GetCode(), c.GetValueType(), c.GetValues(),
                                  c.GetValueSize(), true));
    }
  // Older models expose SendCommand but not GetSupportedControlCodes. Keep the
  // native escape hatch explicit.
  result.push_back(
      {{"id", "native-command"},
       {"label", "SDK SendCommand"},
       {"group", "Vendor"},
       {"type", "json"},
       {"value", {{"commandId", 0}, {"parameter", 0}}},
       {"writable", true},
       {"readable", false},
       {"note", "Advanced native command. Model support is checked by the SDK; "
                "no completion claim. parameter: 0 up, 1 down."},
       {"native", {{"api", "SendCommand"}, {"commands", commandNames}}}});
  return result;
}
Json setValue(Device &d, const Json &input) {
  const std::string id = input.at("propertyId");
  const Json v = input.at("value");
  if (id == "native-command") {
    if (!v.is_object() || !v.contains("commandId") || !v.contains("parameter"))
      throw std::runtime_error("Supply commandId and parameter");
    const auto code = nativeValue(v["commandId"], 3),
               parameter = nativeValue(v["parameter"], 2);
    if (!commandNames.count(uint32_t(code)) || parameter > 1)
      throw std::runtime_error("Unknown SDK command or parameter");
    check(SDK::SendCommand(d.handle, uint32_t(code),
                           SDK::CrCommandParam(parameter)),
          "SendCommand");
    return {{"verified", false}};
  }
  if (!std::regex_match(id, std::regex("(cc|dp):[0-9]+")))
    throw std::runtime_error("Unknown Sony property identifier");
  auto parsed = std::stoull(id.substr(3));
  if (parsed > UINT32_MAX)
    throw std::runtime_error("Invalid property code");
  uint32_t code = uint32_t(parsed);
  if (id.rfind("cc:", 0) == 0) {
    Controls controls(d.handle);
    check(controls.error, "GetSupportedControlCodes");
    for (uint32_t i = 0; i < controls.size; ++i) {
      auto &c = controls.items[i];
      if (c.GetCode() != code)
        continue;
      auto type = c.GetValueType();
      if (type == SDK::CrDataType_STR) {
        auto text = utf16.from_bytes(v.get<std::string>());
        if (text.size() > 65534)
          throw std::runtime_error("Control string too long");
        check(SDK::ExecuteControlCodeString(
                  d.handle, c.GetCode(), uint16_t(text.size()),
                  reinterpret_cast<const uint16_t *>(text.c_str())),
              "ExecuteControlCodeString");
      } else {
        validateNative(v, type,
                       valuesList(c.GetValues(), c.GetValueSize(), type));
        check(SDK::ExecuteControlCodeValue(d.handle, c.GetCode(),
                                           nativeValue(v, type)),
              "ExecuteControlCodeValue");
      }
      return {{"verified", false}};
    }
    throw std::runtime_error("Control code is not currently supported");
  }
  {
    PropertyList list(d.handle);
    SDK::CrDeviceProperty *p = nullptr;
    for (int32_t i = 0; i < list.size; ++i)
      if (list.items[i].GetCode() == code)
        p = &list.items[i];
    if (!p || !p->IsSetEnableCurrentValue())
      throw std::runtime_error("Property is not currently writable");
    if (p->GetValueType() == SDK::CrDataType_STR) {
      auto text = utf16.from_bytes(v.get<std::string>());
      if (text.size() > 254)
        throw std::runtime_error("SDK string exceeds 254 UTF-16 units");
      std::vector<uint16_t> buffer(text.size() + 2, 0);
      buffer[0] = uint16_t(text.size() + 1);
      for (size_t i = 0; i < text.size(); ++i) {
        auto c = uint16_t(text[i]);
        buffer[i + 1] = code == SDK::CrDeviceProperty_ImageID_String
                            ? uint16_t((c >> 8) | (c << 8))
                            : c;
      }
      p->SetCurrentStr(buffer.data());
      check(SDK::SetDeviceProperty(d.handle, p), "SetDeviceProperty");
    } else {
      validateNative(
          v, p->GetValueType(),
          valuesList(p->GetValues(), p->GetValueSize(), p->GetValueType()));
      p->SetCurrentValue(nativeValue(v, p->GetValueType()));
      check(SDK::SetDeviceProperty(d.handle, p), "SetDeviceProperty");
    }
  }
  // Property callbacks are hints. Only a fresh matching read is reported as
  // verified.
  for (int attempt = 0; attempt < 10; ++attempt) {
    std::this_thread::sleep_for(100ms);
    PropertyList list(d.handle);
    for (int32_t i = 0; i < list.size; ++i) {
      auto &p = list.items[i];
      if (p.GetCode() == code && p.IsGetEnableCurrentValue()) {
        auto actual = currentValue(p);
        auto desired = p.GetValueType() == SDK::CrDataType_STR
                           ? v
                           : numberValue(nativeValue(v, p.GetValueType()),
                                         p.GetValueType());
        if (actual == desired)
          return {{"verified", true}, {"value", actual}};
      }
    }
  }
  return {{"verified", false}};
}
void selfTest() {
  if (numberValue(0xffff, 0x1002) != -1)
    throw std::runtime_error("signed decode");
  if (nativeValue("18446744073709551615", 4) != UINT64_MAX)
    throw std::runtime_error("uint64 precision");
  bool rejected = false;
  try {
    nativeValue(65536, 2);
  } catch (...) {
    rejected = true;
  }
  if (!rejected)
    throw std::runtime_error("bounds");
  validateNative(12, 0x4002, Json::array({10, 20, 2}));
  rejected = false;
  try {
    validateNative(13, 0x4002, Json::array({10, 20, 2}));
  } catch (...) {
    rejected = true;
  }
  if (!rejected)
    throw std::runtime_error("step");
  rejected = false;
  try {
    validateNative(7, 0x2002, Json::array({1, 2}));
  } catch (...) {
    rejected = true;
  }
  if (!rejected)
    throw std::runtime_error("enum");
}
int main(int argc, char **argv) {
  // Vendor output must never corrupt JSON-RPC stdout.
  FILE *rpc = fdopen(dup(STDOUT_FILENO), "w");
  dup2(STDERR_FILENO, STDOUT_FILENO);
  try {
    selfTest();
    if (argc > 1 && std::string(argv[1]) == "--self-test") {
      if (!SDK::Init())
        throw std::runtime_error("SDK initialization failed");
      fprintf(rpc,
              "{\"ok\":true,\"propertyNames\":%zu,\"controlNames\":%zu,"
              "\"sdkVersion\":%u}\n",
              propertyNames.size(), controlNames.size(), SDK::GetSDKVersion());
      SDK::Release();
      fclose(rpc);
      return 0;
    }
    if (!SDK::Init())
      throw std::runtime_error("Sony SDK initialization failed");
    {
      Device device;
      std::string line;
      while (std::getline(std::cin, line)) {
        Json id = nullptr, response;
        try {
          if (line.size() > 1024 * 1024)
            throw std::runtime_error("Request too large");
          auto req = Json::parse(line);
          id = req.at("id");
          auto method = req.at("method").get<std::string>();
          auto p = req.value("params", Json::object());
          Json result;
          if (method == "discover")
            result = discover();
          else if (method == "connect")
            result = connect(device, p);
          else if (method == "info")
            result = {{"sdkVersion", SDK::GetSDKVersion()},
                      {"properties", propertyNames.size()},
                      {"controlCodes", controlNames.size()}};
          else {
            device.require(p);
            if (method == "properties")
              result = properties(device);
            else if (method == "set" || method == "command")
              result = setValue(device, p);
            else if (method == "disconnect") {
              device.close();
              result = {{"disconnected", true}};
            } else
              throw std::runtime_error("Unknown Sony bridge method");
          }
          response = {{"jsonrpc", "2.0"}, {"id", id}, {"result", result}};
        } catch (const std::exception &e) {
          response = {{"jsonrpc", "2.0"},
                      {"id", id},
                      {"error", {{"code", -32000}, {"message", e.what()}}}};
        }
        auto text =
            response.dump(-1, ' ', false, Json::error_handler_t::replace);
        fprintf(rpc, "%s\n", text.c_str());
        fflush(rpc);
      }
    }
    SDK::Release();
    fclose(rpc);
    return 0;
  } catch (const std::exception &e) {
    fprintf(stderr, "Sony bridge: %s\n", e.what());
    fclose(rpc);
    return 1;
  }
}
