# Recorder Studio: implementation and production qualification

Updated 26 October 2026. **Included in the release as a recorder preview; hardware qualification is still required.** The current target is Windows with a DeckLink Quad 2, up to eight 1080p30/29.97 SDI inputs, and embedded SDI audio. The user's CPU, RAM, GPU model, and recording drive have not been measured. A GPU by itself does not establish eight-channel ProRes encoding capacity.

## Operator workflow

Open **Recorder Studio** in Shader's toolbar. Find inputs, select the card (or all DeckLink inputs), and press **Monitor inputs**. Up to eight physical inputs stay open when returning to shading; previews share the same capture process. **Stop monitoring** releases idle inputs to other software. Close vMix before acquiring the card.

The multiview and table show input name, SDI connector, camera-button mapping, format/audio, and signal/recording status. Right-click a preview or use its menu to rename and map the input. Aliases appear in capture dropdowns and become the names of new camera folders/files. Names, mappings, format and recording selection are fixed during a take. Video-format changes require stopping monitoring first. Supported recording modes are explicitly 1080p30 and 1080p29.97; verify the actual SDI frame rate instead of treating those as interchangeable.

**Choose folder** opens the native Windows/macOS folder picker. The selected path and its actual available/total disk space appear together. The readout refreshes every five seconds, including during recording. Remaining time uses the selected codec, number of inputs and 2/8/16-channel audio. Two GiB are reserved for file finalization. These are estimates, not guaranteed codec bitrates. Start checks writable storage, free space, and video/audio readiness again. Optional duration stops the take automatically; otherwise Stop finishes it.

Select one or more cameras, choose ProRes 422 LT or ProRes 422, name the take and Record. Each camera produces its own MOV parts with all selected embedded audio channels. Continuous five-minute parts keep earlier completed media independent of the current part. Recordings are editor-neutral; no Premiere-specific project is required. A muted microphone is not classified as dead space.

## Architecture actually implemented

- `native/recorder`: Rust/Axum supervisor and one separate worker process per physical input. Both survive loss of the UI/Node engine. The supervisor reconnects to surviving workers after restart. Startup without surviving workers marks unfinished sessions interrupted and preserves files.
- Official GStreamer Rust bindings, requiring GStreamer 1.22 or later. `decklinkvideosrc` and `decklinkaudiosrc` select the stable **persistent ID**, not an enumeration index or device label. Existing connector profiles are retained. Native DeckLink SDK enumeration supplies per-card group ID and the Quad 2 connector mapping.
- One warm full-rate video/audio pipeline per input. A bounded droppable preview branch emits 480×270 JPEGs at up to six frames per second. Recording consumes original full-size buffers; full-rate media never passes through JavaScript.
- Per-worker ProRes encoding through `avenc_prores_ks` and unchanged 48 kHz S32LE PCM. Automatic CPU threading is enabled. Video/audio queue overflow or timestamp discontinuity produces a visible fault and ends the affected track rather than reporting a clean take. Healthy workers continue.
- GStreamer `splitmuxsink` with `qtmux`, periodic MOV header updates, bounded segments and explicit file flushes. Completed parts are flushed and renamed from `.mov.partial` to `.mov`; their time ranges are atomically journaled. Current media files receive periodic flush requests. The storage/controller/OS must still be qualified under abrupt power loss.
- Common host monotonic start boundary, original frame timestamps, independent audio timestamps, and a per-camera first/last timestamp report. This is **software alignment**, not a claim of frame-accurate, genlocked acquisition. Native RP188 timecode and DeckLink synchronized-capture groups are not implemented.
- Disk failure/low space is checked in each recording worker, so it does not depend solely on the supervisor. A supervisor-level check also stops the take near the reserve. Files on a removed drive are never replaced by new media silently.
- Windows recording workers request system execution state to inhibit idle sleep during a take. This does not prevent forced sleep, shutdown or power failure.
- Engine shutdown and update/restart are refused while a recording is active or a stop remains uncertain. Closing the Studio view does not stop recording. If the app's normal quit is refused, it opens Recorder Studio for attention.
- A failed input can be released/reopened after the take. Automatic signal-loss reconnection within the same take, spare-drive failover and redundant recording are not implemented. A stopped input is reported as partial; missing picture is never manufactured.

