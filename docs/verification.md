# Verification — 26 October 2026

- TypeScript check and Vite production build passed.
- Rust check and Tauri macOS app bundling passed on Apple Silicon.
- 16 automated tests passed with no skips: shared UI/MCP registry, stale and concurrent edits, live-write locks, vector validation, ATEM packet encoding (including exact 64-bit and UTF-8 values), real TCP VISCA framing, HTTP authentication/origin checks, credential redaction, capture mapping, scoped assistant tools with a local HTTP model fixture, real MCP stdio interoperability, packaged engine outside the repository, native Sony codec checks, and actual Sony SDK/plugin loading and discovery.
- Opened the packaged native app without a development server or separate Node installation. Applied simulator Lift Red = 0.125 through the UI; queried the same state through the packaged MCP executable and received revision 1 with `[0.125, 0, 0, 0]`.
- Inspected the native UI and Settings. Credentials remain unset as requested. Settings shows the packaged MCP executable path and integration status.
- Native Sony SDK 2.02 initializes and enumerates successfully. No Sony cameras were visible on this network. Physical connection and property writes are not claimed as verified.
- FFmpeg generated a valid JPEG from a synthetic test input. Physical SDI/UVC capture remains unverified. The installed FFmpeg has AVFoundation, not DeckLink support.
- Verified the macOS Quit path: HTTP shutdown succeeded, engine exited with code 0, and both session descriptor and singleton lock were removed. A custom Quit menu routes through Tauri's controlled exit because native macOS Quit bypassed `ExitRequested` in this configuration.

No physical camera settings were changed. Paid model requests were not made. The unsigned/ad-hoc-signed local debug app is a development build, not a notarized distribution release.

## Volunteer console revision

- Final automated suite: 28 tests passed, no failures or skips. TypeScript, frontend production build and packaged MCP checks passed.

- Added regression coverage for anchored brightness/color recipes, iris-before-gain ordering, reverse exposure order, policy ceilings, shutter preservation, exact return to starting values, stale anchors and revisions, partial failures, external changes during a batch, Sony enum/packed-unit handling, PTZOptics temperature decoding, saved routing/policies, program visibility through keys/transitions, MJPEG fragmentation and input-process sharing.
- Inspected the rebuilt native Tauri app: Simple view opens by default with large brightness, warmth and tint controls; Advanced and Settings remain reachable. No actual camera is presented as connected.
- Used an isolated browser/engine fixture with real FFmpeg-generated moving test video. Preview advanced continuously at 8 fps; a snapshot was captured while preview continued. This is synthetic input, not a physical DeckLink test.
- UI interaction: moving brightness to its positive limit produced f/2 and +12 dB, while shutter remained 1/60. Switched to Advanced and checked those values. Keyboard wheel adjustment applied successfully. Settings saved the preserve-aperture policy and displayed the new-starting-point instruction.
- The updated packaged MCP catalogue includes shading, routing and preview tools. A packaged MCP shading request changes iris while preserving shutter.

Physical camera/lens response, actual ATEM route visibility at the studio and all eight DeckLink subdevices still require commissioning on the production network. PTZOptics exposure curves and unrecognized native encodings remain in Advanced rather than receiving invented stop-based semantics.

Final UI lifecycle check: switching Simple → Advanced → Simple kept the generated preview live and produced no browser console warnings/errors. Rebuilt and reopened the final native app with the simulator ready in Simple view. Test server and generated-feed processes were shut down.

## Lighting link and camera preset revision

- Final automated suite: **39 tests passed, zero failures or skips**. TypeScript, Vite production build, bundled engine and Tauri macOS app build passed.
- Real loopback HTTP tests cover quick acknowledgement, legacy/forward compatibility, schema limits, duplicate IDs, stale sequences, unknown presets, browser-origin rejection and catalogue redaction. Real UDP tests cover typed OSC encoding, complete/incomplete look bursts, current-look requests, correlated feedback and preset catalogue replies. A failed port reconfiguration restores the previous receiver.
- Preset tests cover persistent stable IDs, archive/restore, native capability validation, complete-scene preflight, expected revisions, partial hardware rejection, external changes and manual cancellation. White-balance interpolation is checked in mired; shutter is held until the fade endpoint.
- Preview-only, blackout, dark and test reports prevent queued lighting recalls. Direct preset messages take priority over accompanying cue mappings. Scope tests reject multi-camera scene recalls or overwrites from a selected-camera assistant request.
- Real MCP stdio creates a camera preset and reads lighting state from the shared engine. The rebuilt standalone executable advertises the new lighting/preset tools outside the repository.
- Browser UI verification used two explicitly labeled simulator cameras: saved a scene with lighting context, recalled a camera look, recalled the scene with a 0.5-second transition, saw final readback counts and an automatically refreshed preview, and saved a cue-to-preset mapping. Development hot reload now reuses the React root.
- Rebuilt and reopened the packaged native app. Verified Presets/Lighting navigation and the built-in test-only lighting report with separate white face light and intentional blue backlight. The app remains open on that example with receiver/automation off and no physical cameras connected. Provider credentials remain unset.
- Screenshots: `.shader/verification/lighting-link-desktop.png` and `.shader/verification/preset-library.png` (the latter is an isolated UI fixture).

