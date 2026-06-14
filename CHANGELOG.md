# Changelog

All notable changes to MAG Subtitler. Versions are the `SCRIPT_VERSION` string in the panel.

## 3.9.1
- About-tab banner switched to the Big Money-NE figlet font (pure ASCII), so the file no longer needs a UTF-8 BOM and the banner can't be mangled by encoding.


## 3.9
- Added an **About** tab: Nyaga ASCII banner, version, author credit, and the GitHub repo link with an **Open Repo in Browser** button.


## 3.8.1
- Added **End at Playhead** on the Cues tab: sets the selected cue's Out point to the playhead, complementing Snap to Playhead (which sets the In). Auto-resolves overlaps and renumbers.


## 3.8
- Fixed font size, tracking and leading not applying: AE doesn't honour these live text-metric setters via expression on all builds, so they're now baked into each cue's text document on Apply Style (and on Repair). Colour/stroke/position/shadow stay live.
- Fixed Shadow Color doing nothing: the expression returned a 3-component colour to a 4-dimensional (RGBA) property, which AE rejected; now returns RGBA.


## 3.7
- Fixed `.ffx` animation keyframes all landing at comp start: scripting's applyPreset ignores the playhead, so keyframes are now shifted to begin at each cue's In point on apply.
- New **Realign Animation to Cue In** button (Animate tab) to fix existing projects whose animation is stuck at the start, in place.


## 3.6
- Fixed live font size not updating: the style expression now applies each property (size, fill, stroke, tracking, leading) as its own isolated statement instead of one chain, so font size renders reliably and one failing setter can't blank the rest. Run **Repair Expressions** on existing projects to apply.
- Whisper **Cue start offset (s)** field with a **From selected layer** helper, to align transcribed cues that sit later on the timeline than time zero in the source file.
- Hygiene pass (no functional change): verified ES3 cleanliness, no undefined calls, no duplicate definitions.

## 3.5.2
- AI-tab fields now auto-save the instant they're edited (whisper paths, model, ffmpeg, language, max segment chars, LLM endpoint, target language, batch size).
- Browse ("...") buttons save on pick.
- Every save flushes prefs to disk immediately (`saveToDisk()`), so a crash or force-kill no longer loses typed paths.
- Batch size is now persisted (previously reset to 15 each session).
- API key field is deliberately never persisted (no plaintext credentials).

## 3.5.1
- Overlap resolution. Whisper `-ml` segment overlaps are auto-trimmed on import; Snap to Playhead and Update Cue auto-resolve collisions (moved cue wins); new **Fix Overlaps** button does a full pass.

## 3.5
- **Split Cue** and **Merge with Next** on the Cues tab; structural edits auto-renumber cues by time.
- Whisper **Max segment chars** (`-ml` / `-sow`) to stop the default ~15s walls of text.

## 3.4.1
- Fixed transcription freezing AE: replaced the console-sharing `start /b` launch with a hidden VBS detach (`WScript.Shell.Run`, wait=false), so `callSystem` returns immediately.
- Progress palette shown before launch; stall detector warns at ~14s and fails cleanly at 60s of no output.
- Cancel also kills ffmpeg when a conversion was active.

## 3.4
- Per-composition subtitle sets. Each comp carries its own precomp/controller/styles/layout, paired by the permanent `comp.id` stored in the precomp comment (`MAGSUB:main=<id>`) — rename-proof.
- The panel follows the active comp. Legacy single-set projects migrate automatically.

## 3.3
- Tracking and leading controls (live, on the controller; leading 0 = auto).
- **Line Layout** panel: single/two lines, max chars per line, and proportional splitting of overlong cues into timed consecutive cues.

## 3.2
- Async transcription: whisper runs detached with a polled log driving a live progress bar; AE stays responsive.
- Generated SRT is saved next to the source media as `<name>_whisper.srt` (never clobbers `<name>.srt`), path reported on completion.

## 3.1
- Index-based style expressions (fixes dead style sliders after some operations).
- **Diagnose** and **Repair Expressions** tools.
- `.ffx` preset browser in the Animate tab.
- Panel preferences persisted via `app.settings`.

## 3.0 and earlier
- Core architecture: SRT import into a tagged precomp with one text layer per cue.
- `SUB_CONTROLLER` null with expression-driven live styling (font, size, fill, stroke, Y, drop shadow).
- Per-cue markers for drag-retiming; mirror to main-comp markers.
- Style presets; built-in entry/exit animation presets.
- Initial (blocking) local whisper transcription and LLM translation.
- SRT / VTT export.
