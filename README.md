# Shader

Tauri desktop foundation for controlling production cameras through one UI, MCP, and a scoped model assistant.

## Run

Requirements: Node 26/npm, Rust, and either macOS Apple silicon with Xcode command-line tools or Windows x64 with Visual Studio C++ build tools and WebView2. GitHub Actions builds and tests both desktop targets.

```sh
npm install
npm run build:sony
npm run desktop
```

`desktop` bundles a native engine executable, starts Vite, and launches Tauri. The bundled Node runtime comes from the official `node` npm distribution, because Homebrew's Node binary does not contain the SEA fuse required for executable generation.

To build a local macOS app:

```sh
npm run desktop:build
```

A verified debug app is also available after `npm run bundle:engine && npm run tauri -- build --debug --bundles app` at `src-tauri/target/debug/bundle/macos/Shader.app`. Local builds are not Apple-notarized distribution releases.

## Releases and updates

Download signed-update releases from [crownemmanuel/shader](https://github.com/crownemmanuel/shader/releases). Installed Windows and Apple silicon Mac copies check for new versions automatically; install them from **Settings → App updates** after camera changes and preset recalls finish. GitHub Actions builds and publishes version tags. See [the release guide](docs/RELEASES.md) for signing, Sony SDK builds, and `npm run release -- patch`.

Headless engine / browser development:

```sh
npm run engine
npm run dev
```

The console is at http://127.0.0.1:1420. The engine binds a separate authenticated loopback port. Its session descriptor is in `~/.shader/session.json`; do not share this file.

## What is implemented

- Automatic DNS-SD, SSDP and WS-Discovery candidate detection, protocol verification, saved targets, and manual connections. The existing ATEM address `172.16.10.10` is a read-only discovery target. Startup discovery sends no camera setting commands.
- ATEM network transport, dynamic camera-control state, native CCmd writes including all wire data types, and mapped program/preview tally. This is the open-source network adapter, not a bundled Blackmagic Switcher SDK.
- PTZOptics VISCA TCP with inquiry-probed controls, color, focus, zoom and bounded pan/tilt; newer HTTP CGI/Digest adapter and advanced request editor.
- Blackmagic direct REST controls on supported cameras with Web Media Manager.
- A compiled Sony Camera Remote SDK 2.02 native bridge: discovery, model identification, authenticated connection, dynamic properties, setters/readback, supported control codes and native commands. SDK initialization and discovery work; physical camera verification is pending. See `native/sony/README.md`.
- Explicit SDI/UVC capture-device mapping, shared continuous 8 fps JPEG preview, fresh snapshots, timestamps and MCP image content. Windows DeckLink capture uses a packaged native SDK helper with per-input discovery, Quad 2 connector labels, automatic/manual formats and signal diagnostics. Other platforms still require a DeckLink-enabled FFmpeg for native DeckLink inputs. See `native/decklink/README.md`; physical Quad 2 verification is pending.
- OpenAI, Claude, Groq and compatible model settings, image input, bounded tool loop, camera-specific assistant scope. API keys are added later in Settings and held only in session memory.
- Simple brightness/warmth/tint controls, visual Advanced sliders and color wheels, numeric fine-tuning, shutter controls, per-camera exposure limits and ATEM input/M/E mapping. See [volunteer controls](docs/volunteer-controls.md).
- UI/MCP command parity, revision checks, per-camera serialized writes, persistent operator locks, activity history, and a labeled simulator.

Full model-specific control coverage is **not certified**. Native protocol editors provide access to additional commands, but supported ranges and behavior still need validation on the actual camera models. Unknown capability is not represented as success.

## Workflow

1. Join the production camera network and launch Shader. Discovery uses network advertisements and saved targets; routed VLANs may require manual addresses.
2. Connect a device. ATEM can expose several camera IDs from one switcher. Input labels are not physical model names.
3. Inspect available controls. “Read back” means the adapter received state; ATEM state is the switcher's state, not physical-camera confirmation. “Sent” means the requested write has not been verified by a device readback.
4. Cameras are unlocked by default. Lock any camera you want protected; the lock persists and the internal assistant cannot unlock it. A stale revision returns an error instead of overwriting another operator's changes.
5. In Settings, map the camera to its ATEM input/program bus and capture subdevice. Selecting it starts live preview; Capture frame saves a fresh image for the assistant. No aux routing is modified automatically.
6. Configure a provider/model in Settings. Choose whether each assistant request may share frames or make changes.

## MCP

Settings shows the exact stdio configuration for the running engine. Use the bundled `shader-engine` executable with `--mcp`, or from the repository:

```sh
npm run mcp
```

For an MCP client, run the executable directly, not `npm` (npm adds non-protocol stdout). Source development configuration:

```json
{
  "mcpServers": {
    "shader": {
      "command": "node",
      "args": [
        "--import",
        "/absolute/path/to/shader/node_modules/tsx/dist/loader.mjs",
        "/absolute/path/to/shader/engine/main.ts",
        "--mcp"
      ]
    }
  }
}
```

The desktop or headless engine must be running. The stdio process attaches to that same state; it does not create an independent hardware connection. Tools include discovery/connect/disconnect, camera state and capabilities, arm/lock/set, PTZ pulse/stop, capture enumeration/mapping/frame, leased live preview, shading plan/apply, exposure policy, tally routing, provider settings and scoped assistant requests. `shader://cameras` is a readable MCP resource.

## Configuration

- `SHADER_DATA_DIR`: engine settings/session directory (default `~/.shader`).
- `SHADER_FFMPEG`: absolute path to a capture-capable FFmpeg executable.
- `SHADER_DECKLINK_BRIDGE`: optional absolute path to the native Windows DeckLink capture helper.
- `SHADER_SONY_BRIDGE`: optional absolute path to override the installed native Sony SDK bridge.

Nonsecret settings persist. Camera passwords and model credentials do not persist. Camera/source mappings are operator assertions: ensure your actual video routing matches them.

## Verification

```sh
npm run check
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Tests include native Sony SDK/plugin loading, discovery and data conversion, scoped assistant tool calls against a local provider fixture, native ATEM packet encoding, malformed/out-of-range input, stale/concurrent writes, VISCA packet framing, live guards, HTTP origin/token enforcement, credential redaction, capture mapping, actual MCP stdio interoperability, and the packaged executable running outside the repository. Hardware and paid model requests are not simulated as passing integration checks.

See `docs/architecture.md` and `docs/vendor-research.md` for the design and primary-source research.

## Lighting-linked camera looks

**Presets** uses numbered slots, starting with 1–4. Each number can hold a separate look for each camera; click it to recall the selected camera, or explicitly apply it to all saved cameras. Save one or several cameras, name slots, and add more. Older named looks and scenes remain available in the manager. Camera buttons can be reordered in Edit mode. **Lighting** receives StageLight reports over HTTP or OSC, shows cue/zone context, and maps lighting cues to presets. StageLight can also recall a Shader preset directly by its published stable ID.

The receiver and automatic recalls start disabled. Camera write locks remain in force. The assistant and MCP can inspect lighting context and save a new camera preset after a correction; no model runs or image uploads happen merely because a lighting report arrives.

See [Look Link setup and supported behavior](docs/look-link.md).

## Recorder Studio

Recorder Studio adds a warm DeckLink multiview, input aliases/mapping, per-camera ProRes/PCM recording, a native recording-folder picker with live free-space estimates, and durable StageMics scene markers. Build the native runtime with `npm run build:recorder`. See [implementation and qualification](docs/recorder-studio-plan.md) and [marker receiver protocol](docs/recorder-marker-protocol.md). The release includes its private media runtime and automated synthetic recording/recovery checks. Eight-input Windows hardware still requires production qualification before live use.
