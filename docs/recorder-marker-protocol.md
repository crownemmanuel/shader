# Shader recorder marker receiver — v1

Implemented 26 October 2026, unreleased. This document aligns with [StageMics' sender contract](stagemics-markers.md). The sender contract supplies complete event examples; the endpoints and semantics below match the implementation in `native/recorder`.

## Connection and discovery

Enable **Recorder Studio → StageMics connection**. Default is HTTP on `127.0.0.1:9202`. For another computer, enable the show-network listener and allow the StageMics IPv4 address. Enter `http://<Shader PC IPv4>:9202` in StageMics. Shader generates the pairing key and exposes it only through the local operator UI; it is excluded from status, MCP results, logs and recording exports.

Every request uses `Authorization: Bearer <pairing key>`. JSON requests use `Content-Type: application/json`. Browser Origin requests are refused. The public listener is disabled by default, and LAN listening requires an explicit sender allowlist. This is a local/show-network HTTP endpoint, not an Internet service or TLS endpoint.

### `GET /recorder/v1/session`

Returns 200 both idle and recording:

```json
{
  "protocol": "shader.recorder/1",
  "app": "Shader",
  "version": "0.1.4",
  "recording": false,
  "recordingSessionId": null,
  "sessionName": null,
  "showRunId": null,
  "startedUtc": null,
  "sessionClockId": "host-mono-<uuid>",
  "ticksPerSecond": "1000000000"
}
```

While recording, session ID/name and `startedUtc` (decimal epoch milliseconds) describe the exact take. Preparing/finalizing are not advertised as recording. StageMics polls every two seconds. An active take's clock identity is preserved when the supervisor reconnects to surviving workers on the same host.

### `POST /recorder/v1/clock/probe`

Request `{ "t1": "1793041260123" }`. Response:

```json
{
  "t1": "1793041260123",
  "t2": "88231000450000",
  "t3": "88231000470000",
  "utc": "1793041260125",
  "sessionClockId": "host-mono-<uuid>",
  "ticksPerSecond": "1000000000"
}
```

`t2` and `utc` are sampled at handler receipt; `t3` is sampled for the response. StageMics uses its own receive time `t4` and computes, with `k = ticksPerSecond / 1000`:

```text
offsetTicks = ((t2 - t1*k) + (t3 - t4*k)) / 2
uncertaintyTicks = ((t4 - t1)*k - (t3 - t2)) / 2
Shader event ticks = originalEventUtc*k + offsetTicks
```

Probe on connect/clock change and every 30 seconds. Keep the shortest-round-trip sample. All timestamps, offsets, samples, and sequences are decimal strings; don't round 64-bit ticks through JavaScript Number. Missing/unknown clock domains are saved as unresolved timing, never replaced silently with packet arrival time. Probes older than 90 seconds are labeled with a clock warning. A new clock after a full restart is not assumed interchangeable with a completed take's old domain.

### `POST /recorder/v1/sessions/{recordingSessionId}/events`

Accepts one event, up to 16 KiB. Required envelope: `protocol`, UUID `eventId`, stable `senderId`, UUID `senderRunId`, decimal `sequence`, matching `recordingSessionId`, `type`, `label`, `time`, and `scope:"all-recorded-inputs"`.

Supported types are **`scene.enter`, `scene.exit`, `marker`**. Scene events include `scene:{id,code?,name}`. UTC time is `time:{domain:"utc",utc,clockSource,clock?}`. `clock` carries `sessionClockId`, `ticksPerSecond`, signed `offsetTicks`, nonnegative `uncertaintyTicks`, and `probedUtc`.

Optional `audio` preserves `{recordingId,recordingName,sample,sampleRate,edited:false}` on the original full-length audio timeline. Cue/cast context and other additive metadata are retained. Edited-audio anchors are rejected in v1. StageMics records silence while mics are muted; no edit map, master-audio asset upload, `gap.begin`, or `gap.end` endpoint is required.

Shader writes and flushes the checksummed event journal **before** acknowledging:

| Response | Meaning |
| --- | --- |
| 201 `{status:"saved",eventId,...}` | Event durably accepted in the local journal |
| 200 `{status:"duplicate",eventId,...}` | Same event ID and same normalized content already stored |
| 409 `EVENT_ID_CONFLICT` | ID reused with different event content |
| 404 `UNKNOWN_SESSION` | That take ID is unknown |
| 400 / 422 | Invalid body, protocol/type, URL/session mismatch or fields |
| 401 / 403 | Pairing key, Origin or sender IP rejected |
| 503 `PERSISTENCE_FAILED` / `JOURNAL_UNAVAILABLE` | Not acknowledged; retain and retry |

Errors use `{status:"rejected",code,error}`. Additional acknowledgment fields include `recordingSessionId`, journal sequence and timing quality. HTTP transport/size-limit errors may come from the HTTP stack. A timeout is an unknown outcome: retry the **identical frozen event**, including event ID/time/clock. The public receiver does not mutate an event on retry. There is no arrival-time correction.

Completed takes continue accepting delayed delivery under their original IDs. Events are never moved onto a later take. StageMics keeps its durable outbox and sends only after seeing a matching active take, as specified in its contract.

### Scene interval rules

- `scene.enter` starts a range. `alreadyLive:true` may precede take start; save the original UTC and negative session ticks, and clip only its visible start to zero.
- `scene.exit` closes the exact `enterEventId` when open, otherwise the latest open matching scene ID for that sender. The exit remains recorded even when no matching enter exists in this take.
- A→B sends explicit exit A then enter B at the same timestamp; sequence orders the events.
- Delivery can arrive late/out of order. Exports sort by event time and sequence, not network order.
- An open range at take end is labeled open and given a visible take-end boundary. No synthetic exit is created.
- Outside-take or unresolved events remain in the journal and exports with their timing status. A scene boundary does not authorize automatic cutting.

### `GET /recorder/v1/sessions/{id}/events/{eventId}`

Optional reconciliation lookup. Returns saved event data or 404. The StageMics v1 sender only needs the three endpoints above.

## Recording handoff and command layer

The take folder contains `markers.jsonl`, CSV and `scenes.json`; each camera folder contains `markers.json` with available segment/local-time projections. Original audio sample positions, uncertainty and camera-name snapshots are retained. A marker with no confirmed media at its time is labeled accordingly. These are editor-neutral sidecars, not proprietary editor projects or a promise that every editor imports markers automatically. No chapters are injected into live MOV files.

The same engine registry exposes `recorder_status`, `recorder_monitor`, `recorder_release`, `recorder_storage`, `recorder_preview`, `recorder_input_update`, `recorder_start`, `recorder_stop`, `recorder_marker`, `recorder_markers`, `recorder_export`, `recorder_recover` and `recorder_network` to UI/MCP. Start requires an idempotency UUID; retry the same arguments/ID after an unknown outcome. Pairing-key retrieval is UI-only. Public StageMics access is limited to session/clock/marker operations and cannot start/stop recordings or change cameras.

## Verification

Rust tests exercise durable journal replay, torn-tail handling, conflict rejection, already-live clipping, explicit exits/reentry and unresolved clocks. The synthetic integration test sends the actual StageMics HTTP envelope, verifies authentication, 201/duplicate/conflict, supervisor crash survival, late exits, 16-channel PCM MOVs and sidecar projection. A separate fault test checks live checkpoints, worker isolation and recovery. Real LAN clock accuracy, physical SDI timing and multiple-editor import remain hardware qualification items; do not infer frame-accurate sync from these tests.
