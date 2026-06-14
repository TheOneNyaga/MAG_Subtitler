# MAG Subtitler v3.9 — Usage Guide

A personal SRT/VTT/ASS/TXT/CSV subtitle suite for After Effects with local AI transcription and translation.

---

## 1. How your work is saved (read this first)

**Everything lives inside the AE project, not the panel.** Cue text, timings, markers, the controller sliders, animations — they are all real layers, effects and keyframes in your `.aep`. The panel is just a remote control.

What this means in practice:

- **Save the project (Ctrl+S) and you can close AE anytime.** Reopen the project, open the panel (Window → MAG_Subtitler.jsx), hit **Refresh List** in the Cues tab, and continue exactly where you left off. You never reload the SRT.
- **You do not even need the panel to keep working.** The subtitles are normal AE layers — you can drag markers, trim layers, and tweak controller sliders with the panel closed.
- If you close AE **without saving**, you lose the subtitle work the same way you'd lose any unsaved AE work. AE's auto-save (Preferences → Auto-Save) covers you here like it does for everything else.
- The panel additionally remembers your **tool preferences** across sessions via AE's settings store: font, size, colors, stroke, shadow values, animation preset, whisper/ffmpeg paths, LLM endpoint and target language. These restore when the panel opens, on any project.
- **Export SRT** at milestones. It is your project-independent backup of text + timing, and the input for re-import if you ever rebuild.

One caution: **do not rename your main comp** after importing. The live-style expressions reference it by name. If you must rename it, click **Style tab → Repair Expressions** afterwards and everything re-links.

---

## 1b. Multiple compositions per project (v3.4)

Each composition carries its **own independent subtitle set**: its own precomp (named `MAG_Subtitles [CompName]`), its own `SUB_CONTROLLER` with its own style sliders, its own layout and animations. Nothing is shared between comps.

The link between a main comp and its precomp is a **ref ID** stored in the precomp's comment field (`MAGSUB:main=<id>`) using AE's permanent comp ID — so renaming either comp never breaks the pairing (cue *expressions* still need a Repair after renaming the main comp, but resolution itself is rename-proof).

**The panel always operates on the set belonging to the active comp** — whichever comp's timeline/viewer has focus, including when you're inside one of the precomps. Switch comps, hit Refresh List, and you're working on that comp's cues; Apply Style, Layout, Sync, Transcribe, Translate, Export and Remove All are all scoped the same way. A 16:9 master at 64px white and a 9:16 vertical cut at 80px yellow with different fonts coexist with zero interference. Diagnose prints which main↔precomp pair it resolved, with the comp ID.

Projects from older versions (single untagged `MAG_Subtitles` precomp) are migrated automatically: the first operation that touches the set tags it to the comp that contains it.

## 2. If the style sliders stop responding (Diagnose / Repair)

The live styling (size, color, stroke, shadow, Y position) is driven by expressions on every cue that read the `SUB_CONTROLLER` null in your main comp. If dragging a controller slider does nothing:

1. **Style tab → Diagnose.** It checks, in order:
   - **Expression engine** — must be `javascript-1.0`. The Legacy ExtendScript engine cannot run text-style expressions, which kills *all* live styling at once. Fix: File → Project Settings → Expressions → JavaScript, or just click Repair (it sets the engine too).
   - Controller present in the main comp.
   - Precomp present + cue count.
   - Whether AE auto-disabled the expression on cue 1 after an error, and what the error was.
   - Whether the expressions reference a **different comp name** than your current main comp (the rename case).
2. **Style tab → Repair Expressions.** Re-links every cue (style, position, drop shadow) to the controller using the current main comp name and forces the JS engine. Note: slide animations get reset to static position — re-apply the animation preset after a repair if you were using a Slide.

---

## 3. Sync tab — manual

The Sync tab fixes the three classic subtitle timing problems plus the marker workflows.

### 3.1 Constant offset ("everything is 2 seconds late")
Enter the amount in **Offset all (s)**, then click **+** (push later) or **−** (pull earlier). Durations are preserved; cues are clamped at 0. Markers rebuild automatically.

