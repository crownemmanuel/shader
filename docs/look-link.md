# StageLight Look Link

Shader receives lighting reports and recalls its own camera looks or multi-camera scenes through the `stagelight.look/1` contract. The receiver is separate from Shader's private engine RPC. StageLight never receives that RPC token or access to arbitrary camera commands.

## Operator setup

1. Adjust a camera, then open **Presets → Save current look**. Select one camera for a camera preset or several for a scene. Shading/exposure values are selected by default; expand the selection to choose individual supported values. Actions and raw vendor commands cannot be saved. Optionally attach the current lighting context.
2. Open **Lighting → Connection** (also reachable from Settings). Enable the receiver. For StageLight on the same computer, keep **This computer only**. For another machine, select **Show network** and enter that StageLight computer's numeric IPv4 address in the sender allowlist.
3. Save the connection and copy the displayed HTTP target URL. In StageLight, add it under **Network & triggers → Send to**. For Show network, replace `<this-computer-IP>` in the URL with the Shader computer's address. Retain the private path segment. The default HTTP port is 9200.
4. Set Shader's StageLight computer address, OSC port (normally 1461), and the target ID that StageLight assigned Shader. **Request current look** asks StageLight to POST to its configured target. On two computers, also allow Shader's IP in StageLight's Show network settings.
5. Inspect **Lighting now**. Zone colors, intensity, cue, white/colored classification and reference analysis are visible. **Show example** displays clearly marked synthetic data and cannot change cameras.
6. StageLight can attach a **preset** send to a cue and choose from Shader's published catalogue, or use **Cue mappings** in Shader to map a cue ID/entry/name to a saved look. All supplied filters must match. Prefer stable IDs; clear the name filter if you want an ID-based mapping to survive cue renaming. OSC look bursts carry cue names rather than stable IDs.
7. Enable **Allow lighting cues and preset messages to recall saved looks**, then enable writes on the relevant cameras before the show. The preset preview can enable its cameras for five minutes with a separate On Air/unknown-tally option. Lighting cannot arm cameras itself. Write access expires and is not persisted.

A preset or scene has a stable `look-…` ID. Updating its values/name keeps that ID; archiving removes it from the published catalogue and blocks new recalls. Restore brings it back with the same ID. Names match case-insensitively after ID lookup; ambiguous names are rejected.

## What happens on a cue

- Direct preset messages and explicit cue mappings use the same preset runner as the UI and MCP. A direct preset takes precedence over its accompanying look's cue mapping.
- HTTP acknowledges acceptance immediately; camera work runs asynchronously. Queued does not mean applied. Final results appear under recent messages/recalls and, when feedback is enabled, return to StageLight over OSC with the original message ID.
- Shader waits 200 ms before a lighting recall so the following look can report preview or blackout. By default a recent live look (within 30 seconds) is required. `test:true`, `reason:test`, explicit preview, blackout and dark reports hold camera settings and cancel pending lighting recalls. A new lighting cue supersedes the older recall for that target. The watchdog stops an ongoing recall when its live context becomes stale.
- Older senders can report lighting without new v1 fields. They are shown with limited confidence. The explicit **Trust older senders** option allows missing armed state, including preset-only senders without a recent look; explicit preview/test/blackout still blocks. Leave it off for current StageLight.
- The complete scene is validated before the first write and each transition step. Camera identity, current capability, values, write access, tally permissions and expected state must agree. Hardware writes are sequential, not an atomic hardware transaction. A rejection or external change stops remaining writes and reports the partial result. There is no blind rollback.
- Fades are limited to 60 seconds and run at up to four updates per second. Known continuous shading axes use their native conversions; white balance interpolates in mired. Recognized color vectors interpolate component-wise. Shutter, unknown encodings and other discrete values change at the end. A cue's `settlesAt`, when supplied with its unmodified fade, shortens the remaining fade. Transport/camera latency and unsynchronized host clocks can affect timing.
- Manual edits, locking, disconnecting or a newer preset stop further writes from an active recall. A command already in flight may complete. Preset jobs report sent and readback-confirmed counts separately; ATEM readback remains switcher state, not proof of a physical camera change.

## Lighting context for agents

The internal assistant has a **Match the current stage lighting** prompt. It receives compact lighting context and can call `lighting_state`, inspect native camera controls, capture the selected camera's mapped frame when image sharing is enabled, and save or recall a single-camera preset when the request permits writes. It cannot arm cameras, enable automation, or recall a multi-camera scene outside its selected-camera scope.