## Files and recovery

```text
Chosen folder/
  Sunday service_take-<id>/
    session.json
    markers.jsonl
    markers.csv
    scenes.json
    Choir wide_SDI-01/
      Choir wide_SDI-1_<id>_part-00000.mov
      Choir wide_SDI-1_<id>_part-00001.mov.partial
      segments.json
      track-report.json
      markers.json
```

Names are sanitized for Windows and include a physical connector/unique identity. Take folders are created exclusively; existing recordings are not overwritten. Selection and names are snapshotted into the session manifest.

The local app-data recorder directory contains authoritative session state and checksum-protected, append-only marker journals. Successful marker acknowledgment follows `sync_all`. Only an unterminated journal tail can be truncated on reload; a corrupt committed record fails closed. JSON/CSV exports can be regenerated from this journal if the destination drive was absent. No pairing key is exported with a take.

In **Recent takes**, **Recover partial files** remuxes readable checkpointed portions into new `.recovered.mov` files using the installed FFmpeg. It leaves original `.partial` files untouched, requires a successful process and nonzero video-frame count, and writes `recovery-report.json`. Existing recovery outputs are never overwritten. A checkpoint cannot restore media that never reached storage. Review recovered duration, all audio channels and alignment before editing. Recovered partial-file timing is not automatically asserted as exact in the marker sidecar; unresolved media remains explicitly unresolved.

## StageMics alignment

