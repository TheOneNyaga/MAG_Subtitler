# MAG Subtitler

An After Effects subtitle plugin — a single ScriptUI panel that turns SRT files (or audio straight off the timeline) into fully styled, live-editable subtitle layers, with local AI transcription and translation.

Built for broadcast and social subtitle delivery. No subscriptions, no cloud round-trips — transcription and translation run entirely on your own machine.

## What it does

- **Import SRT** → text layers in a self-contained subtitle precomp, one cue per layer.
- **Live styling** via a controller null: font, size, fill, stroke, Y position, tracking, leading, and a full drop-shadow group — every cue updates as you drag a slider, because styling is expression-driven, not baked.
- **Local AI transcription** with [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (CUDA), running detached in the background with a live progress bar while AE stays responsive. SRT is saved next to your source media.
- **Local AI translation** against any OpenAI-compatible endpoint (e.g. llama-server) — translate every cue in place.
- **Line layout** — single/two-line, max characters per line, and proportional splitting of overlong cues into properly timed consecutive cues.
- **Cue editing** — split, merge, add, delete, snap to playhead, with automatic overlap resolution and time-order renumbering.
- **Per-composition sets** — each comp in a project carries its own independent subtitle set (own precomp, own styles, own layout), paired by a rename-proof comp ID.
- **Marker-based retiming** — drag cue markers to retime; mirror to main-comp markers for reference.
- **Export** SRT and VTT.

## Requirements

- Adobe After Effects (tested on recent CC builds), with **Allow Scripts to Write Files and Access Network** enabled (Preferences → Scripting & Expressions).
- For transcription: a built `whisper-cli.exe` and a `ggml-*.bin` model. See [docs/GUIDE.md](docs/GUIDE.md) for the build and setup.
- For MP4/MOV direct input: `ffmpeg` on PATH (optional — without it, feed WAV).
- For translation: any local OpenAI-compatible chat-completions server.

## Install

1. Copy `MAG_Subtitler.jsx` into your After Effects `Scripts/ScriptUI Panels/` folder:
   - Windows: `C:\Program Files\Adobe\Adobe After Effects <ver>\Support Files\Scripts\ScriptUI Panels\`
2. Restart After Effects.
3. Open it from the **Window** menu → `MAG_Subtitler.jsx`.

To test changes without restarting: **File → Scripts → Run Script File…** and pick the `.jsx`.

## Quick start

1. Open your comp.
2. **AI tab** → set the whisper-cli and model paths once (they persist). Set **Max segment chars** to ~84.
3. **Transcribe Media File → Import**, pick the video. Watch the progress bar; cues import when it finishes.
4. **Style tab** → **Apply Layout** (2 lines / 42 chars / split on), then style with the sliders.
5. **Cues tab** → split at speaker changes, merge, snap, fix overlaps as needed.
6. **Export SRT / VTT** when done.

Full documentation: **[docs/GUIDE.md](docs/GUIDE.md)**.

## Architecture (short version)

Cues live as text layers (`SUB_0001`…) inside a tagged precomp, dropped as one layer into the main comp. A `SUB_CONTROLLER` null holds the style values as effect sliders; each cue's `sourceText` and `position` carry expressions that read the controller cross-comp. This is what makes styling live and global per set while keeping per-cue timing and text independent. The expressions use the JavaScript engine (the script sets it).

## License

See [LICENSE](LICENSE).
