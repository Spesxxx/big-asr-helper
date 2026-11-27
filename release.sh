#!/bin/bash
# 一键打包发布脚本：同步更新 version.json 并生成最新 big-asr-helper-extension.zip
# 用法: ./release.sh "本次更新说明"
set -e
cd "$(dirname "$0")"

VERSION=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
NOTES="${1:-例行优化与问题修复}"

python3 - "$VERSION" "$NOTES" <<'EOF'
import json, sys, os
ver, notes = sys.argv[1], sys.argv[2]
path = "version.json"
data = json.load(open(path)) if os.path.exists(path) else {}
data["version"] = ver
data["notes"] = notes
if not data.get("download_url"):
    data["download_url"] = "https://github.com/Spesxxx/big-asr-helper/releases/latest/download/big-asr-helper-extension.zip"
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("Updated version.json ->", ver)
EOF

chmod +x updater/native_host.py 安装一键更新_Mac.command
rm -f big-asr-helper-extension.zip
zip -r big-asr-helper-extension.zip extension updater 安装一键更新_Mac.command 安装一键更新_Windows.bat README.md
echo "Done! Upload both version.json and big-asr-helper-extension.zip to GitHub."
