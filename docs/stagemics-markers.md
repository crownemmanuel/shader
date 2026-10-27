# StageMics → Shader recorder: what the mic app will send

Written 26 October 2026 from the StageMics side (repository `~/Documents/Projects/stagemics`). It narrows [recorder-marker-protocol.md](recorder-marker-protocol.md) to what StageMics actually does and will send. Where the two disagree about the mic app, this file is the mic app's answer. The endpoint shapes below are the ones StageMics is being built against, so please keep them or tell the StageMics session what changed.

## What StageMics is

StageMics runs the actors' radio mics on the Allen & Heath dLive, scene by scene. The operator (or LiveStage over OSC) **activates a scene**, steps through its **cues** (who is live), and **ends the scene**. StageMics also records each character's mic from Dante (one WAV per character, silence while muted) and exports them for the video editor.

So StageMics knows, to the millisecond, when each scene started and ended. That is what it sends to Shader: **scene start, scene end and operator markers**. Nothing else in v1.

## Corrections to the current plan's assumptions about the mic app

1. **No edited master audio and no edit maps.** StageMics never removes time. Its exports are full-length files on the recording's own timeline, with silence where a mic was muted, and a one-scene export is just that scene's range cut out, not re-timed. `audio-edit-maps` and `audio-assets` are not needed for StageMics. Keep them for later if you want, but StageMics will not call them.
2. **No `gap.begin` / `gap.end`.** StageMics does not propose cuts. A muted mic or the time between scenes is not dead space, and StageMics will never say it is.
3. **Explicit `scene.exit`.** End scene sends `scene.exit`. Going straight from scene A to scene B (no End in between) sends `scene.exit` for A, then `scene.enter` for B, with the same time; `sequence` orders them.
4. **Time is `utc` plus a measured clock offset.** StageMics stamps every event with its own wall clock (ms since epoch) at the moment the scene changed, and adds the result of its latest clock probe against Shader (below). It never sends arrival time and never re-stamps an event on retry.
5. **A take that starts mid-scene gets the scene.** When StageMics first sees a new `recordingSessionId` while a scene is live, it sends a `scene.enter` for that scene with `"alreadyLive": true` and the scene's **real** start time, which is earlier than the take's start. Please accept it and clamp the interval to the take's start (keep the original time).
6. **No take, no event.** If Shader says it is not recording, a scene change is **not** sent. StageMics shows "Shader is not recording" to the operator and keeps the event in its own log. It never puts an event on a later take.
7. **Shader unreachable.** Events are bound to the last take StageMics saw recording and kept in a durable outbox until Shader answers. If StageMics has never seen a take (for example, Shader was unreachable from the start), events wait. When Shader answers, StageMics sends them only if `startedUtc` shows that take started before the event (corrected by the probe's skew); otherwise they are dropped as "not recording".
8. **One mic app, one take at a time.** StageMics talks to one Shader address.

## Connection

- HTTP/1.1 JSON, StageMics is the client. Default target `127.0.0.1:9202`; the operator sets host, port and the pairing key in StageMics (Build → Settings → Shader video recorder).
- Every request: `Authorization: Bearer <pairing key>`, `Content-Type: application/json`, `User-Agent: StageMics/<version>`. No `Origin` header.
- Timeout 3 s per request. A timeout is an unknown outcome: StageMics retries the identical body.
- All 64-bit values (ms, ticks, samples, sequence) are **decimal strings**.

## 1. Heartbeat and handshake: `GET /recorder/v1/session`

StageMics asks every **2 s** (and right before sending queued events). This is the handshake and the operator's "Shader: connected, recording 'Sunday service'" light.

Response `200` (both when recording and when not):

```json
{
  "protocol": "shader.recorder/1",
  "app": "Shader",
  "version": "0.2.0",
  "recording": true,
  "recordingSessionId": "e834609f-6b1c-454b-9e35-1b22c4679200",
  "sessionName": "Sunday service",
  "showRunId": null,
  "startedUtc": "1793041200000",
  "sessionClockId": "host-mono-7f3a",
  "ticksPerSecond": "1000000000"
}
```

When not recording: `"recording": false, "recordingSessionId": null` (clock fields still present). StageMics needs `protocol`, `recording`, `recordingSessionId`, `startedUtc`, `sessionClockId` and `ticksPerSecond`; it shows `app`, `version` and `sessionName`; it ignores anything else. A different `protocol` major is shown as an error and nothing is sent. `401`/`403` is shown as "Shader refused the pairing key".

## 2. Clock: `POST /recorder/v1/clock/probe`

StageMics probes 4 times on connect, whenever `sessionClockId` changes, and every 30 s, and keeps the sample with the shortest round trip.

Request: `{ "t1": "1793041260123" }` (StageMics UTC ms at send).
Response `200`:

```json
{ "t1": "1793041260123", "t2": "88231000450000", "t3": "88231000470000", "sessionClockId": "host-mono-7f3a", "ticksPerSecond": "1000000000", "utc": "1793041260125" }
```

`t2` / `t3` are your monotonic ticks at receipt and at reply; `utc` is your wall clock at receipt (only used to show the operator how far the two clocks differ). With `t4` = StageMics UTC at receipt of the answer, StageMics computes (NTP style):

- `offsetTicks = ((t2 − t1·k) + (t3 − t4·k)) / 2`, where `k = ticksPerSecond / 1000`
- `uncertaintyTicks = ((t4 − t1)·k − (t3 − t2)) / 2`

so that **your ticks for an event = `utc · k + offsetTicks`**, ± `uncertaintyTicks`. That result is in every event as `time.clock`. On a LAN this should be a few ms.

## 3. Events: `POST /recorder/v1/sessions/{recordingSessionId}/events`

One event per request, in `sequence` order; the next one goes only after the previous one is `saved` or `duplicate`. The body is built and **frozen** the first time it is sent (stored in the outbox), so a retry is byte-for-byte identical.

### Envelope (every event)

| Field | Value |
| --- | --- |
| `protocol` | `"shader.recorder/1"` |
| `eventId` | UUID, made once when the scene changed |
| `senderId` | `"stagemics-<8 hex>"`, stable for that StageMics install |
| `senderRunId` | UUID, new each time StageMics starts |
| `sequence` | decimal string, from `"1"` within a run |
| `recordingSessionId` | the take it belongs to (same as the URL) |
| `showRunId` | echoed from the session answer, or omitted |
| `type` | `scene.enter`, `scene.exit` or `marker` |
| `label` | human text, at most 200 characters, e.g. `"Scene 7 · The Shepherds"` |
| `time` | `{ "domain": "utc", "utc": "<ms>", "clockSource": "stagemics-host", "clock": {…} }` |
| `audio` | optional: where StageMics' own audio recording was at that moment (below) |
| `scope` | `"all-recorded-inputs"` |

`time.clock` (absent if StageMics could not probe yet):
`{ "sessionClockId": "host-mono-7f3a", "ticksPerSecond": "1000000000", "offsetTicks": "-1793041171892000000", "uncertaintyTicks": "600000", "probedUtc": "1793041260123" }`

`audio` (only while StageMics is recording Dante):
`{ "recordingId": "rec_m2x8k1", "recordingName": "Sunday service", "sample": "1440000", "sampleRate": 48000, "edited": false }`.
`sample` is the position on StageMics' recording timeline; every StageMics export of that recording starts at sample 0 of it, so a scene at sample 1 440 000 is 30.000 s into every exported character file. Use it as an audio anchor (two or more per show come for free, one per scene change). It is never an edited position.

### `scene.enter`

```json
{
  "protocol": "shader.recorder/1",
  "eventId": "6f51d144-7d61-4dfb-80cf-c4e49db9b616",
  "senderId": "stagemics-3fa9c2d1",
  "senderRunId": "747f8600-51ae-4b80-ae96-713cbcb7d3dd",
  "sequence": "42",
  "recordingSessionId": "e834609f-6b1c-454b-9e35-1b22c4679200",
  "type": "scene.enter",
  "label": "Scene 7 · The Shepherds",
  "scene": { "id": "scene_k2j4", "code": "7", "name": "The Shepherds" },
  "cue": { "id": "cue_91", "number": 1, "label": "Shepherds enter" },
  "cast": [ { "id": "ch_mary", "name": "Mary", "mic": 3 }, { "id": "ch_joseph", "name": "Joseph", "mic": 1 } ],
  "alreadyLive": false,
  "time": { "domain": "utc", "utc": "1793041262000", "clockSource": "stagemics-host", "clock": { "sessionClockId": "host-mono-7f3a", "ticksPerSecond": "1000000000", "offsetTicks": "-1793041171892000000", "uncertaintyTicks": "600000", "probedUtc": "1793041260123" } },
  "audio": { "recordingId": "rec_m2x8k1", "recordingName": "Sunday service", "sample": "1440000", "sampleRate": 48000, "edited": false },
  "scope": "all-recorded-inputs"
}
```

`scene.id` is stable (LiveStage's scene id); `code` is the display number (`7`, `2.1`). The same scene can be entered again later (a second run, a restart): that is a new `eventId`, and Shader should treat it as a new interval (take 2 of that scene).

### `scene.exit`

Same envelope, plus:

```json
{
  "type": "scene.exit",
  "label": "End of scene 7 · The Shepherds",
  "scene": { "id": "scene_k2j4", "code": "7", "name": "The Shepherds" },
  "enterEventId": "6f51d144-7d61-4dfb-80cf-c4e49db9b616",
  "enteredUtc": "1793041262000",
  "reason": "ended"
}
```

`reason`: `ended` (End scene), `next-scene` (another scene was activated; its `scene.enter` follows with the same `utc`), or `removed` (the scene was deleted or re-imported away). `enterEventId` may name an enter that went to an earlier take or was never sent (no take then); match on it when you can, otherwise close the open interval for that `scene.id`.

### `marker`

```json
{ "type": "marker", "label": "Mary's mic crackled" }
```

Sent when the operator presses Mark in StageMics' Recorder tab (and from StageMics' "Send a test marker" button). No note in v1.

### Answers StageMics expects

| Answer | StageMics does |
| --- | --- |
| `201` `{ "status": "saved", "eventId": … }` | Done; next event |
| `200` `{ "status": "duplicate", "eventId": … }` | Done (an earlier try was saved) |
| `400` / `422` | Drops it, shows the `error` text (a StageMics bug) |
| `404` / `409` with `code: "NO_ACTIVE_SESSION"` or `"UNKNOWN_SESSION"` | Drops it, shows "Shader no longer has that take" |
| `409` with `code: "EVENT_ID_CONFLICT"` | Drops it, shows it as a StageMics bug |
| `401` / `403` | Keeps it, stops sending, shows "Shader refused the pairing key" until the key is changed |
| `429` | Keeps it, waits `Retry-After` seconds (or 2 s) |
| `5xx`, timeout, connection refused | Keeps it, retries the identical body after 250 ms, 500 ms, 1 s, 2 s, then every 2 s |

Error bodies: `{ "status": "rejected", "code": "…", "error": "plain sentence for the operator" }`.

StageMics never gives up on an event that can still be saved. It shows the operator how many are waiting, and keeps the outbox on disk, so a StageMics restart or a crash loses nothing that wasn't acknowledged. A StageMics restart mid-scene does **not** resend `scene.enter`: it remembers what it already sent.

## What the StageMics operator sees

A **VIDEO** light in the StageMics top bar, shown only when the Shader link is on: green "recording", amber "Shader is not recording" or "N markers waiting", red "Shader not answering" or "key refused". The Settings card shows the target, Shader's app/version and take name, the clock round trip and skew, and the last events with their state (saved, duplicate, waiting, not sent because no take, rejected).

## Testing without each other

- StageMics will ship `pnpm fake-shader` (`scripts/fake-shader.ts`): a small fake of the three endpoints above, used by StageMics' own checks. It's also a reference for the shapes.
- To drive Shader from the real StageMics without touching the sound desk: run StageMics with the desk in **dry run** (Build → Desk → Dry run) or against its `pnpm fake-dlive` desk. **Never** test against the real dLive (it is used for live church services). Activate / end scenes on StageMics' Show screen and watch Shader's marker lane.
- Acceptance from the StageMics side:
  1. Activate a scene, switch to another, end it: Shader stores enter, exit + enter, exit, in that order, with StageMics' times.
  2. Stop Shader's listener, change scenes, start it again: the queued events arrive with their original times, once each.
  3. Shader saves an event but the answer is lost: the retry gets `duplicate`, and there is one marker.
  4. Start a take while a scene is live: one `scene.enter` with `alreadyLive: true` and the earlier time.
  5. Not recording: scene changes are not sent; StageMics says so.
  6. Wrong key: `401`, StageMics shows it, nothing is lost; fix the key and everything is delivered.

## Open questions for Shader

1. Will `GET /recorder/v1/session` answer `200` with `recording: false` when there is no take, as above? StageMics needs `startedUtc` from it.
2. Is `ticksPerSecond` fixed per `sessionClockId`? StageMics assumes yes.
3. Is accepting an `alreadyLive` enter that starts before the take OK, clamped to the take start?
4. Pairing: does Shader generate the key and show it to the operator to paste into StageMics? StageMics assumes so (it stores it in its settings file, never in logs or exports).
