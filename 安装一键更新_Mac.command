#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$DIR/updater/native_host.py"
HOST_NAME="com.spesxxx.big_asr_updater"
EXT_ID="piamoojicmlhbikgnddghckmigmkojja"

chmod +x "$HOST_SCRIPT"

MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Big ASR Helper 1-Click Auto Updater",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
)

TARGETS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
)

mkdir -p "${TARGETS[0]}"
for target in "${TARGETS[@]}"; do
  parent="$(dirname "$target")"
  if [ -d "$parent" ]; then
    mkdir -p "$target"
    echo "$MANIFEST_CONTENT" > "$target/$HOST_NAME.json"
    echo "✓ 已注册更新器到: $target/$HOST_NAME.json"
  fi
done

echo ""
echo "======================================================"
echo "✅ 一键自动更新注册成功！"
echo "现在回到 Chrome 打开标注页，以后有新版本直接点面板里的"
echo "「⚡ 一键更新」就会自动覆盖并重启扩展，无需再手动解压！"
echo "======================================================"
echo ""
read -n 1 -s -r -p "按任意键关闭此窗口..."
