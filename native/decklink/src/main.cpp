// Native Windows DeckLink capture. SDK interfaces are kept outside the webview.
#include <windows.h>
#include <wincodec.h>
#include <objbase.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <thread>
#include <vector>
#include "DeckLinkAPI_h.h"
#include "json.hpp"
#include "core.hpp"
using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

template<class T> class Com {
    T* p = nullptr;
public:
    Com() = default;
    explicit Com(T* value) : p(value) {}
    ~Com() { reset(); }
    Com(const Com&) = delete;
    Com& operator=(const Com&) = delete;
    Com(Com&& other) noexcept : p(other.p) { other.p = nullptr; }
    Com& operator=(Com&& other) noexcept { if (this != &other) { reset(); p = other.p; other.p = nullptr; } return *this; }
    void reset(T* value = nullptr) { if (p) p->Release(); p = value; }
    T** put() { reset(); return &p; }
    T* get() const { return p; }
    T* operator->() const { return p; }
    explicit operator bool() const { return p != nullptr; }
};
struct Failure : std::runtime_error {
    std::string code;
    Failure(std::string c) : std::runtime_error(c), code(std::move(c)) {}
};
void check(HRESULT hr, const char* code) { if (FAILED(hr)) throw Failure(code); }
void checkInput(HRESULT hr) {
    if (hr == E_ACCESSDENIED) throw Failure("input_busy");
    if (hr == E_INVALIDARG) throw Failure("unsupported_format");
    check(hr, "capture_failed");
}
std::string utf8(const wchar_t* text, int length = -1) {
    if (!text) return {};
    if (length < 0) length = int(wcslen(text));
    int count = WideCharToMultiByte(CP_UTF8, 0, text, length, nullptr, 0, nullptr, nullptr);
    std::string result(count, '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, length, result.data(), count, nullptr, nullptr);
    return result;
}
std::string deviceName(IDeckLink* device, bool model = false) {
    BSTR value = nullptr;
    HRESULT hr = model ? device->GetModelName(&value) : device->GetDisplayName(&value);
    std::string result = SUCCEEDED(hr) ? utf8(value, SysStringLen(value)) : "DeckLink";
    SysFreeString(value);
    return result;
}
std::optional<LONGLONG> attribute(IDeckLinkProfileAttributes* attrs, BMDDeckLinkAttributeID id) {
    LONGLONG value = 0;
    if (!attrs || FAILED(attrs->GetInt(id, &value))) return {};
    return value;
}
std::string identity(IDeckLinkProfileAttributes* attrs) {
    auto persistent = attribute(attrs, BMDDeckLinkPersistentID);
    auto sub = attribute(attrs, BMDDeckLinkSubDeviceIndex);
    if (!persistent) throw Failure("device_identity_unavailable");
    std::ostringstream out;
    out << "pid:" << std::hex << uint64_t(*persistent) << ":sub:" << std::dec << sub.value_or(0);
    return out.str();
}
Com<IDeckLinkIterator> iterator() {
    Com<IDeckLinkIterator> it;
    check(CoCreateInstance(CLSID_CDeckLinkIterator, nullptr, CLSCTX_ALL, IID_IDeckLinkIterator,
        reinterpret_cast<void**>(it.put())), "driver_unavailable");
    return it;
}
Com<IDeckLinkProfileAttributes> attributes(IDeckLink* device) {
    Com<IDeckLinkProfileAttributes> result;
    check(device->QueryInterface(IID_IDeckLinkProfileAttributes, reinterpret_cast<void**>(result.put())), "driver_incompatible");
    return result;
}
bool captureCapable(IDeckLinkProfileAttributes* attrs) {
    auto io = attribute(attrs, BMDDeckLinkVideoIOSupport);
    auto duplex = attribute(attrs, BMDDeckLinkDuplex);
    return io && (*io & bmdDeviceSupportsCapture) && duplex && *duplex != bmdDuplexInactive;
}
bool autoDetection(IDeckLinkProfileAttributes* attrs) {
    BOOL supported = FALSE;
    return SUCCEEDED(attrs->GetFlag(BMDDeckLinkSupportsInputFormatDetection, &supported)) && supported;
}
Com<IDeckLinkInput> inputInterface(IDeckLink* device) {
    Com<IDeckLinkInput> input;
    check(device->QueryInterface(IID_IDeckLinkInput, reinterpret_cast<void**>(input.put())), "driver_incompatible");
    return input;
}
bool supportedMode(IDeckLinkInput* input, BMDDisplayMode mode, BMDPixelFormat pixel) {
    BOOL supported = FALSE;
    return SUCCEEDED(input->DoesSupportVideoMode(bmdVideoConnectionUnspecified, mode, pixel,
        bmdNoVideoInputConversion, bmdSupportedVideoModeDefault, nullptr, &supported)) && supported;
}
json modes(IDeckLinkInput* input) {
    json result = json::array();
    Com<IDeckLinkDisplayModeIterator> it;
    check(input->GetDisplayModeIterator(it.put()), "enumeration_failed");
    Com<IDeckLinkDisplayMode> mode;
    while (it->Next(mode.put()) == S_OK) {
        if (!supportedMode(input, mode->GetDisplayMode(), bmdFormat8BitYUV)) continue;
        BSTR name = nullptr;
        mode->GetName(&name);
        BMDTimeValue duration = 0; BMDTimeScale scale = 0;
        mode->GetFrameRate(&duration, &scale);
        result.push_back({{"code", shader::fourCC(mode->GetDisplayMode())}, {"name", utf8(name, SysStringLen(name))},
            {"width", mode->GetWidth()}, {"height", mode->GetHeight()},
            {"fps", duration ? double(scale) / double(duration) : 0}});
        SysFreeString(name);
    }
    return result;
}
json discover() {
    json result = {{"protocol", 1}, {"sources", json::array()}, {"diagnostics", json::array()}};
    auto it = iterator();
    Com<IDeckLink> device;
    while (it->Next(device.put()) == S_OK) {
        try {
            auto attrs = attributes(device.get());
            if (!captureCapable(attrs.get())) {
                result["diagnostics"].push_back(deviceName(device.get()) + ": inactive or output-only. Check connector configuration in Desktop Video Setup.");
                continue;
            }
            auto input = inputInterface(device.get());
            std::string model = deviceName(device.get(), true), name = deviceName(device.get());
            json source = {{"device", identity(attrs.get())}, {"name", name}, {"nativeName", name}, {"model", model},
                {"supportsAutoDetection", autoDetection(attrs.get())}, {"modes", modes(input.get())}};
            auto sub = attribute(attrs.get(), BMDDeckLinkSubDeviceIndex);
            if (sub) source["subdeviceIndex"] = *sub;
            if (model == "DeckLink Quad 2" && sub && *sub >= 0 && *sub < 8) {
                source["connector"] = shader::quad2Connector(unsigned(*sub));
                source["name"] = name + " · SDI " + std::to_string(source["connector"].get<unsigned>());
            }
            auto profile = attribute(attrs.get(), BMDDeckLinkProfileID);
            if (profile) source["profile"] = shader::fourCC(uint32_t(*profile));
            result["sources"].push_back(source);
        } catch (const Failure& e) {
            result["diagnostics"].push_back(deviceName(device.get()) + ": " + e.code);
        }
    }
    return result;
}

// A caller-owned conversion target; allocation does not require an output-capable card.
class BgraFrame final : public IDeckLinkVideoFrame {
    std::atomic<ULONG> refs{1};
    long width, height;
public:
    std::vector<BYTE> bytes;
    BgraFrame(long w, long h) : width(w), height(h) {
        if (w <= 0 || h <= 0 || w > 8192 || h > 4320) throw Failure("unsupported_format");
        bytes.resize(size_t(w) * h * 4);
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid != IID_IUnknown && iid != IID_IDeckLinkVideoFrame) return E_NOINTERFACE;
        *out = static_cast<IDeckLinkVideoFrame*>(this); AddRef(); return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override { ULONG n = --refs; if (!n) delete this; return n; }
    long STDMETHODCALLTYPE GetWidth() override { return width; }
    long STDMETHODCALLTYPE GetHeight() override { return height; }
    long STDMETHODCALLTYPE GetRowBytes() override { return width * 4; }
    BMDPixelFormat STDMETHODCALLTYPE GetPixelFormat() override { return bmdFormat8BitBGRA; }
    BMDFrameFlags STDMETHODCALLTYPE GetFlags() override { return bmdFrameFlagDefault; }
    HRESULT STDMETHODCALLTYPE GetBytes(void** out) override { if (!out) return E_POINTER; *out = bytes.data(); return S_OK; }
    HRESULT STDMETHODCALLTYPE GetTimecode(BMDTimecodeFormat, IDeckLinkTimecode** out) override { if (out) *out = nullptr; return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE GetAncillaryData(IDeckLinkVideoFrameAncillary** out) override { if (out) *out = nullptr; return E_NOTIMPL; }
};
std::vector<BYTE> jpeg(IWICImagingFactory* wic, BgraFrame* frame, bool interlaced) {
    UINT width = UINT(frame->GetWidth()), height = UINT(frame->GetHeight());
    if (interlaced) { // Blend fields for the low-rate monitoring feed, avoiding comb artifacts.
        for (UINT y = 0; y + 1 < height; y += 2)
            for (UINT x = 0; x < width * 4; ++x) {
                size_t a = size_t(y) * width * 4 + x, b = a + width * 4;
                BYTE v = BYTE((unsigned(frame->bytes[a]) + frame->bytes[b]) / 2);
                frame->bytes[a] = frame->bytes[b] = v;
            }
    }
    Com<IWICBitmap> bitmap;
    check(wic->CreateBitmapFromMemory(width, height, GUID_WICPixelFormat32bppBGRA,
        width * 4, UINT(frame->bytes.size()), frame->bytes.data(), bitmap.put()), "conversion_failed");
    UINT outWidth = std::min(width, UINT(960));
    UINT outHeight = std::max(UINT(1), UINT(uint64_t(height) * outWidth / width));
    Com<IWICBitmapScaler> scaler;
    check(wic->CreateBitmapScaler(scaler.put()), "conversion_failed");
    check(scaler->Initialize(bitmap.get(), outWidth, outHeight, WICBitmapInterpolationModeFant), "conversion_failed");
    Com<IWICFormatConverter> converter;
    check(wic->CreateFormatConverter(converter.put()), "conversion_failed");
    check(converter->Initialize(scaler.get(), GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone,
        nullptr, 0, WICBitmapPaletteTypeCustom), "conversion_failed");
    Com<IStream> stream;
    check(CreateStreamOnHGlobal(nullptr, TRUE, stream.put()), "encoding_failed");
    Com<IWICBitmapEncoder> encoder;
    check(wic->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, encoder.put()), "encoding_failed");
    check(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache), "encoding_failed");
    Com<IWICBitmapFrameEncode> output;
    Com<IPropertyBag2> options;
    check(encoder->CreateNewFrame(output.put(), options.put()), "encoding_failed");
    PROPBAG2 option{}; option.pstrName = const_cast<wchar_t*>(L"ImageQuality");
    VARIANT quality; VariantInit(&quality); quality.vt = VT_R4; quality.fltVal = 0.85f;
    check(options->Write(1, &option, &quality), "encoding_failed");
    check(output->Initialize(options.get()), "encoding_failed");
    check(output->SetSize(outWidth, outHeight), "encoding_failed");
    WICPixelFormatGUID pixel = GUID_WICPixelFormat24bppBGR;
    check(output->SetPixelFormat(&pixel), "encoding_failed");
    check(output->WriteSource(converter.get(), nullptr), "encoding_failed");
    check(output->Commit(), "encoding_failed");
    check(encoder->Commit(), "encoding_failed");
    STATSTG stat{}; check(stream->Stat(&stat, STATFLAG_NONAME), "encoding_failed");
    if (stat.cbSize.QuadPart > 8 * 1024 * 1024) throw Failure("frame_too_large");
    HGLOBAL memory = nullptr;
    check(GetHGlobalFromStream(stream.get(), &memory), "encoding_failed");
    auto data = static_cast<BYTE*>(GlobalLock(memory));
    if (!data) throw Failure("encoding_failed");
    std::vector<BYTE> result(data, data + size_t(stat.cbSize.QuadPart));
    GlobalUnlock(memory);
    return result;
}
struct ModeChange { BMDDisplayMode mode; BMDPixelFormat pixel; BMDFieldDominance fields; };
struct Session {
    std::mutex mutex;
    std::condition_variable changed;
    bool stop = false, noSignal = true;
    Com<IDeckLinkVideoInputFrame> latest;
    std::optional<ModeChange> pending;
    Clock::time_point lastAccepted{};
};
class Callback final : public IDeckLinkInputCallback {
    std::atomic<ULONG> refs{1};
    std::shared_ptr<Session> state;
    bool detect;
public:
    Callback(std::shared_ptr<Session> s, bool automatic) : state(std::move(s)), detect(automatic) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid != IID_IUnknown && iid != IID_IDeckLinkInputCallback) return E_NOINTERFACE;
        *out = static_cast<IDeckLinkInputCallback*>(this); AddRef(); return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override { ULONG n = --refs; if (!n) delete this; return n; }
    HRESULT STDMETHODCALLTYPE VideoInputFormatChanged(BMDVideoInputFormatChangedEvents, IDeckLinkDisplayMode* mode,
        BMDDetectedVideoInputFormatFlags flags) override {
        if (!detect || !mode) return S_OK;
        std::lock_guard<std::mutex> lock(state->mutex);
        BMDPixelFormat pixel = bmdFormat8BitYUV;
        if (flags & bmdDetectedVideoInputRGB444)
            pixel = (flags & bmdDetectedVideoInput12BitDepth) ? bmdFormat12BitRGB : bmdFormat10BitRGB;
        state->pending = ModeChange{mode->GetDisplayMode(), pixel, mode->GetFieldDominance()};
        state->latest.reset();
        state->changed.notify_one();
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE VideoInputFrameArrived(IDeckLinkVideoInputFrame* frame, IDeckLinkAudioInputPacket*) override {
        if (!frame) return S_OK;
        std::lock_guard<std::mutex> lock(state->mutex);
        if (state->stop) return S_OK;
        state->noSignal = (frame->GetFlags() & bmdFrameHasNoInputSource) != 0;
        if (state->noSignal) state->latest.reset();
        else if (!state->pending && Clock::now() - state->lastAccepted >= std::chrono::milliseconds(125)) {
            frame->AddRef();
            state->latest.reset(frame);
            state->lastAccepted = Clock::now();
        }
        state->changed.notify_one();
        return S_OK;
    }
};
void status(const json& event) { std::cerr << event.dump() << '\n'; }
struct CaptureGuard {
    IDeckLinkInput* input;
    ~CaptureGuard() { input->StopStreams(); input->DisableVideoInput(); input->SetCallback(nullptr); }
};
void capture(const std::string& requested, const std::string& format, IWICImagingFactory* wic) {
    auto it = iterator();
    Com<IDeckLink> device, selected;
    unsigned matches = 0;
    while (it->Next(device.put()) == S_OK) {
        try {
            auto attrs = attributes(device.get());
            if (identity(attrs.get()) == requested || deviceName(device.get()) == requested) {
                ++matches; device->AddRef(); selected.reset(device.get());
            }
        } catch (const Failure&) {
            // An unrelated legacy/output device must not hide a usable Quad 2 input.
        }
    }
    if (matches == 0) throw Failure("device_missing");
    if (matches != 1) throw Failure("ambiguous_device");
    auto attrs = attributes(selected.get());
    if (!captureCapable(attrs.get())) throw Failure("input_inactive");
    auto input = inputInterface(selected.get());
    bool automatic = format.empty();
    if (automatic && !autoDetection(attrs.get())) throw Failure("format_required");
    auto available = modes(input.get());
    if (available.empty()) throw Failure("unsupported_format");
    BMDDisplayMode mode = static_cast<BMDDisplayMode>(shader::fourCC(format.empty() ? available[0]["code"].get<std::string>() : format));
    BMDPixelFormat pixel = bmdFormat8BitYUV;
    if (!supportedMode(input.get(), mode, pixel)) throw Failure("unsupported_format");
    Com<IDeckLinkDisplayMode> description;
    check(input->GetDisplayMode(mode, description.put()), "unsupported_format");
    BMDFieldDominance fields = description->GetFieldDominance();
    Com<IDeckLinkVideoConversion> conversion;
    check(CoCreateInstance(CLSID_CDeckLinkVideoConversion, nullptr, CLSCTX_ALL, IID_IDeckLinkVideoConversion,
        reinterpret_cast<void**>(conversion.put())), "driver_incompatible");
    auto state = std::make_shared<Session>();
    Com<Callback> callback(new Callback(state, automatic));
    check(input->SetCallback(callback.get()), "capture_failed");
    // Only clean up an input we have successfully acquired; never stop another application's stream.
    BMDVideoInputFlags flags = automatic ? bmdVideoInputEnableFormatDetection : bmdVideoInputFlagDefault;
    HRESULT enabled = input->EnableVideoInput(mode, pixel, flags);
    if (FAILED(enabled)) { input->SetCallback(nullptr); checkInput(enabled); }
    CaptureGuard guard{input.get()};
    checkInput(input->StartStreams());
    std::thread([state] {
        std::string line;
        while (std::getline(std::cin, line)) if (line == "stop") break;
        std::lock_guard<std::mutex> lock(state->mutex);
        state->stop = true;
        state->changed.notify_one();
    }).detach();
    std::string lastStatus;
    while (true) {
        Com<IDeckLinkVideoInputFrame> frame;
        std::optional<ModeChange> change;
        bool noSignal;
        {
            std::unique_lock<std::mutex> lock(state->mutex);
            state->changed.wait_for(lock, std::chrono::milliseconds(250));
            if (state->stop) break;
            noSignal = state->noSignal;
            change = state->pending; state->pending.reset();
            frame = std::move(state->latest);
        }
        if (change && (change->mode != mode || change->pixel != pixel || change->fields != fields)) {
            input->StopStreams();
            mode = change->mode; pixel = change->pixel; fields = change->fields;
            if (!supportedMode(input.get(), mode, pixel)) throw Failure("unsupported_format");
            checkInput(input->EnableVideoInput(mode, pixel, flags));
            check(input->FlushStreams(), "capture_failed");
            { std::lock_guard<std::mutex> lock(state->mutex); state->latest.reset(); }
            checkInput(input->StartStreams());
            status({{"event", "status"}, {"status", "format_changed"}, {"format", shader::fourCC(mode)}});
            lastStatus.clear();
            continue;
        }
        std::string signal = noSignal ? "no_signal" : "live";
        if (signal != lastStatus) { status({{"event", "status"}, {"status", signal}}); lastStatus = signal; }
        if (!frame || noSignal) continue;
        Com<BgraFrame> converted(new BgraFrame(frame->GetWidth(), frame->GetHeight()));
        check(conversion->ConvertFrame(frame.get(), converted.get()), "conversion_failed");
        auto bytes = jpeg(wic, converted.get(), fields == bmdUpperFieldFirst || fields == bmdLowerFieldFirst);
        // A signal-loss notification invalidates even a frame already being converted.
        { std::lock_guard<std::mutex> lock(state->mutex); if (state->noSignal || state->pending || state->stop) continue; }
        if (fwrite(bytes.data(), 1, bytes.size(), stdout) != bytes.size() || fflush(stdout) != 0) break;
    }
}
int wmain(int argc, wchar_t** argv) {
    bool listing = argc == 2 && std::wstring(argv[1]) == L"--list";
    HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    int exitCode = 0;
    try {
        check(initialized, "com_unavailable");
        if (listing) std::cout << discover().dump() << '\n';
        else {
            Com<IWICImagingFactory> wic;
            check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_IWICImagingFactory,
                reinterpret_cast<void**>(wic.put())), "encoder_unavailable");
            if (argc == 2 && std::wstring(argv[1]) == L"--self-test") {
                if (shader::quad2Connector(4) != 2 || shader::fourCC(shader::fourCC("Hp30")) != "Hp30") throw Failure("self_test_failed");
                Com<BgraFrame> sample(new BgraFrame(1920, 1080));
                auto bytes = jpeg(wic.get(), sample.get(), false);
                if (bytes.size() < 4 || bytes[0] != 255 || bytes[1] != 216 || bytes.back() != 217) throw Failure("self_test_failed");
                Com<IWICStream> encoded;
                check(wic->CreateStream(encoded.put()), "self_test_failed");
                check(encoded->InitializeFromMemory(bytes.data(), DWORD(bytes.size())), "self_test_failed");
                Com<IWICBitmapDecoder> decoder;
                check(wic->CreateDecoderFromStream(encoded.get(), nullptr, WICDecodeMetadataCacheOnLoad, decoder.put()), "self_test_failed");
                Com<IWICBitmapFrameDecode> decoded;
                check(decoder->GetFrame(0, decoded.put()), "self_test_failed");
                UINT width = 0, height = 0;
                check(decoded->GetSize(&width, &height), "self_test_failed");
                if (width != 960 || height != 540) throw Failure("self_test_failed");
                const unsigned expected[] = {1, 3, 5, 7, 2, 4, 6, 8};
                for (unsigned i = 0; i < 8; ++i) if (shader::quad2Connector(i) != expected[i]) throw Failure("self_test_failed");
                std::cout << json({{"ok", true}, {"protocol", 1}, {"jpegBytes", bytes.size()}, {"width", width}, {"height", height}, {"hardwareTested", false}}).dump() << '\n';
            } else if ((argc == 3 || argc == 5) && std::wstring(argv[1]) == L"--capture" &&
                (argc != 5 || std::wstring(argv[3]) == L"--format")) {
                _setmode(_fileno(stdout), _O_BINARY);
                capture(utf8(argv[2]), argc == 5 ? utf8(argv[4]) : "", wic.get());
            } else throw Failure("invalid_arguments");
        }
    } catch (const Failure& e) {
        if (listing) std::cout << json({{"protocol", 1}, {"sources", json::array()}, {"error", e.code}}).dump() << '\n';
        else status({{"event", "error"}, {"code", e.code}});
        exitCode = 1;
    } catch (const std::exception&) {
        if (listing) std::cout << json({{"protocol", 1}, {"sources", json::array()}, {"error", "capture_failed"}}).dump() << '\n';
        else status({{"event", "error"}, {"code", "capture_failed"}});
        exitCode = 1;
    }
    if (SUCCEEDED(initialized)) CoUninitialize();
    return exitCode;
}
