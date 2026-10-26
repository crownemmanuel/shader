# Sony Camera Remote SDK bridge

The native C++ bridge is implemented, linked to **Sony Camera Remote SDK 2.02.00**, and packaged into the macOS app. The user authorized acceptance and local installation of Sony's license on 26 October 2026. The original SDK stays under ignored `vendor/`; it is not source code for this project.

## Build

```sh
npm run build:sony
```

Requires the official Mac SDK unpacked as `vendor/RemoteCli` (or `SONY_SDK_ROOT` pointing to that extracted sample directory), Xcode command-line tools and the SDK readme at `vendor/sdk/Camera_Remote_SDK_Readme_v2.02.00.pdf`. The script compiles our bridge and stages runtime resources in `src-tauri/resources/sony/`. Sony's macOS adapters must live at `Contents/Frameworks/CrAdapter` relative to the bridge directory; simply placing `CrAdapter` beside the executable fails with SDK error `0x8703`.

The app finds its packaged bridge automatically. Headless development finds `native/sony/build/shader-sony`. `SHADER_SONY_BRIDGE` overrides it with an absolute executable path. The build currently targets macOS; Windows/Linux SDK libraries and packaging remain a porting task.

## Native implementation

- `Init`, `EnumCameraObjects`, model/GUID/IP identification, `CreateCameraObjectInfo`, `Connect` with callback completion, `Disconnect`, `ReleaseDevice`, `Release`.
- SSH credentials and explicit fingerprint match when the camera requires authentication. Compare the fingerprint with the camera's own network settings; credentials are session-only. Non-SSH models may require camera-body pairing confirmation.
- Every property returned by `GetDeviceProperties` becomes a UI/MCP descriptor, including its current read/write access, native data type and dynamic options/range. Generated names cover 841 SDK property identifiers; this is a dictionary, **not a claim that a camera supports 841 controls**.
- Signed/unsigned integers, enum arrays, ranges, and UTF-16 strings are supported. 64-bit values use decimal strings to preserve precision. Native 128-bit/unknown data types remain visible and read-only with an explicit limitation.
- `SetDeviceProperty` checks current access and values again in the native process, then polls for matching readback. The engine refreshes the property catalogue after a write.
- Every returned `GetSupportedControlCodes` entry is exposed through `ExecuteControlCodeValue` / `ExecuteControlCodeString`. SDK button up/down semantics are kept explicit; accepted commands are marked unverified, not falsely labeled complete.
- `SendCommand` is available as an advanced native JSON control, including for older models without dynamic control-code enumeration. The SDK decides model support. The generated command dictionary is included in native metadata.

This is camera-property/command integration. Other SDK subsystems (media transfer/deletion, firmware installation, LUT/file upload, streaming administration, specialized PTZF API and OSD/live-view transport) are not wrapped. Capture uses the separate SDI/video-input subsystem. Model-specific display formatting and specialized packed structures remain native values.

## JSON-RPC contract

One UTF-8 JSON object per line over stdin/stdout. Vendor logging is redirected to stderr, never mixed into MCP/JSON-RPC. Methods: `info`, `discover`, `connect`, `properties`, `set`, `command`, `disconnect`. The engine owns each child process and closes it gracefully. No native network server is exposed.

```json
{ "jsonrpc": "2.0", "id": 1, "method": "discover", "params": {} }
```

Property IDs are `dp:<decimal-code>`, control IDs are `cc:<decimal-code>`. `native-command` accepts `{ "commandId": 0, "parameter": 0 }`. Inspect descriptors before writing; do not assume a code is supported because it exists in SDK headers.

Verification: native codec self-test, SDK initialization, runtime plugin loading, network enumeration and JSON-RPC integration run successfully here. Enumeration returned an empty list on the current network. Physical camera connection, firmware compatibility and write/readback remain unverified.

Sources: [Sony SDK](https://support.d-imaging.sony.co.jp/app/sdk/en/index.html), [accepted agreement](https://support.d-imaging.sony.co.jp/app/sdk/licenseagreement_d/en-US.html), and the installed official headers/API reference. `third_party/json.hpp` is nlohmann JSON 3.12.0 under MIT, SHA-256 `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63`.
