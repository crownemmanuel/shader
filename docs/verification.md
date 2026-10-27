# Verification — 26 October 2026

## Blackmagic zoom slider — included in this release

- Advanced Lens replaces the ATEM continuous zoom numeric box with a labeled spring-return slider. Corrected parameter 0.9 bounds to −1…+1 and added the shared `lens_zoom` command with a 600 ms keepalive timeout.
- Six isolated engine tests cover normalized bounds, speed changes/keepalives, release/lock, shared-switcher disconnect, delayed acknowledgements and shutdown. The complete suite passes 71 tests with one Windows-only helper test skipped on macOS. TypeScript and Vite production build pass.
- Browser checks use simulated ATEM cameras and cover both directions, keyboard release, pointer release outside, cancellation, lost focus, hidden windows, delayed replies, locking, switching tabs/cameras, errors and retry. Desktop and compact layouts were inspected. No physical camera movement or Windows hardware validation was performed; this change is included in this release.

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

## Numbered presets and camera ordering — included in this release

- Added regression tests for camera-scoped numbered recall, distinct values in multi-camera slots, merging saves without overwriting other cameras, group preflight and locks, stale revision rejection, failed batch-save preservation, slot names/membership across restart, old-library compatibility, and camera-order preservation across hidden/disconnected identities.
- The complete local suite passes 63 tests; the Windows-only helper self-test is skipped on macOS. Production frontend and standalone engine builds pass.
- Chrome interaction checks used simulated camera data and verified four permanent slots, grey empty slots per camera, single-camera recall, explicit group recall, add/rename slots, multi-camera saves, drag and keyboard reordering, unchanged camera colors, numeric preset shortcuts, order after reload, and desktop/narrow-window layouts. No production cameras were written during these checks.
- Numbered presets and reordering are included in this release.

## Unreleased Recorder Studio — 26 October 2026

- Implemented the Rust supervisor/independent capture workers, GStreamer ProRes/PCM segments, warm preview sharing, native folder-picker command, actual free/total space, estimated remaining time, input naming/mapping, selective recording, StageMics HTTP receiver, marker sidecars, and interrupted-part recovery. Earlier numbered-preset and camera-reorder work is preserved.
- Engine suite: **65 passed, one Windows-only helper test skipped** on macOS. New tests cover shared recorder preview ownership, fresh snapshot provenance, guarded format/name changes, alias persistence, pairing-key access and update blocking.
- Six Rust tests pass for durable marker replay/conflicts, journal corruption/torn-tail handling, scene intervals, already-live scenes and unresolved clock/audio validation. Rust Clippy passes with warnings denied.
- Real synthetic 1080p30 recordings pass: ProRes LT video and **16 embedded PCM channels**, playable segment rollover, actual storage queries, shutdown refusal during recording, StageMics authentication/probe/201/duplicate/conflict handling, supervisor process kill/reconnection, and delayed scene exits on the original completed take. All timestamps and audio anchors remain in sidecars.
- A separate **two-input** test kills one capture worker after a readable MOV checkpoint. The healthy input continues, the take is marked partial, and recovery creates a new playable 48-frame MOV while preserving the original `.partial`. The test also verifies that a dead input can be released. Both tests pass against the optimized local recorder executable. These tests simulate process failure; they do not prove power-loss durability.
- Eighteen Chrome checks pass against the actual React UI with isolated fixtures: eight-input multiview/table, native picker invocation through a mocked Tauri boundary, visible path/free space, five-second disk updates, input renaming/mapping, selected-camera Record/Stop, markers, disabled destination changes during recording, return to shading with recording preserved, and narrow-window layout. No browser errors. The native picker implementation compiles with Tauri; the Windows OS picker itself has not been exercised on this Mac.
- TypeScript/frontend production build, Tauri `cargo check`, optimized recorder build/staging and Windows native DeckLink helper cross-compilation pass. The full recorder Rust code also passes Windows target type-checking with `DOCS_RS=1` to skip linking native GStreamer libraries; **this is not a Windows executable/runtime test**.
- Local media runtime: GStreamer 1.28.8. Windows GStreamer packaging requires the documented MSVC runtime/development installation and build step. Clean Windows installer/dependency testing, actual Quad 2 inputs, eight-stream sustained recording, physical timing/synchronization, power removal, and multi-editor import are still pending. See [qualification plan](recorder-studio-plan.md).
- No release, tag, push, camera writes or live dLive/StageLight commands were performed for this recorder work.

## All-changes release packaging

- Added the recorder runtime to both release targets. Windows downloads the official MSVC x64 GStreamer 1.28.8 installer with a pinned SHA-256. macOS stages and relocates 52 media binaries and their transitive libraries, with per-package licenses and build metadata.
- The staged macOS runtime reports all required plugins, and passed synthetic ProRes/16-channel PCM recording, segment rollover, disk-space checks, StageMics authentication/clock/deduplication, recorder-service restart survival, input-worker crash isolation and recovery into a new playable MOV while retaining the original.
- CI runs these checks against the staged recorder on both platforms before installer publication. The limited-scope 0.1.5 draft was cancelled when the user requested every change. Failed draft builds were superseded with fixes before publication. CI uses compact synthetic video to verify recording, markers and recovery without treating shared runners as a ProRes performance benchmark; local 1080p30 verification remains separate. Eight-input hardware qualification remains pending.