[StageMics' contract](stagemics-markers.md) is authoritative for what the mic app sends. [Receiver protocol](recorder-marker-protocol.md) documents Shader's matching implementation.

StageMics records full-length character WAVs with silence while muted. It does not remove time, does not send edit maps and does not identify dead space. Shader accepts `scene.enter`, explicit `scene.exit`, and `marker`. It preserves original UTC, measured clock offsets, uncertainty, sequence, cue/cast context and original audio sample positions. Scenes already live at take start retain their earlier timestamps; only the visible range is clipped to zero. A scene transition closes A and opens B at the same time in sequence order. Completed takes accept delayed events bound to their original IDs.

The integration is authenticated HTTP JSON, default port 9202. Existing lighting uses OSC and HTTP; StageMics v1 uses HTTP for acknowledged durable marker delivery. No OSC marker listener or scene automation is added in this implementation. Markers do not change camera controls or operate a sound console. Testing uses local fixtures only, never a live dLive console.

## Storage sizing

At nominal 1080p30, the estimate budgets 103 Mbps for ProRes LT or 148 Mbps for ProRes 422 per input, plus 48,000 × 4 × audio-channel-count bytes/s. Eight 16-channel streams are approximately **128 MB/s (459 GB/hour)** for LT or **173 MB/s (621 GB/hour)** for 422. These figures include PCM audio, exclude filesystem/container overhead and may differ from actual encoded rates. Keep additional headroom for variability and long sessions; the UI's reserve is not a drive-performance certification.

## Build and checks

```sh
# Official GStreamer runtime + development files, libav/DeckLink plugins, Rust and pkg-config required.
npm run build:recorder
npm run check
npm test
npm run test:recorder
```

Windows: use the **MSVC x64** GStreamer 1.28.8 with runtime and development files, with libav/DeckLink plugins. Set `GSTREAMER_1_0_ROOT_MSVC_X86_64` to their installation root. The build script compiles Rust, checks required factories, and stages the executable with the runtime's DLL/plugin/share directories. The Node launcher points PATH and plugin discovery at this private runtime. Blackmagic Desktop Video remains a separately installed hardware driver. Run the build in an MSVC developer environment.

The app build fails if Recorder Studio has not been staged. Release CI installs the official Windows GStreamer 1.28.8 development/runtime package with a pinned SHA-256, bundles its runtime and notices, and checks the staged executable. macOS builds copy only required plugins and the complete non-system dynamic-library dependency graph, rewrite loader paths, preserve package license/build metadata, and sign the relocated binaries. Both platforms run synthetic recording and crash-recovery checks against the staged runtime. Blackmagic input enumeration remains Windows-only; physical hardware qualification is separate from these package checks.

`SHADER_RECORDER` can select an absolute development executable. Synthetic test sources require `SHADER_RECORDER_TEST_INPUTS=1` and are not exposed by production UI/MCP source selection. `SHADER_RECORDER_SEGMENT_SECONDS` shortens segments in fault tests. Test scripts use isolated state/output folders; `SHADER_FFMPEG` and `SHADER_FFPROBE` can point to local inspection tools.

## Production qualification still required

1. Test the packaged Windows executable/runtime on a clean machine with the installed Desktop Video version and all eight Quad 2 inputs. Verify physical connector identity and unchanged card profiles.
2. Measure CPU/GPU/RAM/storage. Sustain eight actual 1080p30 feeds with maximum intended audio for at least the longest planned service plus margin. Measure CPU, memory, writer queues, dropped frames, audio continuity, temperature and disk latency through segment rollover. Test both profiles independently.
3. Record flash/clap references on all inputs. Quantify relative start offset and drift across hours. Test hardware reference/genlock if required; a network clock probe alone does not provide genlock.
4. Test source disconnect/reconnect, wrong SDI rate, full disk, USB/NVMe removal, worker crash, supervisor crash, UI/Node crash, forced reboot, suspend and controlled power removal on expendable media. Check that healthy tracks continue, failures remain visible and shutdown never reports a false clean completion.
5. Inspect every recovered/closed MOV with independent tools. Import ProRes/PCM into multiple editors, check all 16 channels, joins and long-take audio/video sync. Verify marker offsets against actual scene cues and StageMics WAV sample anchors. Keep original files during this process.
6. Validate installer dependency isolation, runtime licenses/notices, driver compatibility and updates. The user authorized including the recorder preview in this release. Do not call it production qualified until these hardware gates pass.

## Primary research references

- [Quad 2 specifications](https://www.blackmagicdesign.com/products/decklink/techspecs/W-DLK-45): eight independent SD/HD inputs/outputs and embedded SDI audio.
- [GStreamer DeckLink video](https://gstreamer.freedesktop.org/documentation/decklink/decklinkvideosrc.html) and [audio](https://gstreamer.freedesktop.org/documentation/decklink/decklinkaudiosrc.html): stable persistent-ID selection, modes, audio channels and connector profiles.
- [Official Rust bindings](https://gstreamer.freedesktop.org/documentation/rust/stable/latest/docs/gstreamer/index.html).
- [Split muxing](https://gstreamer.freedesktop.org/documentation/multifile/splitmuxsink.html) and [qtmux](https://gstreamer.freedesktop.org/documentation/isomp4/qtmux.html): independent parts, robust mux reservation and periodic header updates.
- [DeckLink synchronized capture](https://sdk-doc.blackmagicdesign.com/decklink-sdk/HighLevel/synchronized.html): capability checks, clock/reference and rate requirements. It must not be assumed for this card.
- [Apple ProRes rates](https://support.apple.com/en-by/102207): approximate 1080p29.97 codec targets; rate estimates are not an encoder-throughput guarantee.
- [Rust file durability](https://doc.rust-lang.org/std/fs/struct.File.html#method.sync_all) and [Windows FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers): explicit flushing and platform limits.
- [FFmpeg container formats](https://ffmpeg.org/ffmpeg-formats.html): conventional final-header MOV/MP4 needs special handling for interrupted recordings.
