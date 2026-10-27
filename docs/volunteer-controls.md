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


## Blackmagic lens zoom

Under **Advanced → Lens**, **Zoom** is a spring-return slider for cameras that report continuous lens zoom through ATEM. Hold left to zoom out or right to zoom in; farther from the center means faster movement. Release to stop at the current framing. Hold an arrow key for keyboard control; releasing the key also stops zoom.

The slider sends a stop on lost focus, camera/tab changes, or locking. The engine also sends a stop if held updates lapse for 600 ms, and before disconnecting an actively zooming camera. These are camera commands, so a working switcher connection and a compatible powered zoom lens are still required.

This follows Blackmagic’s lens parameter **0.9**, continuous zoom speed **−1 to +1**, with **0** for stop; it is separate from absolute zoom position. See the camera-control protocol in the [Blackmagic Studio Camera manual](https://documents.blackmagicdesign.com/UserManuals/BlackmagicStudioCameraManual4k.pdf?_v=1687158010000).

## Numbered presets and camera order

Presets 1–4 are always shown above the camera buttons. A grey number means the selected camera has no look saved in that slot (or is locked). Choose **Save…**, then a number, to store this camera’s current shading values. Saving another camera to the same number keeps each camera’s own look. Click a number to apply only the selected camera’s look.

Use the arrow beside a number for **Apply to all saved cameras**. Each saved camera receives its own values; unsaved cameras are untouched. All saved cameras are preflighted before recall, and a missing or locked camera blocks the group. **Manage** lets you name a number (for example “Choir”), select several cameras to save, apply individual cameras, or remove a camera from a slot. **+** adds another slot. Older named looks remain under **Older looks & scenes** and are not automatically assigned to numbers. Slots and names persist in the preset library.

Keys **1–9** recall the matching numbered preset on the selected camera. **Alt+1–9** selects a camera by its visible button position. Shortcuts pause while typing or using a dialog; plain preset shortcuts also pause while editing camera buttons.

Choose **Edit** above the camera buttons and drag a button to reorder it. You can also right-click a button and choose **Move earlier/later**, or focus it in Edit mode and use **Alt+Left/Right**. Button order is remembered on this computer; colors, names, hidden cameras, capture mappings and physical ATEM inputs stay attached to the same camera identities.
