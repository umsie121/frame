#!/usr/bin/env bash
# Builds the shell APK with plain SDK tools (no Gradle). Needs: JDK 17, Android SDK
# build-tools 34.0.0 + platforms;android-34 (compile SDK; the app itself targets API 23).
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
# Homebrew openjdk@17 is keg-only (installed without sudo); use it unless JAVA_HOME is set.
if [ -z "${JAVA_HOME:-}" ] && [ -d /opt/homebrew/opt/openjdk@17 ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  export PATH="$JAVA_HOME/bin:$PATH"
fi
BT="$SDK/build-tools/34.0.0"
JAR="$SDK/platforms/android-34/android.jar"
OUT=build
rm -rf "$OUT" && mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/assets"

# Bundle the current web UI so a fresh install works with nothing else (deploys override it on /sdcard).
WEB=../apps/client/dist
[ -f "$WEB/index.html" ] || { echo "Build the client first: pnpm build"; exit 1; }
cp -R "$WEB" "$OUT/assets/web"

"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" --manifest AndroidManifest.xml -I "$JAR" -A "$OUT/assets" "$OUT/res.zip" \
  --min-sdk-version 23 --target-sdk-version 22
javac --release 8 -Xlint:-options -classpath "$JAR" -d "$OUT/classes" $(find src -name '*.java')
"$BT/d8" --min-api 23 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -j ../unsigned.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

# Local debug key, generated once, git-ignored (*.keystore). Fine for a sideloaded home app.
KS=debug.keystore
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias shell \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Family Frame" >/dev/null 2>&1
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --out "$OUT/family-frame-shell.apk" "$OUT/aligned.apk"
echo "Built $OUT/family-frame-shell.apk"