The production StageLight app was not modified or driven, and no physical camera settings were changed. Real production cue delivery/fades and camera/SDI responses still need an on-site integration check. No paid model calls or automatic frame uploads were made.

## Compact monitoring workspace

- Saved the existing application as local Git checkpoint `cb5f799` before changing the layout.
- TypeScript and frontend production build passed; all 39 automated engine tests passed without skips.
- Used an isolated fixture with 12 explicitly labeled simulator cameras and an FFmpeg-generated 960 × 540 moving image. At a 1280 × 720 viewport, the monitor measured 647.70 × 364.33 CSS pixels (16:9); expanded view measured 1031.11 × 579.99 (16:9).
- Verified left/right pane switching, hiding/restoring the camera strip, selecting camera 12 from the compact picker, strip overflow and keeping the selected camera visible. Advanced controls scrolled 597 pixels while the preview stayed at the same position on screen.
- Expanded preview and Escape return keep the same mounted monitor and continuous generated feed; focus returns to Expand. The assistant remains usable beside the workspace. Fixed its pre-existing effect cleanup error exposed by the UI check.
- Screenshot: `.shader/verification/compact-workspace.png`. This is generated test video, not a physical camera or DeckLink verification.
- Rebuilt and opened the native macOS app successfully. Checked the simulator workspace and Expand → Escape return in WKWebView. The packaged app remains open with simulated controls and no physical camera connection.

## Windows DeckLink integration — 26 October 2026

- Added a separate native Windows SDK capture helper, stable per-subdevice identities, Quad 2 SDI connector labels, automatic/manual formats, signal diagnostics and graceful input release.
- Cross-compiled a Windows x64 executable using LLVM MinGW and the pinned Blackmagic COM interfaces. Its imports are Windows system libraries; no third-party runtime DLL is needed beside the helper.
- Local suite: 57 passed, 1 skipped. Nine new process-boundary tests use a Node fixture for discovery, sharing, signal recovery, eight independent workers, lifecycle/restarts, persistence and error handling. They do not establish hardware compatibility.
- Frontend production build, packaged engine test and Tauri `cargo check` passed.
- Windows-only WIC JPEG encode/decode self-test is wired into native builds and CI, but was not executed on this Mac. Actual Quad 2 capture, driver compatibility and sustained eight-input throughput remain pending on Windows.

## Version 0.1.5 — zoom, numbered presets and camera ordering

- Advanced Lens replaces the ATEM continuous zoom numeric box with a spring-return slider. Parameter 0.9 uses normalized −1…+1 speeds and a 600 ms keepalive timeout. Release, lock, lost focus, tab/camera changes, disconnect and shutdown send stop commands.
- Six isolated zoom tests cover bounds, keepalives, release/lock, shared-switcher disconnect, delayed acknowledgements and shutdown. Numbered-preset tests cover per-camera/group recall, distinct camera values, merge saves, locks, stale state, persistence and camera order.
- The isolated release frontend and standalone engine build pass. All 69 applicable engine tests pass; one Windows-only capture helper test is skipped on macOS and runs in release CI.
- Chrome fixture checks cover zoom gestures, keyboard release, hidden windows, delayed replies, errors/retry, and desktop/compact layouts. Earlier fixture checks verified numbered slots, group recall, adding/renaming/saving slots, numeric shortcuts, drag/keyboard camera order and persistence. No physical camera writes were performed.
- Recorder Studio remains in the development workspace and is excluded from this release pending runtime packaging and Windows hardware qualification.
