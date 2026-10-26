# Architecture

Shader is a Tauri 2 desktop shell with a React console and a TypeScript camera engine compiled into a Node single executable. There is one engine owner per running session. Tauri invokes an authenticated loopback RPC endpoint; an external MCP stdio process forwards to the same endpoint. The browser never receives the engine token. Entered credentials cross IPC to the engine and are not returned in state or MCP responses.

```
React console → Tauri invoke ─┐
                             ├→ shared command registry → engine → camera adapters
MCP stdio → local RPC ────────┘                  ↑
                                     built-in model tool loop
```

`engine/commands.ts` is the public command surface. Each entry includes a Zod input schema, description, read-only annotation and implementation. MCP tools are generated from that registry. The built-in assistant receives a narrower view of the same tools scoped to the selected camera. It cannot enable its own write access, change providers, or send frames without the request's image-sharing scope.

`engine/types.ts` describes native capabilities: stable IDs, current values, numeric bounds, enum options, vector component order, readability/writability, freshness, and native addressing. An adapter supplies these descriptors; the UI renders them without vendor-specific control duplication. New properties can appear at runtime. The advanced vendor controls carry unmodeled commands through the same write path. They are protocol escape hatches, not claims of model-verified support.

Write operations are serialized per camera. Clients supply an expected revision; stale writes fail instead of silently overwriting another operator. Cameras are writable unless an operator locks them; locks persist in settings and apply equally to the UI, presets, Look Link and agents. The internal assistant cannot unlock a camera. Updates wait for in-flight writes to finish. Switcher camera-control updates from any console arrive as they happen; the UI long-polls `system_changes` instead of polling on a timer, and Simple mode re-anchors its starting point when another console changes the camera (values compared with a 1/1024 tolerance for fixed-point echoes). No network discovery operation intentionally sends camera-setting changes.

ATEM is a bidirectional switcher-state connection with transport acknowledgements. The camera-control signal from switcher to camera can be one-way, so a switcher echo is not proof that a camera changed. PTZ VISCA controls perform inquiries after successful command completion. HTTP acceptance is labeled unverified where a documented readback is unavailable. Failed writes keep the previous state and produce an activity entry.

Capture is independent of control. A user associates a capture source with a camera; Shader does not route ATEM aux outputs. FFmpeg provides a shared 8 fps JPEG stream per physical source. Preview leases renew while polling and expire after 15 seconds without a client. Camera selection/remapping closes previous leases. Fresh snapshot requests share the stream and wait for a later sequence. JPEG parsing has an 8 MB bound; stale signal is explicit. Frames carry camera/source IDs, timestamp, retrieval-time state revision and SHA-256. The most recent 20 snapshots are held in memory. This is a monitoring and agent feed, not a calibrated grading monitor or signal synchronization system.

Provider settings persist without secrets in `~/.shader/settings.json`. API keys remain in engine memory. OpenAI and Groq use Chat Completions; Claude uses Messages; local/OpenAI-compatible endpoints are configurable. Vision and tool support depend on the selected model. The tool loop is bounded to six rounds. No model call is made until a user configures a model and sends a message.

The engine session descriptor is mode 0600. RPC binds to 127.0.0.1 on an ephemeral port, requires a bearer token and rejects browser Origin headers. Tauri's webview has no shell capability. The Vite-only development proxy is restricted to the loopback development origin and is not shipped.

The packaged ATEM transport uses an explicit in-process implementation of the dependency's worker boundary, retaining its UDP framing, packet retransmission and reconnect logic. This avoids runtime module-path lookup inside a Node single executable. `scripts/threadedclass-inline.ts` accepts only the ATEM socket class; it is not a general worker loader.

Sony runs in a native child process linked to the official SDK. It enumerates properties and supported control codes, preserving native types and model-specific restrictions. The SDK and adapters ship as app resources; no vendor code executes in the webview. Camera property changes trigger a fresh capability read. Network discovery initializes the Sony SDK and closes its enumeration process after use.

## Deterministic volunteer control

`engine/shading.ts` defines semantic axes, native-unit conversions and an anchored exposure/color planner. Both visual editors and engine recipes use it. Simple control sessions track a starting camera snapshot and current expected values. Apply uses the existing write guard, camera queue and revision check; external changes to a pending target stop the batch. Manual writes or policy changes invalidate the anchor. Supported Sony enum choices are intersected with policy limits. Unknown encodings never enter automatic recipes.

ATEM sessions are retained independently of their camera-control endpoints, so a switcher with no CCdP cameras can still supply tally for Sony/PTZ cameras. Each camera has an optional switcher/input/M/E route. Program visibility includes nested sources/keyers/transitions through `atem-connection`; aux outputs are not treated as program. Disconnection makes mapped tally unknown.

## Presets and lighting link

`engine/presets.ts` owns a versioned, atomically written preset library and asynchronous recall jobs. `engine/preset-values.ts` is the shared pure selection/interpolation layer. Scene frames acquire camera queues in stable ID order, validate all targets before writing, and compare saved-control expectations between frames. Manual camera actions cancel conflicting jobs. Per-camera guards and native validation remain in the existing write path.

`engine/look-link.ts` owns a separate optional HTTP/OSC receiver. `engine/lighting-types.ts` validates the reference contract and derives nominal zone context. `engine/osc.ts` implements bounded i/f/s messages and immediate bundles. A secret HTTP path and source IP allowlist separate this ingress from the private bearer-token RPC. Network messages can update context or select existing presets, never introduce arbitrary camera commands or arm cameras. Message IDs/sequences, complete-burst checks, live-state gates and explicit cue rules mediate actions.

`engine/look-commands.ts` extends the shared UI/MCP registry. The React preset and lighting panels use those commands; the internal assistant receives only a selected-camera subset. Compact lighting context contains no receiver secret. All external descriptions remain data, not agent instructions. See `docs/look-link.md` for the supported protocol and commissioning boundary.
