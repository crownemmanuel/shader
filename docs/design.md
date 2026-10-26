# Shader console

A desktop camera-shading workspace. The memorable element is the camera monitor and the compact RGB component strips directly below it; navigation and assistant stay quiet.

Palette: graphite #18212b (workspace), ink #111820 (monitor), slate #23303d (controls), cloud #e8edf1 (text), mist #99aab9 (secondary), ice #8bc9dd (selection). Amber #ddbd7c only denotes pending/unknown state. Red denotes program and errors. System typography for native legibility; tabular numerals only where values align.

Layout: left-aligned camera sidebar, camera monitor and grouped controls in the center, scoped assistant on the right. Settings are a sheet, not another dashboard. No decorative cards or hero headings. The UI never uses a stock photo as a live feed.

Review against brief: prioritize connection state, capture routing, supported native controls and agent parity over waveform decorations or grading controls that the hardware cannot implement. Empty state offers discovery, manual connection and an explicitly labeled simulator. Unknown and requested values are visually distinct from device-reported values.

## Volunteer revision

The operator selects a camera, sees its routed picture and On Air status, then uses Simple or Advanced. Simple has two large areas: Fix brightness and Fix color. Advanced uses lift/gamma/gain opponent color wheels, blue–amber and green–magenta sliders, and number fields behind disclosures. Shutter has an explicit manual control. Raw SDK values remain available where a semantic mapping is unknown.

Tokens: charcoal workspace #222426, control surface #292b2e, monitor #151719, border #414448, primary text #edf0f2, secondary #b0b5bb, warm selection #ecc38b. Red plus “ON AIR” text marks the selected program route. Color in sliders and wheels conveys direction. System font, 11–13 px secondary/control labels, 18 px Simple headings; 8 px radii, 12–24 px spacing. Keep assistant collapsed initially so preview and controls have room.

Interaction review: sliders support keyboard arrows; wheel controls support arrows and separate numeric fields. Apply buttons retain stale-revision protection. Simple commits on release/key-up. Unknown video shows a truthful empty state; signal loss labels the retained frame. Settings owns camera/capture/ATEM mapping and per-camera exposure limits. Live preview and snapshots share one source process.
