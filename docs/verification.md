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
