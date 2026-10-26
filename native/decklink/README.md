# Native DeckLink capture for Windows

Shader's Windows helper discovers and captures Blackmagic DeckLink inputs directly through the Desktop Video COM API. A DeckLink-enabled FFmpeg is not required. The target installation is a DeckLink Quad 2 with eight independently configured SDI connectors. Desktop Video must be installed on the capture computer.

## Build and packaging

Run from an **x64 Visual Studio Developer PowerShell** with the Windows SDK installed:

```powershell
npm run build:decklink
```

The script checks the vendored interface hashes, runs MIDL, compiles the helper with MSVC, and runs a WIC JPEG self-test. It stages `shader-decklink.exe` and license notices under `src-tauri/resources/decklink/`. Tauri's development and build hooks run this step; the release workflow also builds and self-tests it before tests. The desktop passes its packaged resource path through `SHADER_DECKLINK_BRIDGE`. Headless development finds `native/decklink/build/shader-decklink.exe`; an absolute `SHADER_DECKLINK_BRIDGE` overrides discovery.

The build uses the Blackmagic-licensed SDK 12.0 COM interfaces redistributed in OBS's SDK directory. It includes no OBS implementation code. These interfaces support Quad 2 enumeration, profiles and automatic capture format detection. The SDK tree and individual SHA-256/Git blob hashes are pinned in `sdk/manifest.json`. The Desktop Video runtime provides the actual implementation; no vendor driver installer or runtime DLL is redistributed. The generated executable uses the Windows COM and Imaging Component services. See `NOTICE.txt` and the notices in each SDK file.

The optional `SHADER_WINDOWS_TOOLCHAIN` directory selects a portable LLVM MinGW cross-build using `widl` and `clang++`. This compiles a Windows executable from macOS/Linux; it does not execute the Windows self-test. Ordinary non-Windows builds stage the notice only and keep existing FFmpeg capture behavior.

## Using the card

1. Install a compatible Blackmagic Desktop Video package and verify the card in Desktop Video Setup.
2. Configure the Quad 2's connectors independently if eight inputs are needed. Shader reads profiles and never changes them automatically.
3. Release these inputs from vMix, Media Express or other capture software.
4. In Shader's capture assignment or routing settings, choose **Find video inputs** / **Find capture devices**. Each active subdevice is listed with its physical SDI connector where identified as a Quad 2.
5. Map the correct source to each camera. Use automatic format detection, or select the camera's exact video format from the supported-mode list. A format change restarts the shared worker while retaining preview leases.

Quad 2 software channels 1–8 correspond to physical connectors **1, 3, 5, 7, 2, 4, 6, 8**. The mapping is derived from SDK subdevice indices. Source keys use the 64-bit persistent identity encoded as text plus the subdevice index, so JavaScript numeric precision and display-name changes do not change the hardware key. A scan upgrades a uniquely matching saved name-based mapping while preserving its mapping ID and format.

## Process contract

- `--list`: one JSON object on stdout with `protocol: 1`, active sources and diagnostics. Source metadata includes supported modes, automatic-detection support, current profile and persistent identity. A driver failure returns an error code and exits nonzero.
- `--capture <persistent-id-or-exact-display-name> [--format <FourCC>]`: JPEG frames on binary stdout; bounded JSON status/error events on stderr. Device selection must match exactly one device. Omit format for automatic mode detection.
- `--self-test`: a real WIC JPEG encoding test and pure mapping/FourCC checks; does not require a DeckLink card or Desktop Video.
- Send `stop` plus newline on stdin, or close stdin, to stop and release capture. Shader escalates to terminating a worker only if graceful shutdown times out.

Each leased physical source gets a helper process. The SDK callback retains at most the latest needed frame; conversion and JPEG encoding happen away from the SDK callback at up to 8 fps. Blackmagic's converter handles source pixel formats, WIC scales to at most 960 pixels wide and encodes JPEG, and interlaced monitoring frames blend their fields. This is an 8-bit monitoring/snapshot feed, not full-rate recording or calibrated HDR grading. Embedded audio is not enabled.

Format notifications are applied on the capture thread. Signal loss invalidates cached frames; no synthetic bars or repeated stills are presented as fresh video. Driver failure messages are mapped to a fixed set of actionable messages before reaching the UI or MCP. Preview and fresh snapshot consumers share capture; opening a source immediately after closing it waits for the old worker to release the hardware handle.

## Verification

Local verification on macOS:

- Windows x64 executable cross-compiled successfully against the vendored IDL using LLVM MinGW.
- Process-level tests cover eight independent source identities/workers, native discovery without FFmpeg, saved mappings, signal recovery, shared snapshots, format restart, rapid close/reopen, and busy-input errors. These use a Node process fixture, not Blackmagic hardware.
- TypeScript/frontend build, packaged engine integration tests and Tauri `cargo check` passed.

The Windows MSVC/WIC self-test runs in the Windows build workflow. Physical Quad 2 capture, actual Desktop Video compatibility, camera signal modes and sustained eight-input load still require verification on the user's Windows computer. See `docs/decklink-windows-research.md` for the hardware acceptance checklist.
