/*
================================================================================
MAG Subtitler  v3.4  (Tier 1)
SRT/VTT/ASS/TXT/CSV subtitle suite for After Effects (ScriptUI Panel)
--------------------------------------------------------------------------------
NEW IN v3 (over v2)
  * CUE EDITOR    - scrollable cue list in the panel: edit text & times, jump
                    to cue, add / delete cues, per-cue animation override,
                    per-cue "bake style" (detach from controller).
  * MULTI-FORMAT  - import SRT, WebVTT, ASS/SSA, plain TXT (auto-timed), CSV.
                    Export SRT and VTT.
  * SYNC TOOLKIT  - offset all, stretch (speed factor), ripple from selected
                    cue, snap selected cue to playhead.
  * STYLE PRESETS - save / load named JSON presets (controller values + font
                    + animation) under Documents/MAG_Subtitler/presets.
  * MORE ANIMS    - Fade In Only, Slide Down, Scale Up Fade, Blur In, Bounce
                    added to the v2 set.
  * TRANSCRIBE    - local whisper.cpp bridge (your GPU, no cloud): pick a
                    media file, the panel shells out to whisper-cli, reads the
                    generated SRT back and imports it. Optional ffmpeg
                    pre-convert to 16 kHz WAV for maximum compatibility.
  * TRANSLATE     - local LLM bridge: batches cue text to an OpenAI-compatible
                    endpoint (default http://127.0.0.1:8080/v1/chat/completions,
                    i.e. llama-server) via curl, writes translations back into
                    the cue layers in place.

CARRIED FROM v2
  * Precomp architecture (MAG_Subtitles comp as one layer in your main comp).
  * SUB_CONTROLLER null in the MAIN comp: live Font Size / Color / Stroke /
    Y Position / full Drop Shadow controls via expressions.
  * Marker retiming inside the precomp AND mirrored on the main-comp layer.
  * Runtime font list from app.fonts (AE 2022+), with substitution warning.

INSTALL
  Windows: ...\Support Files\Scripts\ScriptUI Panels\MAG_Subtitler.jsx
  AE: Edit > Preferences > Scripting & Expressions ->
      tick "Allow Scripts to Write Files and Access Network"  (REQUIRED for
      presets, transcription and translation).
  Open via Window > MAG_Subtitler.jsx

REQUIREMENTS
  * AE 2020+ (JavaScript expression engine; the script enables it).
  * Transcribe: a whisper.cpp build (whisper-cli.exe) + a ggml model file.
  * Translate: curl in PATH (Windows 10+ ships it) + a running local LLM
    server with an OpenAI-compatible /v1/chat/completions endpoint.
================================================================================
*/