### 3.2 Drift ("starts in sync, drifts out by the end") — Stretch factor
Drift means the SRT was timed against a different frame rate or playback speed. Multiply all times by a factor:

| Situation | Factor |
|---|---|
| SRT timed at 25 fps, your video is 23.976 | **1.04271** (25 ÷ 23.976) |
| SRT timed at 23.976, video is 25 | **0.95904** |
| SRT timed at 24, video is 25 (PAL speedup) | **0.96** |
| SRT timed at 25, video is 24 | **1.04167** |

General rule: `factor = srt_fps / video_fps`. If the start is also off, fix drift with Stretch **first**, then apply a constant Offset.

### 3.3 One section is off ("fine until the mid-roll edit") — Ripple
You cut or extended part of the video, so all cues *after* a point need shifting but earlier ones are fine. Find the first wrong cue's number (# column in the Cues tab), enter it in **Ripple from cue #**, set the shift in seconds (negative = earlier), click **Ripple**. Cues before that number are untouched.

### 3.4 Single-cue nudging
Use the **Cues tab**: select the cue, either type exact In/Out seconds and **Update Cue**, or park the playhead where the line should start and hit **Snap to Playhead** (works from the main comp or the precomp; offsets are handled).

### 3.5 Marker retiming (visual workflow)
- **Inside the precomp:** every cue layer has one marker at its in-point (duration = cue length, comment = text). Drag the markers, then **Apply Cue Markers → Timing** to commit. **Rebuild Cue Markers from Timing** goes the other way (use it after trimming layers by hand).
- **From the main comp** (without entering the precomp): **Mirror Markers to Main Layer** stamps one marker per cue (tagged `#n text…`) onto the `MAG_Subtitles` layer. Drag them on your main timeline against the actual picture/audio, then **Apply Main-Layer Markers → Cues**. The `#n` tag is how cues are matched — don't edit it out of the comment.

Recommended sync order for a messy file: **Stretch → Offset → Ripple (if needed) → marker/per-cue polish.**

---

## 4. AI tab — Transcribe (local whisper.cpp)

Turns any audio/video file into timed cues, entirely on your GPU. No cloud, no account.

### 4.1 One-time setup

**Build whisper.cpp** (same toolchain as a llama.cpp CUDA build — identical ggml codebase):

```
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release -j
```

The binary you want is `build\bin\Release\whisper-cli.exe` (older builds name it `main.exe` — that works too, same flags).

**Download a model** (ggml `.bin` format — these are *not* the same files as llama.cpp GGUFs). Official conversions live at `huggingface.co/ggerganov/whisper.cpp`:

| Model | File | Size | VRAM | Notes |
|---|---|---|---|---|
| large-v3 | `ggml-large-v3.bin` | ~3.1 GB | ~4.7 GB | Best accuracy, best non-English. **Recommended default on a 4090.** |
| large-v3-turbo | `ggml-large-v3-turbo.bin` | ~1.6 GB | ~2.7 GB | ~6–8× faster than large-v3, accuracy very close. Best speed/quality trade. |
| medium | `ggml-medium.bin` | ~1.5 GB | ~2.6 GB | Fine for clear English speech. |
| small | `ggml-small.bin` | ~0.5 GB | ~1 GB | Quick drafts. |
| Quantized (e.g. `-q5_0`) | varies | ~40% smaller | lower | Minor accuracy cost; useful if VRAM is busy with something else. |

On the 4090, large-v3 transcribes several times faster than realtime; turbo is near-instant for short brand spots.

**ffmpeg (strongly recommended):** whisper.cpp's CLI natively eats 16 kHz WAV. Set the ffmpeg path in the panel and it pre-converts *any* input (MP4, MOV, MKV, MP3…) to a temp 16 kHz mono WAV automatically. Without it, only WAV input is safe.

### 4.2 Running it

