#!/bin/sh
# Voice lines for the HQ easter egg, made with macOS's built-in `say` (free, offline), then given a
# building-PA sound with ffmpeg (band-pass + short echo). Written to the git-ignored
# apps/client/public/private/vo/ (one line says the owner's name), deployed with the UI.
#   sh scripts/make-voice.sh Alex
set -e
NAME="${1:-Operator}"
VOICE="${VOICE:-Samantha}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/apps/client/public/private/vo"
TMP="$(mktemp -d)"
mkdir -p "$OUT"
line() {
  say -v "$VOICE" -r "${3:-165}" -o "$TMP/$1.aiff" "$2"
  # 22 kHz mono 16-bit WAV: tiny, and every WebView decodes it.
  ffmpeg -loglevel error -y -i "$TMP/$1.aiff" \
    -af "highpass=f=260,lowpass=f=4200,aecho=0.8:0.55:45|90:0.28|0.14,acompressor=threshold=0.2:ratio=3,loudnorm=I=-11:TP=-1:LRA=7" \
    -ar 22050 -ac 1 -c:a pcm_s16le "$OUT/$1.wav"
}
line uplink "Establishing uplink." 160
line entering "Entering ${NAME}'s bedroom now." 160
line locating "Locating target." 155
line locate "Locating." 150
line acquired "Target acquired." 145
line window "Window located." 155
# Samantha reads "live" as "liv" whatever the spelling, so the voice says "camera feed" instead.
line feed "Establishing camera feed." 160
line camera "Bambu Lab camera online." 160
line secure "Establishing secure connection." 160
line secured "Connection secured." 155
line loading "Loading camera feed." 160
line online "Camera feed online." 160
line destruct "Self destruct sequence initiated." 160
line three "Three." 150
line two "Two." 150
line one "One." 150
rm -rf "$TMP"
ls -la "$OUT"