(function MAG_Subtitler(thisObj) {

    // ============================ CONFIG ============================
    var SCRIPT_NAME     = "MAG Subtitler";
    var SCRIPT_VERSION  = "3.10.1";
    var REPO_URL        = "https://github.com/TheOneNyaga/MAG_Subtitler";
    var SETTINGS_SEC    = "MAG_Subtitler";
    var CONTROLLER_NAME = "SUB_CONTROLLER";
    var SUBCOMP_NAME    = "MAG_Subtitles";
    var LAYER_PREFIX    = "SUB_";
    var ANIM_PRESETS    = ["None", "Fade In/Out", "Fade In Only", "Slide Up",
                           "Slide Down", "Slide From Bottom", "Pop", "Bounce",
                           "Scale Up Fade", "Blur In", "Typewriter"];
    var STATIC_FONTS = ["Arial-BoldMT","ArialMT","Helvetica","Helvetica-Bold",
        "Roboto-Bold","Montserrat-Bold","OpenSans-Bold","Inter-Bold","Impact",
        "Verdana-Bold","BebasNeue-Regular","Oswald-Bold","Georgia-Bold"];

    // ============================ UTILS ============================
    function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
    function trim(s) { return String(s).replace(/^\s+|\s+$/g, ""); }
    function escExpr(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
    function toNum(v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; }

    function getSetting(key, dflt) {
        try { if (app.settings.haveSetting(SETTINGS_SEC, key)) return app.settings.getSetting(SETTINGS_SEC, key); } catch (e) {}
        return dflt;
    }
    function setSetting(key, val) { try { app.settings.saveSetting(SETTINGS_SEC, key, String(val)); } catch (e) {} }

    // --- minimal JSON (ExtendScript has none) ---
    function jStr(v) {
        var t = typeof v, i, out;
        if (v === null || t === "undefined") return "null";
        if (t === "number" || t === "boolean") return String(v);
        if (t === "string") {
            return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                          .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
        }
        if (v instanceof Array) {
            out = [];
            for (i = 0; i < v.length; i++) out.push(jStr(v[i]));
            return "[" + out.join(",") + "]";
        }
        out = [];
        for (var k in v) if (v.hasOwnProperty(k)) out.push(jStr(k) + ":" + jStr(v[k]));
        return "{" + out.join(",") + "}";
    }
    function jParse(s) {
        s = trim(String(s));
        try { return eval("(" + s + ")"); } catch (e) { return null; }
    }
    // pull first JSON array out of arbitrary LLM text
    function extractJsonArray(s) {
        s = String(s);
        var a = s.indexOf("["), b = s.lastIndexOf("]");
        if (a === -1 || b === -1 || b < a) return null;
        return jParse(s.substring(a, b + 1));
    }

    function setJSEngine() { try { app.project.expressionEngine = "javascript-1.0"; } catch (e) {} }

    // ============================ TIMECODES ============================
    function parseTimecode(tc) {                 // SRT/VTT  00:00:01,500 / 00:00:01.500 / 00:01.500
        tc = trim(tc);
        var m = tc.match(/(\d+):(\d+):(\d+)[,\.](\d+)/);
        if (m) return parseInt(m[1],10)*3600 + parseInt(m[2],10)*60 + parseInt(m[3],10) + parseInt(m[4],10)/1000;
        m = tc.match(/(\d+):(\d+)[,\.](\d+)/);   // MM:SS.mmm (VTT short form)
        if (m) return parseInt(m[1],10)*60 + parseInt(m[2],10) + parseInt(m[3],10)/1000;
        var f = parseFloat(tc);                  // raw seconds (CSV)
        return isNaN(f) ? 0 : f;
    }
    function parseAssTime(tc) {                  // H:MM:SS.cc (centiseconds)
        var m = trim(tc).match(/(\d+):(\d+):(\d+)\.(\d+)/);
        if (!m) return 0;
        var cs = parseInt(m[4],10); if (m[4].length === 2) cs *= 10; // cs -> ms
        return parseInt(m[1],10)*3600 + parseInt(m[2],10)*60 + parseInt(m[3],10) + cs/1000;
    }
    function fmtSRT(sec) {
        var h=Math.floor(sec/3600), mn=Math.floor((sec%3600)/60), s=Math.floor(sec%60);
        var ms=Math.round((sec-Math.floor(sec))*1000); if (ms===1000){s++;ms=0;}
        return pad(h,2)+":"+pad(mn,2)+":"+pad(s,2)+","+pad(ms,3);
    }
    function fmtVTT(sec) { return fmtSRT(sec).replace(",", "."); }
    function fmtShort(sec) {
        var mn=Math.floor(sec/60), s=sec-mn*60;
        return pad(mn,2)+":"+(s<10?"0":"")+s.toFixed(2);
    }

    // ============================ PARSERS ============================
    function parseSRT(content) {
        var subs = [];
        content = String(content).replace(/\r\n/g,"\n").replace(/\r/g,"\n").replace(/^\uFEFF/,"");
        var blocks = content.split(/\n\s*\n/);
        for (var i = 0; i < blocks.length; i++) {
            var block = trim(blocks[i]); if (block === "") continue;
            var lines = block.split("\n"); var tcIdx = -1;
            for (var j = 0; j < lines.length; j++) if (lines[j].indexOf("-->") !== -1) { tcIdx = j; break; }
            if (tcIdx === -1) continue;
            var t = lines[tcIdx].split("-->");
            var text = trim(lines.slice(tcIdx+1).join("\n")).replace(/<[^>]+>/g,"").replace(/\{[^}]+\}/g,"");
            if (text === "") continue;
            subs.push({ start: parseTimecode(t[0]), end: parseTimecode(t[1]), text: text });
        }
        return subs;
    }
    function parseVTT(content) { return parseSRT(String(content).replace(/^WEBVTT[^\n]*\n/, "")); }
    function shiftSubs(subs, off) {
        off = toNum(off, 0);
        if (!off) return subs;
        for (var i = 0; i < subs.length; i++) {
            subs[i].start = Math.max(0, subs[i].start + off);
            subs[i].end   = Math.max(subs[i].start + 0.05, subs[i].end + off);
        }
        return subs;
    }

    function parseASS(content) {
        var subs = [];
        content = String(content).replace(/\r\n/g,"\n").replace(/\r/g,"\n");
        var lines = content.split("\n");
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            if (ln.indexOf("Dialogue:") !== 0) continue;
            var body = ln.substring(9);
            // Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
            var parts = body.split(",");
            if (parts.length < 10) continue;
            var start = parseAssTime(parts[1]), end = parseAssTime(parts[2]);
            var text = parts.slice(9).join(",");
            text = text.replace(/\{[^}]*\}/g, "").replace(/\\N/g, "\n").replace(/\\n/g, "\n").replace(/\\h/g, " ");
            text = trim(text);
            if (text === "") continue;
            subs.push({ start: start, end: end, text: text });
        }
        return subs;
    }

    function parseTXT(content, startAt, durEach, gap) {
        var subs = [], t = startAt;
        var lines = String(content).replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n");
        for (var i = 0; i < lines.length; i++) {
            var ln = trim(lines[i]); if (ln === "") continue;
            subs.push({ start: t, end: t + durEach, text: ln });
            t += durEach + gap;
        }
        return subs;
    }

    function parseCSV(content) {
        // expects: start,end,text   (times = seconds or HH:MM:SS,mmm; delimiter , ; or tab)
        var subs = [];
        var lines = String(content).replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n");
        for (var i = 0; i < lines.length; i++) {
            var ln = trim(lines[i]); if (ln === "") continue;
            var delim = (ln.indexOf("\t") !== -1) ? "\t" : ((ln.indexOf(";") !== -1) ? ";" : ",");
            var parts = ln.split(delim);
            if (parts.length < 3) continue;
            var st = parseTimecode(parts[0]), en = parseTimecode(parts[1]);
            if (i === 0 && isNaN(parseFloat(parts[0])) && st === 0 && en === 0) continue; // header row
            var text = trim(parts.slice(2).join(delim));
            if (text === "") continue;
            subs.push({ start: st, end: en, text: text });
        }
        return subs;
    }

    function parseAny(content, fileName, txtOpts) {
        var ext = "";
        var m = String(fileName).match(/\.([a-zA-Z0-9]+)$/);
        if (m) ext = m[1].toLowerCase();
        if (ext === "srt") return parseSRT(content);
        if (ext === "vtt") return parseVTT(content);
        if (ext === "ass" || ext === "ssa") return parseASS(content);
        if (ext === "csv" || ext === "tsv") return parseCSV(content);
        if (ext === "txt") return parseTXT(content, txtOpts.startAt, txtOpts.durEach, txtOpts.gap);
        // sniff
        if (String(content).indexOf("WEBVTT") === 0) return parseVTT(content);
        if (String(content).indexOf("Dialogue:") !== -1) return parseASS(content);
        if (String(content).indexOf("-->") !== -1) return parseSRT(content);
        return parseTXT(content, txtOpts.startAt, txtOpts.durEach, txtOpts.gap);
    }

    // ============================ COMP LOOKUP ============================
    function findLayerByName(comp, name) {
        if (!comp) return null;
        for (var i = 1; i <= comp.numLayers; i++) if (comp.layer(i).name === name) return comp.layer(i);
        return null;
    }
    function findCompByName(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === name) return it;
        }
        return null;
    }
    // ---- multi-set resolution (v3.4) ----
    // Every subtitle precomp is tagged in its COMMENT with the permanent id of
    // its owner comp: "MAGSUB:main=<comp.id>". comp.id is unique per project
    // and survives renames, so each composition can carry its own independent
    // subtitle set (own precomp, own controller, own styles). All panel
    // operations resolve the set belonging to the ACTIVE comp.
    function isSubCompItem(it) {
        return (it instanceof CompItem) && it.name.indexOf(SUBCOMP_NAME) === 0;
    }
    function subTagId(sc) {
        try { var m = String(sc.comment).match(/MAGSUB:main=(\d+)/); if (m) return parseInt(m[1],10); } catch (e) {}
        return 0;
    }
    function tagSubComp(sc, mainComp) {
        try { sc.comment = "MAGSUB:main=" + mainComp.id; } catch (e) {}
    }
    function compById(id) {
        if (!id) return null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.id === id) return it;
        }
        return null;
    }
    function mainCompContaining(sc) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it !== sc && findSubLayerInMain(it, sc)) return it;
        }
        return null;
    }
    function findSubCompFor(mainComp) {
        if (!mainComp) return null;
        var i, it;
        for (i = 1; i <= app.project.numItems; i++) {           // pass 1: id tag
            it = app.project.item(i);
            if (isSubCompItem(it) && subTagId(it) === mainComp.id) return it;
        }
        for (i = 1; i <= app.project.numItems; i++) {           // pass 2: legacy untagged, contained in this comp
            it = app.project.item(i);
            if (isSubCompItem(it) && subTagId(it) === 0 && findSubLayerInMain(mainComp, it)) {
                tagSubComp(it, mainComp);                       // migrate on sight
                return it;
            }
        }
        return null;
    }
    function findMainComp() {
        var a = app.project.activeItem;
        if (a && a instanceof CompItem) {
            if (isSubCompItem(a)) {                              // user is inside a precomp
                var m = compById(subTagId(a)) || mainCompContaining(a);
                if (m) return m;
            } else {
                if (findSubCompFor(a)) return a;                 // active comp owns a set
                if (findLayerByName(a, CONTROLLER_NAME)) return a; // partial set
            }
        }
        // fallback: first comp in the project that owns a set (legacy single-set projects)
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && !isSubCompItem(it) && findSubCompFor(it)) return it;
        }
        return (a && a instanceof CompItem && !isSubCompItem(a)) ? a : null;
    }
    function getActiveCompStrict() {
        var c = app.project.activeItem;
        if (!c || !(c instanceof CompItem)) { alert("Open or select a composition first."); return null; }
        return c;
    }
    function findSubComp() { return findSubCompFor(findMainComp()); }
    function findSubLayerInMain(mainComp, subComp) {
        if (!mainComp || !subComp) return null;
        for (var i = 1; i <= mainComp.numLayers; i++) {
            var L = mainComp.layer(i);
            if (L.source && L.source === subComp) return L;
        }
        return null;
    }

    // ============================ FONTS ============================
    function getInstalledFonts() {
        var out = [];
        try {
            if (app.fonts && app.fonts.allFonts) {
                var all = app.fonts.allFonts, seen = {};
                for (var i = 0; i < all.length; i++) {
                    var f = all[i]; var ps = f.postScriptName;
                    if (!ps || seen[ps]) continue; seen[ps] = true;
                    out.push({ label: (f.familyName||"") + " - " + (f.styleName||"") + "  [" + ps + "]", ps: ps });
                }
                out.sort(function(a,b){ return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0); });
            }
        } catch (e) {}
        if (out.length === 0) for (var k = 0; k < STATIC_FONTS.length; k++) out.push({ label: STATIC_FONTS[k], ps: STATIC_FONTS[k] });
        return out;
    }

    // ============================ CONTROLLER ============================
    function addSlider(fx,name,val){var p=fx.addProperty("ADBE Slider Control");p.name=name;p.property(1).setValue(val);return p;}
    function addColorC(fx,name,rgba){var p=fx.addProperty("ADBE Color Control");p.name=name;p.property(1).setValue(rgba);return p;}
    function addCheck(fx,name,val){var p=fx.addProperty("ADBE Checkbox Control");p.name=name;p.property(1).setValue(val);return p;}

    function topUpController(ctl) {
        // v3.3 adds Tracking/Leading; older controllers get them on demand
        var fx = ctl.property("ADBE Effect Parade");
        if (!ctl.effect("Tracking")) addSlider(fx, "Tracking", 0);
        if (!ctl.effect("Leading"))  addSlider(fx, "Leading", 0);
    }
    function ensureController(mainComp) {
        var ctl = findLayerByName(mainComp, CONTROLLER_NAME);
        if (ctl) { topUpController(ctl); return ctl; }
        ctl = mainComp.layers.addNull();
        ctl.name = CONTROLLER_NAME; ctl.label = 9; ctl.enabled = false; ctl.guideLayer = true; ctl.moveToBeginning();
        var fx = ctl.property("ADBE Effect Parade");
        addSlider(fx,"Font Size",64);
        addColorC(fx,"Font Color",[1,1,1,1]);
        addSlider(fx,"Stroke Width",0);
        addColorC(fx,"Stroke Color",[0,0,0,1]);
        addSlider(fx,"Y Position",mainComp.height*0.85);
        addSlider(fx,"Tracking",0);
        addSlider(fx,"Leading",0);
        addCheck (fx,"Shadow Enable",1);
        addColorC(fx,"Shadow Color",[0,0,0,1]);
        addSlider(fx,"Shadow Opacity",70);
        addSlider(fx,"Shadow Distance",6);
        addSlider(fx,"Shadow Softness",8);
        addSlider(fx,"Shadow Angle",135);
        return ctl;
    }

    // ============================ EXPRESSIONS ============================
    function ctlRef(mainName){ return 'comp("'+escExpr(mainName)+'").layer("'+CONTROLLER_NAME+'")'; }

    function styleExpr(mainName) {
        var c = ctlRef(mainName);
        // Index-based effect refs ((1).value) survive localisation and are the
        // most reliable resolution path. try/catch keeps the cue rendering with
        // its baked style instead of error-disabling if the controller is gone.
        // Live setters cover ONLY colour + stroke - those render reliably via the
        // sourceText style API. Font size, tracking and leading are text-metric
        // setters that AE does NOT honour live on all builds (AE 2026 included),
        // so those three are BAKED into each cue's TextDocument on Apply Style
        // instead (see bakeTextMetrics). The expression starts from the cue's
        // current (baked) style, so the baked size/tracking/leading carry through.
        return 'var s=text.sourceText.style;\n' +
            'try{\n' +
            '  var ctl='+c+';\n' +
            '  try{ var fill=ctl.effect("Font Color")(1).value; s=s.setFillColor([fill[0],fill[1],fill[2]]); }catch(eF){}\n' +
            '  try{ var sc=ctl.effect("Stroke Color")(1).value; s=s.setStrokeColor([sc[0],sc[1],sc[2]]); }catch(eC){}\n' +
            '  try{ s=s.setStrokeWidth(ctl.effect("Stroke Width")(1).value); }catch(eW){}\n' +
            '}catch(err){}\n' +
            's;';
    }
    function posExpr(mainName) {
        return 'var y=thisComp.height*0.85;\n' +
               'try{y='+ctlRef(mainName)+'.effect("Y Position")(1).value;}catch(err){}\n' +
               '[thisComp.width/2,y];';
    }
    function posSlideExpr(mainName, inT, outT, offset) {
        return 'var y=thisComp.height*0.85;\n' +
               'try{y='+ctlRef(mainName)+'.effect("Y Position")(1).value;}catch(err){}\n' +
               'var off=ease(time,'+inT+','+outT+','+offset+',0);\n[thisComp.width/2,y+off];';
    }
    function shadowExpr(mainName, prop) {
        var c = ctlRef(mainName);
        if (prop==="Opacity")
            return 'var v=0;try{var on='+c+'.effect("Shadow Enable")(1).value;' +
                   'v=on>0?'+c+'.effect("Shadow Opacity")(1).value:0;}catch(err){}v;';
        if (prop==="Distance") return 'var v=6;try{v='+c+'.effect("Shadow Distance")(1).value;}catch(err){}v;';
        if (prop==="Softness") return 'var v=8;try{v='+c+'.effect("Shadow Softness")(1).value;}catch(err){}v;';
        if (prop==="Direction") return 'var v=135;try{v='+c+'.effect("Shadow Angle")(1).value;}catch(err){}v;';
        if (prop==="Shadow Color") return 'var v=[0,0,0,1];try{var k='+c+'.effect("Shadow Color")(1).value;v=[k[0],k[1],k[2],1];}catch(err){}v;';
        return "";
    }

    function ensureDropShadow(L, mainName) {
        var fx = L.property("ADBE Effect Parade"), ds = null;
        for (var i = 1; i <= fx.numProperties; i++) if (fx.property(i).matchName === "ADBE Drop Shadow") { ds = fx.property(i); break; }
        if (!ds) ds = fx.addProperty("ADBE Drop Shadow");
        try{ds.property("Shadow Color").expression=shadowExpr(mainName,"Shadow Color");}catch(e){}
        try{ds.property("Opacity").expression=shadowExpr(mainName,"Opacity");}catch(e){}
        try{ds.property("Direction").expression=shadowExpr(mainName,"Direction");}catch(e){}
        try{ds.property("Distance").expression=shadowExpr(mainName,"Distance");}catch(e){}
        try{ds.property("Softness").expression=shadowExpr(mainName,"Softness");}catch(e){}
        return ds;
    }

    // ============================ CUE LAYERS ============================
    function cueIndexOf(L) { return parseInt(String(L.name).replace(LAYER_PREFIX,""),10); }

    function getCueText(L) { return L.property("ADBE Text Properties").property("ADBE Text Document").value.text; }

    function setCueText(L, txt, mainName) {
        var src = L.property("ADBE Text Properties").property("ADBE Text Document");
        var hadExpr = (src.expression !== "");
        if (hadExpr) src.expression = "";
        var doc = src.value; doc.text = txt; src.setValue(doc);
        if (hadExpr && mainName) src.expression = styleExpr(mainName);
    }

    function setCueMarker(L) {
        var mp = L.property("Marker");
        while (mp.numKeys > 0) mp.removeKey(1);
        var mv = new MarkerValue(getCueText(L).substr(0,60));
        mv.duration = Math.max(0.001, L.outPoint - L.inPoint);
        mp.setValueAtTime(L.inPoint, mv);
    }

    function createCueLayer(subComp, idx, start, end, text, fontPS, mainName) {
        var L = subComp.layers.addText(text);
        L.name = LAYER_PREFIX + pad(idx, 4); L.label = 11;
        L.startTime = 0; L.inPoint = start; L.outPoint = end;
        var src = L.property("ADBE Text Properties").property("ADBE Text Document");
        var doc = src.value;
        doc.justification = ParagraphJustification.CENTER_JUSTIFY;
        doc.applyStroke = true; doc.strokeOverFill = false; doc.strokeWidth = 0;
        if (fontPS) { try { doc.font = fontPS; } catch (e) {} }
        src.setValue(doc);
        src.expression = styleExpr(mainName);
        L.property("ADBE Transform Group").property("ADBE Position").expression = posExpr(mainName);
        ensureDropShadow(L, mainName);
        setCueMarker(L);
        return L;
    }

    function eachCue(subComp, fn) {
        for (var i = 1; i <= subComp.numLayers; i++) {
            var L = subComp.layer(i);
            if (L.name.indexOf(LAYER_PREFIX) === 0 && (L instanceof TextLayer)) fn(L);
        }
    }
    function getCuesSorted(subComp) {
        var arr = [];
        eachCue(subComp, function(L){ arr.push(L); });
        arr.sort(function(a,b){ return cueIndexOf(a) - cueIndexOf(b); });
        return arr;
    }
    function getCuesByTime(subComp) {
        var arr = [];
        eachCue(subComp, function(L){ arr.push(L); });
        arr.sort(function(a,b){ return (a.inPoint - b.inPoint) || (cueIndexOf(a) - cueIndexOf(b)); });
        return arr;
    }
    function renumberCues(subComp) {
        // After split/merge/add, make index order = time order again (the list,
        // SRT export and translate batching all sort by index). Two-pass rename
        // avoids name collisions.
        var arr = getCuesByTime(subComp);
        var i;
        for (i = 0; i < arr.length; i++) arr[i].name = "MAGTMP_" + (i + 1);
        for (i = 0; i < arr.length; i++) { arr[i].name = LAYER_PREFIX + pad(i + 1, 4); setCueMarker(arr[i]); }
        return arr.length;
    }
    function fixAllOverlaps(subComp) {
        // Trim each cue so it ends no later than the next cue starts.
        // Whisper's -ml segmentation routinely emits ~0.2-0.5s overlaps.
        var arr = getCuesByTime(subComp), n = 0;
        for (var i = 0; i < arr.length - 1; i++) {
            if (arr[i].outPoint > arr[i+1].inPoint + 0.001) {
                arr[i].outPoint = Math.max(arr[i].inPoint + 0.1, arr[i+1].inPoint);
                setCueMarker(arr[i]);
                n++;
            }
        }
        return n;
    }
    function resolveOverlapsAround(L, subComp) {
        // After snapping/retiming a cue, the MOVED CUE WINS: any cue that now
        // overlaps it is trimmed (earlier cues end at L.in, later cues start
        // at L.out, keeping a 0.1s minimum duration).
        var n = 0;
        eachCue(subComp, function(o){
            if (o === L) return;
            if (o.inPoint < L.inPoint && o.outPoint > L.inPoint + 0.001) {
                o.outPoint = Math.max(o.inPoint + 0.1, L.inPoint); setCueMarker(o); n++;
            } else if (o.inPoint >= L.inPoint && o.inPoint < L.outPoint - 0.001) {
                o.inPoint = L.outPoint;                       // starts later, keeps its end
                if (o.outPoint < o.inPoint + 0.1) o.outPoint = o.inPoint + 0.1;
                setCueMarker(o); n++;
            }
        });
        return n;
    }
    function flatCueText(L) {
        return trim(String(getCueText(L)).replace(/[\r\n\x03]+/g, " ").replace(/\s+/g, " "));
    }
    function maxCueIndex(subComp) {
        var mx = 0;
        eachCue(subComp, function(L){ var i = cueIndexOf(L); if (i > mx) mx = i; });
        return mx;
    }

    // ============================ ANIMATION ============================
    function removeBlurFx(L) {
        var fx = L.property("ADBE Effect Parade");
        for (var i = fx.numProperties; i >= 1; i--)
            if (fx.property(i).name === "MAG Blur") fx.property(i).remove();
    }
    function clearAnimation(L, mainName) {
        var tg = L.property("ADBE Transform Group");
        var names = ["ADBE Opacity","ADBE Scale"];
        for (var i = 0; i < names.length; i++) {
            try { var p = tg.property(names[i]); while (p.numKeys > 0) p.removeKey(1); } catch (e) {}
        }
        try { tg.property("ADBE Opacity").setValue(100); } catch (e) {}
        try { tg.property("ADBE Scale").setValue([100,100]); } catch (e) {}
        tg.property("ADBE Position").expression = posExpr(mainName);
        removeBlurFx(L);
        try {
            // remove ALL text animators: ours ("Typewriter") and any applied .ffx preset animators
            var an = L.property("ADBE Text Properties").property("ADBE Text Animators");
            for (var k = an.numProperties; k >= 1; k--) an.property(k).remove();
        } catch (e) {}
    }

    function applyAnimation(L, preset, mainName) {
        clearAnimation(L, mainName);
        if (!preset || preset === "None") return;
        var inT=L.inPoint, outT=L.outPoint, dur=outT-inT;
        if (dur <= 0) return;
        var fade=Math.min(0.25,dur*0.25);
        var t0=inT,t1=inT+fade,t2=outT-fade,t3=outT;
        var tg=L.property("ADBE Transform Group");
        var op=tg.property("ADBE Opacity");

        if (preset==="Fade In/Out") {
            op.setValuesAtTimes([t0,t1,t2,t3],[0,100,100,0]);
        } else if (preset==="Fade In Only") {
            op.setValuesAtTimes([t0,t1],[0,100]);
        } else if (preset==="Slide Up"||preset==="Slide Down"||preset==="Slide From Bottom") {
            var offset = (preset==="Slide Up")?60:((preset==="Slide Down")?-60:160);
            tg.property("ADBE Position").expression = posSlideExpr(mainName,t0,t1,offset);
            op.setValuesAtTimes([t0,t1,t2,t3],[0,100,100,0]);
        } else if (preset==="Pop") {
            var sc=tg.property("ADBE Scale"); var pop=Math.min(0.15,dur*0.2);
            sc.setValuesAtTimes([t0,t0+pop,t0+pop*1.6],[[0,0],[115,115],[100,100]]);
            op.setValuesAtTimes([t0,t0+pop*0.6,t2,t3],[0,100,100,0]);
        } else if (preset==="Bounce") {
            var sc2=tg.property("ADBE Scale"); var b=Math.min(0.4,dur*0.4);
            sc2.setValuesAtTimes([t0,t0+b*0.4,t0+b*0.65,t0+b*0.85,t0+b],
                [[0,0],[112,112],[94,94],[103,103],[100,100]]);
            op.setValuesAtTimes([t0,t0+b*0.3,t2,t3],[0,100,100,0]);
        } else if (preset==="Scale Up Fade") {
            var sc3=tg.property("ADBE Scale");
            sc3.setValuesAtTimes([t0,t1],[[80,80],[100,100]]);
            op.setValuesAtTimes([t0,t1,t2,t3],[0,100,100,0]);
        } else if (preset==="Blur In") {
            var fx=L.property("ADBE Effect Parade");
            var bl=fx.addProperty("ADBE Gaussian Blur 2"); bl.name="MAG Blur";
            try { bl.property("ADBE Gaussian Blur 2-0003").setValue(1); } catch(e) {} // repeat edge px
            var blurr=bl.property("ADBE Gaussian Blur 2-0001");
            blurr.setValuesAtTimes([t0,t1],[40,0]);
            op.setValuesAtTimes([t0,t1,t2,t3],[0,100,100,0]);
        } else if (preset==="Typewriter") {
            try {
                var anims=L.property("ADBE Text Properties").property("ADBE Text Animators");
                var anim=anims.addProperty("ADBE Text Animator"); anim.name="Typewriter";
                var sel=anim.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
                sel.property("ADBE Text Percent End").setValuesAtTimes([t0,t2],[0,100]);
                var ap=anim.property("ADBE Text Animator Properties");
                ap.addProperty("ADBE Text Opacity"); ap.property("ADBE Text Opacity").setValue(0);
            } catch (e) { alert("Typewriter setup failed: "+e.toString()); }
            op.setValuesAtTimes([t0,t0+0.05,t2,t3],[0,100,100,0]);
        }
    }

    // ============================ FFX PRESETS (AE built-in text animations) ============================
    function scanFFXPresets() {
        var out = [];
        try {
            // Folder.startup == the AE "Support Files" dir (folder of AfterFX.exe)
            var root = new Folder(Folder.startup.fsName + "/Presets/Text");
            if (root.exists) {
                var subs = root.getFiles(function (f) { return f instanceof Folder; });
                for (var i = 0; i < subs.length; i++) {
                    var files = subs[i].getFiles("*.ffx");
                    for (var j = 0; j < files.length; j++)
                        out.push({ label: decodeURI(subs[i].displayName) + " / " +
                                          decodeURI(files[j].displayName).replace(/\.ffx$/i, ""),
                                   path: files[j].fsName });
                }
                var rootFiles = root.getFiles("*.ffx");
                for (var k = 0; k < rootFiles.length; k++)
                    out.push({ label: decodeURI(rootFiles[k].displayName).replace(/\.ffx$/i, ""), path: rootFiles[k].fsName });
            }
        } catch (e) {}
        return out;
    }
    // applyPreset() via scripting drops keyframes at the preset's saved absolute
    // times (near 0), ignoring the playhead - so every cue's animation landed at
    // comp start. We walk the layer's keyframes and shift them so the earliest
    // lands at the target time (cue In, or playhead for Animate-Out).
    function eachKeyedProp(root, fn) {
        var pt; try { pt = root.propertyType; } catch (e) { return; }
        if (pt === PropertyType.PROPERTY) {
            var nk = 0; try { nk = root.numKeys; } catch (e2) {}
            if (nk > 0) fn(root);
        } else {
            var n = 0; try { n = root.numProperties; } catch (e3) { return; }
            for (var i = 1; i <= n; i++) { try { eachKeyedProp(root.property(i), fn); } catch (e4) {} }
        }
    }
    function minKeyTimeOfLayer(L) {
        var t = null;
        eachKeyedProp(L, function (p) { var kt = p.keyTime(1); if (t === null || kt < t) t = kt; });
        return t;
    }
    function shiftLayerKeys(L, delta) {
        if (!delta) return;
        eachKeyedProp(L, function (p) {
            if (delta > 0) { for (var i = p.numKeys; i >= 1; i--) p.setKeyTime(i, p.keyTime(i) + delta); }
            else           { for (var j = 1; j <= p.numKeys; j++) p.setKeyTime(j, p.keyTime(j) + delta); }
        });
    }
    function applyPresetAt(L, f, target) {
        // capture pre-existing earliest key so we only realign when the preset
        // actually added keys at/near 0 (clean cue = no prior keys)
        L.applyPreset(f);
        var tmin = minKeyTimeOfLayer(L);
        if (tmin !== null) shiftLayerKeys(L, target - tmin);
    }
    function layerKeyExtent(L) {
        var lo=null, hi=null;
        eachKeyedProp(L, function(p){
            var a=p.keyTime(1), b=p.keyTime(p.numKeys);
            if (lo===null||a<lo) lo=a;
            if (hi===null||b>hi) hi=b;
        });
        return (lo===null)?null:{lo:lo,hi:hi};
    }
    function fitCueAnim(L, targetLen) {
        // Anchor the animation start to the cue In and scale its length so it
        // finishes within the cue. targetLen<=0 means "squeeze to cue only if
        // it currently overruns"; targetLen>0 sets an explicit length (capped
        // at the cue duration). Returns true if it touched any keys.
        var ext = layerKeyExtent(L); if (!ext) return false;
        var span = ext.hi - ext.lo;
        var cueDur = Math.max(0.05, L.outPoint - L.inPoint);
        var desired = (targetLen > 0) ? Math.min(targetLen, cueDur) : Math.min(span, cueDur);
        var factor = (span > 0) ? (desired / span) : 1;
        var shiftRight = (L.inPoint - ext.lo) > 0.0005;   // ordering to avoid key collisions
        eachKeyedProp(L, function(p){
            var times=[]; for (var i=1;i<=p.numKeys;i++) times.push(p.keyTime(i));
            var nt=[]; for (i=0;i<times.length;i++) nt.push(L.inPoint + (times[i]-ext.lo)*factor);
            if (shiftRight) { for (i=times.length;i>=1;i--){ try{ p.setKeyTime(i, nt[i-1]); }catch(e1){} } }
            else            { for (i=1;i<=times.length;i++){ try{ p.setKeyTime(i, nt[i-1]); }catch(e2){} } }
        });
        return true;
    }
    function fitAnimToCues(targetLen) {
        var subComp=findSubComp(); if(!subComp){ alert("Import first."); return 0; }
        app.beginUndoGroup("MAG: Fit Animation to Cues");
        var n=0;
        try { eachCue(subComp, function(L){ if (fitCueAnim(L, targetLen)) n++; }); }
        finally { app.endUndoGroup(); }
        return n;
    }
    function realignAllAnimation() {
        var subComp = findSubComp(); if (!subComp) { alert("Import first."); return 0; }
        app.beginUndoGroup("MAG: Realign Animation to Cue In");
        var n = 0;
        try {
            eachCue(subComp, function (L) {
                var tmin = minKeyTimeOfLayer(L);
                if (tmin !== null && Math.abs(tmin - L.inPoint) > 0.001) { shiftLayerKeys(L, L.inPoint - tmin); n++; }
            });
        } finally { app.endUndoGroup(); }
        return n;
    }
    function applyFFXToCue(L, ffxPath, atPlayhead) {
        var subComp = findSubComp(); if (!subComp) return false;
        var f = new File(ffxPath); if (!f.exists) { alert("Preset file not found:\n" + ffxPath); return false; }
        try { subComp.openInViewer(); } catch (e) {}
        var target = atPlayhead ? subComp.time : L.inPoint;
        try { applyPresetAt(L, f, target); return true; }
        catch (e2) { alert("applyPreset failed: " + e2.toString()); return false; }
    }
    function applyFFXToAll(ffxPath) {
        var subComp = findSubComp(); if (!subComp) { alert("Import first."); return; }
        var f = new File(ffxPath); if (!f.exists) { alert("Preset file not found:\n" + ffxPath); return; }
        try { subComp.openInViewer(); } catch (e) {}
        app.beginUndoGroup("MAG: Apply FFX Preset");
        var n = 0;
        try {
            eachCue(subComp, function (L) {
                try { applyPresetAt(L, f, L.inPoint); n++; } catch (e2) {}
            });
        } finally { app.endUndoGroup(); }
        alert("Applied preset to " + n + " cue(s); keyframes aligned to each cue's In point.\nNote: .ffx presets STACK - use Animation preset 'None' (Animate tab) to strip animators before applying a different one. For correct alignment, apply ffx to cues that have no other keyframes.");
    }

    // ============================ DIAGNOSE / REPAIR ============================
    function diagnose() {
        var msgs = [];
        var eng = "(unknown)";
        try { eng = app.project.expressionEngine; } catch (e) {}
        msgs.push("Expression engine: " + eng + (eng === "javascript-1.0" ? "   [OK]" :
            "   [PROBLEM] -> File > Project Settings > Expressions: set to JavaScript"));
        var mainComp = findMainComp(), subComp = findSubComp();
        msgs.push("Scope: resolved from the ACTIVE comp (each comp has its own set in v3.4)");
        msgs.push("Main comp: " + (mainComp ? mainComp.name + "  (id " + mainComp.id + ")" : "NOT FOUND"));
        msgs.push("Controller: " + ((mainComp && findLayerByName(mainComp, CONTROLLER_NAME)) ? "found" : "MISSING - re-import or Apply Style to recreate"));
        if (!subComp) { msgs.push("Precomp: MISSING"); alert(msgs.join("\n")); return; }
        var cues = getCuesSorted(subComp);
        msgs.push("Precomp: found (" + cues.length + " cues)");
        if (cues.length > 0) {
            var src = cues[0].property("ADBE Text Properties").property("ADBE Text Document");
            msgs.push("Cue 1 style expression: " + (src.expressionEnabled ? "enabled" : "DISABLED (AE auto-disabled it after an error)"));
            try { if (src.expressionError && src.expressionError !== "") msgs.push("Expression error: " + src.expressionError); } catch (e) {}
            if (mainComp && src.expression.indexOf('comp("' + escExpr(mainComp.name) + '")') === -1)
                msgs.push("WARNING: cue expressions reference a different comp name than '" + mainComp.name +
                          "'. Was the main comp renamed? Click Repair Expressions.");
        }
        msgs.push("\nIf size/color sliders do nothing: fix the engine if flagged, then click Repair Expressions.");
        alert(msgs.join("\n"));
    }
    function repairExpressions() {
        var mainComp = findMainComp(), subComp = findSubComp();
        if (!mainComp || !subComp) { alert("Nothing to repair - import first."); return; }
        setJSEngine();
        app.beginUndoGroup("MAG: Repair Expressions");
        var n = 0;
        try {
            var ctl = ensureController(mainComp);
            var bSz=0,bTr=0,bLd=0;
            try { bSz=ctl.effect("Font Size")(1).value; bTr=ctl.effect("Tracking")(1).value; bLd=ctl.effect("Leading")(1).value; } catch(eC){}
            eachCue(subComp, function (L) {
                var src = L.property("ADBE Text Properties").property("ADBE Text Document");
                src.expression = ""; src.expression = styleExpr(mainComp.name);
                var pos = L.property("ADBE Transform Group").property("ADBE Position");
                pos.expression = ""; pos.expression = posExpr(mainComp.name);
                ensureDropShadow(L, mainComp.name);
                n++;
            });
            bakeTextMetrics(bSz, bTr, bLd);
        } finally { app.endUndoGroup(); }
        alert("Re-linked " + n + " cue(s) to controller '" + CONTROLLER_NAME + "' in comp '" + mainComp.name +
              "'.\nNote: slide animations were reset to static position - re-apply the animation preset if you used Slide.");
    }

    // ============================ PRECOMP ============================
    function ensureSubComp(mainComp) {
        var sc = findSubCompFor(mainComp);
        if (!sc) {
            var nm = SUBCOMP_NAME + " [" + mainComp.name + "]";
            if (findCompByName(nm)) nm = SUBCOMP_NAME + " [" + mainComp.id + "]";
            sc = app.project.items.addComp(nm, mainComp.width, mainComp.height,
                                           mainComp.pixelAspect, mainComp.duration, mainComp.frameRate);
        }
        tagSubComp(sc, mainComp);
        var li = findSubLayerInMain(mainComp, sc);
        if (!li) { li = mainComp.layers.add(sc); li.moveToBeginning(); li.startTime = 0; }
        return { comp: sc, layer: li };
    }
    function clearCueLayers(subComp) {
        for (var i = subComp.numLayers; i >= 1; i--) {
            var L = subComp.layer(i);
            if (L.name.indexOf(LAYER_PREFIX) === 0) L.remove();
        }
    }

    // ============================ CORE ACTIONS ============================
    function importParsed(subs, fontPS, animPreset, replace) {
        var mainComp = getActiveCompStrict(); if (!mainComp) return 0;
        if (isSubCompItem(mainComp)) {
            mainComp = findMainComp();
            if (!mainComp || isSubCompItem(mainComp)) { alert("Select your MAIN comp (not the subtitle precomp)."); return 0; }
        }
        if (subs.length === 0) { alert("No cues parsed."); return 0; }
        setJSEngine();
        app.beginUndoGroup("MAG: Import Subtitles");
        var count = 0;
        try {
            ensureController(mainComp);
            var s = ensureSubComp(mainComp);
            var base = 0;
            if (replace) clearCueLayers(s.comp); else base = maxCueIndex(s.comp);
            for (var i = 0; i < subs.length; i++) {
                var L = createCueLayer(s.comp, base + i + 1, subs[i].start, subs[i].end, subs[i].text, fontPS, mainComp.name);
                applyAnimation(L, animPreset, mainComp.name);
                count++;
            }
        } catch (e) { alert("Import error: " + e.toString()); }
        finally { app.endUndoGroup(); }
        return count;
    }

    function pushStyleToController(fontSize, fill, strokeW, stroke, yPos, tracking, leading) {
        var mainComp = findMainComp(); if (!mainComp) { alert("No controller found. Import first."); return; }
        setJSEngine();
        app.beginUndoGroup("MAG: Apply Style");
        try {
            var ctl = ensureController(mainComp);
            ctl.effect("Font Size")(1).setValue(fontSize);
            ctl.effect("Font Color")(1).setValue([fill[0],fill[1],fill[2],1]);
            ctl.effect("Stroke Width")(1).setValue(strokeW);
            ctl.effect("Stroke Color")(1).setValue([stroke[0],stroke[1],stroke[2],1]);
            ctl.effect("Y Position")(1).setValue(yPos);
            ctl.effect("Tracking")(1).setValue(toNum(tracking,0));
            ctl.effect("Leading")(1).setValue(toNum(leading,0));
            bakeTextMetrics(fontSize, tracking, leading);   // size/tracking/leading are baked, not live
        } catch (e) { alert("Style error: "+e.toString()); }
        finally { app.endUndoGroup(); }
    }

    function bakeTextMetrics(size, tracking, leading) {
        // Write font size / tracking / leading directly into each cue's text
        // document. Reliable where the live style expression isn't (AE 2026).
        var subComp = findSubComp(); if (!subComp) return 0;
        var mainComp = findMainComp();
        var sz = toNum(size, 0), tr = toNum(tracking, 0), ld = toNum(leading, 0), n = 0;
        eachCue(subComp, function (L) {
            var src = L.property("ADBE Text Properties").property("ADBE Text Document");
            var hadExpr = (src.expression !== "");
            if (hadExpr) src.expression = "";          // edit the base doc, not the expr result
            var doc = src.value;
            try { if (sz > 0) doc.fontSize = sz; } catch (e1) {}
            try { doc.tracking = tr; } catch (e2) {}
            try {
                if (ld > 0) { doc.autoLeading = false; doc.leading = ld; }
                else { doc.autoLeading = true; }
            } catch (e3) {}
            src.setValue(doc);
            if (hadExpr && mainComp) src.expression = styleExpr(mainComp.name);
            n++;
        });
        return n;
    }
    function applyFontToCues(fontPS) {
        if (!fontPS) return;
        var subComp = findSubComp(); if (!subComp) { alert("Import first."); return; }
        var mainComp = findMainComp();
        setJSEngine();
        app.beginUndoGroup("MAG: Apply Font");
        var applied = null;
        try {
            eachCue(subComp, function (L) {
                var src = L.property("ADBE Text Properties").property("ADBE Text Document");
                var hadExpr = (src.expression !== "");
                if (hadExpr) src.expression = "";
                var doc = src.value;
                try { doc.font = fontPS; } catch (e) {}
                src.setValue(doc);
                if (hadExpr && mainComp) src.expression = styleExpr(mainComp.name);
                if (applied === null) applied = src.value.font;
            });
        } catch (e) { alert("Font error: "+e.toString()); }
        finally { app.endUndoGroup(); }
        if (applied && applied !== fontPS)
            alert("AE substituted font:\n  requested "+fontPS+"\n  applied   "+applied+"\nPick an entry from the dropdown for an exact match.");
    }

    function applyShadowToController(enable, color, opacity, distance, softness, angle) {
        var mainComp = findMainComp(); if (!mainComp) { alert("No controller. Import first."); return; }
        setJSEngine();
        app.beginUndoGroup("MAG: Apply Shadow");
        try {
            var ctl = ensureController(mainComp);
            ctl.effect("Shadow Enable")(1).setValue(enable?1:0);
            ctl.effect("Shadow Color")(1).setValue([color[0],color[1],color[2],1]);
            ctl.effect("Shadow Opacity")(1).setValue(opacity);
            ctl.effect("Shadow Distance")(1).setValue(distance);
            ctl.effect("Shadow Softness")(1).setValue(softness);
            ctl.effect("Shadow Angle")(1).setValue(angle);
            var subComp = findSubComp();
            if (subComp) eachCue(subComp, function(L){ ensureDropShadow(L, mainComp.name); });
        } catch (e) { alert("Shadow error: "+e.toString()); }
        finally { app.endUndoGroup(); }
    }

    function applyAnimationToAll(preset) {
        var subComp=findSubComp(), mainComp=findMainComp();
        if (!subComp||!mainComp) { alert("Import first."); return; }
        setJSEngine();
        app.beginUndoGroup("MAG: Apply Animation");
        try { eachCue(subComp, function(L){ applyAnimation(L, preset, mainComp.name); }); }
        catch (e) { alert("Animation error: "+e.toString()); }
        finally { app.endUndoGroup(); }
    }

    // ---- per-cue ----
    function applyAnimationToCue(L, preset) {
        var mainComp=findMainComp(); if (!mainComp) return;
        setJSEngine();
        app.beginUndoGroup("MAG: Cue Animation");
        try { applyAnimation(L, preset, mainComp.name); }
        finally { app.endUndoGroup(); }
    }
    function bakeCueStyle(L) {
        // detach from controller: freeze current style into the TextDocument
        app.beginUndoGroup("MAG: Bake Cue Style");
        try {
            var src = L.property("ADBE Text Properties").property("ADBE Text Document");
            src.expression = "";
        } finally { app.endUndoGroup(); }
    }
    function relinkCueStyle(L) {
        var mainComp=findMainComp(); if (!mainComp) return;
        app.beginUndoGroup("MAG: Relink Cue Style");
        try { L.property("ADBE Text Properties").property("ADBE Text Document").expression = styleExpr(mainComp.name); }
        finally { app.endUndoGroup(); }
    }

    // ---- markers ----
    function syncTimingFromCueMarkers() {
        var subComp=findSubComp(); if (!subComp) { alert("Import first."); return; }
        app.beginUndoGroup("MAG: Cue Markers -> Timing");
        var n=0;
        try {
            eachCue(subComp, function(L){
                var mp=L.property("Marker"); if (mp.numKeys<1) return;
                var mt=mp.keyTime(1), mv=mp.keyValue(1);
                var dur=mv.duration>0?mv.duration:(L.outPoint-L.inPoint);
                L.inPoint=mt; L.outPoint=mt+dur; n++;
            });
        } finally { app.endUndoGroup(); }
        alert("Retimed "+n+" cue(s) from their markers.");
    }
    function rebuildCueMarkers() {
        var subComp=findSubComp(); if (!subComp) { alert("Import first."); return; }
        app.beginUndoGroup("MAG: Timing -> Cue Markers");
        try { eachCue(subComp, function(L){ setCueMarker(L); }); }
        finally { app.endUndoGroup(); }
    }
    function mirrorMarkersToMain() {
        var mainComp=findMainComp(), subComp=findSubComp();
        if (!mainComp||!subComp) { alert("Import first."); return; }
        var subLayer=findSubLayerInMain(mainComp,subComp);
        if (!subLayer) { alert("MAG_Subtitles layer not in main comp."); return; }
        app.beginUndoGroup("MAG: Mirror Markers to Main");
        try {
            var mp=subLayer.property("Marker"); while (mp.numKeys>0) mp.removeKey(1);
            var off=subLayer.startTime;
            eachCue(subComp, function(L){
                var mv=new MarkerValue("#"+cueIndexOf(L)+" "+getCueText(L).substr(0,50));
                mv.duration=Math.max(0.001,L.outPoint-L.inPoint);
                mp.setValueAtTime(off+L.inPoint,mv);
            });
        } finally { app.endUndoGroup(); }
        alert("Markers mirrored onto the MAG_Subtitles layer.");
    }
    function applyMainMarkersToCues() {
        var mainComp=findMainComp(), subComp=findSubComp();
        if (!mainComp||!subComp) { alert("Import first."); return; }
        var subLayer=findSubLayerInMain(mainComp,subComp);
        if (!subLayer) { alert("MAG_Subtitles layer not in main comp."); return; }
        var off=subLayer.startTime, mp=subLayer.property("Marker");
        app.beginUndoGroup("MAG: Main Markers -> Cues");
        var n=0;
        try {
            for (var k=1;k<=mp.numKeys;k++) {
                var mv=mp.keyValue(k), mt=mp.keyTime(k);
                var m=String(mv.comment).match(/#(\d+)/); if (!m) continue;
                var L=findLayerByName(subComp, LAYER_PREFIX+pad(parseInt(m[1],10),4)); if (!L) continue;
                var dur=mv.duration>0?mv.duration:(L.outPoint-L.inPoint);
                L.inPoint=mt-off; L.outPoint=mt-off+dur; setCueMarker(L); n++;
            }
        } finally { app.endUndoGroup(); }
        alert("Retimed "+n+" cue(s) from main-layer markers.");
    }

    // ---- sync toolkit ----
    function offsetAll(delta) {
        var subComp=findSubComp(); if (!subComp) { alert("Import first."); return; }
        app.beginUndoGroup("MAG: Offset All");
        try {
            eachCue(subComp, function(L){
                var d=L.outPoint-L.inPoint;
                var ni=Math.max(0,L.inPoint+delta);
                L.inPoint=ni; L.outPoint=ni+d; setCueMarker(L);
            });
        } finally { app.endUndoGroup(); }
    }
    function stretchAll(factor) {
        if (factor<=0) { alert("Factor must be > 0."); return; }
        var subComp=findSubComp(); if (!subComp) { alert("Import first."); return; }
        app.beginUndoGroup("MAG: Stretch Timing");
        try {
            eachCue(subComp, function(L){
                var ni=L.inPoint*factor, no=L.outPoint*factor;
                L.inPoint=ni; L.outPoint=Math.max(ni+0.05,no); setCueMarker(L);
            });
        } finally { app.endUndoGroup(); }
    }
    function rippleFrom(idx, delta) {
        var subComp=findSubComp(); if (!subComp) { alert("Import first."); return; }
        app.beginUndoGroup("MAG: Ripple Offset");
        try {
            eachCue(subComp, function(L){
                if (cueIndexOf(L) < idx) return;
                var d=L.outPoint-L.inPoint;
                var ni=Math.max(0,L.inPoint+delta);
                L.inPoint=ni; L.outPoint=ni+d; setCueMarker(L);
            });
        } finally { app.endUndoGroup(); }
    }
    function playheadInSub() {
        var mainComp=findMainComp(), subComp=findSubComp();
        var a=app.project.activeItem;
        if (a===subComp && subComp) return subComp.time;
        if (a===mainComp && subComp) { var sl=findSubLayerInMain(mainComp,subComp); return mainComp.time-(sl?sl.startTime:0); }
        return null;
    }
    function extendCueToPlayhead(L) {
        var t=playheadInSub();
        if (t===null) { alert("Open the main comp or the precomp to use the playhead."); return false; }
        if (t <= L.inPoint + 0.05) { alert("Move the playhead PAST the cue's start - this sets the cue's end (Out) to the playhead."); return false; }
        app.beginUndoGroup("MAG: Extend Cue to Playhead");
        try { L.outPoint=t; setCueMarker(L); } finally { app.endUndoGroup(); }
        return true;
    }
    function snapCueToPlayhead(L) {
        var mainComp=findMainComp(), subComp=findSubComp();
        var t=null;
        var a=app.project.activeItem;
        if (a===subComp) t=subComp.time;
        else if (a===mainComp && subComp) {
            var sl=findSubLayerInMain(mainComp,subComp);
            t=mainComp.time-(sl?sl.startTime:0);
        }
        if (t===null) { alert("Open the main comp or the precomp to use the playhead."); return; }
        app.beginUndoGroup("MAG: Snap Cue to Playhead");
        try {
            var d=L.outPoint-L.inPoint;
            L.inPoint=Math.max(0,t); L.outPoint=L.inPoint+d; setCueMarker(L);
        } finally { app.endUndoGroup(); }
    }

    // ---- export / remove ----
    function gatherCueRows() {
        var subComp=findSubComp(); if (!subComp) return [];
        var rows=[];
        eachCue(subComp, function(L){
            rows.push({inPoint:L.inPoint,outPoint:L.outPoint,text:getCueText(L)});
        });
        rows.sort(function(a,b){return a.inPoint-b.inPoint;});
        return rows;
    }
    function exportSubs(format) {
        var rows=gatherCueRows();
        if (rows.length===0) { alert("No cues to export."); return; }
        var out="", k;
        if (format==="vtt") {
            out="WEBVTT\n\n";
            for (k=0;k<rows.length;k++)
                out+=(k+1)+"\n"+fmtVTT(rows[k].inPoint)+" --> "+fmtVTT(rows[k].outPoint)+"\n"+rows[k].text+"\n\n";
        } else {
            for (k=0;k<rows.length;k++)
                out+=(k+1)+"\n"+fmtSRT(rows[k].inPoint)+" --> "+fmtSRT(rows[k].outPoint)+"\n"+rows[k].text+"\n\n";
        }
        var ext="."+format;
        var f=File.saveDialog("Export "+format.toUpperCase()+" as", format.toUpperCase()+":*"+ext);
        if (!f) return;
        if (f.name.toLowerCase().indexOf(ext)===-1) f=new File(f.fsName+ext);
        f.encoding="UTF-8"; f.open("w"); f.write(out); f.close();
        alert("Exported "+rows.length+" cue(s):\n"+f.fsName);
    }
    function removeAll() {
        var mainComp=findMainComp(), subComp=findSubComp();
        if (!confirm("Remove the MAG_Subtitles precomp, its layer, and SUB_CONTROLLER?")) return;
        app.beginUndoGroup("MAG: Remove All");
        try {
            if (mainComp) {
                if (subComp) { var sl=findSubLayerInMain(mainComp,subComp); if (sl) sl.remove(); }
                var ctl=findLayerByName(mainComp,CONTROLLER_NAME); if (ctl) ctl.remove();
            }
            if (subComp) subComp.remove();
        } finally { app.endUndoGroup(); }
    }

    // ============================ LINE LAYOUT ============================
    function wrapText(text, maxChars) {
        var clean = trim(String(text).replace(/[\r\n\x03]+/g, " "));
        if (clean === "") return [""];
        var words = clean.split(/\s+/), lines = [], cur = "";
        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            if (cur === "") cur = w;
            else if ((cur.length + 1 + w.length) <= maxChars) cur += " " + w;
            else { lines.push(cur); cur = w; }
        }
        if (cur !== "") lines.push(cur);
        return lines;
    }
    function reflowAllCues(maxChars, maxLines, splitOverflow, fontPS, anim) {
        var subComp = findSubComp(), mainComp = findMainComp();
        if (!subComp || !mainComp) { alert("Import first."); return 0; }
        var cues = getCuesSorted(subComp);
        if (cues.length === 0) { alert("No cues."); return 0; }
        var subs = [];
        for (var i = 0; i < cues.length; i++) {
            var L = cues[i];
            var txt = String(L.property("ADBE Text Properties").property("ADBE Text Document").value.text);
            var lines = wrapText(txt, maxChars);
            var t0 = L.inPoint, t1 = L.outPoint, dur = Math.max(0.01, t1 - t0);
            if (lines.length <= maxLines || !splitOverflow) {
                if (lines.length > maxLines) {
                    // no splitting: cram the remainder into the last allowed line
                    var head = lines.slice(0, maxLines - 1);
                    head.push(lines.slice(maxLines - 1).join(" "));
                    lines = head;
                }
                subs.push({ start: t0, end: t1, text: lines.join("\r") });
            } else {
                // split overlong cue into chunks of maxLines; time proportional to chars
                var chunks = [];
                for (var c = 0; c < lines.length; c += maxLines) chunks.push(lines.slice(c, c + maxLines));
                var totalChars = 0, lens = [];
                for (var k = 0; k < chunks.length; k++) { var n = chunks[k].join(" ").length; lens.push(n); totalChars += n; }
                var t = t0;
                for (var k2 = 0; k2 < chunks.length; k2++) {
                    var e = (k2 === chunks.length - 1) ? t1
                          : t + ((totalChars > 0) ? dur * lens[k2] / totalChars : dur / chunks.length);
                    subs.push({ start: t, end: e, text: chunks[k2].join("\r") });
                    t = e;
                }
            }
        }
        try { mainComp.openInViewer(); } catch (eV) {}
        return importParsed(subs, fontPS, anim, true);
    }

    // ============================ PRESETS ============================
    function presetsFolder() {
        var f = new Folder(Folder.myDocuments.fsName + "/MAG_Subtitler/presets");
        if (!f.exists) f.create();
        return f;
    }
    function readControllerState() {
        var mainComp=findMainComp(); if (!mainComp) return null;
        var ctl=findLayerByName(mainComp,CONTROLLER_NAME); if (!ctl) return null;
        function gv(n){ try { return ctl.effect(n)(1).value; } catch(e){ return null; } }
        return {
            fontSize: gv("Font Size"), fontColor: gv("Font Color"),
            strokeWidth: gv("Stroke Width"), strokeColor: gv("Stroke Color"),
            yPos: gv("Y Position"),
            tracking: gv("Tracking"), leading: gv("Leading"),
            shadowEnable: gv("Shadow Enable"), shadowColor: gv("Shadow Color"),
            shadowOpacity: gv("Shadow Opacity"), shadowDistance: gv("Shadow Distance"),
            shadowSoftness: gv("Shadow Softness"), shadowAngle: gv("Shadow Angle")
        };
    }
    function savePreset(name, font, anim) {
        var st = readControllerState();
        if (!st) { alert("No controller to read. Import first."); return; }
        st.font = font; st.anim = anim; st.version = SCRIPT_VERSION;
        var f = new File(presetsFolder().fsName + "/" + name.replace(/[^\w\- ]/g,"_") + ".json");
        f.encoding="UTF-8"; f.open("w"); f.write(jStr(st)); f.close();
        alert("Preset saved:\n"+f.fsName);
    }
    function listPresets() {
        var files = presetsFolder().getFiles("*.json"), names=[];
        for (var i=0;i<files.length;i++) names.push(decodeURI(files[i].displayName).replace(/\.json$/,""));
        return names;
    }
    function loadPreset(name) {
        var f = new File(presetsFolder().fsName + "/" + name + ".json");
        if (!f.exists) { alert("Preset not found."); return null; }
        f.encoding="UTF-8"; f.open("r"); var s=f.read(); f.close();
        return jParse(s);
    }
    function applyPreset(p) {
        if (!p) return;
        pushStyleToController(
            toNum(p.fontSize,64),
            p.fontColor||[1,1,1,1],
            toNum(p.strokeWidth,0),
            p.strokeColor||[0,0,0,1],
            toNum(p.yPos,900),
            toNum(p.tracking,0), toNum(p.leading,0));
        applyShadowToController(
            toNum(p.shadowEnable,1)>0,
            p.shadowColor||[0,0,0,1],
            toNum(p.shadowOpacity,70), toNum(p.shadowDistance,6),
            toNum(p.shadowSoftness,8), toNum(p.shadowAngle,135));
        if (p.font) applyFontToCues(p.font);
        if (p.anim) applyAnimationToAll(p.anim);
    }

    // ============================ SHELL / AI BRIDGES ============================
    function runCmd(cmdLine) {
        // Windows-safe wrapper. Blocks until done. Returns stdout.
        var full = (File.fs === "Windows")
            ? ('cmd.exe /s /c "' + cmdLine + '"')
            : ('/bin/sh -c "' + cmdLine.replace(/"/g,'\\"') + '"');
        return system.callSystem(full);
    }
    function q(p) { return '"' + String(p) + '"'; }

    function whisperLenFlags(maxLen) {
        // -ml: max segment length in characters (token-level timestamps),
        // -sow: only split on word boundaries. 0 disables -> whisper defaults
        // (which produce the very long ~15s segments).
        var n = Math.round(toNum(maxLen, 0));
        return (n > 0) ? (" -ml " + n + " -sow") : "";
    }
    function transcribeOutBase(mediaPath) {
        // SRT lands NEXT TO the source media as <name>_whisper.srt so it is
        // discoverable and never clobbers an existing <name>.srt.
        var mf = new File(mediaPath);
        var folder = mf.parent.fsName.replace(/\\/g,"/");
        var name = decodeURI(mf.displayName).replace(/\.[^.]+$/,"");
        return folder + "/" + name + "_whisper";
    }

    function transcribeMediaBlocking(opts) {
        // Non-Windows fallback (blocking). Windows uses startTranscribeAsync.
        var stamp = new Date().getTime();
        var tmp = Folder.temp.fsName.replace(/\\/g,"/");
        var audioIn = opts.media, log = "";
        if (opts.ffmpegPath && trim(opts.ffmpegPath) !== "") {
            var wav = tmp + "/mag_whisper_" + stamp + ".wav";
            log += runCmd(q(opts.ffmpegPath)+" -y -i "+q(opts.media)+" -ar 16000 -ac 1 -c:a pcm_s16le "+q(wav)+" 2>&1");
            if (!(new File(wav)).exists) { alert("ffmpeg conversion failed:\n"+log.substr(0,800)); return null; }
            audioIn = wav;
        }
        var outBase = transcribeOutBase(opts.media);
        var lang = (opts.language && trim(opts.language)!=="") ? trim(opts.language) : "auto";
        log += "\n" + runCmd(q(opts.whisperExe)+" -m "+q(opts.modelPath)+" -f "+q(audioIn)+" -osrt -of "+q(outBase)+" -l "+lang+whisperLenFlags(opts.maxLen)+" 2>&1");
        var srtFile = new File(outBase + ".srt");
        if (!srtFile.exists) { alert("Whisper did not produce an SRT.\nOutput (tail):\n"+log.substr(Math.max(0,log.length-900))); return null; }
        srtFile.encoding="UTF-8"; srtFile.open("r"); var content=srtFile.read(); srtFile.close();
        return { content: content, srtPath: srtFile.fsName };
    }

    function startTranscribeAsync(opts, onDone) {
        // Windows: run whisper DETACHED via a temp .bat, tail its log with
        // app.scheduleTask, and drive a progress palette. AE stays responsive.
        if (File.fs !== "Windows") {
            var r = transcribeMediaBlocking(opts);
            if (r) onDone(r.content, r.srtPath);
            return;
        }
        var stamp = new Date().getTime();
        var tmp = Folder.temp.fsName;                       // backslash paths are fine in .bat
        var logPath  = tmp + "\\mag_whisper_" + stamp + ".log";
        var flagPath = tmp + "\\mag_whisper_" + stamp + ".done";
        var batPath  = tmp + "\\mag_whisper_" + stamp + ".bat";
        var wavPath  = tmp + "\\mag_whisper_" + stamp + ".wav";
        var outBase  = transcribeOutBase(opts.media).replace(/\//g,"\\");
        var srtPath  = outBase + ".srt";
        var lang = (opts.language && trim(opts.language)!=="") ? trim(opts.language) : "auto";
        var useFF = (opts.ffmpegPath && trim(opts.ffmpegPath) !== "");

        // stale outputs from a previous run would false-positive the polls
        try { var oldS=new File(srtPath); if (oldS.exists) oldS.remove(); } catch(e0) {}

        var bat = "@echo off\r\n";
        var audioIn = opts.media;
        if (useFF) {
            bat += q(opts.ffmpegPath)+" -y -i "+q(opts.media)+" -ar 16000 -ac 1 -c:a pcm_s16le "+q(wavPath)+" >> "+q(logPath)+" 2>&1\r\n";
            audioIn = wavPath;
        }
        bat += q(opts.whisperExe)+" -m "+q(opts.modelPath)+" -f "+q(audioIn)+
               " -osrt -of "+q(outBase)+" -l "+lang+whisperLenFlags(opts.maxLen)+
               " --print-progress >> "+q(logPath)+" 2>&1\r\n";
        if (useFF) bat += "del "+q(wavPath)+" >nul 2>&1\r\n";
        bat += "echo done> "+q(flagPath)+"\r\n";
        var bf = new File(batPath); bf.encoding="UTF-8"; bf.open("w"); bf.write(bat); bf.close();

        // DETACH FIX (v3.4.1): 'start /b' shares callSystem's console, and
        // callSystem waits until everything on that console exits -> AE froze
        // for the whole run. Instead, a VBS wrapper fires the .bat via
        // WScript.Shell.Run with window=0 (hidden) and wait=false; wscript
        // exits instantly, so callSystem returns instantly.
        var vbsPath = tmp + "\\mag_whisper_" + stamp + ".vbs";
        var vbs = 'CreateObject("WScript.Shell").Run Chr(34) & "' +
                  batPath.replace(/\\/g, "\\\\") + '" & Chr(34), 0, False\r\n';
        var vf = new File(vbsPath); vf.encoding = "UTF-8"; vf.open("w"); vf.write(vbs); vf.close();

        // ---- progress palette (shown BEFORE launch so UI exists even if launch stalls) ----
        var pal = new Window("palette", "MAG Subtitler - Transcribing", undefined, {resizeable:false});
        pal.orientation="column"; pal.alignChildren=["fill","top"]; pal.margins=14; pal.spacing=8;
        pal.add("statictext",undefined,"Source: "+decodeURI(new File(opts.media).displayName));
        var st = pal.add("statictext",undefined, useFF ? "Converting audio (ffmpeg)..." : "Starting whisper...");
        var pb = pal.add("progressbar",undefined,0,100); pb.preferredSize=[320,14];
        var pct = pal.add("statictext",undefined,"0%");
        pal.add("statictext",undefined,"SRT will be saved next to the media file.");
        var cancelBtn = pal.add("button",undefined,"Cancel");
        pal.show(); pal.update();

        system.callSystem('wscript.exe ' + q(vbsPath));   // returns immediately

        var ticks = 0;
        function readLog() {
            var lf=new File(logPath); if (!lf.exists) return "";
            lf.encoding="UTF-8"; if (!lf.open("r")) return "";
            var s=lf.read(); lf.close(); return s;
        }
        function cleanup() {
            try { app.cancelTask($.global.__MAGSUB_TASKID); } catch(e1) {}
            $.global.__MAGSUB_TICK = null;
            try { pal.close(); } catch(e2) {}
            try { (new File(batPath)).remove(); } catch(e3) {}
            try { (new File(flagPath)).remove(); } catch(e4) {}
            try { (new File(vbsPath)).remove(); } catch(e4b) {}
        }
        cancelBtn.onClick=function(){
            cleanup();
            // best-effort kill; affects any running whisper-cli instance
            system.callSystem('cmd.exe /c taskkill /f /im whisper-cli.exe >nul 2>&1');
            if (useFF) system.callSystem('cmd.exe /c taskkill /f /im ffmpeg.exe >nul 2>&1');
            try { (new File(logPath)).remove(); } catch(e5) {}
        };

        $.global.__MAGSUB_TICK = function() {
            ticks++;
            var log = readLog();
            if (log === "" && !(new File(flagPath)).exists) {
                if (ticks === 20) st.text = "Still waiting for whisper to start... (check paths if this persists)";
                if (ticks >= 90) {   // ~60s with zero output: declare failure
                    cleanup();
                    alert("Transcription never started (no output after 60s).\nCheck the whisper-cli / ffmpeg / model paths.\n\nCommand that was launched:\n"+bat.substr(0,500));
                    return;
                }
            }
            if (log.indexOf("whisper_model_load") !== -1 || log.indexOf("ggml_cuda_init") !== -1)
                st.text = "Transcribing on GPU...";
            var m, last = -1, re = /progress\s*=\s*(\d+)%/g;
            while ((m = re.exec(log)) !== null) last = parseInt(m[1], 10);
            if (last >= 0) { pb.value = last; pct.text = last + "%"; }
            else if (ticks % 3 === 0) { pb.value = (pb.value + 3) % 100; } // indeterminate shimmer pre-progress
            pal.update();

            if ((new File(flagPath)).exists) {
                var srtFile = new File(srtPath);
                var ok = srtFile.exists;
                var tail = log.substr(Math.max(0, log.length - 900));
                cleanup();
                try { (new File(logPath)).remove(); } catch(e6) {}
                if (!ok) { alert("Whisper did not produce an SRT.\nLog (tail):\n"+tail); return; }
                srtFile.encoding="UTF-8"; srtFile.open("r"); var content=srtFile.read(); srtFile.close();
                onDone(content, srtFile.fsName);
            }
        };
        $.global.__MAGSUB_TASKID = app.scheduleTask("if ($.global.__MAGSUB_TICK) $.global.__MAGSUB_TICK();", 700, true);
    }

    function llmChat(endpoint, apiKey, prompt, maxTokens) {
        var tmp = Folder.temp.fsName.replace(/\\/g,"/");
        var stamp = new Date().getTime();
        var payloadPath = tmp + "/mag_llm_req_" + stamp + ".json";
        var outPath     = tmp + "/mag_llm_res_" + stamp + ".json";

        var payload = {
            model: "local",
            temperature: 0.2,
            max_tokens: maxTokens || 2048,
            messages: [ { role: "user", content: prompt } ]
        };
        var pf = new File(payloadPath);
        pf.encoding="UTF-8"; pf.open("w"); pf.write(jStr(payload)); pf.close();

        var auth = (apiKey && trim(apiKey)!=="") ? (' -H "Authorization: Bearer '+trim(apiKey)+'"') : "";
        var cmd = 'curl -s -X POST '+q(endpoint)+' -H "Content-Type: application/json"'+auth+
                  ' --data-binary @'+q(payloadPath)+' -o '+q(outPath)+' --max-time 600';
        runCmd(cmd);

        var of = new File(outPath);
        if (!of.exists) { alert("No response from LLM endpoint (curl failed). Is the server running?"); return null; }
        of.encoding="UTF-8"; of.open("r"); var res=of.read(); of.close();
        try { pf.remove(); of.remove(); } catch (e) {}

        var data = jParse(res);
        if (!data) { alert("Could not parse LLM response:\n"+String(res).substr(0,500)); return null; }
        if (data.error) { alert("LLM error: "+jStr(data.error).substr(0,500)); return null; }
        try { return data.choices[0].message.content; } catch (e2) {
            alert("Unexpected LLM response shape:\n"+String(res).substr(0,500)); return null;
        }
    }

    function translateAllCues(endpoint, apiKey, targetLang, batchSize, progressFn) {
        var subComp=findSubComp(), mainComp=findMainComp();
        if (!subComp||!mainComp) { alert("Import first."); return; }
        var cues = getCuesSorted(subComp);
        if (cues.length===0) { alert("No cues."); return; }
        if (!batchSize || batchSize<1) batchSize=15;

        var done=0, failed=0;
        app.beginUndoGroup("MAG: Translate Cues");
        try {
            for (var ofs=0; ofs<cues.length; ofs+=batchSize) {
                var batch=cues.slice(ofs, Math.min(ofs+batchSize, cues.length));
                var texts=[];
                for (var i=0;i<batch.length;i++) texts.push(getCueText(batch[i]));

                var prompt =
                    "Translate the following subtitle lines into " + targetLang + ".\n" +
                    "Rules: return ONLY a JSON array of strings, exactly " + texts.length +
                    " items, same order. Preserve internal line breaks (\\n). " +
                    "Keep translations concise and natural for on-screen subtitles. No commentary.\n\n" +
                    "Input:\n" + jStr(texts);

                var reply = llmChat(endpoint, apiKey, prompt, 4096);
                if (reply === null) { failed += batch.length; break; }
                var arr = extractJsonArray(reply);
                if (!arr || arr.length !== texts.length) {
                    failed += batch.length;
                    alert("Batch "+(Math.floor(ofs/batchSize)+1)+" returned a malformed array; skipped. (Got: "+
                          String(reply).substr(0,200)+")");
                    continue;
                }
                for (var k=0;k<batch.length;k++) {
                    setCueText(batch[k], String(arr[k]), mainComp.name);
                    setCueMarker(batch[k]);
                    done++;
                }
                if (progressFn) progressFn(done, cues.length);
            }
        } finally { app.endUndoGroup(); }
        alert("Translation complete: "+done+" cue(s) translated"+(failed>0?(", "+failed+" failed/skipped"):"")+".");
    }

    // ============================ UI ============================
    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel) ? thisObj
            : new Window("palette", SCRIPT_NAME+" "+SCRIPT_VERSION, undefined, {resizeable:true});
        win.orientation="column"; win.alignChildren=["fill","fill"]; win.spacing=6; win.margins=8;

        var fontData=getInstalledFonts();
        var fontLabels=[]; for (var fi=0;fi<fontData.length;fi++) fontLabels.push(fontData[fi].label);

        var loadedContent=null, loadedName="";

        function colFromSetting(key, dflt) {
            var s=getSetting(key,""); if (s==="") return dflt;
            var p=s.split(","); if (p.length<3) return dflt;
            return [toNum(p[0],dflt[0]),toNum(p[1],dflt[1]),toNum(p[2],dflt[2])];
        }
        function colToSetting(c){ return c[0]+","+c[1]+","+c[2]; }

        var fillColor=colFromSetting("fillColor",[1,1,1]);
        var strokeColor=colFromSetting("strokeColor",[0,0,0]);
        var shadowColor=colFromSetting("shadowColor",[0,0,0]);

        var tabs = win.add("tabbedpanel");
        tabs.alignChildren=["fill","fill"];

        // ---------------- TAB: Import ----------------
        var tImp = tabs.add("tab", undefined, "Import");
        tImp.orientation="column"; tImp.alignChildren=["fill","top"]; tImp.spacing=6; tImp.margins=8;

        var loadBtn = tImp.add("button", undefined, "Choose subtitle file (.srt .vtt .ass .txt .csv)...");
        var loadedTxt = tImp.add("statictext", undefined, "(none loaded)");

        var txtGrp = tImp.add("panel", undefined, "Plain TXT auto-timing");
        txtGrp.orientation="row"; txtGrp.margins=8; txtGrp.spacing=4;
        txtGrp.add("statictext",undefined,"Start:");
        var txtStart=txtGrp.add("edittext",undefined,"0"); txtStart.characters=4;
        txtGrp.add("statictext",undefined,"Dur:");
        var txtDur=txtGrp.add("edittext",undefined,"3"); txtDur.characters=4;
        txtGrp.add("statictext",undefined,"Gap:");
        var txtGap=txtGrp.add("edittext",undefined,"0.2"); txtGap.characters=4;

        var modeGrp = tImp.add("group");
        var replaceRb = modeGrp.add("radiobutton", undefined, "Replace existing cues");
        var appendRb  = modeGrp.add("radiobutton", undefined, "Append");
        replaceRb.value=true;

        var importBtn = tImp.add("button", undefined, "IMPORT"); importBtn.preferredSize.height=30;
        tImp.add("statictext", undefined, "Import uses the Style & Animate tab settings.");

        // ---------------- TAB: Cues ----------------
        var tCue = tabs.add("tab", undefined, "Cues");
        tCue.orientation="column"; tCue.alignChildren=["fill","fill"]; tCue.spacing=6; tCue.margins=8;

        var cueList = tCue.add("listbox", undefined, [], {
            numberOfColumns: 4, showHeaders: true,
            columnTitles: ["#","In","Out","Text"], columnWidths: [34,70,70,260]
        });
        cueList.preferredSize=[440,220];

        var edGrp = tCue.add("panel", undefined, "Edit selected cue");
        edGrp.orientation="column"; edGrp.alignChildren=["fill","top"]; edGrp.margins=8; edGrp.spacing=4;
        var edTimes = edGrp.add("group");
        edTimes.add("statictext",undefined,"In (s):");
        var edIn=edTimes.add("edittext",undefined,""); edIn.characters=8;
        edTimes.add("statictext",undefined,"Out (s):");
        var edOut=edTimes.add("edittext",undefined,""); edOut.characters=8;
        var edText = edGrp.add("edittext", undefined, "", {multiline:true});
        edText.preferredSize=[420,52];

        var cueBtns1 = edGrp.add("group");
        var refreshCuesBtn = cueBtns1.add("button", undefined, "Refresh List");
        var fixOvBtn       = cueBtns1.add("button", undefined, "Fix Overlaps");
        var updateCueBtn   = cueBtns1.add("button", undefined, "Update Cue");
        var jumpBtn        = cueBtns1.add("button", undefined, "Jump To");
        var snapBtn        = cueBtns1.add("button", undefined, "Snap to Playhead");
        var endAtBtn       = cueBtns1.add("button", undefined, "End at Playhead");

        var cueBtns2 = edGrp.add("group");
        var addCueBtn    = cueBtns2.add("button", undefined, "Add Cue at Playhead");
        var splitCueBtn  = cueBtns2.add("button", undefined, "Split Cue");
        var mergeCueBtn  = cueBtns2.add("button", undefined, "Merge with Next");
        var delCueBtn    = cueBtns2.add("button", undefined, "Delete Cue");

        var cueAnimGrp = edGrp.add("group");
        cueAnimGrp.add("statictext", undefined, "Cue anim:");
        var cueAnimList = cueAnimGrp.add("dropdownlist", undefined, ANIM_PRESETS);
        cueAnimList.selection=0; cueAnimList.preferredSize.width=130;
        var cueAnimBtn = cueAnimGrp.add("button", undefined, "Apply");
        var bakeBtn    = cueAnimGrp.add("button", undefined, "Bake Style");
        var relinkBtn  = cueAnimGrp.add("button", undefined, "Relink");

        // ---------------- TAB: Style ----------------
        var tSty = tabs.add("tab", undefined, "Style");
        tSty.orientation="column"; tSty.alignChildren=["fill","top"]; tSty.spacing=6; tSty.margins=8;

        var fontRow=tSty.add("group");
        fontRow.add("statictext",undefined,"Font:");
        var fontList=fontRow.add("dropdownlist",undefined,fontLabels);
        fontList.selection=0; fontList.preferredSize.width=240;
        var refreshFontsBtn=fontRow.add("button",undefined,"Refresh");

        var sizeRow=tSty.add("group");
        sizeRow.add("statictext",undefined,"Size:");
        var sizeInput=sizeRow.add("edittext",undefined,getSetting("fontSize","64")); sizeInput.characters=6;
        // (stroke/shadow/anim fields restore from settings below, after creation)
        sizeRow.add("statictext",undefined,"Y pos:");
        var yInput=sizeRow.add("edittext",undefined,""); yInput.characters=7;
        sizeRow.add("statictext",undefined,"(blank = h*0.85)");

        var typoRow=tSty.add("group");
        typoRow.add("statictext",undefined,"Tracking:");
        var trackInput=typoRow.add("edittext",undefined,getSetting("tracking","0")); trackInput.characters=6;
        typoRow.add("statictext",undefined,"Leading:");
        var leadInput=typoRow.add("edittext",undefined,getSetting("leading","0")); leadInput.characters=6;
        typoRow.add("statictext",undefined,"(leading 0 = auto)");

        var layGrp=tSty.add("panel",undefined,"Line Layout");
        layGrp.orientation="column"; layGrp.alignChildren=["fill","top"]; layGrp.margins=8; layGrp.spacing=4;
        var layRow1=layGrp.add("group");
        var oneLineRb=layRow1.add("radiobutton",undefined,"Single line");
        var twoLineRb=layRow1.add("radiobutton",undefined,"Two lines");
        if (getSetting("layoutLines","2")==="1") oneLineRb.value=true; else twoLineRb.value=true;
        layRow1.add("statictext",undefined,"Max chars/line:");
        var maxCharsInput=layRow1.add("edittext",undefined,getSetting("layoutMaxChars","42")); maxCharsInput.characters=5;
        var splitCk=layGrp.add("checkbox",undefined,"Split overlong cues into new cues (timing divided by length)");
        splitCk.value=(getSetting("layoutSplit","1")==="1");
        var layoutBtn=layGrp.add("button",undefined,"Apply Layout to All Cues");

        var fillRow=tSty.add("group");
        fillRow.add("statictext",undefined,"Fill:");
        var fillBtn=fillRow.add("button",undefined,"Pick");
        var fillLabel=fillRow.add("statictext",undefined,"255,255,255"); fillLabel.preferredSize.width=100;
        fillRow.add("statictext",undefined,"Stroke px:");
        var strokeInput=fillRow.add("edittext",undefined,"0"); strokeInput.characters=4;
        var strokeBtn=fillRow.add("button",undefined,"Color");
        var strokeLabel=fillRow.add("statictext",undefined,"0,0,0"); strokeLabel.preferredSize.width=70;

        var shGrp=tSty.add("panel",undefined,"Drop Shadow");
        shGrp.orientation="column"; shGrp.alignChildren=["fill","top"]; shGrp.margins=8; shGrp.spacing=4;
        var shRow0=shGrp.add("group");
        var shEnable=shRow0.add("checkbox",undefined,"Enable"); shEnable.value=true;
        shRow0.add("statictext",undefined,"Color:");
        var shColBtn=shRow0.add("button",undefined,"Pick");
        var shColLabel=shRow0.add("statictext",undefined,"0,0,0"); shColLabel.preferredSize.width=70;
        var shRow1=shGrp.add("group");
        shRow1.add("statictext",undefined,"Opac:");  var shOpac=shRow1.add("edittext",undefined,"70"); shOpac.characters=4;
        shRow1.add("statictext",undefined,"Dist:");  var shDist=shRow1.add("edittext",undefined,"6");  shDist.characters=4;
        shRow1.add("statictext",undefined,"Soft:");  var shSoft=shRow1.add("edittext",undefined,"8");  shSoft.characters=4;
        shRow1.add("statictext",undefined,"Angle:"); var shAng=shRow1.add("edittext",undefined,"135"); shAng.characters=4;

        var applyStyleBtn=tSty.add("button",undefined,"Apply Style + Font + Shadow to All");

        var diagRow=tSty.add("group");
        var diagBtn=diagRow.add("button",undefined,"Diagnose");
        var repairBtn=diagRow.add("button",undefined,"Repair Expressions");

        var prGrp=tSty.add("panel",undefined,"Presets");
        prGrp.orientation="row"; prGrp.margins=8; prGrp.spacing=4;
        var presetList=prGrp.add("dropdownlist",undefined,listPresets());
        presetList.preferredSize.width=160;
        if (presetList.items.length>0) presetList.selection=0;
        var loadPresetBtn=prGrp.add("button",undefined,"Load");
        var savePresetBtn=prGrp.add("button",undefined,"Save As...");
        var refreshPresetBtn=prGrp.add("button",undefined,"R");

        // ---------------- TAB: Animate ----------------
        var tAni = tabs.add("tab", undefined, "Animate");
        tAni.orientation="column"; tAni.alignChildren=["fill","top"]; tAni.spacing=6; tAni.margins=8;
        var animRow=tAni.add("group");
        animRow.add("statictext",undefined,"Preset:");
        var animList=animRow.add("dropdownlist",undefined,ANIM_PRESETS);
        animList.selection=0; animList.preferredSize.width=180;
        var applyAnimBtn=tAni.add("button",undefined,"Apply Animation to All Cues");
        tAni.add("statictext",undefined,"Per-cue overrides live in the Cues tab.");

        var ffxGrp=tAni.add("panel",undefined,"AE Text Animation Presets (.ffx)");
        ffxGrp.orientation="column"; ffxGrp.alignChildren=["fill","top"]; ffxGrp.margins=8; ffxGrp.spacing=4;
        var ffxData=scanFFXPresets();
        var ffxLabels=[]; for (var xi=0;xi<ffxData.length;xi++) ffxLabels.push(ffxData[xi].label);
        var ffxRow=ffxGrp.add("group");
        var ffxList=ffxRow.add("dropdownlist",undefined,ffxLabels);
        ffxList.preferredSize.width=240;
        if (ffxList.items.length>0) ffxList.selection=0;
        var ffxBrowseBtn=ffxRow.add("button",undefined,"Browse...");
        var ffxCustomPath="";
        var ffxWhereRow=ffxGrp.add("group");
        var ffxAtIn=ffxWhereRow.add("radiobutton",undefined,"Keyframes at cue In");
        var ffxAtPlay=ffxWhereRow.add("radiobutton",undefined,"At playhead (for Animate Out)");
        ffxAtIn.value=true;
        var ffxBtnRow=ffxGrp.add("group");
        var ffxAllBtn=ffxBtnRow.add("button",undefined,"Apply to All Cues");
        var ffxSelBtn=ffxBtnRow.add("button",undefined,"Apply to Selected Cue");
        var ffxFixRow=ffxGrp.add("group");
        var ffxRealignBtn=ffxFixRow.add("button",undefined,"Realign Animation to Cue In");
        ffxFixRow.add("statictext",undefined,"(start only)");
        var ffxFitRow=ffxGrp.add("group");
        ffxFitRow.add("statictext",undefined,"Anim length (s):");
        var ffxLenInput=ffxFitRow.add("edittext",undefined,getSetting("animFitLen","")); ffxLenInput.characters=6;
        var ffxFitAllBtn=ffxFitRow.add("button",undefined,"Fit All Cues");
        var ffxFitSelBtn=ffxFitRow.add("button",undefined,"Fit Selected");
        ffxFitRow.add("statictext",undefined,"(blank/0 = squeeze to cue)");
        ffxGrp.add("statictext",undefined,"Presets stack: run preset 'None' above to strip animators first.");

        // ---------------- TAB: Sync ----------------
        var tSyn = tabs.add("tab", undefined, "Sync");
        tSyn.orientation="column"; tSyn.alignChildren=["fill","top"]; tSyn.spacing=6; tSyn.margins=8;

        var ofsRow=tSyn.add("group");
        ofsRow.add("statictext",undefined,"Offset all (s):");
        var ofsInput=ofsRow.add("edittext",undefined,"0.5"); ofsInput.characters=6;
        var ofsPlus=ofsRow.add("button",undefined,"+"); var ofsMinus=ofsRow.add("button",undefined,"-");

        var strRow=tSyn.add("group");
        strRow.add("statictext",undefined,"Stretch factor:");
        var strInput=strRow.add("edittext",undefined,"1.0"); strInput.characters=6;
        var strBtn=strRow.add("button",undefined,"Apply");
        tSyn.add("statictext",undefined,"e.g. 25fps->23.976: factor 1.04271");

        var ripRow=tSyn.add("group");
        ripRow.add("statictext",undefined,"Ripple from cue #");
        var ripIdx=ripRow.add("edittext",undefined,"1"); ripIdx.characters=4;
        ripRow.add("statictext",undefined,"by (s):");
        var ripDelta=ripRow.add("edittext",undefined,"0.5"); ripDelta.characters=6;
        var ripBtn=ripRow.add("button",undefined,"Ripple");

        var mGrp=tSyn.add("panel",undefined,"Marker Retiming");
        mGrp.orientation="column"; mGrp.alignChildren=["fill","top"]; mGrp.margins=8; mGrp.spacing=4;
        var syncBtn=mGrp.add("button",undefined,"Apply Cue Markers -> Timing");
        var rebuildBtn=mGrp.add("button",undefined,"Rebuild Cue Markers from Timing");
        var mirrorBtn=mGrp.add("button",undefined,"Mirror Markers to Main Layer");
        var applyMainBtn=mGrp.add("button",undefined,"Apply Main-Layer Markers -> Cues");

        // ---------------- TAB: AI ----------------
        var tAI = tabs.add("tab", undefined, "AI");
        tAI.orientation="column"; tAI.alignChildren=["fill","top"]; tAI.spacing=6; tAI.margins=8;

        var wGrp=tAI.add("panel",undefined,"Transcribe (local whisper.cpp)");
        wGrp.orientation="column"; wGrp.alignChildren=["fill","top"]; wGrp.margins=8; wGrp.spacing=4;
        var weRow=wGrp.add("group"); weRow.add("statictext",undefined,"whisper-cli:");
        var whisperExe=weRow.add("edittext",undefined,getSetting("whisperExe","")); whisperExe.characters=26;
        var weBtn=weRow.add("button",undefined,"...");
        var wmRow=wGrp.add("group"); wmRow.add("statictext",undefined,"model:");
        var whisperModel=wmRow.add("edittext",undefined,getSetting("whisperModel","")); whisperModel.characters=28;
        var wmBtn=wmRow.add("button",undefined,"...");
        var wfRow=wGrp.add("group"); wfRow.add("statictext",undefined,"ffmpeg (opt):");
        var ffmpegPath=wfRow.add("edittext",undefined,getSetting("ffmpegPath","")); ffmpegPath.characters=24;
        var wfBtn=wfRow.add("button",undefined,"...");
        var wlRow=wGrp.add("group"); wlRow.add("statictext",undefined,"language:");
        var whisperLang=wlRow.add("edittext",undefined,getSetting("whisperLang","auto")); whisperLang.characters=6;
        wlRow.add("statictext",undefined,"Max segment chars:");
        var whisperMaxLen=wlRow.add("edittext",undefined,getSetting("whisperMaxLen","84")); whisperMaxLen.characters=5;
        wlRow.add("statictext",undefined,"(0 = whisper default)");
        var woRow=wGrp.add("group"); woRow.add("statictext",undefined,"Cue start offset (s):");
        var whisperOffset=woRow.add("edittext",undefined,getSetting("whisperOffset","0")); whisperOffset.characters=8;
        var woFromLayerBtn=woRow.add("button",undefined,"From selected layer");
        woRow.add("statictext",undefined,"(added to every cue)");
        var transcribeBtn=wGrp.add("button",undefined,"Transcribe Media File -> Import");

        var lGrp=tAI.add("panel",undefined,"Translate (local LLM)");
        lGrp.orientation="column"; lGrp.alignChildren=["fill","top"]; lGrp.margins=8; lGrp.spacing=4;
        var leRow=lGrp.add("group"); leRow.add("statictext",undefined,"endpoint:");
        var llmEndpoint=leRow.add("edittext",undefined,getSetting("llmEndpoint","http://127.0.0.1:8080/v1/chat/completions"));
        llmEndpoint.characters=32;
        var lkRow=lGrp.add("group"); lkRow.add("statictext",undefined,"API key (opt):");
        var llmKey=lkRow.add("edittext",undefined,""); llmKey.characters=24;
        var ltRow=lGrp.add("group"); ltRow.add("statictext",undefined,"Target language:");
        var llmLang=ltRow.add("edittext",undefined,getSetting("llmLang","Swahili")); llmLang.characters=14;
        ltRow.add("statictext",undefined,"batch:");
        var llmBatch=ltRow.add("edittext",undefined,getSetting("llmBatch","15")); llmBatch.characters=3;
        var translateBtn=lGrp.add("button",undefined,"Translate All Cues In Place");
        lGrp.add("statictext",undefined,"Tip: export SRT first as a backup of the original language.");


        // ---------------- TAB: About ----------------
        var tAbout = tabs.add("tab", undefined, "About");
        tAbout.orientation="column"; tAbout.alignChildren=["fill","top"]; tAbout.spacing=8; tAbout.margins=10;

        var BANNER = [
            " /$$$$$$$$ /$$                  /$$$$$$",
            "|__  $$__/| $$                 /$$__  $$",
            "   | $$   | $$$$$$$   /$$$$$$ | $$  \\ $$ /$$$$$$$   /$$$$$$",
            "   | $$   | $$__  $$ /$$__  $$| $$  | $$| $$__  $$ /$$__  $$",
            "   | $$   | $$  \\ $$| $$$$$$$$| $$  | $$| $$  \\ $$| $$$$$$$$",
            "   | $$   | $$  | $$| $$_____/| $$  | $$| $$  | $$| $$_____/",
            "   | $$   | $$  | $$|  $$$$$$$|  $$$$$$/| $$  | $$|  $$$$$$$",
            "   |__/   |__/  |__/ \\_______/ \\______/ |__/  |__/ \\_______/",
            "",
            " /$$   /$$",
            "| $$$ | $$",
            "| $$$$| $$ /$$   /$$  /$$$$$$   /$$$$$$   /$$$$$$",
            "| $$ $$ $$| $$  | $$ |____  $$ /$$__  $$ |____  $$",
            "| $$  $$$$| $$  | $$  /$$$$$$$| $$  \\ $$  /$$$$$$$",
            "| $$\\  $$$| $$  | $$ /$$__  $$| $$  | $$ /$$__  $$",
            "| $$ \\  $$|  $$$$$$$|  $$$$$$$|  $$$$$$$|  $$$$$$$",
            "|__/  \\__/ \\____  $$ \\_______/ \\____  $$ \\_______/",
            "           /$$  | $$           /$$  \\ $$",
            "          |  $$$$$$/          |  $$$$$$/",
            "           \\______/            \\______/"
        ];
        var asciiBox = tAbout.add("statictext", [0,0,360,270], BANNER.join("\n"), {multiline:true});
        try { asciiBox.graphics.font = ScriptUI.newFont("Courier New", ScriptUI.FontStyle.REGULAR, 9); }
        catch(eAF) { try { asciiBox.graphics.font = ScriptUI.newFont("Consolas", ScriptUI.FontStyle.REGULAR, 9); } catch(eAF2) {} }

        var aboutTitle = tAbout.add("statictext", undefined, "MAG Subtitler  v" + SCRIPT_VERSION);
        try { aboutTitle.graphics.font = ScriptUI.newFont("dialog", ScriptUI.FontStyle.BOLD, 15); } catch(eAT) {}
        tAbout.add("statictext", undefined, "After Effects subtitle toolkit");
        tAbout.add("statictext", undefined, "by Muriithi Nyaga / MAGIANT CORP");

        var repoPanel = tAbout.add("panel", undefined, "GitHub");
        repoPanel.orientation="column"; repoPanel.alignChildren=["fill","top"]; repoPanel.margins=8; repoPanel.spacing=4;
        var repoUrlBox = repoPanel.add("edittext", undefined, REPO_URL, {readonly:true});
        var repoOpenBtn = repoPanel.add("button", undefined, "Open Repo in Browser");
        repoOpenBtn.onClick = function(){
            try {
                if (File.fs === "Windows") system.callSystem('cmd.exe /c start "" "' + REPO_URL + '"');
                else system.callSystem('open "' + REPO_URL + '"');
            } catch(eOpen) { alert("Open this URL manually:\n" + REPO_URL); }
        };
        tAbout.add("statictext", undefined, "MIT License \u2014 free to use and modify.");

        var quotePanel = tAbout.add("panel", undefined, "Thought for the void");
        quotePanel.orientation="column"; quotePanel.alignChildren=["fill","top"]; quotePanel.margins=8; quotePanel.spacing=6;
        var QUOTES = [
            "Life is the only free trial that starts without your consent, runs on invisible terms, and ends with a mandatory data wipe you can't negotiate.",
            "We are all just temporary glitches in entropy's code, convinced our stack overflow errors are meaningful features.",
            "The universe doesn't test you. It simply forgets to turn off the simulation and lets you suffer the consequences.",
            "Life gives you just enough consciousness to notice how little control you have, then charges you rent for the awareness.",
            "Existence is nature's way of keeping matter busy until it can recycle it without guilt.",
            "You spend your life building a story worth telling, only to realize the audience left before the first act ended.",
            "The great cosmic joke isn't that life is short. It's that it's long enough to make you believe it might mean something.",
            "We are born screaming into a void that never answers, then spend decades pretending the echo was a conversation.",
            "Life doesn't come with a save button. It only has an autosave that overwrites everything you were trying to preserve.",
            "The only verifiable fact of existence is that it continues without you, and the silence afterward is the most honest review you'll ever receive."
        ];
        var quoteIdx = Math.floor(Math.random()*QUOTES.length);
        var quoteText = quotePanel.add("statictext", [0,0,330,110], QUOTES[quoteIdx], {multiline:true});
        try { quoteText.graphics.font = ScriptUI.newFont("dialog", ScriptUI.FontStyle.ITALIC, 11); } catch(eQF) {}
        var quoteBtn = quotePanel.add("button", undefined, "Next quote");
        quoteBtn.onClick = function(){ quoteIdx=(quoteIdx+1)%QUOTES.length; quoteText.text=QUOTES[quoteIdx]; };
        // auto-advance every 5s; cancel any prior task so reopening doesn't stack them
        try { if ($.global.__MAGSUB_QUOTE_TASK) app.cancelTask($.global.__MAGSUB_QUOTE_TASK); } catch(eQC) {}
        $.global.__MAGSUB_QUOTE_FN = function(){ try { quoteIdx=(quoteIdx+1)%QUOTES.length; quoteText.text=QUOTES[quoteIdx]; } catch(eQT) {} };
        $.global.__MAGSUB_QUOTE_TASK = app.scheduleTask("if($.global.__MAGSUB_QUOTE_FN)$.global.__MAGSUB_QUOTE_FN();", 5000, true);


        // ---------------- bottom utility row ----------------
        var utilGrp=win.add("group"); utilGrp.alignment=["fill","bottom"];
        var exportSrtBtn=utilGrp.add("button",undefined,"Export SRT");
        var exportVttBtn=utilGrp.add("button",undefined,"Export VTT");
        var removeBtn=utilGrp.add("button",undefined,"Remove All");

        // ============================ UI HELPERS ============================
        function flushPrefs() {
            // app.settings lives in AE's prefs file, which is normally written
            // only on clean exit - a crash/force-kill loses everything typed.
            // saveToDisk() flushes immediately.
            try { app.preferences.saveToDisk(); } catch (e) {}
        }
        function persistField(field, key) {
            field.onChange = function(){ setSetting(key, field.text); flushPrefs(); };
        }
        persistField(whisperExe,   "whisperExe");
        persistField(whisperModel, "whisperModel");
        persistField(ffmpegPath,   "ffmpegPath");
        persistField(whisperLang,  "whisperLang");
        persistField(whisperMaxLen,"whisperMaxLen");
        persistField(whisperOffset,"whisperOffset");
        persistField(llmEndpoint,  "llmEndpoint");
        persistField(llmLang,      "llmLang");
        persistField(llmBatch,     "llmBatch");
        // llmKey is deliberately NOT persisted: no credentials in plaintext prefs.
        function uiFontPS() {
            if (!fontList.selection) return null;
            return fontData[fontList.selection.index] ? fontData[fontList.selection.index].ps : null;
        }
        function uiY() {
            var v=trim(yInput.text);
            if (v==="") { var c=findMainComp(); return c?c.height*0.85:900; }
            return toNum(v,900);
        }
        function uiAnim() { return animList.selection?animList.selection.text:"None"; }
        function txtOpts() { return { startAt:toNum(txtStart.text,0), durEach:toNum(txtDur.text,3), gap:toNum(txtGap.text,0.2) }; }
        function pickColor() {
            var hex=$.colorPicker(); if (hex===-1) return null;
            return [((hex>>16)&0xFF)/255,((hex>>8)&0xFF)/255,(hex&0xFF)/255];
        }
        function rgbLabel(c){return Math.round(c[0]*255)+","+Math.round(c[1]*255)+","+Math.round(c[2]*255);}
        function applyAllStyle() {
            pushStyleToController(toNum(sizeInput.text,64),fillColor,toNum(strokeInput.text,0),strokeColor,uiY(),
                toNum(trackInput.text,0), toNum(leadInput.text,0));
            applyShadowToController(shEnable.value,shadowColor,toNum(shOpac.text,70),toNum(shDist.text,6),toNum(shSoft.text,8),toNum(shAng.text,135));
            applyFontToCues(uiFontPS());
            // persist prefs for next session
            setSetting("fontSize", sizeInput.text);
            setSetting("strokeWidth", strokeInput.text);
            setSetting("fillColor", colToSetting(fillColor));
            setSetting("strokeColor", colToSetting(strokeColor));
            setSetting("shadowColor", colToSetting(shadowColor));
            setSetting("shOpac", shOpac.text); setSetting("shDist", shDist.text);
            setSetting("shSoft", shSoft.text); setSetting("shAng", shAng.text);
            setSetting("shEnable", shEnable.value ? "1" : "0");
            setSetting("animPreset", uiAnim());
            setSetting("tracking", trackInput.text);
            setSetting("leading", leadInput.text);
            var fps=uiFontPS(); if (fps) setSetting("fontPS", fps);
            flushPrefs();
        }

        var cueLayersCache=[];
        function refreshCueList() {
            cueList.removeAll(); cueLayersCache=[];
            var subComp=findSubComp(); if (!subComp) return;
            var cues=getCuesSorted(subComp);
            for (var i=0;i<cues.length;i++) {
                var L=cues[i];
                var it=cueList.add("item", String(cueIndexOf(L)));
                it.subItems[0].text=fmtShort(L.inPoint);
                it.subItems[1].text=fmtShort(L.outPoint);
                it.subItems[2].text=getCueText(L).replace(/\n/g," | ").substr(0,60);
                cueLayersCache.push(L);
            }
        }
        function selectedCue() {
            if (!cueList.selection) { alert("Select a cue in the list first."); return null; }
            var L=cueLayersCache[cueList.selection.index];
            if (!L) { alert("Cue not found; refresh the list."); return null; }
            try { var nm=L.name; } catch (e) { alert("Cue layer was deleted; refresh the list."); return null; }
            return L;
        }

        // ============================ HANDLERS ============================
        loadBtn.onClick=function(){
            var f=File.openDialog("Select subtitle file","Subtitles:*.srt;*.vtt;*.ass;*.ssa;*.txt;*.csv;*.tsv,All:*.*");
            if (!f) return;
            f.encoding="UTF-8"; if (!f.open("r")) { alert("Could not open file."); return; }
            loadedContent=f.read(); f.close(); loadedName=decodeURI(f.displayName);
            loadedTxt.text=loadedName;
        };
        importBtn.onClick=function(){
            if (!loadedContent) { alert("Load a subtitle file first."); return; }
            var subs=parseAny(loadedContent, loadedName, txtOpts());
            var n=importParsed(subs, uiFontPS(), uiAnim(), replaceRb.value);
            if (n>0) { applyAllStyle(); refreshCueList(); alert("Imported "+n+" cue(s)."); }
        };

        refreshCuesBtn.onClick=refreshCueList;
        fixOvBtn.onClick=function(){
            var sc=findSubComp(); if (!sc) { alert("Import first."); return; }
            app.beginUndoGroup("MAG: Fix Overlaps");
            try { var n=fixAllOverlaps(sc); } finally { app.endUndoGroup(); }
            refreshCueList();
            alert(n+" overlapping cue(s) trimmed.");
        };
        cueList.onChange=function(){
            if (!cueList.selection) return;
            var L=cueLayersCache[cueList.selection.index]; if (!L) return;
            try {
                edIn.text=L.inPoint.toFixed(3); edOut.text=L.outPoint.toFixed(3);
                edText.text=getCueText(L);
            } catch (e) { refreshCueList(); }
        };
        updateCueBtn.onClick=function(){
            var L=selectedCue(); if (!L) return;
            var mainComp=findMainComp();
            app.beginUndoGroup("MAG: Update Cue");
            try {
                var ni=toNum(edIn.text,L.inPoint), no=toNum(edOut.text,L.outPoint);
                if (no<=ni) no=ni+0.1;
                L.inPoint=ni; L.outPoint=no;
                setCueText(L, edText.text, mainComp?mainComp.name:null);
                setCueMarker(L);
                var sc=findSubComp();
                if (sc) { var k=resolveOverlapsAround(L, sc); if (k>0) renumberCues(sc); }
            } finally { app.endUndoGroup(); }
            refreshCueList();
        };
        jumpBtn.onClick=function(){
            var L=selectedCue(); if (!L) return;
            var mainComp=findMainComp(), subComp=findSubComp();
            var a=app.project.activeItem;
            if (a===subComp) subComp.time=L.inPoint;
            else if (a===mainComp) {
                var sl=findSubLayerInMain(mainComp,subComp);
                mainComp.time=L.inPoint+(sl?sl.startTime:0);
            } else if (subComp) { subComp.openInViewer(); subComp.time=L.inPoint; }
        };
        snapBtn.onClick=function(){
            var L=selectedCue(); if (!L) return;
            snapCueToPlayhead(L);
            var sc=findSubComp();
            if (sc) { var k=resolveOverlapsAround(L, sc); if (k>0) renumberCues(sc); }
            refreshCueList();
        };
        endAtBtn.onClick=function(){
            var L=selectedCue(); if (!L) { alert("Select a cue first."); return; }
            if (!extendCueToPlayhead(L)) return;
            var sc=findSubComp();
            if (sc) { var k=resolveOverlapsAround(L, sc); if (k>0) renumberCues(sc); }
            refreshCueList();
        };
        addCueBtn.onClick=function(){
            var mainComp=findMainComp(), subComp=findSubComp();
            if (!subComp||!mainComp) { alert("Import (or create) the subtitle system first."); return; }
            var sl=findSubLayerInMain(mainComp,subComp);
            var a=app.project.activeItem;
            var t=(a===subComp)?subComp.time:((a===mainComp)?(mainComp.time-(sl?sl.startTime:0)):0);
            setJSEngine();
            app.beginUndoGroup("MAG: Add Cue");
            try {
                var idx=maxCueIndex(subComp)+1;
                var L=createCueLayer(subComp, idx, Math.max(0,t), Math.max(0,t)+3, "New subtitle", uiFontPS(), mainComp.name);
                applyAnimation(L, uiAnim(), mainComp.name);
                renumberCues(subComp);
            } finally { app.endUndoGroup(); }
            refreshCueList();
        };
        delCueBtn.onClick=function(){
            var L=selectedCue(); if (!L) return;
            app.beginUndoGroup("MAG: Delete Cue");
            try { L.remove(); renumberCues(findSubComp()); } finally { app.endUndoGroup(); }
            refreshCueList();
        };
        splitCueBtn.onClick=function(){
            var L=selectedCue(); if (!L) { alert("Select a cue to split."); return; }
            var mainComp=findMainComp(), subComp=findSubComp();
            if (!mainComp||!subComp) return;
            var sl=findSubLayerInMain(mainComp,subComp);
            var a=app.project.activeItem;
            // split point: playhead if it falls inside the cue, else the midpoint
            var ph=(a===subComp)?subComp.time:((a===mainComp)?(mainComp.time-(sl?sl.startTime:0)):-1);
            var t0=L.inPoint, t1=L.outPoint;
            var t=(ph>t0+0.05 && ph<t1-0.05)?ph:(t0+t1)/2;
            var txt=flatCueText(L);
            // pick the word boundary nearest the time proportion
            var p=(t-t0)/(t1-t0), target=Math.round(p*txt.length), cut=-1, best=1e9;
            for (var ci=0; ci<txt.length; ci++) {
                if (txt.charAt(ci)===" " && Math.abs(ci-target)<best) { best=Math.abs(ci-target); cut=ci; }
            }
            if (cut<0) { alert("Single word - nothing to split."); return; }
            var txtA=trim(txt.substr(0,cut)), txtB=trim(txt.substr(cut+1));
            if (txtA===""||txtB==="") { alert("Split point leaves an empty cue - move the playhead."); return; }
            setJSEngine();
            app.beginUndoGroup("MAG: Split Cue");
            try {
                var dup=L.duplicate();
                L.outPoint=t; dup.inPoint=t; dup.outPoint=t1;
                setCueText(L, txtA, mainComp.name);
                setCueText(dup, txtB, mainComp.name);
                applyAnimation(L, uiAnim(), mainComp.name);      // re-seat fades on new bounds
                applyAnimation(dup, uiAnim(), mainComp.name);
                renumberCues(subComp);
            } finally { app.endUndoGroup(); }
            refreshCueList();
        };
        mergeCueBtn.onClick=function(){
            var L=selectedCue(); if (!L) { alert("Select a cue to merge."); return; }
            var mainComp=findMainComp(), subComp=findSubComp();
            if (!mainComp||!subComp) return;
            var arr=getCuesByTime(subComp), N=null;
            for (var i=0;i<arr.length;i++) if (arr[i]===L) { N=(i+1<arr.length)?arr[i+1]:null; break; }
            if (!N) { alert("No following cue to merge with."); return; }
            setJSEngine();
            app.beginUndoGroup("MAG: Merge Cues");
            try {
                var merged=flatCueText(L)+" "+flatCueText(N);
                L.outPoint=N.outPoint;
                setCueText(L, merged, mainComp.name);
                N.remove();
                applyAnimation(L, uiAnim(), mainComp.name);
                renumberCues(subComp);
            } finally { app.endUndoGroup(); }
            refreshCueList();
        };
        cueAnimBtn.onClick=function(){
            var L=selectedCue(); if (!L) return;
            applyAnimationToCue(L, cueAnimList.selection?cueAnimList.selection.text:"None");
        };
        bakeBtn.onClick=function(){ var L=selectedCue(); if (L) bakeCueStyle(L); };
        relinkBtn.onClick=function(){ var L=selectedCue(); if (L) relinkCueStyle(L); };

        refreshFontsBtn.onClick=function(){
            fontData=getInstalledFonts(); fontList.removeAll();
            for (var i=0;i<fontData.length;i++) fontList.add("item",fontData[i].label);
            if (fontData.length) fontList.selection=0;
        };
        fillBtn.onClick=function(){var c=pickColor(); if(c){fillColor=c;fillLabel.text=rgbLabel(c);}};
        strokeBtn.onClick=function(){var c=pickColor(); if(c){strokeColor=c;strokeLabel.text=rgbLabel(c);}};
        shColBtn.onClick=function(){var c=pickColor(); if(c){shadowColor=c;shColLabel.text=rgbLabel(c);}};
        applyStyleBtn.onClick=applyAllStyle;

        loadPresetBtn.onClick=function(){
            if (!presetList.selection) { alert("No preset selected."); return; }
            var p=loadPreset(presetList.selection.text);
            applyPreset(p);
        };
        savePresetBtn.onClick=function(){
            var name=prompt("Preset name:","MyStyle");
            if (!name) return;
            savePreset(name, uiFontPS(), uiAnim());
            presetList.removeAll();
            var names=listPresets();
            for (var i=0;i<names.length;i++) presetList.add("item",names[i]);
            if (presetList.items.length>0) presetList.selection=0;
        };
        refreshPresetBtn.onClick=function(){
            presetList.removeAll();
            var names=listPresets();
            for (var i=0;i<names.length;i++) presetList.add("item",names[i]);
            if (presetList.items.length>0) presetList.selection=0;
        };

        applyAnimBtn.onClick=function(){ applyAnimationToAll(uiAnim()); };
        diagBtn.onClick=diagnose;
        repairBtn.onClick=repairExpressions;

        layoutBtn.onClick=function(){
            var ml = oneLineRb.value ? 1 : 2;
            var mc = Math.max(8, Math.round(toNum(maxCharsInput.text,42)));
            var msg = "Re-wrap ALL cues to max "+mc+" chars x "+ml+" line(s)?";
            if (splitCk.value) msg += "\nOverlong cues will be SPLIT into extra cues (timing divided proportionally).";
            else msg += "\nOverlong text will be crammed into the last allowed line.";
            msg += "\nNote: per-cue animation overrides reset to the current Animate preset.";
            if (!confirm(msg)) return;
            setSetting("layoutMaxChars",String(mc));
            setSetting("layoutLines",String(ml));
            setSetting("layoutSplit",splitCk.value?"1":"0");
            var n = reflowAllCues(mc, ml, splitCk.value, uiFontPS(), uiAnim());
            if (n > 0) { applyAllStyle(); refreshCueList(); alert("Layout applied: "+n+" cue(s) after reflow."); }
        };

        function currentFFXPath() {
            if (ffxCustomPath !== "") return ffxCustomPath;
            if (!ffxList.selection) { alert("No .ffx preset selected. Pick one or Browse."); return null; }
            return ffxData[ffxList.selection.index] ? ffxData[ffxList.selection.index].path : null;
        }
        ffxBrowseBtn.onClick=function(){
            var f=File.openDialog("Select an .ffx text animation preset","FFX:*.ffx");
            if (!f) return;
            ffxCustomPath=f.fsName;
            ffxList.selection=null;
            alert("Custom preset armed:\n"+decodeURI(f.displayName)+"\n(Selecting from the dropdown clears it.)");
        };
        ffxList.onChange=function(){ ffxCustomPath=""; };
        ffxAllBtn.onClick=function(){ var p=currentFFXPath(); if (p) applyFFXToAll(p); };
        ffxRealignBtn.onClick=function(){ var n=realignAllAnimation(); refreshCueList(); alert(n>0?("Realigned "+n+" cue(s) to their In points."):"Nothing to realign - animation starts are already at the cue In (this is expected for presets applied in v3.7+). To shorten animations that outlast a cue, use Fit."); };
        ffxFitAllBtn.onClick=function(){
            var L0=toNum(ffxLenInput.text,0); setSetting("animFitLen",ffxLenInput.text); flushPrefs();
            var n=fitAnimToCues(L0); refreshCueList();
            alert("Fit animation on "+n+" cue(s)"+(L0>0?(" to "+L0+"s (capped at each cue's length)."):" - squeezed any that overran their cue."));
        };
        ffxFitSelBtn.onClick=function(){
            var L=selectedCue(); if(!L){ alert("Select a cue on the Cues tab first."); return; }
            var L0=toNum(ffxLenInput.text,0); setSetting("animFitLen",ffxLenInput.text); flushPrefs();
            app.beginUndoGroup("MAG: Fit Animation (selected)");
            try { fitCueAnim(L, L0); } finally { app.endUndoGroup(); }
            refreshCueList(); alert("Fit animation on the selected cue.");
        };
        ffxSelBtn.onClick=function(){
            var L=selectedCue(); if (!L) return;
            var p=currentFFXPath(); if (!p) return;
            app.beginUndoGroup("MAG: FFX on Cue");
            try { applyFFXToCue(L, p, ffxAtPlay.value); } finally { app.endUndoGroup(); }
        };

        ofsPlus.onClick =function(){ offsetAll( Math.abs(toNum(ofsInput.text,0))); refreshCueList(); };
        ofsMinus.onClick=function(){ offsetAll(-Math.abs(toNum(ofsInput.text,0))); refreshCueList(); };
        strBtn.onClick  =function(){ stretchAll(toNum(strInput.text,1)); refreshCueList(); };
        ripBtn.onClick  =function(){ rippleFrom(Math.round(toNum(ripIdx.text,1)), toNum(ripDelta.text,0)); refreshCueList(); };
        syncBtn.onClick=function(){ syncTimingFromCueMarkers(); refreshCueList(); };
        rebuildBtn.onClick=rebuildCueMarkers;
        mirrorBtn.onClick=mirrorMarkersToMain;
        applyMainBtn.onClick=function(){ applyMainMarkersToCues(); refreshCueList(); };

        weBtn.onClick=function(){ var f=File.openDialog("Locate whisper-cli executable"); if (f) { whisperExe.text=f.fsName; setSetting("whisperExe",f.fsName); flushPrefs(); } };
        wmBtn.onClick=function(){ var f=File.openDialog("Locate whisper ggml model (.bin)"); if (f) { whisperModel.text=f.fsName; setSetting("whisperModel",f.fsName); flushPrefs(); } };
        wfBtn.onClick=function(){ var f=File.openDialog("Locate ffmpeg executable"); if (f) { ffmpegPath.text=f.fsName; setSetting("ffmpegPath",f.fsName); flushPrefs(); } };
        woFromLayerBtn.onClick=function(){
            var a=app.project.activeItem;
            if (!a || !(a instanceof CompItem) || !a.selectedLayers || a.selectedLayers.length===0) {
                alert("Select the audio/video layer in your comp first, then click this.\nIt reads where that layer starts on the timeline and uses it as the offset."); return;
            }
            var L=a.selectedLayers[0];
            var off=(L.inPoint!=null)?L.inPoint:L.startTime;
            whisperOffset.text=String(Math.round(off*1000)/1000);
            setSetting("whisperOffset",whisperOffset.text); flushPrefs();
        };

        transcribeBtn.onClick=function(){
            if (trim(whisperExe.text)===""||trim(whisperModel.text)==="") { alert("Set whisper-cli and model paths first."); return; }
            var media=File.openDialog("Select audio/video file to transcribe");
            if (!media) return;
            setSetting("whisperExe",whisperExe.text); setSetting("whisperModel",whisperModel.text);
            setSetting("ffmpegPath",ffmpegPath.text); setSetting("whisperLang",whisperLang.text);
            setSetting("whisperMaxLen",whisperMaxLen.text);
            setSetting("whisperOffset",whisperOffset.text);
            flushPrefs();
            transcribeBtn.enabled=false;
            var offNow=toNum(whisperOffset.text,0);
            startTranscribeAsync({
                media: media.fsName, whisperExe: whisperExe.text, modelPath: whisperModel.text,
                ffmpegPath: ffmpegPath.text, language: whisperLang.text, maxLen: whisperMaxLen.text
            }, function(content, srtPath){
                transcribeBtn.enabled=true;
                var subs=shiftSubs(parseSRT(content), offNow);
                var n=importParsed(subs, uiFontPS(), uiAnim(), replaceRb.value);
                if (n>0) {
                    var sc=findSubComp(), fixed=sc?fixAllOverlaps(sc):0;
                    applyAllStyle(); refreshCueList();
                    alert("Transcribed and imported "+n+" cue(s)."+(fixed>0?"\n("+fixed+" whisper segment overlap(s) auto-trimmed.)":"")+"\n\nSRT saved to:\n"+srtPath);
                } else {
                    alert("Transcription finished but no cues were imported.\nSRT saved to:\n"+srtPath);
                }
            });
            transcribeBtn.enabled=true; // panel stays usable; progress palette owns the run
        };

        translateBtn.onClick=function(){
            if (!confirm("Translate ALL cues in place to '"+llmLang.text+"'?\nExport an SRT backup first if you need the original.")) return;
            setSetting("llmEndpoint",llmEndpoint.text); setSetting("llmLang",llmLang.text);
            translateBtn.text="Translating... (AE will freeze per batch)";
            win.update();
            translateAllCues(trim(llmEndpoint.text), llmKey.text, trim(llmLang.text),
                Math.round(toNum(llmBatch.text,15)), null);
            translateBtn.text="Translate All Cues In Place";
            refreshCueList();
        };

        exportSrtBtn.onClick=function(){ exportSubs("srt"); };
        exportVttBtn.onClick=function(){ exportSubs("vtt"); };
        removeBtn.onClick=function(){ removeAll(); refreshCueList(); };

        // ---- restore persisted UI prefs ----
        fillLabel.text=rgbLabel(fillColor);
        strokeLabel.text=rgbLabel(strokeColor);
        shColLabel.text=rgbLabel(shadowColor);
        strokeInput.text=getSetting("strokeWidth","0");
        shOpac.text=getSetting("shOpac","70"); shDist.text=getSetting("shDist","6");
        shSoft.text=getSetting("shSoft","8");  shAng.text=getSetting("shAng","135");
        shEnable.value=(getSetting("shEnable","1")==="1");
        var savedAnim=getSetting("animPreset","None");
        for (var ai=0;ai<animList.items.length;ai++)
            if (animList.items[ai].text===savedAnim) { animList.selection=ai; break; }
        var savedFont=getSetting("fontPS","");
        if (savedFont!=="")
            for (var sfi=0;sfi<fontData.length;sfi++)
                if (fontData[sfi].ps===savedFont) { fontList.selection=sfi; break; }

        win.layout.layout(true); win.layout.resize();
        win.onResizing=win.onResize=function(){ this.layout.resize(); };
        if (win instanceof Window) { win.center(); win.show(); }
        refreshCueList();
        return win;
    }

    buildUI(thisObj);

})(this);