1. AI tab → set **whisper-cli** path, **model** path, optionally **ffmpeg** path. These persist between sessions.
2. **Language:** `auto` detects; or force a code: `en`, `sw` (Swahili), `fr`, `ar`, `hi`, `zh`, `ja`, `pt`, `es`, `de`… (standard ISO-639-1, ~100 languages).
3. Click **Transcribe Media File → Import** and pick the video/audio.
3b. **Max segment chars** (default **84** = two 42-char lines) caps how long each whisper segment may run, splitting on word boundaries with token-level timestamps. This is the fix for whisper's default behavior of emitting one 15-second wall of text per cue. Set 42 for snappier single-line cues, 0 to restore whisper's default. Pair with Line Layout afterwards for final wrapping.
3c. **Cue start offset (s)** shifts every transcribed cue by a fixed number of seconds on import. Use it when the speech sits later on your AE timeline than time zero in the file you transcribe — e.g. the clip is placed 10s into the comp, or whisper anchored the first cue at 00:00 over leading music/silence. Click **From selected layer** to fill it automatically from where the selected audio/video layer starts on the timeline. A uniform offset only fixes a uniform shift; if whisper mis-timed just the first cue over leading silence, delete or re-time that one cue on the Cues tab instead. 0 = no shift.
4. A **progress window** opens: whisper runs detached in the background while AE stays responsive, with a live percentage bar (ffmpeg conversion shows first if enabled, then "Transcribing on GPU..."). **Cancel** kills the run (it force-kills any running whisper-cli process). You can keep working in AE during long transcriptions, but avoid editing the subtitle comps mid-run since the import fires when whisper finishes.
5. **The SRT is saved next to your source media** as `<name>_whisper.srt` (e.g. `spot.mp4` → `spot_whisper.srt`) — it never overwrites an existing `<name>.srt`, and the completion alert shows the full path.
6. The SRT then imports through the normal pipeline: precomp, controller, your current style + animation, Replace/Append mode from the Import tab.

Tips: clean dialogue stems transcribe dramatically better than music-bedded mixes — if you have the VO stem, feed that. Whisper's sentence segmentation is decent but not broadcast-grade; expect to merge/split a few cues in the Cues tab.

