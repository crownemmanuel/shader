# Volunteer controls and routing

Shader opens in Simple view. Use Advanced for visual manual controls and the complete native control catalogue. The simulator is explicitly labelled; it does not generate a pretend camera image.

## Simple view

- **Brightness** is an adjustment from a starting point, expressed in stops. Drag and release to apply. Opening iris comes first, then bounded sensor gain or ISO. Darkening reduces gain first, then closes iris. Returning to zero restores the starting values. Shutter and ND never enter this recipe.
- Default limits are f/2–f/8, 0–12 dB gain, and ISO 3200. These are configurable starting limits, not a claim that every lens or camera supports them. Current settings outside a configured interval are held. Preserve aperture in Settings to keep depth of field fixed.
- **Warmth** changes color temperature; **Tint** changes green–magenta balance. “Too blue / amber / green / magenta” chooses the opposing correction. Corrections are bounded, anchored adjustments, not automatic scene analysis or a guarantee of neutral whites.
- Use **current picture as starting point** after a manual change, external hardware adjustment, or changed policy. The engine rejects outdated anchors and stale revisions. Partial failures name completed operations and stop; it does not blindly roll back a live camera.
- The first recipe is a deterministic control policy, not an image feedback loop. A successful command does not establish that measured brightness changed. Live camera calibration, scene metering, noise ceilings and exposure-mode handling remain commissioning work.

## Supported semantic mappings

| Adapter                      | Simple mappings                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simulator                    | Iris, sensor gain, white balance and tint; shutter visible in Advanced                                                                                                                                                                             |
| ATEM                         | Aperture Value converted to f-number; gain in dB (or ISO); Kelvin/tint vector preserved as one native write; shutter denominator exposed in Advanced                                                                                               |
| Sony                         | FNumber divided by 100; normal numeric ISO, excluding Auto/packed extension modes; Colortemp in reported range/steps; ColorTuningGM where the reported range matches the documented encoding; shutter fractions decoded from reported enum choices |
| PTZOptics VISCA              | Reported color-temperature index translated to Kelvin; Simple warmth requires color-temperature WB mode. Unknown model exposure curves and tint stay in Advanced.                                                                                  |
| Other / REST native controls | Native control catalogue remains available. No EV or color-direction semantics inferred from arbitrary numeric fields.                                                                                                                             |

Unsupported controls are disabled or remain in Advanced. The engine does not silently change exposure mode or white-balance mode. Use the camera’s manual modes and verify its response before volunteer use.

## Camera picture and On Air

Open **Settings → Camera mapping** to see all connected cameras in a table. Each row has a Show checkbox, camera name/status, video capture input, video format, ATEM switcher, ATEM input and program bus. Changes save automatically; a failed save keeps the previous mapping and shows the error on that row. **Find video inputs** refreshes the shared capture list and shows discovery diagnostics directly above the table. Camera buttons, brightness limits, assistant, integrations and app updates have separate settings tabs. Choose each camera’s ATEM switcher, input and audience M/E program bus in its row. The same mapping works for Sony and PTZOptics. Tally follows visible program/preview inputs, including keyers and transitions using the ATEM connection library’s visibility calculation. An aux-only assignment is not labelled On Air. A missing/disconnected switcher or missing bus/input produces **unknown** tally.

Choose the capture subdevice carrying that camera’s physical SDI feed. An eight-input DeckLink must expose the relevant capture subdevices under its Desktop Video profile; use Find video inputs to discover each separately. On Windows the native helper shows Quad 2 connector labels and supported video formats; choose automatic detection or a matching manual format. Mapping does not reroute an ATEM output and cannot verify that someone plugged the expected camera into the selected port.

The selected camera starts a continuous 960-pixel-wide JPEG preview at 8 fps. Preview and MCP snapshots share a capture process for the mapped source. Snapshot requests wait for a new frame; they do not open a competing DeckLink handle. Stale signal is labelled. Preview leases expire when clients disappear and are closed when changing cameras or input mappings.

This is a monitoring/agent feed, not a calibrated grading monitor or a full-frame-rate recording pipeline. Windows uses the packaged native DeckLink helper and requires Blackmagic Desktop Video on the capture computer. Release the input from vMix or other capture software before opening it in Shader. Other platforms need a DeckLink-enabled FFmpeg (`SHADER_FFMPEG` can select it). Physical Quad 2 capture remains to be verified.

## MCP / internal assistant

The UI and MCP use the same command registry:

- `camera_route`, `capture_assign`, `capture_register`, `exposure_policy`
- `shade_begin`, `shade_plan`, `shade_apply`
- `preview_open`, `preview_frame`, `preview_close`
- `capture_frame`, `frame_get`, `camera_get`, and the existing native `control_set`

`shade_begin` returns a session ID; `shade_plan` accepts `{brightness, warmth, tint}` without writing. `shade_apply` requires the same session ID, a current revision and camera write access. Brightness is -4…4 stops; warmth/tint are -1…1 from the anchor. The internal assistant gets these shading tools under its existing selected-camera and write-permission scope. Provider credentials can still be configured later in Settings.

A frame includes camera ID, source ID, capture timestamp and control revision observed at retrieval. Revision is context, not proof that a hardware setting had already taken effect when the video frame was exposed.

## References for the implementation

- [Blackmagic Camera Control](https://documents.blackmagicdesign.com/DeveloperManuals/BlackmagicCameraControl.pdf), SDI protocol pp. 98–102: aperture encoding, white balance/tint, shutter and color correction.
- [Sony exposure guidance](https://www.sony.com/electronics/support/cameras-camcorders/articles/00025973): aperture, shutter and ISO have different consequences. Iris-first with optional aperture preservation is this app’s operating policy, not a universal camera rule.
- Sony Camera Remote SDK 2.02, locally installed API reference: `dp_FNumber`, `dp_IsoSensitivity`, `dp_ShutterSpeed`, `dp_Colortemp`, `dp_ColorTuningGM`. Scope and encodings are model dependent.
- [PTZOptics exposure commands](https://docs.ptzoptics.com/dev/visca-api/exposure/) and [inquiry replies](https://docs.ptzoptics.com/dev/visca-api/inquiries/): temperature index, mode and differing write/read packet representations. Use the exact connected model’s capabilities before expanding the exposure recipe.

## Arrange the monitoring workspace

Cameras appear in a horizontally scrolling strip. Select a camera to keep its 16:9 picture beside the controls. The controls scroll independently, so the image stays visible during adjustments.

Open **Layout** to put controls on the left or right, or hide the camera strip. When hidden, the camera name becomes a selector, with an Add camera button beside it. These layout preferences are remembered on this computer. Narrow workspaces place the preview above the controls.

Use **Expand** above the picture for a larger view. Press **Escape** or **Return to controls** to return. Expanding keeps the existing video preview running.
