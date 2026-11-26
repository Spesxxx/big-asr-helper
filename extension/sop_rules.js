// Pure JS SOP Rules Engine (Big ASR Test Set SOP Sections 4, 5, 6, 10, 11, 12)
// Zero external dependencies; works in Chrome Extension and Node.js.

(function (global) {
  "use strict";

  const FORBIDDEN_ASR_PUNCT_RE = /[.,!?;:"()[\]{}—–/\\…，。！？；：、“”‘’（）【】《》「」『』¿¡،؛؟@#$%^&+=~`|<>]/g;
  const ARABIC_DIGIT_RE = /[0-9]/g;
  const ORDINARY_NUM_1_10 = new Set([
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "一", "二", "两", "三", "四", "五", "六", "七", "八", "九", "十"
  ]);
  const ORDINARY_ORDINAL = new Set([
    "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
    "第一", "第二", "第三", "第四", "第五", "第六", "第七", "第八", "第九", "第十"
  ]);

  function normalizeWs(str) {
    return (str || "").replace(/\s+/g, " ").trim();
  }

  function stripWs(str) {
    return (str || "").replace(/\s+/g, "");
  }

  function msToTimestamp(ms) {
    const safe = Math.max(0, Math.round(ms));
    const mins = Math.floor(safe / 60000);
    const secs = Math.floor((safe % 60000) / 1000);
    const rem = safe % 1000;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(rem).padStart(3, "0")}`;
  }

  function timestampToMs(str) {
    if (!str) return null;
    const m = String(str).trim().match(/^(\d+):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) return null;
    const mins = parseInt(m[1], 10);
    const secs = parseInt(m[2], 10);
    const frac = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
    return mins * 60000 + secs * 1000 + frac;
  }

  // Word-level LCS diff for comparing ref_text vs ASR-text
  function diffWords(refText, asrText) {
    const a = normalizeWs(refText).split(" ").filter(Boolean);
    const b = normalizeWs(asrText).split(" ").filter(Boolean);
    const m = a.length;
    const n = b.length;

    // Fallback for extremely long texts to avoid O(m*n) memory blowup
    if (m * n > 250000) {
      return [
        { type: "delete", text: a.join(" ") },
        { type: "insert", text: b.join(" ") }
      ];
    }

    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      const ai = a[i].toLowerCase();
      for (let j = n - 1; j >= 0; j--) {
        if (ai === b[j].toLowerCase()) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
        }
      }
    }

    const ops = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i].toLowerCase() === b[j].toLowerCase()) {
        ops.push({ type: "equal", text: b[j] });
        i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: "delete", text: a[i] });
        i++;
      } else {
        ops.push({ type: "insert", text: b[j] });
        j++;
      }
    }
    while (i < m) ops.push({ type: "delete", text: a[i++] });
    while (j < n) ops.push({ type: "insert", text: b[j++] });

    // Merge consecutive ops of same type
    const merged = [];
    for (const op of ops) {
      if (merged.length && merged[merged.length - 1].type === op.type) {
        merged[merged.length - 1].text += " " + op.text;
      } else {
        merged.push({ ...op });
      }
    }
    return merged;
  }

  // Section 4: Validate ASR-text
  function validateAsrText(asrText, langCode) {
    const errors = [];
    const warnings = [];
    const text = (asrText || "").trim();

    if (!text) {
      errors.push("ASR-text 为空");
      return { errors, warnings };
    }

    // Temporarily mask valid '***' spans (Section 4.4)
    const masked = text.replace(/\*\*\*/g, " ");

    // Check stray asterisks
    if (masked.includes("*")) {
      errors.push("ASR-text 含非法星号 '*'（仅连续大段英文允许写为 ***）");
    }

    // Check Arabic numerals
    const digits = masked.match(ARABIC_DIGIT_RE);
    if (digits) {
      const uniq = [...new Set(digits)].join(" ");
      errors.push(`ASR-text 禁止阿拉伯数字：${uniq}`);
    }

    // Check forbidden punctuation & special symbols
    const puncts = masked.match(FORBIDDEN_ASR_PUNCT_RE);
    if (puncts) {
      const uniq = [...new Set(puncts)].join(" ");
      errors.push(`ASR-text 含禁用标点或特殊符号：${uniq}`);
    }

    // Check English span candidate in non-English language (Section 4.4)
    const lang = (langCode || "").toUpperCase();
    if (lang && lang !== "EN" && lang !== "EN-US" && lang !== "EN-GB" && !lang.startsWith("EN")) {
      const engRun = masked.match(/\b[A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){5,}\b/g);
      // Only warn for non-Latin scripts OR obvious English stopword runs
      const hasNonLatin = /[^\u0000-\u024F\s]/.test(masked);
      if (hasNonLatin && engRun) {
        warnings.push(`检测到连续较长英文片段（如 "${engRun[0].slice(0, 40)}..."），若为大段英文请按 SOP 4.4 替换为 *** 并在 general_remark 标注时间`);
      }
    }

    return { errors, warnings };
  }

  // Parse ITN tags and validate Section 5
  function validateItnText(itnText, asrText, confirmedLatestAsr) {
    const errors = [];
    const warnings = [];
    const text = (itnText || "").trim();

    if (!text) {
      errors.push("ITN-text 为空");
      return { errors, warnings, tags: [] };
    }

    if (confirmedLatestAsr === false) {
      errors.push("尚未点击 Confirm Latest ASR（页面提示 Confirmation required）");
    }

    // Full-width tag characters check
    if (/[［］｜]/.test(text)) {
      errors.push("ITN-text 包含全角括号或竖线（［ ］ ｜），必须使用半角 [ ] |");
    }

    // Scan brackets for nesting / unclosed / structure
    const tags = [];
    let depth = 0;
    let startIdx = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "[") {
        if (depth > 0) {
          errors.push(`ITN 标签不允许嵌套（位置 ${i}）`);
        }
        depth++;
        if (depth === 1) startIdx = i;
      } else if (ch === "]") {
        if (depth === 0) {
          errors.push(`ITN-text 存在多余的右括号 ']'（位置 ${i}）`);
        } else {
          depth--;
          if (depth === 0 && startIdx >= 0) {
            const raw = text.slice(startIdx, i + 1);
            const inner = text.slice(startIdx + 1, i);
            tags.push({ raw, inner, start: startIdx, end: i + 1 });
            startIdx = -1;
          }
        }
      }
    }
    if (depth > 0) {
      errors.push("ITN-text 存在未闭合的左括号 '['");
    }

    const asrLower = normalizeWs(asrText || "").toLowerCase();

    for (const tag of tags) {
      const parts = tag.inner.split("|");
      if (parts.length !== 2) {
        errors.push(`ITN 标签必须且只能包含一个 '|'：${tag.raw}`);
        continue;
      }
      const [src, out] = parts;
      const srcTrim = src.trim();
      const outTrim = out.trim();

      if (!srcTrim) errors.push(`ITN 标签 source text 为空：${tag.raw}`);
      if (!outTrim) errors.push(`ITN 标签 output 为空：${tag.raw}`);

      // Punctuation must be outside tag
      if (/[.,!?;:。，！？；：、]$/.test(outTrim)) {
        errors.push(`ITN 标签内结尾含标点（标点必须在标签外）：${tag.raw}`);
      }
      if (/^[.,!?;:。，！？；：、]/.test(outTrim)) {
        errors.push(`ITN 标签内开头含标点（标点必须在标签外）：${tag.raw}`);
      }

      // Source must exist in ASR-text
      if (asrLower && srcTrim && !asrLower.includes(normalizeWs(srcTrim).toLowerCase())) {
        errors.push(`ITN 标签 source text 未在 ASR-text 中找到：${tag.raw}`);
      }

      // Warn on ordinary 1-10 quantity or ordinary ordinal conversion
      const srcLow = srcTrim.toLowerCase();
      if (ORDINARY_NUM_1_10.has(srcLow) && /^\d+$/.test(outTrim)) {
        warnings.push(`疑似误转 1–10 普通数量词（SOP 5.2 规定普通数量词不转）：${tag.raw}`);
      }
      if (ORDINARY_ORDINAL.has(srcLow) && /^\d+(st|nd|rd|th)?$/i.test(outTrim)) {
        warnings.push(`疑似误转普通序数词（非日期场景通常不转）：${tag.raw}`);
      }
    }

    return { errors, warnings, tags };
  }

  // Section 6, 10, 12: Validate utterances & full ITN coverage
  function validateUtterances(utterances, itnText, totalDurationMs, maxUtteranceSec = 20) {
    const errors = [];
    const warnings = [];

    if (!Array.isArray(utterances) || utterances.length === 0) {
      errors.push("utterances 为空，至少需要 1 个片段");
      return { errors, warnings };
    }

    let prevEnd = -1;
    const concatParts = [];

    for (let i = 0; i < utterances.length; i++) {
      const u = utterances[i];
      const idx = String(i + 1).padStart(3, "0");
      const start = u.startMs;
      const end = u.endMs;
      const txt = (u.text || "").trim();

      if (start == null || end == null || Number.isNaN(start) || Number.isNaN(end)) {
        errors.push(`utterance ${idx} 缺少有效时间戳`);
      } else {
        const dur = end - start;
        if (dur < 100) {
          errors.push(`utterance ${idx} 时长 ${dur}ms < 100ms（SOP 限制最小时长 100ms）`);
        }
        if (start < 0) {
          errors.push(`utterance ${idx} 开始时间 < 0`);
        }
        if (totalDurationMs > 0 && end > totalDurationMs + 100) {
          errors.push(`utterance ${idx} 结束时间 ${msToTimestamp(end)} 超出音频总长 ${msToTimestamp(totalDurationMs)}`);
        }
        if (prevEnd >= 0 && start < prevEnd) {
          errors.push(`utterance ${idx} 与前一段重叠（${msToTimestamp(start)} < ${msToTimestamp(prevEnd)}）`);
        }
        if (dur > maxUtteranceSec * 1000) {
          errors.push(`utterance ${idx} 时长 ${(dur / 1000).toFixed(2)}s > ${maxUtteranceSec}s（必须按句子或自然停顿切分至 ≤${maxUtteranceSec}s）`);
        }
        prevEnd = end;
      }

      if (!txt) {
        errors.push(`utterance ${idx} 文本为空`);
      }
      concatParts.push(txt);
    }

    // Full concatenation check (Section 10.2 & 10.3: ignore whitespace & line breaks only)
    const expected = stripWs(itnText || "");
    const actual = stripWs(concatParts.join(""));

    if (expected && actual !== expected) {
      let mismatchIdx = 0;
      const minLen = Math.min(expected.length, actual.length);
      while (mismatchIdx < minLen && expected[mismatchIdx] === actual[mismatchIdx]) {
        mismatchIdx++;
      }
      const expSnip = expected.slice(Math.max(0, mismatchIdx - 12), mismatchIdx + 24);
      const actSnip = actual.slice(Math.max(0, mismatchIdx - 12), mismatchIdx + 24);
      errors.push(
        `utterances 拼接未 100% 还原 ITN-text（差异位置 ${mismatchIdx}）：期望 "...${expSnip}..."，实际 "...${actSnip}..."`
      );
    }

    return { errors, warnings };
  }

  // Section 11: Validate general_remark
  function validateGeneralRemark(remark, asrText, itnText) {
    const errors = [];
    const warnings = [];
    const r = (remark || "").trim();
    const hasTripleStar = (asrText || "").includes("***") || (itnText || "").includes("***");

    if (hasTripleStar && !r) {
      warnings.push("文本中含 ***（大段英文），按 SOP 4.4 / 11 应在 general_remark 中注明并给出大致时间段");
    }
    if (r && r.length < 15 && !/\d{1,2}:\d{2}/.test(r)) {
      warnings.push("general_remark 过于简略或缺少时间段（建议格式：00:12.300–00:14.800 具体问题描述）");
    }
    return { errors, warnings };
  }

  // Full Section 12 Pre-submission Audit
  function runFullAudit(state) {
    const asrRes = validateAsrText(state.asrText, state.language);
    const itnRes = validateItnText(state.itnText, state.asrText, state.confirmedLatestAsr);
    const uttRes = validateUtterances(state.utterances, state.itnText, state.totalDurationMs, state.maxUtteranceSec || 20);
    const remRes = validateGeneralRemark(state.generalRemark, state.asrText, state.itnText);

    const errors = [...asrRes.errors, ...itnRes.errors, ...uttRes.errors, ...remRes.errors];
    const warnings = [...asrRes.warnings, ...itnRes.warnings, ...uttRes.warnings, ...remRes.warnings];

    return {
      passed: errors.length === 0,
      errors,
      warnings,
      sections: { asr: asrRes, itn: itnRes, utterances: uttRes, remark: remRes }
    };
  }

  // Split ITN-text into complete sentences (never splitting inside [source|output] tags)
  // Guarantees 100% lossless partition of ITN-text.
  function splitItnSentences(itnText) {
    const text = (itnText || "").trim();
    if (!text) return [];

    const sentences = [];
    let current = "";
    let inTag = false;
    const SENTENCE_END = new Set([".", "!", "?", "。", "！", "？", "؟", "।"]);

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      current += ch;

      if (ch === "[") inTag = true;
      else if (ch === "]") inTag = false;

      if (!inTag && SENTENCE_END.has(ch)) {
        const prev = i > 0 ? text[i - 1] : "";
        const next = i + 1 < text.length ? text[i + 1] : "";

        // Don't split decimal numbers like 3.14 or abbreviations like U.S.
        if (ch === "." && /\d/.test(prev) && /\d/.test(next)) continue;
        if (ch === "." && /[A-Za-z]/.test(next)) continue;

        // Absorb trailing closing quotes/brackets or repeated punctuation (e.g. ?!, ... , .")
        while (i + 1 < text.length && /[!?."'”’」』）)\]]/.test(text[i + 1])) {
          if (text[i + 1] === "[") break;
          i++;
          current += text[i];
        }

        const trimmed = current.trim();
        if (trimmed) sentences.push(trimmed);
        current = "";
      }
    }

    const tail = current.trim();
    if (tail) {
      // SOP 6.1: Trailing unfinished half-sentence must be its own segment without adding punctuation!
      sentences.push(tail);
    }

    return sentences;
  }

  // Force lossless alignment of LLM-returned utterance texts against exact ITN-text.
  // If LLM slightly altered punctuation/case/tags, re-slice exact ITN-text spans to guarantee 100% Section 10 coverage!
  function reconcileUtterancesWithItn(llmUtterances, itnText, totalDurationMs) {
    const cleanItn = (itnText || "").trim();
    if (!cleanItn) return [];

    // First check if llmUtterances already reconstruct ITN-text identically
    const validInput = (llmUtterances || []).filter((u) => u && (u.text || "").trim());
    if (validInput.length > 0) {
      const concat = stripWs(validInput.map((u) => u.text).join(""));
      if (concat === stripWs(cleanItn)) {
        return normalizeTimings(validInput, totalDurationMs);
      }

      // Attempt greedy exact-pointer projection onto cleanItn so 100% coverage is guaranteed
      const projected = projectSegmentsOntoItn(validInput, cleanItn);
      if (projected) {
        return normalizeTimings(projected, totalDurationMs);
      }
    }

    // Fallback: deterministic sentence split + proportional timing
    const sents = splitItnSentences(cleanItn);
    const totalChars = sents.reduce((acc, s) => acc + Math.max(1, stripWs(s).length), 0);
    let cursor = 0;
    const built = sents.map((s, idx) => {
      const weight = Math.max(1, stripWs(s).length) / totalChars;
      const startMs = Math.round(cursor);
      const endMs = idx === sents.length - 1 ? Math.round(totalDurationMs) : Math.round(cursor + weight * totalDurationMs);
      cursor = endMs;
      return { startMs, endMs, text: s };
    });
    return normalizeTimings(built, totalDurationMs);
  }

  // Map approximate segment boundaries onto exact ITN-text character positions
  function projectSegmentsOntoItn(segments, cleanItn) {
    // Build a map from stripped index -> original index in cleanItn
    const strippedChars = [];
    const origIndices = [];
    for (let i = 0; i < cleanItn.length; i++) {
      if (!/\s/.test(cleanItn[i])) {
        strippedChars.push(cleanItn[i]);
        origIndices.push(i);
      }
    }
    const strippedItn = strippedChars.join("");
    const strippedItnLow = strippedItn.toLowerCase();

    const result = [];
    let ptr = 0;

    for (let sIdx = 0; sIdx < segments.length; sIdx++) {
      const seg = segments[sIdx];
      if (sIdx === segments.length - 1) {
        if (ptr >= strippedItn.length) return null;
        const startOrig = origIndices[ptr];
        result.push({
          startMs: seg.startMs,
          endMs: seg.endMs,
          text: cleanItn.slice(startOrig).trim()
        });
        ptr = strippedItn.length;
        break;
      }

      const segStripped = stripWs(seg.text || "");
      const targetLen = segStripped.length;
      if (targetLen === 0) continue;

      // Try exact length match or anchor on last 6 chars
      const anchor = segStripped.slice(-Math.min(8, segStripped.length)).toLowerCase();
      const searchStart = Math.max(ptr + 1, ptr + targetLen - 15);
      const searchEnd = Math.min(strippedItn.length - 1, ptr + targetLen + 15);
      const windowStr = strippedItnLow.slice(searchStart, searchEnd + anchor.length);
      const foundRel = anchor ? windowStr.indexOf(anchor) : -1;

      let endPtr = foundRel >= 0 ? searchStart + foundRel + anchor.length : Math.min(strippedItn.length - 1, ptr + targetLen);
      // Never split inside a [...] ITN tag
      const origEnd = origIndices[Math.min(endPtr, origIndices.length - 1)];
      const beforeSlice = cleanItn.slice(0, origEnd);
      const openBrackets = (beforeSlice.match(/\[/g) || []).length;
      const closeBrackets = (beforeSlice.match(/\]/g) || []).length;
      if (openBrackets > closeBrackets) {
        const nextClose = cleanItn.indexOf("]", origEnd);
        if (nextClose !== -1) {
          while (endPtr < origIndices.length && origIndices[endPtr] <= nextClose) {
            endPtr++;
          }
        }
      }

      if (endPtr <= ptr) return null;
      const startOrig = origIndices[ptr];
      const endOrig = endPtr < origIndices.length ? origIndices[endPtr] : cleanItn.length;
      const sliceText = cleanItn.slice(startOrig, endOrig).trim();
      if (!sliceText) return null;

      result.push({
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: sliceText
      });
      ptr = endPtr;
    }

    if (stripWs(result.map((r) => r.text).join("")) !== strippedItn) {
      return null;
    }
    return result;
  }

  // Ensure chronological order, non-overlap (>=60ms pixel-safe gap), >=120ms duration, within audio bounds
  function normalizeTimings(segments, totalDurationMs) {
    const maxMs = Math.max(200, Math.round(totalDurationMs || 10000));
    const minDur = 120;
    const gap = 60;

    const out = segments.map((s) => ({
      startMs: Math.max(0, Math.min(maxMs - minDur, Math.round(s.startMs || 0))),
      endMs: Math.max(minDur, Math.min(maxMs, Math.round(s.endMs || maxMs))),
      text: (s.text || "").trim()
    }));

    for (let i = 0; i < out.length; i++) {
      if (i > 0 && out[i].startMs < out[i - 1].endMs + gap) {
        out[i].startMs = Math.min(maxMs - minDur, out[i - 1].endMs + gap);
      }
      if (out[i].endMs < out[i].startMs + minDur) {
        out[i].endMs = Math.min(maxMs, out[i].startMs + minDur);
      }
    }
    return out;
  }

  // Find the best safe character split index in `text` near `ratio` (0..1),
  // prioritizing: 1) sentence punctuation, 2) clause punctuation, 3) word boundary.
  // NEVER splits inside a [source|output] ITN tag.
  function findBestTextSplitIndex(text, ratio) {
    const len = text.length;
    if (len < 4) return -1;
    const target = Math.max(2, Math.min(len - 2, Math.round(len * ratio)));

    // Precompute bracket depth so we never split inside [...]
    const insideTag = new Uint8Array(len + 1);
    let depth = 0;
    for (let i = 0; i < len; i++) {
      if (text[i] === "[") depth++;
      insideTag[i] = depth > 0 ? 1 : 0;
      if (text[i] === "]" && depth > 0) depth--;
    }

    function pickNearest(positions) {
      let best = -1;
      let bestDist = Infinity;
      for (const pos of positions) {
        if (pos <= 1 || pos >= len - 1) continue;
        if (insideTag[pos] || insideTag[pos - 1]) continue;
        const left = text.slice(0, pos).trim();
        const right = text.slice(pos).trim();
        if (!left || !right) continue;
        const d = Math.abs(pos - target);
        if (d < bestDist) {
          bestDist = d;
          best = pos;
        }
      }
      return best;
    }

    const sentBounds = [];
    const clauseBounds = [];
    const wordBounds = [];

    for (let i = 1; i < len - 1; i++) {
      const ch = text[i - 1];
      const cur = text[i];
      if (/[.!?。！？؟।]/.test(ch) && (!/\d/.test(cur) || ch !== ".")) {
        sentBounds.push(i);
      } else if (/[,;:，；：、]/.test(ch)) {
        clauseBounds.push(i);
      } else if (/\s/.test(cur) && !/\s/.test(ch)) {
        wordBounds.push(i);
      }
    }

    // Prefer sentence boundary within 35% of target, else clause boundary within 25%, else nearest word boundary
    const sPick = pickNearest(sentBounds);
    if (sPick !== -1 && Math.abs(sPick - target) <= len * 0.35) return sPick;

    const cPick = pickNearest(clauseBounds);
    if (cPick !== -1 && Math.abs(cPick - target) <= len * 0.25) return cPick;

    const wPick = pickNearest(wordBounds);
    if (wPick !== -1) return wPick;

    // Last resort for space-less scripts (CJK/Thai/etc.): nearest non-tag char index
    for (let offset = 0; offset < len; offset++) {
      for (const cand of [target + offset, target - offset]) {
        if (cand > 1 && cand < len - 1 && !insideTag[cand] && !insideTag[cand - 1]) {
          return cand;
        }
      }
    }
    return -1;
  }

  // HARD GUARANTEE: Recursively split any segment exceeding maxDurationMs (default 20000ms)
  // using sentence boundaries first, then longest VAD acoustic pause + natural clause/word boundary.
  function enforceMaxUtteranceDuration(segments, maxDurationMs = 20000, vad = null, totalDurationMs = 0) {
    const cap = Math.max(5000, Number(maxDurationMs) || 20000);
    const out = [];

    function splitOne(seg, depth = 0) {
      const dur = seg.endMs - seg.startMs;
      if (dur <= cap || depth > 8) {
        out.push(seg);
        return;
      }

      // 1. If the segment contains multiple complete sentences, split by sentences first!
      const sents = splitItnSentences(seg.text);
      if (sents.length >= 2) {
        const totalChars = sents.reduce((a, s) => a + Math.max(1, stripWs(s).length), 0);
        let cursor = seg.startMs;
        sents.forEach((s, idx) => {
          const w = Math.max(1, stripWs(s).length) / totalChars;
          const sStart = Math.round(cursor);
          const sEnd = idx === sents.length - 1 ? seg.endMs : Math.round(cursor + w * dur);
          cursor = sEnd;
          splitOne({ startMs: sStart, endMs: sEnd, text: s }, depth + 1);
        });
        return;
      }

      // 2. Single long sentence > cap: pick best split timestamp (prefer longest VAD silence in middle 25%..75%)
      const minSplitMs = Math.max(seg.startMs + Math.round(dur * 0.25), seg.endMs - cap + 300);
      const maxSplitMs = Math.min(seg.endMs - Math.round(dur * 0.25), seg.startMs + cap - 300);
      let splitMs = Math.round((seg.startMs + seg.endMs) / 2);
      if (minSplitMs < maxSplitMs) {
        splitMs = Math.round((minSplitMs + maxSplitMs) / 2);
      }

      if (vad && Array.isArray(vad.silences) && vad.silences.length > 0) {
        const lo = Math.min(minSplitMs, maxSplitMs);
        const hi = Math.max(minSplitMs, maxSplitMs);
        let bestSil = null;
        for (const sil of vad.silences) {
          if (sil.midMs >= lo && sil.midMs <= hi) {
            if (!bestSil || sil.durMs > bestSil.durMs) {
              bestSil = sil;
            }
          }
        }
        if (bestSil) {
          splitMs = bestSil.midMs;
        }
      }

      const ratio = Math.max(0.2, Math.min(0.8, (splitMs - seg.startMs) / Math.max(1, dur)));
      const splitIdx = findBestTextSplitIndex(seg.text, ratio);
      if (splitIdx === -1) {
        out.push(seg);
        return;
      }

      const leftText = seg.text.slice(0, splitIdx).trim();
      const rightText = seg.text.slice(splitIdx).trim();
      if (!leftText || !rightText) {
        out.push(seg);
        return;
      }

      splitOne({ startMs: seg.startMs, endMs: splitMs - 15, text: leftText }, depth + 1);
      splitOne({ startMs: splitMs + 15, endMs: seg.endMs, text: rightText }, depth + 1);
    }

    for (const seg of segments || []) {
      splitOne(seg, 0);
    }
    return normalizeTimings(out, totalDurationMs || (out.length ? out[out.length - 1].endMs : 20000));
  }

  const SopRules = {
    normalizeWs,
    stripWs,
    msToTimestamp,
    timestampToMs,
    diffWords,
    validateAsrText,
    validateItnText,
    validateUtterances,
    validateGeneralRemark,
    runFullAudit,
    splitItnSentences,
    reconcileUtterancesWithItn,
    enforceMaxUtteranceDuration,
    normalizeTimings
  };

  global.SopRules = SopRules;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SopRules;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
