// DOM Adapter for AIDP Big ASR Annotation Platform
// Matches: https://aidp.byteintl.com/management/paas/task-v2/*/mark-v3/*
// 100% Shadow DOM + same-origin iframe safe.
// SAFETY GUARANTEE: Never clicks "提交" (Submit) or "释放" (Release).

(function (global) {
  "use strict";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getWin(el) {
    return (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
  }

  function setReactTextareaValue(el, value) {
    if (!el) throw new Error("目标文本框未找到");
    const win = getWin(el);
    const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  function setReactRangeValue(el, value) {
    if (!el) return;
    const win = getWin(el);
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  // Deep query across document, open Shadow DOMs, and accessible same-origin iframes
  function deepQuerySelectorAll(selector, root = document, visited = new Set()) {
    const results = [];
    if (!root || visited.has(root)) return results;
    visited.add(root);

    try {
      results.push(...root.querySelectorAll(selector));
    } catch (_) {}

    let allNodes = [];
    try {
      allNodes = root.querySelectorAll("*");
    } catch (_) {}

    for (const el of allNodes) {
      if (el.id === "asr-helper-panel") continue;
      if (el.shadowRoot) {
        results.push(...deepQuerySelectorAll(selector, el.shadowRoot, visited));
      }
      if (el.tagName === "IFRAME") {
        try {
          if (el.contentDocument) {
            results.push(...deepQuerySelectorAll(selector, el.contentDocument, visited));
          }
        } catch (_) {}
      }
    }
    return results;
  }

  function deepQuerySelector(selector, root = document) {
    return deepQuerySelectorAll(selector, root)[0] || null;
  }

  // Collect visible text across top document + accessible same-origin iframes
  function getAllBodyText() {
    const chunks = [document.body?.innerText || ""];
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        if (iframe.contentDocument?.body?.innerText) {
          chunks.push(iframe.contentDocument.body.innerText);
        }
      } catch (_) {}
    }
    return chunks.join("\n");
  }

  function findTextarea(fieldId, fallbackIdx) {
    const exact =
      deepQuerySelector(`textarea[data-field-id="${fieldId}"]`) ||
      deepQuerySelector(`[data-field-id="${fieldId}"] textarea`);
    if (exact) return exact;

    const allMain = deepQuerySelectorAll("textarea").filter((ta) => {
      const fid = ta.getAttribute("data-field-id") || "";
      if (fid.startsWith("utterance-text-")) return false;
      if (ta.closest && ta.closest("#asr-helper-panel")) return false;
      return true;
    });
    if (allMain.length === 0) return null;
    if (fallbackIdx < 0) return allMain[allMain.length + fallbackIdx] || null;
    return allMain[fallbackIdx] || null;
  }

  function getTextareaDiagnostic() {
    const total = deepQuerySelectorAll("textarea").filter((ta) => !(ta.closest && ta.closest("#asr-helper-panel"))).length;
    const iframes = document.querySelectorAll("iframe").length;
    return `页面共检测到 ${total} 个文本框 / ${iframes} 个 iframe（请确认左侧选中的是「未提交」可编辑题目，而非只读的「已提交」题）`;
  }

  function findButtonByText(labelText, root = document) {
    const target = labelText.trim().toLowerCase();
    // Hard safety guard: never allow automated click on Submit or Release
    if (target === "提交" || target === "submit" || target === "释放" || target === "release") {
      throw new Error("安全拦截：扩展禁止自动点击提交或释放按钮");
    }
    const buttons = deepQuerySelectorAll("button", root).filter((b) => !(b.closest && b.closest("#asr-helper-panel")));
    return (
      buttons.find((b) => (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === target) ||
      buttons.find((b) => (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().includes(target)) ||
      null
    );
  }

  function getItemId() {
    const m = getAllBodyText().match(/题目\s*ID[：:]\s*(\d+)/);
    return m ? m[1] : "";
  }

  function getLanguageCode() {
    const tags = deepQuerySelectorAll(".ant-tag, span");
    for (const el of tags) {
      if (el.closest && el.closest("#asr-helper-panel")) continue;
      const t = (el.textContent || "").trim();
      if (/^[A-Z]{2,3}(?:-[A-Z]{2})?$/.test(t) && t !== "ASR" && t !== "ITN" && t !== "AI" && t !== "ID") {
        return t;
      }
    }
    return "UNKNOWN";
  }

  function isLikelyAudioUrl(url) {
    if (!url || !/^https?:\/\//i.test(url)) return false;
    const clean = url.split("?")[0].toLowerCase();
    if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|html)$/i.test(clean)) {
      return false;
    }
    return /bigspeech|audio|speech|asr/i.test(url) || /\.(wav|mp3|ogg|flac|m4a|opus|webm)$/i.test(clean);
  }

  function getAudioUrl() {
    // 1. Signed audio URL printed in the active queue card / page text
    const urlRegex = /https?:\/\/[^\s"'<>]*bytetos\.com[^\s"'<>]+/gi;
    const allMatches = getAllBodyText().match(urlRegex) || [];
    for (const u of allMatches) {
      const cleaned = u.trim().replace(/[.,;)]+$/, "");
      if (isLikelyAudioUrl(cleaned)) return cleaned;
    }

    // 2. Check performance entries in top window and same-origin iframes (filtered strictly to audio)
    const windows = [window];
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        if (iframe.contentWindow) windows.push(iframe.contentWindow);
      } catch (_) {}
    }
    for (const win of windows) {
      if (win.performance && win.performance.getEntriesByType) {
        const resources = win.performance.getEntriesByType("resource");
        for (let i = resources.length - 1; i >= 0; i--) {
          const name = resources[i].name || "";
          if (isLikelyAudioUrl(name)) {
            return name;
          }
        }
      }
    }

    const audioEl = deepQuerySelector("audio");
    if (audioEl?.src) return audioEl.src;

    return "";
  }

  function getTotalDurationMs() {
    const allText = getAllBodyText();
    const m1 = allText.match(/\d{2}:\d{2}\.\d{3}\s*\/\s*(\d{2}:\d{2}\.\d{3})/);
    if (m1 && global.SopRules) {
      const ms = global.SopRules.timestampToMs(m1[1]);
      if (ms > 0) return ms;
    }
    const m2 = allText.match(/Duration\s+(\d+(?:\.\d+)?)s/i);
    if (m2) return Math.round(parseFloat(m2[1]) * 1000);
    return 0;
  }

  function getRefText() {
    const cards = deepQuerySelectorAll(".ant-card, section, div");
    for (const card of cards) {
      if (card.closest && card.closest("#asr-helper-panel")) continue;
      const head = card.querySelector && card.querySelector(".ant-card-head-title");
      if (head && /Reference Text\s*[·•]\s*ref_text/i.test(head.textContent || "")) {
        const typo = card.querySelector("div.ant-typography");
        if (typo) {
          const clone = typo.cloneNode(true);
          clone.querySelectorAll("button, .ant-typography-copy").forEach((b) => b.remove());
          return (clone.textContent || "").trim();
        }
      }
    }

    const allTypo = deepQuerySelectorAll("div.ant-typography").filter((el) => {
      if (el.closest && el.closest("#asr-helper-panel")) return false;
      const card = el.closest && el.closest(".ant-card");
      return card && /ref_text/i.test(card.textContent || "");
    });
    if (allTypo.length > 0) {
      const clone = allTypo[0].cloneNode(true);
      clone.querySelectorAll("button, .ant-typography-copy").forEach((b) => b.remove());
      return (clone.textContent || "").trim();
    }
    return "";
  }

  function getUtterances() {
    const tas = deepQuerySelectorAll('textarea[data-field-id^="utterance-text-"]');
    return tas.map((ta, idx) => {
      let startMs = null;
      let endMs = null;
      const card = (ta.closest && ta.closest(".ant-card")) || ta.parentElement;
      if (card) {
        const m = (card.textContent || "").match(/(\d{2}:\d{2}\.\d{3})\s*[→\->]+\s*(\d{2}:\d{2}\.\d{3})/);
        if (m && global.SopRules) {
          startMs = global.SopRules.timestampToMs(m[1]);
          endMs = global.SopRules.timestampToMs(m[2]);
        }
      }
      return {
        index: idx,
        startMs,
        endMs,
        text: ta.value || "",
        textarea: ta
      };
    });
  }

  function isConfirmationRequired() {
    const badges = deepQuerySelectorAll(".ant-tag, span, div");
    return badges.some(
      (el) => !(el.closest && el.closest("#asr-helper-panel")) && el.children.length === 0 && /confirmation required/i.test((el.textContent || "").trim())
    );
  }

  function readPageState() {
    const asrTa = findTextarea("asr-text-input", 0);
    const itnTa = findTextarea("itn-text-input", 1);
    const remTa = findTextarea("general-remark-input", -1);
    return {
      itemId: getItemId(),
      language: getLanguageCode(),
      audioUrl: getAudioUrl(),
      totalDurationMs: getTotalDurationMs(),
      refText: getRefText(),
      asrText: asrTa ? asrTa.value : "",
      itnText: itnTa ? itnTa.value : "",
      generalRemark: remTa ? remTa.value : "",
      confirmedLatestAsr: !isConfirmationRequired(),
      utterances: getUtterances()
    };
  }

  function setAsrText(text) {
    const ta = findTextarea("asr-text-input", 0);
    if (!ta) throw new Error(`未找到 ASR-text 输入框；${getTextareaDiagnostic()}`);
    setReactTextareaValue(ta, text);
  }

  function setItnText(text) {
    const ta = findTextarea("itn-text-input", 1);
    if (!ta) throw new Error(`未找到 ITN-text 输入框；${getTextareaDiagnostic()}`);
    setReactTextareaValue(ta, text);
  }

  function setGeneralRemark(text) {
    const ta = findTextarea("general-remark-input", -1);
    if (!ta) throw new Error(`未找到 general_remark 输入框；${getTextareaDiagnostic()}`);
    setReactTextareaValue(ta, text);
  }

  async function clickGenerateRecommendedItn() {
    const btn =
      deepQuerySelector('button[data-field-id="generate-itn-button"]') ||
      findButtonByText("Generate recommended ITN from ASR") ||
      findButtonByText("Generate recommended ITN") ||
      findButtonByText("生成推荐");
    if (!btn) throw new Error("未找到 Generate recommended ITN from ASR 按钮");
    const before = findTextarea("itn-text-input", 1)?.value || "";
    btn.click();

    const start = Date.now();
    while (Date.now() - start < 4000) {
      await sleep(250);
      const now = findTextarea("itn-text-input", 1)?.value || "";
      if (now && now !== before) return now;
      if (now && Date.now() - start >= 600) return now;
    }
    return findTextarea("itn-text-input", 1)?.value || "";
  }

  function clickConfirmLatestAsr() {
    const btn =
      deepQuerySelector('button[data-field-id="confirm-itn-for-asr"]') ||
      findButtonByText("Confirm Latest ASR");
    if (!btn) throw new Error("未找到 Confirm Latest ASR 按钮");
    btn.click();
  }

  function clickSaveDraft() {
    const btn = findButtonByText("暂存");
    if (!btn) throw new Error("未找到 暂存 按钮");
    btn.click();
  }

  // Delete all existing utterance segments safely via verified data-field-id="delete-utterance-*"
  async function clearAllSegments() {
    let safety = 0;
    while (safety++ < 150) {
      const delBtns = deepQuerySelectorAll('button[data-field-id^="delete-utterance-"]');
      if (delBtns.length === 0) break;
      delBtns[delBtns.length - 1].click();
      await sleep(160);
    }
  }

  function getTimelineElements() {
    const inner = deepQuerySelector(".tl-timeline__inner");
    const waverow = deepQuerySelector(".tl-waverow");
    const wave = deepQuerySelector("canvas.tl-wave") || waverow;
    if (!inner || !waverow) throw new Error("未找到时间轴容器 (.tl-timeline__inner / .tl-waverow)");
    const win = getWin(inner);
    let scroller = inner.parentElement;
    while (scroller && scroller !== inner.ownerDocument.body) {
      const style = win.getComputedStyle(scroller);
      if (style.overflowX === "auto" || style.overflowX === "scroll" || scroller.scrollWidth > scroller.clientWidth + 5) {
        break;
      }
      scroller = scroller.parentElement;
    }
    return { inner, waverow, wave, scroller: scroller || inner.parentElement, win };
  }

  function findZoomSlider() {
    return deepQuerySelectorAll('input[type="range"]').find((inp) => parseFloat(inp.max) >= 4) || null;
  }

  // Compute exact pixels-per-second from .tl-ruler__tick (immune to .tl-timeline__inner min-width:100% padding!)
  function getTimelinePxPerSec(totalDurationMs) {
    const ticks = deepQuerySelectorAll(".tl-ruler__tick");
    const parsed = [];
    for (const el of ticks) {
      const m = (el.textContent || "").trim().match(/^(\d+):(\d{2})$/);
      if (!m) continue;
      const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      const leftPx = parseFloat(el.style.left);
      if (!Number.isNaN(leftPx)) {
        parsed.push({ sec, leftPx });
      }
    }
    if (parsed.length >= 2) {
      const first = parsed[0];
      const last = parsed[parsed.length - 1];
      const dSec = last.sec - first.sec;
      const dPx = last.leftPx - first.leftPx;
      if (dSec > 0 && dPx > 0) {
        return dPx / dSec;
      }
    }
    const zoomSlider = findZoomSlider();
    if (zoomSlider) {
      const z = parseFloat(zoomSlider.value);
      if (z > 0) return 60 * z;
    }
    const inner = deepQuerySelector(".tl-timeline__inner");
    if (inner && totalDurationMs > 0) {
      return inner.getBoundingClientRect().width / (totalDurationMs / 1000);
    }
    return 60;
  }

  // Compute offset of an element's ownerDocument relative to top-level browser viewport (handles nested iframes)
  function getFrameViewportOffset(el) {
    let offsetX = 0;
    let offsetY = 0;
    let curWin = getWin(el);
    let guard = 0;
    while (curWin && curWin !== window && guard++ < 5) {
      try {
        const frameEl = curWin.frameElement;
        if (!frameEl) break;
        const r = frameEl.getBoundingClientRect();
        offsetX += r.left;
        offsetY += r.top;
        curWin = curWin.parent;
      } catch (_) {
        break;
      }
    }
    return { offsetX, offsetY };
  }

  function sendDebuggerDrag(startX, endX, y) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "DEBUGGER_DRAG", payload: { startX, endX, y } },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp || !resp.ok) return reject(new Error(resp?.error || "debugger 拖拽失败"));
          resolve(resp.data);
        }
      );
    });
  }

  // Dispatch genuine trusted mouse drag via chrome.debugger (with synthetic PointerEvent fallback)
  async function dragCreateSegment(startMs, endMs, totalDurationMs) {
    const { inner, waverow, scroller, win } = getTimelineElements();
    let pxPerSec = getTimelinePxPerSec(totalDurationMs);
    if (pxPerSec <= 0 || totalDurationMs <= 0) {
      throw new Error("时间轴刻度或音频时长无效");
    }

    // Ensure the waveform row is vertically visible in the viewport before dragging!
    try {
      waverow.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(120);
    } catch (_) {}

    // If the segment itself is wider than the visible viewport, zoom out so both endpoints fit cleanly!
    if (scroller && scroller.clientWidth > 0) {
      const segPx = ((endMs - startMs) / 1000) * pxPerSec;
      if (segPx > scroller.clientWidth - 40) {
        const zoomSlider = findZoomSlider();
        if (zoomSlider) {
          const neededRatio = (scroller.clientWidth - 60) / Math.max(1, segPx);
          const curZoom = parseFloat(zoomSlider.value) || 1;
          const nextZoom = Math.max(parseFloat(zoomSlider.min) || 0.25, +(curZoom * neededRatio).toFixed(2));
          setReactRangeValue(zoomSlider, nextZoom);
          await sleep(220);
          pxPerSec = getTimelinePxPerSec(totalDurationMs);
        }
      }
    }

    const relStartX = (startMs / 1000) * pxPerSec;
    const relEndX = (endMs / 1000) * pxPerSec;

    // Scroll timeline so the entire segment (start..end) sits inside the visible virtualized canvas
    if (scroller && scroller.scrollWidth > scroller.clientWidth) {
      const midX = (relStartX + relEndX) / 2;
      const desiredScroll = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, midX - scroller.clientWidth / 2));
      scroller.scrollLeft = desiredScroll;
      await sleep(120);
    }

    const innerRect = inner.getBoundingClientRect();
    const waveRect = waverow.getBoundingClientRect();
    const { offsetX, offsetY } = getFrameViewportOffset(inner);
    const vpY = offsetY + waveRect.top + waveRect.height * 0.5;
    const vpStartX = offsetX + innerRect.left + relStartX;
    const vpEndX = offsetX + innerRect.left + relEndX;

    // Primary: Chrome DevTools Protocol trusted mouse drag (isTrusted: true)
    try {
      await sendDebuggerDrag(vpStartX, vpEndX, vpY);
      await sleep(200);
      return;
    } catch (e) {
      console.warn("[ASR Helper] debugger drag failed, falling back to synthetic events:", e);
    }

    // Fallback: synthetic PointerEvent + MouseEvent
    const y = waveRect.top + waveRect.height * 0.5;
    const startX = innerRect.left + relStartX;
    const target = deepQuerySelector("canvas.tl-wave") || waverow;
    const common = {
      bubbles: true,
      cancelable: true,
      view: win,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    };
    target.dispatchEvent(new win.PointerEvent("pointerdown", { ...common, clientX: startX, clientY: y }));
    target.dispatchEvent(new win.MouseEvent("mousedown", { ...common, clientX: startX, clientY: y }));
    for (let s = 1; s <= 10; s++) {
      const liveX = inner.getBoundingClientRect().left + relStartX + ((relEndX - relStartX) * s) / 10;
      win.dispatchEvent(new win.PointerEvent("pointermove", { ...common, clientX: liveX, clientY: y }));
      win.dispatchEvent(new win.MouseEvent("mousemove", { ...common, clientX: liveX, clientY: y }));
      await sleep(16);
    }
    const finalX = inner.getBoundingClientRect().left + relEndX;
    win.dispatchEvent(new win.PointerEvent("pointerup", { ...common, buttons: 0, clientX: finalX, clientY: y }));
    win.dispatchEvent(new win.MouseEvent("mouseup", { ...common, buttons: 0, clientX: finalX, clientY: y }));
    await sleep(220);
  }

  // Clear existing segments, draw all new segments on timeline, and fill their utterance texts
  async function applyUtterancesToPage(segments, totalDurationMs, onProgress) {
    if (!segments || segments.length === 0) throw new Error("没有可回填的 utterance 片段");

    if (onProgress) onProgress("正在清空旧片段...");
    await clearAllSegments();
    await sleep(200);

    const zoomSlider = findZoomSlider();
    if (zoomSlider) {
      setReactRangeValue(zoomSlider, 1);
      await sleep(200);
    }

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (onProgress) {
        onProgress(`正在切分第 ${i + 1}/${segments.length} 段 (${global.SopRules.msToTimestamp(seg.startMs)} → ${global.SopRules.msToTimestamp(seg.endMs)})...`);
      }
      const beforeCount = deepQuerySelectorAll('textarea[data-field-id^="utterance-text-"]').length;
      await dragCreateSegment(seg.startMs, seg.endMs, totalDurationMs);

      let afterCount = deepQuerySelectorAll('textarea[data-field-id^="utterance-text-"]').length;
      if (afterCount <= beforeCount) {
        // Retry with 80ms inset to avoid pixel-rounding collision with adjacent segment borders
        await dragCreateSegment(seg.startMs + 80, Math.max(seg.startMs + 220, seg.endMs - 80), totalDurationMs);
      }
    }

    await sleep(250);
    const utts = getUtterances();
    const count = Math.min(utts.length, segments.length);
    for (let i = 0; i < count; i++) {
      setReactTextareaValue(utts[i].textarea, segments[i].text);
      await sleep(40);
    }

    return { created: utts.length, expected: segments.length };
  }

  global.AidpDom = {
    readPageState,
    setAsrText,
    setItnText,
    setGeneralRemark,
    clickGenerateRecommendedItn,
    clickConfirmLatestAsr,
    clickSaveDraft,
    clearAllSegments,
    applyUtterancesToPage
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