### 4.3 Compatibility notes
- Works with any whisper.cpp build new enough to support `-osrt` (all builds from the last several years).
- Forks with the same CLI surface (e.g. CUDA-optimized builds) work as long as they accept `-m -f -osrt -of -l`.
- **faster-whisper / whisperX are not drop-in** — different CLI. If you want word-level karaoke timing later (whisperX's specialty), that's a Tier 2 feature; the bridge would shell to a small Python wrapper instead.

---

## 5. AI tab — Translate (local LLM)

Translates every cue **in place**, batch by batch, through any OpenAI-compatible chat endpoint.

### 5.1 What's compatible
Anything serving **`/v1/chat/completions`** in the OpenAI schema:

- **llama.cpp `llama-server`** — the default endpoint `http://127.0.0.1:8080/v1/chat/completions` assumes this. No API key needed when hitting it directly.
- **A gateway in front of it** (e.g. an authenticated proxy) — put the gateway URL in the endpoint field and the bearer token in the API-key field.
- **LM Studio** (`http://localhost:1234/v1/chat/completions`), **Ollama** (`http://localhost:11434/v1/chat/completions`), **vLLM**, **KoboldCpp** — all fine.
- Cloud OpenAI-compatible APIs also work (endpoint + key), but the whole point of this design is that you don't need them.

The request sends `model: "local"` — llama-server ignores the model field and uses whatever's loaded. Multi-model servers (Ollama/LM Studio) generally also default sensibly, but load your intended model first.

### 5.2 Model guidance
Subtitle translation is an easy task for any solid instruction-tuned model ≥ ~8B:

- **Good:** Gemma-class 20–30B instruct models (strong multilingual coverage incl. Swahili), Qwen 3.x 27–35B (excellent for Asian languages), Mistral/Llama instruct ≥ 8B for major European languages.
- **Important — disable reasoning/thinking mode.** The panel extracts the first JSON array from the reply, so stray `<think>` preambles usually survive parsing, but reasoning burns time and tokens for zero gain here. If your server has a reasoning toggle (e.g. `--reasoning off`), keep it off for translation runs.
- Coder-tuned models work but aren't ideal stylistically; small models (<4B) start mangling idioms.

### 5.3 Running it
1. **Export an SRT backup first.** Translation overwrites cue text in place (it *is* one undo group, but a file backup is the adult move).
2. Set endpoint, optional key, **Target language** (free text: "Swahili", "French", "Brazilian Portuguese — informal" all work; you can encode register in the language string).
3. **Batch size** (default 15): the model must return a JSON array with exactly that many items. If batches keep getting rejected as malformed, drop to 8–10 — smaller batches are easier for the model to format perfectly. Raise to 20–25 with a strong model to reduce round-trips.
4. Click translate. **AE freezes during each batch** (same blocking-call reason as transcription). A 100-cue file at batch 15 is 7 requests — on a local 26B that's typically well under a minute total.
5. A malformed batch is **skipped with a warning**, never half-applied. Re-run translate afterwards; already-translated cues just get re-translated (harmless), or ripple through manually in the Cues tab.

Timing is untouched by translation — only text changes, and markers update to the new text.

---

\n**Manual timing by playhead (v3.8.1):** **Snap to Playhead** sets the selected cue's START to the playhead (keeping its duration); **End at Playhead** sets its END (Out) to the playhead. Together they let you time a cue by ear — park at the first word and Snap, park at the last word and End at Playhead. Both auto-resolve overlaps (the cue you moved wins) and renumber by time. Works from the main comp or inside the precomp.\n\n## 4b. Split, Merge, Add (v3.5)

On the **Cues tab**, next to Add/Delete:

- **Split Cue** — select a cue and park the playhead where the split should land (works from the main comp or inside the precomp); if the playhead is outside the cue it splits at the midpoint. The text divides at the word boundary nearest the time proportion, both halves keep the timing on either side of the cut, and entry/exit animation is re-seated on the new bounds. Ideal for breaking whisper's run-on segments at speaker changes — jump the playhead to where the second voice starts and hit Split.
- **Merge with Next** — joins the selected cue with the following cue (by time): texts concatenate, timing spans both.
- **Add Cue at Playhead** — unchanged, drops a 3s placeholder cue.

After any of these, cues are **automatically renumbered by time** so the list, SRT export and translation order always match the timeline.

## 4c. Overlapping cues (v3.5.1)

Two cues sharing screen time render on top of each other — the stacked-words artifact. Two common causes, both handled:

- **Whisper `-ml` segmentation** emits slightly overlapping timestamps (≈0.2–0.5s) between consecutive segments. These are **auto-trimmed right after transcription import**; the completion alert reports how many.
- **Snap to Playhead / Update Cue** can drop a cue onto another cue's time range. Both operations now auto-resolve: **the cue you moved wins** — earlier cues are trimmed to end where it starts, later cues start where it ends (0.1s minimum duration preserved), and cues are renumbered by time if order changed.

For everything else (hand-edited SRTs, old projects) the **Fix Overlaps** button on the Cues tab does a full pass, trimming every cue to end no later than the next begins.

## 5b. Typography & Line Layout (v3.3)\n\n**Reliability note (v3.8):** After Effects does not honour live `setFontSize`/`setTracking`/`setLeading` from a text expression on all builds (AE 2026 included) — the sliders would read a value but the glyphs wouldn't change. So **font size, tracking and leading are now baked into each cue's text on Apply Style** rather than driven live. Set them in the panel (or on the controller) and click **Apply Style + Font + Shadow to All**; they update reliably. Fill colour, stroke, Y position and the drop shadow remain fully live via the controller null. Shadow colour now also works (it previously errored on a colour-dimension mismatch). Dragging the Font Size slider on the null no longer previews live — use Apply Style.\n

**Tracking and Leading** live on the Style tab next to Size, and on the controller null as live sliders like everything else. Tracking is AE's letter-spacing in thousandths of an em (try 25–50 for an airy broadcast look, negative to tighten). Leading is the baseline-to-baseline distance in pixels for multi-line cues — **0 means auto** (≈120% of font size); set an explicit value when auto feels too tight or too loose for your font. Both apply live: drag the controller sliders or set values and hit Apply Style. Existing comps from older versions get the new sliders automatically the first time you Apply Style or Repair Expressions.

**Line Layout** (Style tab panel) re-wraps every cue's text:

- **Single line / Two lines** — the maximum lines a cue may occupy on screen. Two lines at 37–42 chars is the broadcast norm; single line suits lower-thirds-style placement or vertical video.
- **Max chars/line** — the wrap width. 42 is the classic TV ceiling; 32–37 for social/vertical.
- **Split overlong cues** (recommended ON) — when a cue can't fit in the allowed lines, it becomes *multiple consecutive cues*, with the original duration divided proportionally to each chunk's text length. This is the proper fix for whisper's tendency to produce run-on sentences. With it OFF, overflow is crammed into the last allowed line instead (line will exceed the char limit).

Apply Layout rebuilds the cue layers (same pipeline as import), so per-cue animation overrides reset to the current Animate-tab preset — do layout *before* fine-tuning individual cues. Timings of non-split cues are untouched. Typical post-transcription order: **Transcribe → Apply Layout (2 lines, 42, split ON) → style → sync polish.**

## 6. Animation: built-in presets vs AE's .ffx library\n**Keyframe alignment (v3.7):** `.ffx` text presets applied via scripting place their keyframes at the preset's saved times (near comp start), not at the playhead — so before v3.7 every cue's animation ran at 0:00. Now keyframes are automatically shifted so the animation begins at each cue's In point. If you have an older project with animation stuck at the start, click **Realign Animation to Cue In** (Animate tab) to fix every cue in place. Built-in presets (Fade, Slide, Pop, etc.) were always anchored correctly. For correct alignment, apply an .ffx to cues that don't already carry other keyframes.\n\n

Two systems, Animate tab:

**Script presets** (Fade In/Out, Fade In Only, Slide Up/Down, Slide From Bottom, Pop, Bounce, Scale Up Fade, Blur In, Typewriter): timing-aware — keyframes scale to each cue's duration, in/out symmetrical, slides stay linked to the controller's Y position. Re-applying replaces the previous one cleanly.

**AE's own .ffx text animation presets:** the dropdown auto-scans `Support Files\Presets\Text\` (Animate In, Animate Out, Blurs, Multi-Line, Tracking, …), or **Browse...** any .ffx — including presets you save yourself (select your animators on any text layer → Animation → Save Animation Preset). Apply to all cues or just the selected one.

Three rules for .ffx:
1. **Keyframes land at the playhead.** "At cue In" mode parks the playhead at each cue's in-point automatically — right for *Animate In* presets. For *Animate Out* presets, use per-cue apply with "At playhead" mode and park the CTI where the out-animation should begin.
2. **Presets stack.** Applying a second .ffx adds to the first. To switch styles, run script preset **None** first — it now strips *all* text animators (script-made and .ffx) plus transform keyframes.
3. .ffx animators are plain keyframes, not duration-aware: a preset authored over 2 seconds runs 2 seconds whether the cue lasts 1.5 s or 6 s. For very short cues prefer the script presets.

---

## 7. Quick troubleshooting

| Symptom | Fix |
|---|---|
| Sliders do nothing | Style → Diagnose, then Repair Expressions (usually the expression engine or a renamed main comp) |
| Font silently wrong | The exact PostScript name isn't installed — pick from the dropdown (it's built from your installed fonts); the panel warns when AE substitutes |
| Transcribe progress stuck at 0% | Model load (esp. large-v3) takes a few seconds before progress lines appear; if it never moves, Cancel and re-check the whisper/model paths |
| AE "frozen" during translate | Normal — translate is still a blocking call per batch; wait for the alert |
| Whisper "did not produce an SRT" | Check the command echoed in the alert: bad model path, or non-WAV input without ffmpeg set |
| Translate: "malformed array, skipped" | Lower batch size; ensure reasoning/thinking mode is off on the server |
| Cues invisible in main comp | The `MAG_Subtitles` layer was deleted/disabled, or it's below your footage with an alpha issue — it should sit at the top |
| Renamed main comp | Repair Expressions |
| Panel list empty after reopening project | Cues tab → Refresh List |
