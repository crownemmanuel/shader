# DeckLink capture on Windows

Research date: 26 October 2026. This report inspects the current workspace and primary vendor/upstream documentation. The user confirmed the card is a **DeckLink Quad 2** and that **Shader can use it independently of vMix**. Direct capture of its eight inputs is the target; simultaneous sharing with vMix is not required. The user's Windows installation and physical card have not been tested. The initial research was followed by the implementation described in `native/decklink/README.md`. The findings below describe the starting point.

## Findings in Shader

1. **DeckLink support is partial.** `engine/capture.ts:82` enumerates DirectShow on Windows, then checks whether FFmpeg supports DeckLink. It only attempts native DeckLink discovery if that backend exists. Capture arguments already support `-f decklink` and an optional format code (`engine/capture.ts:376`). Camera mapping, shared previews and snapshots already exist.
2. **The packaged backend is the leading explanation for missing native devices.** `scripts/fetch-ffmpeg.ts:47` selects Gyan's Windows essentials build. Its published component lists omit DeckLink, including from the full variant. Desktop Video installation cannot add a backend to an already compiled FFmpeg executable. The actual installed Windows binary should be checked with `-devices`; there is no Windows binary here to execute. Sources: [Gyan build contents](https://www.gyan.dev/ffmpeg/builds/#libraries), [FFmpeg DeckLink requirements](https://ffmpeg.org/ffmpeg-devices.html#decklink).
3. **The device parser has a confirmed mismatch.** `engine/capture.ts:133` invokes `-sources decklink`, but line 137 only recognizes names in single quotes. FFmpeg 9.0.2 emits a device identifier followed by a bracketed description for `-sources`; single-quoted descriptions belong to its legacy `-list_devices` output. A small reproduction using those upstream formats confirmed our parser accepts the legacy row and rejects the current row. This is a software reproduction, not hardware validation. Sources: [FFmpeg source-list formatter](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/fftools/opt_common.c#L1274), [DeckLink identifiers and legacy listing](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavdevice/decklink_common.cpp#L507).
4. **Failure details are discarded.** `engine/capture.ts:229` drops capture stderr and later displays a generic error. Discovery also does not distinguish every driver/backend/enumeration failure. Users need separate messages for missing capture support, missing runtime, busy input, unsupported mode and absent signal.

The app also offers manual DeckLink registration in `app/routing-settings.tsx:187`. Registration saves a source; it cannot supply missing capture support. A DirectShow route may be available when Blackmagic's optional DirectShow/WDM components are installed, but that must be checked on the Windows machine. Successful vMix capture does not establish DirectShow availability. [Desktop Video installation components](https://sdk-doc.blackmagicdesign.com/decklink-sdk/section1.html#custom-windows-installations)

## Eight independent inputs

The confirmed Quad 2 supports eight independent SD/HD channels up to 1080p60. [Blackmagic specifications](https://www.blackmagicdesign.com/products/decklink/techspecs)

The card must expose independent connectors, rather than four paired input/output channels. The SDK calls this the two-subdevice half-duplex profile within each connector pair. The whole card has four such pairs; it is not an eight-channel video stream. Software must enumerate and open the individual active capture subdevices. Profile changes affect peers, so discovery should read the current configuration rather than automatically changing it. [Blackmagic device profiles](https://sdk-doc.blackmagicdesign.com/decklink-sdk/HighLevel/profiles.html)

Quad 2 connector numbering is nonsequential:

| Software channel (1-based) | Physical SDI connector |
| --- | --- |
| 1 | 1 |
| 2 | 3 |
| 3 | 5 |
| 4 | 7 |
| 5 | 2 |
| 6 | 4 |
| 7 | 6 |
| 8 | 8 |

Show the enumerated name and an operator-confirmed connector label. Do not assume the first software index means the first consecutive connector. vMix provides [Desktop Video Setup instructions for all eight channels](https://docs.vmix.com/knowledgebase/article.aspx/94/how-to-map-the-blackmagic-decklink-quad2-to-be-8-channels).

## Implemented direction (following this research)

The implementation adds a Windows x64 C++ DeckLink helper, similar in packaging to the existing Sony helper. Use the official SDK at build time and the installed Desktop Video runtime on the capture computer. Windows enumeration uses COM and `IDeckLinkIterator`. [Windows SDK entry point](https://sdk-doc.blackmagicdesign.com/decklink-sdk/accessing.html)

Implementation responsibilities:

- Enumerate card/subdevice identities, active profiles and capture capability. Persist hardware identity separately from the editable display label.
- List supported signal modes and provide automatic format detection where supported, with a manual resolution/frame-rate choice when necessary. Handle format-change callbacks and restart capture appropriately. [Automatic mode detection](https://sdk-doc.blackmagicdesign.com/decklink-sdk/HighLevel/automodedetection.html)
- Capture frames through `IDeckLinkInput` and its callbacks, convert pixel format/range correctly, and supply JPEG frames to the existing preview/snapshot service. [Capture sequence](https://sdk-doc.blackmagicdesign.com/decklink-sdk/HighLevel/capture.html)
- Keep one hardware session per input and share frames among consumers. Use bounded queues, release idle inputs, preserve frame provenance, and explicitly report signal loss. Existing previews target 960 pixels wide at 8 fps; the native worker can discard unneeded frames before expensive conversion.
- Return structured device, signal and error status separately from frame bytes. Add Windows packaging and runtime-version diagnostics. Retain DirectShow for other capture devices.

A smaller interim route is to fix the FFmpeg parser and select a tested DeckLink-capable executable using the existing `SHADER_FFMPEG` override. If packaging a custom FFmpeg, do not simply add DeckLink to the current GPL/x264 configuration: FFmpeg 9.0.2 requires `--enable-nonfree` for that combination and marks that result unredistributable. A dedicated build without GPL components is a separate option requiring build and SDK-term review; this finding does not mean every possible DeckLink-enabled build is unredistributable. [FFmpeg configuration logic](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/configure#L4660)

## Input ownership and possible future sharing

The user confirmed Shader can use the card on its own, so NDI reception is outside the current implementation scope. Release the intended inputs from vMix or other capture software before using direct capture in Shader.

Blackmagic documents exclusive access to an enabled hardware input. If vMix owns a particular input, another capture instance receives access denied. This is a capture-ownership issue, separate from device enumeration. Different free subdevices can be used separately. [Input access rules](https://sdk-doc.blackmagicdesign.com/decklink-sdk/DeckLinkAPI/interfaces/idecklinkinput.html#idecklinkinput-enablevideoinput-method)

If simultaneous sharing becomes a future requirement, an NDI receiver in Shader could receive individual camera feeds published by vMix. vMix documents camera-input output over NDI; this avoids competing for the hardware input. Shader currently has no NDI source kind (`engine/types.ts:75`), so this would require separate implementation. [vMix output documentation](https://www1.vmix.com/help29/NDIandOMT1.html)

## Windows verification

Use the FFmpeg executable actually used by Shader, respecting any `SHADER_FFMPEG` override. These PowerShell commands inspect capabilities and list sources; replace the example path:

```powershell
$ff = 'C:\path\to\Shader\ffmpeg.exe'
& $ff -hide_banner -devices
& $ff -hide_banner -sources decklink
& $ff -hide_banner -f dshow -list_devices true -i dummy
```

The DirectShow listing can exit nonzero after printing its devices. If DeckLink is absent from `-devices`, native discovery cannot work through that executable. If it is present, preserve the source-list output to verify parsing and runtime access.

Acceptance checks for the eventual implementation:

1. On the Windows card, enumerate every active input with a distinct identity and verify connector labels against real feeds.
2. With the tested inputs released by vMix/Media Express, capture each one and then all required simultaneous feeds. Confirm independent content, acceptable latency and bounded CPU/memory use.
3. Test the studio's actual signal modes, signal loss/reconnection and format changes. Verify image aspect ratio, color range and deinterlacing where applicable.
4. Verify previews and snapshots share input ownership, and stopping Shader releases it for vMix. Confirm busy-input errors with vMix holding an input.
5. Restart the machine/app and confirm mappings remain correct.

Recommendation for the confirmed setup: implement native DeckLink SDK capture on Windows, enumerate all eight Quad 2 inputs with correct connector mapping, and reuse Shader's previews and snapshots. Validate direct capture with vMix's inputs released.
