// Content Script UI Controller for Big ASR Annotation Helper
// Injects a non-intrusive floating workflow panel onto AIDP annotation pages.

(function () {
  "use strict";

  if (document.getElementById("asr-helper-panel")) return;

  let cachedAudio = { url: "", base64: "", mimeType: "", vad: null };
  let lastAsrResult = null;
  let lastItemId = "";

  function sendBgMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp || !resp.ok) {
          reject(new Error(resp?.error || "后台任务执行失败"));
          return;
        }
        resolve(resp.data);
      });
    });
  }

  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function ensureAudioLoaded(audioUrl) {
    if (!audioUrl) throw new Error("未在页面检测到音频链接，请展开左侧题目栏或刷新页面");
    if (cachedAudio.url === audioUrl && cachedAudio.base64) {
      return cachedAudio;
    }
    const fetched = await sendBgMessage({ type: "FETCH_AUDIO", audioUrl });
    let vad = null;
    try {
      const ab = base64ToArrayBuffer(fetched.base64);
      vad = await AudioVad.analyzeAudioArrayBuffer(ab);
    } catch (e) {
      console.warn("[ASR Helper] Web Audio VAD skipped:", e);
    }
    const useCompact = Boolean(vad && vad.compactWavBase64);
    cachedAudio = {
      url: audioUrl,
      base64: useCompact ? vad.compactWavBase64 : fetched.base64,
      mimeType: useCompact ? "audio/wav" : fetched.mimeType,
      byteLength: useCompact ? vad.compactBytes : fetched.byteLength,
      vad
    };
    return cachedAudio;
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Build Floating UI
  const toggleBtn = document.createElement("button");
  toggleBtn.id = "asr-helper-toggle";
  toggleBtn.innerHTML = `<span>🎙️</span><span>ASR 助手</span>`;
  document.body.appendChild(toggleBtn);

  const panel = document.createElement("div");
  panel.id = "asr-helper-panel";
  panel.innerHTML = `
    <div class="asr-header" id="asr-header-drag">
      <div class="asr-header-title">
        <span>🎙️ Big ASR 助手</span>
        <span class="asr-badge">v1.0.12</span>
      </div>
      <div class="asr-header-actions">
        <button class="asr-icon-btn" id="asr-btn-collapse" title="折叠/展开面板">−</button>
        <button class="asr-icon-btn" id="asr-btn-refresh" title="刷新当前题信息">⟳</button>
        <button class="asr-icon-btn" id="asr-btn-settings" title="API 与参数设置">⚙️</button>
        <button class="asr-icon-btn" id="asr-btn-close" title="隐藏到右下角按钮">✕</button>
      </div>
    </div>
    <div class="asr-body">
      <div class="asr-update-banner asr-hidden" id="asr-update-banner">
        <span id="asr-update-text"></span>
        <a class="asr-update-link" id="asr-update-link" href="#" target="_blank" rel="noopener">下载新版</a>
      </div>
      <div class="asr-meta" id="asr-meta-box">
        <div>题目: <b id="asr-meta-id">-</b></div>
        <div>语种: <b id="asr-meta-lang">-</b></div>
        <div>时长: <b id="asr-meta-dur">-</b></div>
        <div>片段: <b id="asr-meta-seg">-</b></div>
      </div>

      <div class="asr-settings asr-hidden" id="asr-settings-box">
        <label>模型 (GEMINI_MODEL)<input id="cfg-model" type="text" /></label>
        <label>接口地址 (GEMINI_BASE_URL)<input id="cfg-url" type="text" /></label>
        <label>API Key (GEMINI_API_KEY)<input id="cfg-key" type="password" /></label>
        <label>单段建议上限(秒)<input id="cfg-maxsec" type="number" min="5" max="60" /></label>
        <label>更新检查地址 (version.json)<input id="cfg-update-url" type="text" placeholder="https://.../version.json" /></label>
        <button class="asr-btn asr-btn-primary" id="cfg-save">保存设置</button>
      </div>

      <div class="asr-status info" id="asr-status">就绪：点击下方步骤开始半自动标注（绝不自动提交）。</div>

      <div class="asr-steps">
        <button class="asr-btn asr-btn-primary" id="step-1-asr">
          <span>① 听音预标 ASR-text & 对比 ref_text</span><span>▶</span>
        </button>
        <button class="asr-btn" id="step-2-itn">
          <span>② 生成推荐 ITN & 第5节规则体检</span><span>▶</span>
        </button>
        <button class="asr-btn" id="step-3-align">
          <span>③ 强制对齐切分 & 回填时间轴</span><span>▶</span>
        </button>
        <button class="asr-btn asr-btn-success" id="step-4-audit">
          <span>④ 第12节提交前全检</span><span>✓</span>
        </button>
        <button class="asr-btn" id="step-save-draft">
          <span>💾 暂存草稿（安全，不提交）</span><span>⌘S</span>
        </button>
      </div>

      <div class="asr-section asr-hidden" id="asr-diff-section">
        <div class="asr-section-title">
          <span>ref_text vs ASR-text 差异高亮</span>
          <button class="asr-icon-btn" style="color:#1677ff;font-size:11.5px" id="btn-apply-remark">填入建议 Remark</button>
        </div>
        <div class="asr-diff" id="asr-diff-box"></div>
      </div>

      <div class="asr-section asr-hidden" id="asr-audit-section">
        <div class="asr-section-title">
          <span>SOP 质检报告</span>
          <span id="asr-audit-badge"></span>
        </div>
        <ul class="asr-list" id="asr-audit-list"></ul>
      </div>

      <div class="asr-footer-note">安全原则：仅辅助预标/切分/暂存，请人工复听确认后手动点「提交」</div>
    </div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector("#" + id);
  const statusEl = $("asr-status");

  function setStatus(text, type = "info") {
    statusEl.className = `asr-status ${type}`;
    statusEl.textContent = text;
  }

  function setBusy(busy) {
    ["step-1-asr", "step-2-itn", "step-3-align", "step-4-audit", "step-save-draft"].forEach((id) => {
      $(id).disabled = busy;
    });
  }

  function refreshMeta() {
    const state = AidpDom.readPageState();
    $("asr-meta-id").textContent = state.itemId ? state.itemId.slice(-8) : "-";
    $("asr-meta-lang").textContent = state.language || "-";
    $("asr-meta-dur").textContent = state.totalDurationMs ? (state.totalDurationMs / 1000).toFixed(1) + "s" : "-";
    $("asr-meta-seg").textContent = `${state.utterances.length} 段`;

    if (state.itemId && state.itemId !== lastItemId) {
      lastItemId = state.itemId;
      lastAsrResult = null;
      $("asr-diff-section").classList.add("asr-hidden");
      $("asr-audit-section").classList.add("asr-hidden");
      setStatus(`已切换到题目 ${state.itemId} (${state.language})，可开始标注。`, "info");
    }
    return state;
  }

  function renderAudit(errors, warnings) {
    const sec = $("asr-audit-section");
    const list = $("asr-audit-list");
    const badge = $("asr-audit-badge");
    sec.classList.remove("asr-hidden");
    list.innerHTML = "";

    if (errors.length === 0 && warnings.length === 0) {
      badge.innerHTML = `<span style="color:#059669;font-weight:700">全部通过 ✓</span>`;
      list.innerHTML = `<li class="ok">SOP 第 4 / 5 / 6 / 10 / 12 节硬性检查全部通过，可复听后手动提交。</li>`;
      return;
    }

    badge.innerHTML = `<span style="color:${errors.length ? "#dc2626" : "#d97706"};font-weight:700">${errors.length} 错误 / ${warnings.length} 提醒</span>`;
    for (const e of errors) {
      const li = document.createElement("li");
      li.className = "err";
      li.textContent = `[错误] ${e}`;
      list.appendChild(li);
    }
    for (const w of warnings) {
      const li = document.createElement("li");
      li.className = "warn";
      li.textContent = `[提醒] ${w}`;
      list.appendChild(li);
    }
  }

  function renderDiff(refText, asrText, summary, suggestedRemark) {
    const sec = $("asr-diff-section");
    const box = $("asr-diff-box");
    const ops = SopRules.diffWords(refText || "", asrText || "");
    const html = ops
      .map((op) => {
        const t = escapeHtml(op.text);
        if (op.type === "delete") return `<del>${t}</del>`;
        if (op.type === "insert") return `<ins>${t}</ins>`;
        return t;
      })
      .join(" ");
    box.innerHTML = `<div style="margin-bottom:4px;color:#475569"><b>摘要：</b>${escapeHtml(summary || "")}</div><div>${html}</div>`;
    if (suggestedRemark) {
      box.innerHTML += `<div style="margin-top:6px;padding:4px 6px;background:#fffbeb;border-radius:4px;color:#92400e"><b>建议 Remark：</b>${escapeHtml(suggestedRemark)}</div>`;
    }
    $("btn-apply-remark").style.display = suggestedRemark ? "inline-block" : "none";
    sec.classList.remove("asr-hidden");
  }

  // Toggle / collapse / hide panel with persisted preference
  function setCollapsed(collapsed) {
    panel.classList.toggle("asr-collapsed", collapsed);
    $("asr-btn-collapse").textContent = collapsed ? "+" : "−";
    $("asr-btn-collapse").title = collapsed ? "展开面板" : "折叠面板";
    chrome.storage.local.set({ asrPanelCollapsed: collapsed });
  }

  chrome.storage.local.get(["asrPanelCollapsed"], (res) => {
    // Default to collapsed on first load so it never blocks the timeline/workspace
    const collapsed = res.asrPanelCollapsed !== undefined ? Boolean(res.asrPanelCollapsed) : true;
    setCollapsed(collapsed);
  });

  $("asr-btn-collapse").addEventListener("click", (e) => {
    e.stopPropagation();
    setCollapsed(!panel.classList.contains("asr-collapsed"));
  });

  toggleBtn.addEventListener("click", () => {
    if (panel.classList.contains("asr-hidden")) {
      panel.classList.remove("asr-hidden");
      setCollapsed(false);
      refreshMeta();
    } else if (panel.classList.contains("asr-collapsed")) {
      setCollapsed(false);
      refreshMeta();
    } else {
      panel.classList.add("asr-hidden");
    }
  });
  $("asr-btn-close").addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.add("asr-hidden");
  });

  // Make panel freely draggable by its header bar
  (function enableHeaderDrag() {
    const header = $("asr-header-drag");
    let dragging = false;
    let startX = 0, startY = 0, origLeft = 0, origTop = 0;

    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      panel.style.right = "auto";
      panel.style.left = origLeft + "px";
      panel.style.top = origTop + "px";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxLeft = Math.max(0, window.innerWidth - 120);
      const maxTop = Math.max(0, window.innerHeight - 44);
      panel.style.left = Math.max(0, Math.min(maxLeft, origLeft + dx)) + "px";
      panel.style.top = Math.max(0, Math.min(maxTop, origTop + dy)) + "px";
    });

    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  })();
  $("asr-btn-refresh").addEventListener("click", () => {
    refreshMeta();
    setStatus("已刷新当前题目状态。", "info");
  });

  // Settings drawer
  function loadSettingsToUi() {
    chrome.storage.local.get(["asrConfig"], (res) => {
      const cfg = { ...ASR_DEFAULT_CONFIG, ...(res.asrConfig || {}) };
      $("cfg-model").value = cfg.GEMINI_MODEL;
      $("cfg-url").value = cfg.GEMINI_BASE_URL;
      $("cfg-key").value = cfg.GEMINI_API_KEY;
      $("cfg-maxsec").value = cfg.MAX_UTTERANCE_SEC;
      $("cfg-update-url").value = cfg.UPDATE_CHECK_URL || "";
    });
  }
  $("asr-btn-settings").addEventListener("click", () => {
    $("asr-settings-box").classList.toggle("asr-hidden");
    loadSettingsToUi();
  });
  $("cfg-save").addEventListener("click", () => {
    const asrConfig = {
      GEMINI_MODEL: $("cfg-model").value.trim() || ASR_DEFAULT_CONFIG.GEMINI_MODEL,
      GEMINI_BASE_URL: $("cfg-url").value.trim() || ASR_DEFAULT_CONFIG.GEMINI_BASE_URL,
      GEMINI_API_KEY: $("cfg-key").value.trim() || ASR_DEFAULT_CONFIG.GEMINI_API_KEY,
      MAX_UTTERANCE_SEC: parseInt($("cfg-maxsec").value, 10) || 20,
      UPDATE_CHECK_URL: $("cfg-update-url").value.trim()
    };
    chrome.storage.local.set({ asrConfig }, () => {
      $("asr-settings-box").classList.add("asr-hidden");
      setStatus("设置已保存。", "ok");
      checkForUpdates();
    });
  });

  async function checkForUpdates() {
    try {
      const info = await sendBgMessage({ type: "CHECK_UPDATE" });
      const banner = $("asr-update-banner");
      if (info && info.hasUpdate && info.downloadUrl) {
        $("asr-update-text").textContent = `🆕 发现新版本 v${info.latestVersion}${info.notes ? "：" + info.notes : ""}`;
        $("asr-update-link").href = info.downloadUrl;
        banner.classList.remove("asr-hidden");
      } else {
        banner.classList.add("asr-hidden");
      }
    } catch (_) {}
  }

  $("btn-apply-remark").addEventListener("click", () => {
    if (lastAsrResult?.suggested_remark) {
      AidpDom.setGeneralRemark(lastAsrResult.suggested_remark);
      setStatus("已将建议说明填入 general_remark。", "ok");
    }
  });

  // STEP 1: Pre-label ASR-text & Diff
  $("step-1-asr").addEventListener("click", async () => {
    setBusy(true);
    try {
      const state = refreshMeta();
      setStatus("正在拉取当前题目音频并分析波形...", "info");
      const audio = await ensureAudioLoaded(state.audioUrl);
      const durationSec = (audio.vad?.durationMs || state.totalDurationMs || 0) / 1000;

      const kb = Math.round((audio.byteLength || 0) / 1024);
      setStatus(`正在调用云端多模态模型听音校正 (${state.language}, ${durationSec.toFixed(1)}s, ${kb}KB ${audio.mimeType})...`, "info");
      const res = await sendBgMessage({
        type: "ANALYZE_ASR",
        payload: {
          language: state.language,
          refText: state.refText,
          audioBase64: audio.base64,
          mimeType: audio.mimeType,
          durationSec
        }
      });

      lastAsrResult = res;
      if (!res.asr_text) throw new Error("模型未返回 asr_text");

      // Render diff & audit before filling so result is never lost even on read-only views
      renderDiff(state.refText, res.asr_text, res.diff_summary, res.suggested_remark);
      const check = SopRules.validateAsrText(res.asr_text, state.language);
      renderAudit(check.errors, check.warnings);

      AidpDom.setAsrText(res.asr_text);
      setStatus(
        check.errors.length === 0
          ? "① ASR-text 已自动回填且通过第4节校验！请核对上方差异后执行第②步。"
          : "① ASR-text 已回填，但检测到第4节规则异常，请查看下方质检报告修正。",
        check.errors.length === 0 ? "ok" : "warn"
      );
    } catch (err) {
      setStatus("① 预标 ASR 失败：" + err.message, "err");
    } finally {
      setBusy(false);
    }
  });

  // STEP 2: Generate recommended ITN & validate Section 5
  $("step-2-itn").addEventListener("click", async () => {
    setBusy(true);
    try {
      const state = refreshMeta();
      if (!state.asrText.trim()) {
        throw new Error("ASR-text 为空，请先完成第①步");
      }
      setStatus("正在触发平台「Generate recommended ITN from ASR」...", "info");
      const itnText = await AidpDom.clickGenerateRecommendedItn();
      const updated = refreshMeta();

      const res = SopRules.validateItnText(updated.itnText || itnText, updated.asrText, true);
      renderAudit(res.errors, res.warnings);

      if (res.errors.length === 0 && (updated.itnText || itnText).trim()) {
        setStatus("② 推荐 ITN 已生成并通过第5节体检！请人工确认标点/规范化后点击 Confirm Latest ASR，再执行第③步。", "ok");
      } else {
        setStatus("② ITN 体检完成，请按下方报告修正（若平台仅在预览框展示推荐结果，请手动应用到 ITN-text）。", "warn");
      }
    } catch (err) {
      setStatus("② 生成/校验 ITN 失败：" + err.message, "err");
    } finally {
      setBusy(false);
    }
  });

  // STEP 3: Forced alignment & timeline segmentation
  $("step-3-align").addEventListener("click", async () => {
    setBusy(true);
    try {
      const state = refreshMeta();
      if (!state.itnText.trim()) {
        throw new Error("ITN-text 为空，请先完成第②步并确认 ITN-text");
      }
      if (!state.confirmedLatestAsr) {
        try {
          AidpDom.clickConfirmLatestAsr();
        } catch (_) {}
      }

      setStatus("正在拉取音频并运行云端对齐切句...", "info");
      const audio = await ensureAudioLoaded(state.audioUrl);
      const durationMs = audio.vad?.durationMs || state.totalDurationMs;

      const cfg = await new Promise((r) => chrome.storage.local.get(["asrConfig"], (x) => r({ ...ASR_DEFAULT_CONFIG, ...(x.asrConfig || {}) })));

      const res = await sendBgMessage({
        type: "ALIGN_UTTERANCES",
        payload: {
          language: state.language,
          itnText: state.itnText,
          audioBase64: audio.base64,
          mimeType: audio.mimeType,
          durationMs,
          maxUtteranceSec: cfg.MAX_UTTERANCE_SEC || 20
        }
      });

      const rawUtts = (res.utterances || []).map((u) => ({
        startMs: Number(u.start_ms ?? u.startMs ?? 0),
        endMs: Number(u.end_ms ?? u.endMs ?? durationMs),
        text: String(u.text || "")
      }));

      // Guarantee 100% lossless ITN-text coverage + refine boundaries with Web Audio VAD
      const maxMs = (cfg.MAX_UTTERANCE_SEC || 20) * 1000;
      let segments = SopRules.reconcileUtterancesWithItn(rawUtts, state.itnText, durationMs);
      if (audio.vad) {
        segments = AudioVad.refineSegmentsWithVad(segments, audio.vad);
      }
      // HARD CAP: enforce every utterance <= maxUtteranceSec (default 20s)
      segments = SopRules.enforceMaxUtteranceDuration(segments, maxMs, audio.vad, durationMs);
      if (audio.vad) {
        segments = AudioVad.refineSegmentsWithVad(segments, audio.vad);
      }

      const applied = await AidpDom.applyUtterancesToPage(segments, durationMs, (msg) => setStatus(msg, "info"));
      const afterState = refreshMeta();
      const audit = SopRules.runFullAudit(afterState);
      renderAudit(audit.errors, audit.warnings);

      setStatus(
        `③ 已回填 ${applied.created}/${applied.expected} 个时间轴片段！请逐条点击 Play 复听边界，并运行第④步全检。`,
        audit.passed ? "ok" : "warn"
      );
    } catch (err) {
      setStatus("③ 对齐切分失败：" + err.message, "err");
    } finally {
      setBusy(false);
    }
  });

  // STEP 4: Full Section 12 Pre-submission Audit
  $("step-4-audit").addEventListener("click", () => {
    const state = refreshMeta();
    const audit = SopRules.runFullAudit(state);
    renderAudit(audit.errors, audit.warnings);
    setStatus(
      audit.passed
        ? "④ 第12节全检通过 ✓！确认音频边界无误后可点击页面「提交」。"
        : `④ 发现 ${audit.errors.length} 项阻断错误，请按下方列表修正后再提交。`,
      audit.passed ? "ok" : "err"
    );
  });

  // Safe Draft Save (never Submit)
  $("step-save-draft").addEventListener("click", () => {
    try {
      AidpDom.clickSaveDraft();
      setStatus("已触发页面「暂存」（未提交）。", "ok");
    } catch (err) {
      setStatus("暂存失败：" + err.message, "err");
    }
  });

  // Auto-refresh metadata & check updates on startup
  setTimeout(() => {
    refreshMeta();
    checkForUpdates();
  }, 1200);
  setInterval(() => {
    if (!panel.classList.contains("asr-hidden")) {
      refreshMeta();
    }
  }, 2500);
})();
