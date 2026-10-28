#!/usr/bin/env bash
# test-localmodels.sh -- the suggested local models: TTS fallback chain, STT chain, voice/setup.sh flags, diarize wrapper.
# Fake binaries on PATH and a throwaway HOME/XDG; no model is downloaded, installed or run, nothing touches the network.
set -uo pipefail
export PYTHONPATH= PYTHONDONTWRITEBYTECODE=1
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
REALHOME="$HOME"; export HOME="$SB/home"; mkdir -p "$HOME"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share"
unset TALOS_TTS TALOS_TTS_ENGINE TALOS_STT TALOS_FORCE_ARCH HF_HOME
A="$SB/agent"; mkdir -p "$A/scripts/voice" "$A/scripts/stt-diarize"
cp "$KIT"/scripts/tts.sh "$KIT"/scripts/stt.sh "$A/scripts/"
cp "$KIT"/scripts/voice/* "$A/scripts/voice/"; cp "$KIT"/scripts/stt-diarize/* "$A/scripts/stt-diarize/"
cp -R "$KIT"/scripts/memory "$A/scripts/memory"
LOG="$SB/calls.log"; : > "$LOG"
FB="$SB/fakebin"; mkdir -p "$FB"
cat > "$FB/say" <<FAKE
#!/bin/bash
out=""; while [ \$# -gt 0 ]; do case "\$1" in -o) out="\$2"; shift 2 ;; -v) shift 2 ;; --) shift; txt="\$*"; break ;; *) txt="\$1"; shift ;; esac; done
echo "say: \$txt" >> "$LOG"; [ -n "\$out" ] && printf 'AIFFDATA' > "\$out"
FAKE
cat > "$FB/afplay" <<FAKE
#!/bin/bash
echo "afplay: \$1" >> "$LOG"
FAKE
cat > "$FB/ffmpeg" <<FAKE
#!/bin/bash
echo "ffmpeg: \$*" >> "$LOG"; printf 'CONVERTED' > "\${@: -1}"
FAKE
cat > "$FB/whisper-cli" <<FAKE
#!/bin/bash
echo "whisper: \$*" >> "$LOG"; echo "   whisper words"
FAKE
chmod +x "$FB"/*
# PATH without real say/whisper: keep only the system basics; our fakes first
export PATH="$FB:/usr/bin:/bin"
rm -f "$FB/uname"
D="$XDG_DATA_HOME/talos"; VD="$XDG_CONFIG_HOME/talos/voice"

T() { ( cd "$A" && bash scripts/tts.sh "$@" 2>&1 ); }
mk_qwen() { # fake venv-qwen python: handles -c and the qwen_tts.py call
  mkdir -p "$D/venv-qwen/bin"
  cat > "$D/venv-qwen/bin/python" <<FAKE
#!/bin/bash
if [ "\$1" = "-c" ]; then exit 0; fi
echo "qwen: \$*" >> "$LOG"; [ "\${QFAIL:-0}" = 1 ] && { echo "boom" >&2; exit 1; }
printf 'QWAV' > "\$2"
FAKE
  chmod +x "$D/venv-qwen/bin/python"
}
mk_kokoro() {
  mkdir -p "$D/venv/bin" "$D/models/kokoro"; : > "$D/models/kokoro/kokoro-v1.0.onnx"; : > "$D/models/kokoro/voices-v1.0.bin"
  cat > "$D/venv/bin/python" <<FAKE
#!/bin/bash
if [ "\$1" = "-c" ]; then exit 0; fi
echo "kokoro: \$*" >> "$LOG"; printf 'KWAV' > "\$2"
FAKE
  chmod +x "$D/venv/bin/python"
}
mk_ref() { mkdir -p "$VD"; printf 'RIFFfake' > "$VD/ref.wav"; printf 'fake words' > "$VD/ref.txt"; }
used() { grep -c "^$1:" "$LOG"; }

# ---------------- TTS chain
: > "$LOG"; out="$(T file "$SB/a.wav" "plain")"
{ [ "$(used say)" = 1 ] && [ "$(used qwen)" = 0 ] && [ "$(used kokoro)" = 0 ] && [ -z "$(printf '%s' "$out" | grep -i qwen)" ]; } && ok "tts: nothing installed -> say, and no noise about Qwen" || no "nothing-installed chain wrong" "$out"
mk_qwen; : > "$LOG"; out="$(T file "$SB/b.wav" "no clip")"
{ [ "$(used qwen)" = 0 ] && [ "$(used say)" = 1 ] && printf '%s' "$out" | grep -q 'no reference voice is set' && printf '%s' "$out" | grep -q 'skipping'; } && ok "tts: Qwen installed but no reference clip -> skipped with a one-line note, falls to say" || no "no-clip skip wrong" "$out"
mk_ref; : > "$LOG"; out="$(T file "$SB/c.wav" "with clip")"
{ [ "$(used qwen)" = 1 ] && [ "$(used say)" = 0 ] && grep -q 'qwen:.*qwen_tts.py .*with clip .*ref.wav .*ref.txt' "$LOG" && [ -s "$SB/c.wav" ]; } && ok "tts: Qwen + clip -> Qwen is preferred and gets the clip and transcript paths" || no "qwen not preferred" "$(cat "$LOG")"
mk_kokoro; : > "$LOG"; T file "$SB/d.wav" "both" >/dev/null
{ [ "$(used qwen)" = 1 ] && [ "$(used kokoro)" = 0 ]; } && ok "tts: with Qwen and Kokoro both ready, Qwen goes first" || no "order wrong" "$(cat "$LOG")"
: > "$LOG"; out="$(QFAIL=1 T file "$SB/e.wav" "qfail")"
{ [ "$(used kokoro)" = 1 ] && [ "$(used say)" = 0 ] && printf '%s' "$out" | grep -q 'Qwen3-TTS failed'; } && ok "tts: a failing Qwen falls through to Kokoro with a note" || no "qwen failure not handled" "$out"
rm -f "$VD/ref.wav"; : > "$LOG"; T file "$SB/f.wav" "kokoro next" >/dev/null 2>&1
{ [ "$(used qwen)" = 0 ] && [ "$(used kokoro)" = 1 ]; } && ok "tts: Qwen skipped (clip gone) -> Kokoro" || no "kokoro not next" "$(cat "$LOG")"
printf 'RIFFfake' > "$VD/ref.wav"; rm -rf "$D/venv"; : > "$LOG"; QFAIL=1 T file "$SB/g.wav" "say last" >/dev/null 2>&1
{ [ "$(used say)" = 1 ] && [ "$(used kokoro)" = 0 ]; } && ok "tts: Qwen failing and Kokoro absent -> say is the last resort" || no "say not last" "$(cat "$LOG")"
mk_kokoro; : > "$LOG"; TALOS_TTS=say T file "$SB/h.wav" "forced say" >/dev/null
{ [ "$(used say)" = 1 ] && [ "$(used qwen)" = 0 ] && [ "$(used kokoro)" = 0 ]; } && ok "tts: TALOS_TTS=say forces say" || no "force say failed" "$(cat "$LOG")"
: > "$LOG"; TALOS_TTS=kokoro T file "$SB/i.wav" "forced kokoro" >/dev/null
{ [ "$(used kokoro)" = 1 ] && [ "$(used qwen)" = 0 ] && [ "$(used say)" = 0 ]; } && ok "tts: TALOS_TTS=kokoro forces Kokoro even when Qwen is ready" || no "force kokoro failed" "$(cat "$LOG")"
: > "$LOG"; TALOS_TTS=qwen T file "$SB/j.wav" "forced qwen" >/dev/null
{ [ "$(used qwen)" = 1 ] && [ "$(used kokoro)" = 0 ]; } && ok "tts: TALOS_TTS=qwen forces Qwen" || no "force qwen failed" "$(cat "$LOG")"
out="$(QFAIL=1 TALOS_TTS=qwen T file "$SB/k.wav" "x")"; rc=$?
out="$(TALOS_TTS_ENGINE=say T file "$SB/l.wav" "legacy")"; [ -s "$SB/l.wav" ] && ok "tts: the older TALOS_TTS_ENGINE variable still works" || no "legacy var broke" "$out"
out="$(TALOS_TTS=bogus T file "$SB/m.wav" "x")"; [ "$?" = 2 ] && ok "tts: an unknown TALOS_TTS value is refused (exit 2)" || no "bogus engine accepted" "$out"
rm -rf "$D" "$VD"; out="$(TALOS_TTS=qwen T file "$SB/n.wav" "x")"; [ "$?" != 0 ] && printf '%s' "$out" | grep -q 'voice/setup.sh --qwen' && ok "tts: forcing Qwen when nothing is installed names the install command" || no "forced qwen hint missing" "$out"

# ---------------- STT chain
printf 'fakeaudio' > "$SB/note.ogg"; S() { ( cd "$A" && bash scripts/stt.sh "$@" 2>&1 ); }
mk_pk() { # fake venv-stt python
  mkdir -p "$D/venv-stt/bin"
  cat > "$D/venv-stt/bin/python" <<FAKE
#!/bin/bash
if [ "\$1" = "-c" ]; then exit 0; fi
echo "parakeet: \$*" >> "$LOG"; [ "\${PFAIL:-0}" = 1 ] && { echo "pk boom" >&2; exit 1; }
echo "parakeet words"
FAKE
  chmod +x "$D/venv-stt/bin/python"
}
mv "$FB/whisper-cli" "$SB/whisper-cli.off"
out="$(S "$SB/note.ogg")"; rc=$?
{ [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'no speech-to-text engine installed' && printf '%s' "$out" | grep -q 'voice/setup.sh --parakeet' && printf '%s' "$out" | grep -q 'whisper-cpp'; } && ok "stt: nothing installed -> one clear message naming both options" || no "nothing-installed message wrong (rc=$rc)" "$out"
mk_pk; : > "$LOG"; out="$(S "$SB/note.ogg")"
{ [ "$out" = "parakeet words" ] && grep -q '^parakeet:.*parakeet_run.py .*--text' "$LOG"; } && ok "stt: Parakeet alone works and prints its transcript" || no "parakeet alone wrong" "$out"
mv "$SB/whisper-cli.off" "$FB/whisper-cli"; mkdir -p "$D/models"; printf m > "$D/models/ggml-base.en.bin"
: > "$LOG"; out="$(S "$SB/note.ogg")"
{ [ "$out" = "parakeet words" ] && ! grep -q '^whisper:' "$LOG"; } && ok "stt: Parakeet is preferred over whisper.cpp" || no "parakeet not preferred" "$out"
: > "$LOG"; out="$(PFAIL=1 S "$SB/note.ogg")"
{ printf '%s' "$out" | grep -q 'trying whisper.cpp' && printf '%s' "$out" | grep -q 'whisper words'; } && ok "stt: Parakeet failing falls back to whisper.cpp with a note" || no "fallback wrong" "$out"
: > "$LOG"; out="$(TALOS_STT=whisper S "$SB/note.ogg")"; { [ "$out" = "whisper words" ] && ! grep -q '^parakeet:' "$LOG"; } && ok "stt: TALOS_STT=whisper forces whisper.cpp" || no "force whisper failed" "$out"
out="$(PFAIL=1 TALOS_STT=parakeet S "$SB/note.ogg")"; [ "$?" != 0 ] && printf '%s' "$out" | grep -q 'Parakeet failed' && ok "stt: forced Parakeet that fails is an error" || no "forced parakeet failure swallowed" "$out"
rm -rf "$D/venv-stt"; out="$(TALOS_STT=parakeet S "$SB/note.ogg")"; [ "$?" != 0 ] && printf '%s' "$out" | grep -q 'setup.sh --parakeet' && ok "stt: forcing Parakeet when it is not installed names the install command" || no "forced parakeet hint missing" "$out"
out="$(TALOS_STT=nope S "$SB/note.ogg")"; [ "$?" = 2 ] && ok "stt: an unknown TALOS_STT value is refused (exit 2)" || no "bogus stt engine accepted" "$out"

# ---------------- voice/setup.sh flags
V() { ( cd "$A" && bash scripts/voice/setup.sh "$@" 2>&1 ); }
rm -rf "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"
for flag in qwen parakeet diarize; do
  out="$(V --$flag --dry-run)"; rc=$?
  r_ok=0; printf '%s' "$out" | grep -q 'Reminder' && printf '%s' "$out" | grep -q 'disk:' && printf '%s' "$out" | grep -q 'licence:' && r_ok=1
  first_reminder=$(printf '%s\n' "$out" | grep -n 'Reminder' | head -1 | cut -d: -f1); first_plan=$(printf '%s\n' "$out" | grep -n '^== [^R]' | head -1 | cut -d: -f1)
  { [ "$rc" = 0 ] && [ "$r_ok" = 1 ] && [ "$first_reminder" -lt "$first_plan" ] && printf '%s' "$out" | grep -q 'Dry run: nothing was changed' && [ ! -e "$XDG_DATA_HOME" ] && [ ! -e "$XDG_CONFIG_HOME" ]; } && ok "setup --$flag --dry-run: disk/RAM/licence reminders come before the plan, nothing is created" || no "--$flag dry-run wrong (rc=$rc)" "$out"
done
out="$(V --qwen --dry-run)"; printf '%s' "$out" | grep -q 'YOU supply the reference clip' && printf '%s' "$out" | grep -q 'no voice files and no reference audio' && printf '%s' "$out" | grep -q "$VD/ref.wav" && ok "setup --qwen: says the user supplies their own clip, and where it goes" || no "qwen clip reminder missing" "$out"
out="$(V --qwen --dry-run)"; printf '%s' "$out" | grep -q 'venv-qwen' && ok "setup --qwen installs into its own venv under the Talos data folder" || no "qwen venv not named" "$out"
out="$(V --diarize --dry-run)"; printf '%s' "$out" | grep -q 'needs --parakeet' && ok "setup --diarize alone warns that transcription needs --parakeet" || no "diarize note missing" "$out"
out="$(V --qwen --parakeet --diarize --dry-run)"; n=$(printf '%s' "$out" | grep -c 'Reminder'); [ "$n" = 3 ] && ok "setup: three new flags together print three reminders" || no "reminder count $n" "$out"
for flag in qwen parakeet; do
  out="$(TALOS_FORCE_ARCH=x86_64 V --$flag --dry-run)"; rc=$?
  { [ "$rc" = 4 ] && printf '%s' "$out" | grep -q 'Apple Silicon' && printf '%s' "$out" | grep -q 'x86_64' && ! printf '%s' "$out" | grep -q 'Reminder' && [ ! -e "$XDG_DATA_HOME" ]; } && ok "setup --$flag on a fake non-arm64 Mac: refused (exit 4), says what works instead, creates nothing" || no "--$flag arch refusal wrong (rc=$rc)" "$out"
done
out="$(TALOS_FORCE_ARCH=x86_64 V --diarize --dry-run)"; [ "$?" = 0 ] && ok "setup --diarize is not refused on Intel (the speaker half has no Apple Silicon need)" || no "diarize wrongly refused" "$out"
out="$(V --kokoro --stt small.en --dry-run)"; printf '%s' "$out" | grep -q 'kokoro-v1.0.onnx' && printf '%s' "$out" | grep -q 'ggml-small.en.bin' && ok "setup: the existing --kokoro and --stt dry-runs are unchanged" || no "old flags broke" "$out"
out="$(V)"; [ "$?" != 0 ] && printf '%s' "$out" | grep -q -- '--qwen' && ok "setup with no option lists the new flags" || no "no-option text wrong" "$out"

# ---------------- diarize wrapper
DT="$A/scripts/stt-diarize/diarize_transcribe.sh"; rm -rf "$XDG_DATA_HOME"
out="$(bash "$DT" "$SB/note.ogg" 2>&1)"; rc=$?
{ [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'missing:' && printf '%s' "$out" | grep -q 'parakeet-mlx' && printf '%s' "$out" | grep -q 'diarization-models' && printf '%s' "$out" | grep -q -- '--parakeet --diarize' && ! printf '%s' "$out" | grep -qi traceback; } && ok "diarize: with nothing installed it lists what is missing and the fix (no traceback)" || no "diarize missing message wrong (rc=$rc)" "$out"
out="$(bash "$DT" 2>&1)"; [ "$?" = 2 ] && ok "diarize: no argument prints usage (exit 2)" || no "diarize usage wrong" "$out"
out="$(bash "$DT" "$SB/note.ogg" abc 2>&1)"; [ "$?" = 2 ] && ok "diarize: a non-numeric speaker count is refused" || no "bad count accepted" "$out"
# merge_speakers.py on a tiny hand-made pair of inputs (no models)
python3 - "$SB" <<'PY'
import json, sys
sb = sys.argv[1]
toks = lambda ws, t0: [{"t": (" " if i else " ") + w, "start": t0 + i * 0.5, "end": t0 + i * 0.5 + 0.4} for i, w in enumerate(ws)]
json.dump({"text": "", "sentences": [
    {"start": 0, "end": 2, "text": "", "tokens": toks(["hello", "there", "Dana"], 0.0)},
    {"start": 5, "end": 7, "text": "", "tokens": toks(["hi", "Sam", "good", "morning"], 5.0)}]}, open(sb + "/p.json", "w"))
json.dump([[0.0, 3.0, 0], [4.5, 8.0, 1]], open(sb + "/d.json", "w"))
PY
out="$(python3 "$A/scripts/stt-diarize/merge_speakers.py" "$SB/p.json" "$SB/d.json")"
want=$'[00:00:00] Speaker 1: hello there Dana\n[00:00:05] Speaker 2: hi Sam good morning'
[ "$out" = "$want" ] && ok "merge_speakers.py: words are assigned to Speaker 1 / Speaker 2 by overlap" || no "merge output wrong" "$out"
# the shipped files carry nothing personal
if grep -rIlE '/Users/|\.virgil|treynor|Tetik' "$KIT/scripts/stt-diarize" "$KIT/scripts/voice" "$KIT/scripts/tts.sh" "$KIT/scripts/stt.sh" "$KIT/setup/local-models.md" >/dev/null 2>&1; then no "personal path or name found in the local-models files"; else ok "no personal paths, names or voiceprint files in the shipped local-model files"; fi
ls "$KIT"/scripts/stt-diarize | grep -qiE '\.(wav|npy|pt|onnx|m4a|mp3)$' && no "audio or model file in stt-diarize" || ok "no audio, voiceprint or model files are shipped"
# qwen_tts.py without mlx-audio: a clear one-line message, no traceback
out="$(python3 -I "$A/scripts/voice/qwen_tts.py" "$SB/q.wav" "hi" "$SB/note.ogg" "$SB/note.ogg" 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'mlx-audio is not installed' && ! printf '%s' "$out" | grep -qi traceback; } && ok "qwen_tts.py: without mlx-audio it exits with a clear message" || no "qwen_tts.py message wrong" "$out"

export HOME="$REALHOME"
echo "  localmodels: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
