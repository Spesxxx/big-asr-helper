#!/usr/bin/env python3
"""Chrome Native Messaging Host for Big ASR Helper 1-Click Auto-Update (macOS / Linux)."""
import json
import os
import shutil
import struct
import sys
import tempfile
import urllib.request
import zipfile

DEFAULT_DOWNLOAD_URL = "https://github.com/Spesxxx/big-asr-helper/releases/latest/download/big-asr-helper-extension.zip"
ALLOWED_PREFIX = "https://github.com/Spesxxx/big-asr-helper/"


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    raw_msg = sys.stdin.buffer.read(msg_len)
    return json.loads(raw_msg.decode("utf-8"))


def send_message(obj):
    encoded = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def perform_update(download_url):
    url = (download_url or "").strip() or DEFAULT_DOWNLOAD_URL
    if not url.startswith(ALLOWED_PREFIX):
        raise ValueError(f"安全拦截：不允许的下载地址 {url}")

    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ext_dir = os.path.join(root_dir, "extension")

    tmp_dir = tempfile.mkdtemp(prefix="big_asr_update_")
    try:
        zip_path = os.path.join(tmp_dir, "release.zip")
        req = urllib.request.Request(url, headers={"User-Agent": "BigASR-AutoUpdater/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r, open(zip_path, "wb") as f:
            shutil.copyfileobj(r, f)

        extract_dir = os.path.join(tmp_dir, "extracted")
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_dir)

        new_ext = os.path.join(extract_dir, "extension")
        if not os.path.isdir(new_ext) or not os.path.isfile(os.path.join(new_ext, "manifest.json")):
            raise RuntimeError("下载的压缩包缺少 extension/manifest.json")

        with open(os.path.join(new_ext, "manifest.json"), "r", encoding="utf-8") as mf:
            new_version = json.load(mf).get("version", "")

        # Copy all files from new_ext into ext_dir (preserving directory inode for Chrome)
        os.makedirs(ext_dir, exist_ok=True)
        for name in os.listdir(new_ext):
            src = os.path.join(new_ext, name)
            dst = os.path.join(ext_dir, name)
            if os.path.isdir(src):
                if os.path.exists(dst):
                    shutil.rmtree(dst)
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)

        return {"ok": True, "version": new_version}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def main():
    try:
        msg = read_message()
        if not msg:
            return
        if msg.get("action") == "ping":
            send_message({"ok": True, "pong": True})
            return
        if msg.get("action") == "update":
            res = perform_update(msg.get("download_url"))
            send_message(res)
            return
        send_message({"ok": False, "error": f"未知指令: {msg.get('action')}"})
    except Exception as e:
        send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
