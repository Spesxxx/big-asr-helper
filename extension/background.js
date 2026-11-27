// Background Service Worker (MV3)
// Handles CORS-free audio fetching and Gemini multimodal audio API requests.

importScripts("config.js");

async function getEffectiveConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["asrConfig"], (res) => {
      resolve({ ...ASR_DEFAULT_CONFIG, ...(res.asrConfig || {}) });
    });
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function inferMimeType(url, contentTypeHeader, bytes) {
  // 1. Sniff real audio magic bytes first
  if (bytes && bytes.length >= 12) {
    const h4 = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (h4 === "RIFF") return "audio/wav";
    if (h4 === "OggS") return "audio/ogg";
    if (h4 === "fLaC") return "audio/flac";
    if (h4.startsWith("ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
    const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (ftyp === "ftyp") return "audio/mp4";
  }
  const ct = (contentTypeHeader || "").split(";")[0].trim().toLowerCase();
  if (ct.startsWith("audio/")) return ct;
  const cleanUrl = (url || "").split("?")[0].toLowerCase();
  if (cleanUrl.endsWith(".mp3")) return "audio/mpeg";
  if (cleanUrl.endsWith(".wav")) return "audio/wav";
  if (cleanUrl.endsWith(".ogg") || cleanUrl.endsWith(".opus")) return "audio/ogg";
  if (cleanUrl.endsWith(".flac")) return "audio/flac";
  if (cleanUrl.endsWith(".m4a") || cleanUrl.endsWith(".mp4")) return "audio/mp4";
  if (cleanUrl.endsWith(".webm")) return "audio/webm";
  return "audio/wav";
}

function deriveGeminiNativeUrl(baseUrl, model, apiKey) {
  const root = (baseUrl || "https://quanzil.com/v1")
    .replace(/\/+$/, "")
    .replace(/\/v1beta$/, "")
    .replace(/\/v1$/, "");
  return `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function extractJsonFromText(text) {
  const raw = (text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("模型返回非合法 JSON: " + raw.slice(0, 200));
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return String(url || "").slice(0, 60);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (timedOut || err?.name === "AbortError") {
      throw new Error(`请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒无响应，域名: ${safeHost(url)}）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiViaOpenAi(config, promptText, audioBase64, mimeType, timeoutMs) {
  const oaiUrl = `${config.GEMINI_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  let oaiResp;
  try {
    oaiResp = await fetchWithTimeout(
      oaiUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.GEMINI_API_KEY}`
        },
        body: JSON.stringify({
          model: config.GEMINI_MODEL,
          temperature: 0.1,
          max_tokens: 8192,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: promptText },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${audioBase64}` } }
              ]
            }
          ]
        })
      },
      timeoutMs || config.TIMEOUT_MS || 90000
    );
  } catch (netErr) {
    throw new Error(`连接云端 API 失败 [${netErr.message}]（请检查网络/代理或稍后重试）`);
  }

  if (!oaiResp.ok) {
    const oaiErr = await oaiResp.text();
    throw new Error(`OpenAI 通道失败 (HTTP ${oaiResp.status}: ${oaiErr.slice(0, 140)})`);
  }
  const oaiData = await oaiResp.json();
  const content = oaiData?.choices?.[0]?.message?.content || "";
  const oaiFinish = oaiData?.choices?.[0]?.finish_reason || "";
  try {
    return extractJsonFromText(content);
  } catch (e) {
    throw new Error(`${e.message} (v1.0.13, oai_finish=${oaiFinish})`);
  }
}

async function callGeminiWithAudio(config, promptText, audioBase64, mimeType, thinkingBudgetOverride, forceOpenAi = false) {
  const fullTimeout = config.TIMEOUT_MS || 90000;
  const nativeTimeout = Math.min(55000, fullTimeout);

  if (forceOpenAi) {
    return await callGeminiViaOpenAi(config, promptText, audioBase64, mimeType, fullTimeout);
  }

  const nativeUrl = deriveGeminiNativeUrl(config.GEMINI_BASE_URL, config.GEMINI_MODEL, config.GEMINI_API_KEY);
  const budget = thinkingBudgetOverride !== undefined ? thinkingBudgetOverride : Number(config.THINKING_BUDGET ?? 0);
  const generationConfig = {
    temperature: 0.1,
    maxOutputTokens: 8192,
    responseMimeType: "application/json"
  };
  if (budget >= 0) {
    generationConfig.thinkingConfig = { thinkingBudget: budget };
  }
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: promptText },
          { inlineData: { mimeType, data: audioBase64 } }
        ]
      }
    ],
    generationConfig
  };

  let resp = null;
  try {
    resp = await fetchWithTimeout(
      nativeUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      },
      nativeTimeout
    );
  } catch (netErr) {
    // Native endpoint timed out or dropped -> retry with a FRESH timeout on OpenAI channel
    await cdpSleep(600);
    return await callGeminiViaOpenAi(config, promptText, audioBase64, mimeType, fullTimeout);
  }

  if (resp.ok) {
    const data = await resp.json();
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const textPart = parts
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");

    if (!textPart) {
      return await callGeminiViaOpenAi(config, promptText, audioBase64, mimeType, fullTimeout);
    }
    try {
      return extractJsonFromText(textPart);
    } catch (parseErr) {
      if (thinkingBudgetOverride === undefined) {
        return await callGeminiWithAudio(config, promptText, audioBase64, mimeType, 0, false);
      }
      return await callGeminiViaOpenAi(config, promptText, audioBase64, mimeType, fullTimeout);
    }
  }

  // Fallback to OpenAI-compatible data URI format when native channel returns 4xx/5xx
  return await callGeminiViaOpenAi(config, promptText, audioBase64, mimeType, fullTimeout);
}

async function handleFetchAudio(audioUrl) {
  if (!audioUrl) throw new Error("未检测到音频 URL");
  let resp;
  try {
    resp = await fetch(audioUrl, { credentials: "omit" });
  } catch (_) {
    try {
      resp = await fetch(audioUrl, { credentials: "include" });
    } catch (err2) {
      throw new Error(`拉取音频失败 [${err2.message}]（域名: ${safeHost(audioUrl)}，请刷新页面或检查网络/代理）`);
    }
  }
  if (!resp.ok) {
    throw new Error(`下载音频失败: HTTP ${resp.status}（域名: ${safeHost(audioUrl)}）`);
  }
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  if (/^(text\/|image\/|application\/(json|javascript|xml))/.test(ct)) {
    throw new Error(`抓到的链接不是音频文件 (Content-Type=${ct}, url=${audioUrl.slice(0, 80)})`);
  }
  const buf = await resp.arrayBuffer();
  if (buf.byteLength < 1000) {
    throw new Error(`下载到的音频异常过小 (${buf.byteLength} bytes)`);
  }
  const bytes = new Uint8Array(buf);
  const mimeType = inferMimeType(audioUrl, ct, bytes);
  const base64 = arrayBufferToBase64(buf);
  return { base64, mimeType, byteLength: buf.byteLength };
}

// Dispatch genuine trusted (isTrusted: true) mouse drag via Chrome DevTools Protocol (chrome.debugger)
const cdpSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || "";
        if (msg.includes("Already attached")) return resolve();
        return reject(new Error(msg));
      }
      resolve();
    });
  });
}

function debuggerDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

function debuggerSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res);
    });
  });
}

async function handleDebuggerDrag(tabId, { startX, endX, y }) {
  if (!tabId) throw new Error("无法获取当前标签页 ID");
  await debuggerAttach(tabId);
  try {
    const sx = Math.round(startX);
    const ex = Math.round(endX);
    const cy = Math.round(y);

    await debuggerSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: sx,
      y: cy,
      button: "none",
      buttons: 0
    });
    await cdpSleep(30);

    await debuggerSend(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: sx,
      y: cy,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await cdpSleep(30);

    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(sx + ((ex - sx) * i) / steps);
      await debuggerSend(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y: cy,
        button: "left",
        buttons: 1
      });
      await cdpSleep(16);
    }

    await debuggerSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: ex,
      y: cy,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
    await cdpSleep(180);
    return { dragged: true };
  } finally {
    await debuggerDetach(tabId);
  }
}

function normalizeAsrResponse(raw) {
  let obj = Array.isArray(raw) ? raw[0] : raw;
  if (obj && typeof obj === "object" && obj.data && typeof obj.data === "object" && !obj.asr_text) {
    obj = obj.data;
  }
  if (!obj || typeof obj !== "object") return { asr_text: "", raw };
  const asrText = String(
    obj.asr_text ?? obj["ASR-text"] ?? obj.asrText ?? obj.transcription ?? obj.transcript ?? obj.text ?? ""
  ).trim();
  return {
    asr_text: asrText,
    has_long_english_span: Boolean(obj.has_long_english_span),
    suggested_remark: String(obj.suggested_remark ?? obj.general_remark ?? obj.remark ?? "").trim(),
    diff_summary: String(obj.diff_summary ?? obj.summary ?? "").trim(),
    _raw: raw
  };
}

async function handleAnalyzeAsr({ language, refText, audioBase64, mimeType, durationSec }) {
  const config = await getEffectiveConfig();
  const prompt = `You are a professional multilingual ASR test-set annotator strictly following the "Big ASR test set SOP".

Task metadata:
- Target language code: ${language || "UNKNOWN"}
- Audio total duration: ${durationSec ? durationSec.toFixed(2) + "s" : "unknown"}
- Reference text (ref_text, for reference ONLY — may contain errors, omissions, or wrong words):
"""
${refText || ""}
"""

Strict SOP Section 4 & 11 Rules for ASR-text:
1. Transcribe the exact spoken content of the MAIN speaker based strictly on the actual audio. Do NOT blindly copy ref_text, do NOT add unspoken words, do NOT drop spoken words.
2. ASR-text MUST NOT contain normal punctuation (.,!?;:), special symbols, or Arabic numerals (0-9). Spell out all spoken numbers as natural words in the target language.
3. Mixed English rule (SOP 4.4):
   - If the target language is NOT English and only a single English word is spoken, transcribe that English word normally.
   - If there is a large, continuous English span in non-English audio, replace that entire continuous English span with exact "***" in asr_text AND note the approximate time range in suggested_remark.
4. If the audio ends mid-sentence, transcribe ONLY what is actually spoken (do not complete it).
5. Note any audio anomalies (severe noise, truncation, overlapping speakers, wrong language, unclear proper nouns, *** English spans, major ref_text mismatch) in suggested_remark using format: "MM:SS.mmm–MM:SS.mmm concise issue description". Leave suggested_remark empty "" if there are no notable issues.

Return ONLY valid JSON with this exact schema (asr_text MUST be non-empty whenever speech is audible):
{
  "asr_text": "corrected full transcription without punctuation or Arabic numerals",
  "has_long_english_span": false,
  "suggested_remark": "",
  "diff_summary": "short Chinese summary of key corrections made compared to ref_text (or '与参考文本基本一致')"
}`;

  let res = normalizeAsrResponse(await callGeminiWithAudio(config, prompt, audioBase64, mimeType));
  if (!res.asr_text) {
    // Auto-retry via OpenAI data URI channel in case upstream native channel dropped the audio attachment
    res = normalizeAsrResponse(await callGeminiWithAudio(config, prompt, audioBase64, mimeType, 256, true));
  }
  if (!res.asr_text) {
    throw new Error(`模型未返回 asr_text（原始返回：${JSON.stringify(res._raw).slice(0, 180)}）`);
  }
  delete res._raw;
  return res;
}

function normalizeAlignResponse(raw) {
  if (Array.isArray(raw)) return { utterances: raw };
  if (raw && typeof raw === "object") {
    const arr = raw.utterances || raw.segments || raw.items || raw.data?.utterances || [];
    return { utterances: Array.isArray(arr) ? arr : [] };
  }
  return { utterances: [] };
}

async function handleAlignUtterances({ language, itnText, audioBase64, mimeType, durationMs, maxUtteranceSec }) {
  const config = await getEffectiveConfig();
  const maxSec = maxUtteranceSec || config.MAX_UTTERANCE_SEC || 20;
  const prompt = `You are an expert audio-text forced alignment & utterance segmentation annotator following "Big ASR test set SOP" Sections 6 & 10.

Task metadata:
- Target language code: ${language || "UNKNOWN"}
- Audio total duration: ${durationMs} ms (${(durationMs / 1000).toFixed(3)} s)
- Maximum recommended utterance duration: ${maxSec} seconds
- Exact confirmed ITN-text (MUST be partitioned 100% losslessly):
"""
${itnText}
"""

Strict SOP Section 6 & 10 Rules (HARD CONSTRAINTS):
1. Partition the exact ITN-text above into ALL chronological utterances aligned with the audio. There is NO fixed count limit — output as many utterances as the audio actually has (e.g. 2, 3, 4, 5, 8, 12+ utterances). NEVER artificially limit the output to 2 segments!
2. Primary segmentation unit (BY SENTENCE):
   - ALWAYS split at EVERY complete sentence boundary (. ? ! 。 ？ ！ ؟). Never merge multiple sentences into one utterance.
   - Even if ITN-text has few or missing internal periods, listen to the actual audio prosody and split at EVERY natural spoken sentence / clear pause boundary.
3. Trailing unfinished half-sentence (SOP 6.1): if the audio ends with an unfinished half-sentence, keep it as its own final utterance and do NOT add a period or merge it into the previous utterance.
4. MANDATORY DURATION CAP (HARD RULE): EVERY single utterance MUST be strictly <= ${maxSec} seconds (${maxSec * 1000} ms)! NEVER output any utterance longer than ${maxSec * 1000} ms. If a single sentence exceeds ${maxSec} seconds, split it into as many segments as needed (target 5s–15s each, strictly <= ${maxSec}s) at the most natural acoustic pause / breath / clause boundary in the audio.
5. Exact text preservation (SOP 10.2): concatenating all utterance "text" fields in order (ignoring spaces/newlines) MUST equal the exact ITN-text character-for-character! Never modify words, case, punctuation, digits, or [source|output] ITN tags, and never split inside a [source|output] tag.
6. Timestamps: accurate millisecond integers (start_ms, end_ms), chronological, non-overlapping (leave at least 60ms gap between adjacent segments when possible: start_ms >= previous end_ms + 60), each segment >= 100ms and <= ${maxSec * 1000}ms, within [0, ${durationMs}].

Return ONLY valid JSON with this exact schema:
{
  "utterances": [
    { "start_ms": 120, "end_ms": 3450, "text": "exact substring from ITN-text" }
  ]
}`;

  let res = normalizeAlignResponse(await callGeminiWithAudio(config, prompt, audioBase64, mimeType));
  if (!res.utterances.length) {
    res = normalizeAlignResponse(await callGeminiWithAudio(config, prompt, audioBase64, mimeType, 256));
  }
  return res;
}

function compareSemver(a, b) {
  const pa = String(a || "0.0.0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0.0.0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

async function handleCheckUpdate() {
  const config = await getEffectiveConfig();
  const currentVersion = chrome.runtime.getManifest().version || "1.0.0";
  const checkUrl = (config.UPDATE_CHECK_URL || "").trim();
  if (!checkUrl) {
    return { configured: false, hasUpdate: false, currentVersion };
  }
  const sep = checkUrl.includes("?") ? "&" : "?";
  const resp = await fetch(`${checkUrl}${sep}_t=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`检查更新失败: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const latestVersion = String(data.version || "").trim();
  const hasUpdate = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0);
  return {
    configured: true,
    hasUpdate,
    currentVersion,
    latestVersion: latestVersion || currentVersion,
    downloadUrl: String(data.download_url || data.downloadUrl || "").trim(),
    notes: String(data.notes || "").trim()
  };
}

const NATIVE_UPDATER_HOST = "com.spesxxx.big_asr_updater";

function handlePerformAutoUpdate(downloadUrl) {
  return new Promise((resolve, reject) => {
    if (!chrome.runtime.sendNativeMessage) {
      return reject(new Error("当前浏览器不支持 Native Messaging"));
    }
    chrome.runtime.sendNativeMessage(
      NATIVE_UPDATER_HOST,
      { action: "update", download_url: downloadUrl || "" },
      (resp) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "未注册本地更新器";
          return reject(new Error(`尚未启用一键自动更新（${msg}）。请双击文件夹里的「安装一键更新_Mac.command」或「安装一键更新_Windows.bat」注册一次即可！`));
        }
        if (!resp || !resp.ok) {
          return reject(new Error(resp?.error || "本地更新器执行失败"));
        }
        resolve(resp);
        // Hot-reload the Chrome extension shortly after sending success response to the page
        setTimeout(() => {
          try {
            chrome.runtime.reload();
          } catch (_) {}
        }, 700);
      }
    );
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "FETCH_AUDIO") {
        const res = await handleFetchAudio(msg.audioUrl);
        sendResponse({ ok: true, data: res });
      } else if (msg.type === "ANALYZE_ASR") {
        const res = await handleAnalyzeAsr(msg.payload);
        sendResponse({ ok: true, data: res });
      } else if (msg.type === "ALIGN_UTTERANCES") {
        const res = await handleAlignUtterances(msg.payload);
        sendResponse({ ok: true, data: res });
      } else if (msg.type === "DEBUGGER_DRAG") {
        const res = await handleDebuggerDrag(sender?.tab?.id, msg.payload);
        sendResponse({ ok: true, data: res });
      } else if (msg.type === "CHECK_UPDATE") {
        const res = await handleCheckUpdate();
        sendResponse({ ok: true, data: res });
      } else if (msg.type === "PERFORM_AUTO_UPDATE") {
        const res = await handlePerformAutoUpdate(msg.downloadUrl);
        sendResponse({ ok: true, data: res });
      } else {
        sendResponse({ ok: false, error: "Unknown message type: " + msg.type });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // keep async message channel open
});