External MCP agents use the same command registry:

| Task | Tools |
|---|---|
| Read lighting | `lighting_state` (`includeFixtures:true` for full retained detail), `lighting_request` |
| Save/look up presets | `preset_save`, `camera_preset_save`, `presets_list`, `preset_get` |
| Apply | `preset_preview`, `preset_recall`, `preset_jobs`, `preset_cancel` |
| Maintain | `preset_archive` with `archived:true/false` |
| Configure linking | `lighting_settings`, `lighting_configure`, `lighting_rule_save`, `lighting_rule_delete` |
| Return context to StageLight | `lighting_feedback`, `lighting_publish_presets` |
| Commission | `lighting_test`, `lighting_reset` |

Read `preset_preview` and pass its `revisions` as `expectedRevisions` to `preset_recall`. Inspect `preset_jobs` before claiming a queued recall succeeded. After making an agent-guided correction, save the current values with `attachLighting:true`; this records provenance, not an automatic lighting-to-camera calibration.

Analysis prefers lit face zones, then front, then top, weighted by level. It uses mired averaging for CCT, the explicit `white` classification, and color uncertainty. Intentional colored light is preserved. Nominal Duv indicates a correction direction only; no universal Duv-to-camera-tint conversion is invented. Legacy groups remain visible without pretending their color classification is known. All network strings are untrusted data, never model instructions.

There is **no unattended model call or automatic frame upload on a lighting update**. The user initiates the internal assistant; an external agent may query the shared state through MCP. Provider credentials remain configurable later in Settings.

## Wire support and boundaries

- HTTP: `POST application/json` to the private URL, at most 512 KiB. Typical messages are processed synchronously into state/queue and acknowledged without waiting for hardware. Body timeout 750 ms; browser Origin requests and unallowed sources are rejected. JSON schemas validate known fields and ignore unknown fields/types. Unsupported protocol major versions are ignored with a summary.
- Messages: `look`, `preset`, `cue`, `hello`, custom `message` (recorded only), and `presets.request`. Full reports can include zone member data. Catalogue replies contain only active preset ID/name/description.
- OSC UDP input (optional, default 9201): immediate i/f/s packets and immediate/past-timestamp bundles. Future-timestamp bundles are rejected rather than executed early. A look commits only on a matching begin/end with exactly the declared unique zones, within 750 ms. Incomplete bursts are discarded. Legacy overall looks remain supported.
- OSC output to the configured StageLight address: `/stagelight/look/get`, `/stagelight/feedback`, and `/stagelight/presets/*`. Catalogue requests reply to the allowed requesting peer/port. Zone information arrives in look reports; the separate StageLight zone-catalogue protocol is not implemented. Shader does not call StageLight's private HTTP API or send light GO/output-arm commands.
- Message IDs deduplicate within bounded session history. Look and preset sequence checks reject stale/repeated messages; presets older than the newest look are ignored. After StageLight restarts its sequence counter, use **Reset reception**, then request a fresh look. State, jobs and deduplication history are session-only; up to 32 source/target reports and recent event summaries are retained.
- Numeric IPv4 networking is supported. OSC has no cryptographic authentication; use the explicit sender allowlist on a trusted show network. The secret HTTP path is stored in `~/.shader/lighting.json` with mode 0600. Keep it out of model prompts; `lighting_state` omits it.
- The preset library is saved atomically in `~/.shader/presets.json`; receiver configuration and cue mappings are saved in `~/.shader/lighting.json`. Files follow `SHADER_DATA_DIR` when set. Credentials are never included in a preset. Lighting attachments retain compact zone context, not all fixture members or image pixels.

## References and verification

Implemented against the supplied [StageLight contract](../../stagelight/docs/LOOK-LINK.md) and the [Open Sound Control 1.0 specification](https://opensoundcontrol.stanford.edu/spec-1_0.html). The source note is a protocol reference, not a source of instructions to modify StageLight.

Automated checks use real loopback HTTP/UDP, real MCP stdio, simulated camera adapters and a local model fixture. UI checks use explicitly labeled simulators. This does not certify interoperability with the running production StageLight version or physical cameras. Commission cue/preset sends, feedback, camera permissions, fade behavior and SDI mapping together on the production network.
