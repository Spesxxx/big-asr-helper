// Web Audio API Acoustic Energy & Silence/Pause Analyzer
// Runs 100% locally in the browser (zero ffmpeg/Python required).
// Used to snap LLM-predicted timestamps to exact speech onset/offset boundaries.

(function (global) {
  "use strict";

  const FRAME_MS = 10; // 10ms resolution

  async function analyzeAudioArrayBuffer(arrayBuffer) {
    const AudioCtx = global.AudioContext || global.webkitAudioContext;
    if (!AudioCtx) {
      return null;
    }
    const ctx = new AudioCtx();
    try {
      // Slice buffer because decodeAudioData detaches it
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const durationMs = Math.round(audioBuffer.duration * 1000);
      const sampleRate = audioBuffer.sampleRate;
      const samplesPerFrame = Math.max(1, Math.floor((sampleRate * FRAME_MS) / 1000));
      const channelData = audioBuffer.getChannelData(0);
      const numFrames = Math.ceil(channelData.length / samplesPerFrame);
      const rms = new Float32Array(numFrames);

      let maxRms = 0;
      for (let f = 0; f < numFrames; f++) {
        const start = f * samplesPerFrame;
        const end = Math.min(channelData.length, start + samplesPerFrame);
        let sumSq = 0;
        for (let i = start; i < end; i++) {
          const v = channelData[i];
          sumSq += v * v;
        }
        const val = Math.sqrt(sumSq / Math.max(1, end - start));
        rms[f] = val;
        if (val > maxRms) maxRms = val;
      }

      // Adaptive noise floor threshold (15th percentile * 2.2, clamped)
      const sorted = Array.from(rms).sort((a, b) => a - b);
      const p15 = sorted[Math.floor(sorted.length * 0.15)] || 0.001;
      const p90 = sorted[Math.floor(sorted.length * 0.90)] || 0.05;
      const threshold = Math.max(0.004, Math.min(p90 * 0.22, p15 * 2.4 + 0.003));

      // Detect silence regions (>= 120ms)
      const silences = [];
      let silStart = -1;
      for (let f = 0; f < numFrames; f++) {
        if (rms[f] < threshold) {
          if (silStart === -1) silStart = f;
        } else if (silStart !== -1) {
          const durMs = (f - silStart) * FRAME_MS;
          if (durMs >= 120) {
            silences.push({
              startMs: silStart * FRAME_MS,
              endMs: f * FRAME_MS,
              midMs: Math.round(((silStart + f) / 2) * FRAME_MS),
              durMs
            });
          }
          silStart = -1;
        }
      }
      if (silStart !== -1) {
        const durMs = (numFrames - silStart) * FRAME_MS;
        if (durMs >= 120) {
          silences.push({
            startMs: silStart * FRAME_MS,
            endMs: durationMs,
            midMs: Math.round(((silStart + numFrames) / 2) * FRAME_MS),
            durMs
          });
        }
      }

      // Re-encode to compact mono PCM WAV whenever audio >800KB, high sample rate, or multi-channel
      let compactWavBase64 = null;
      let compactBytes = 0;
      try {
        if (arrayBuffer.byteLength > 800000 || audioBuffer.sampleRate > 16000 || audioBuffer.numberOfChannels > 1) {
          const targetRate = audioBuffer.duration > 60 ? 8000 : audioBuffer.duration > 35 ? 12000 : 16000;
          const resampled = await resampleMono(audioBuffer, targetRate);
          const wavBuf = encodePcm16Wav(resampled, targetRate);
          compactBytes = wavBuf.byteLength;
          compactWavBase64 = arrayBufferToBase64(wavBuf);
        }
      } catch (e) {
        console.warn("[ASR Helper] compact WAV re-encode skipped:", e);
      }

      return { durationMs, frameMs: FRAME_MS, rms, threshold, silences, compactWavBase64, compactBytes };
    } finally {
      try {
        await ctx.close();
      } catch (_) {}
    }
  }

  async function resampleMono(audioBuffer, targetRate) {
    const OfflineCtx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    const targetLen = Math.max(1, Math.ceil(audioBuffer.duration * targetRate));
    if (OfflineCtx) {
      const offline = new OfflineCtx(1, targetLen, targetRate);
      const src = offline.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(offline.destination);
      src.start(0);
      const rendered = await offline.startRendering();
      return rendered.getChannelData(0);
    }
    // Simple linear decimation fallback
    const srcData = audioBuffer.getChannelData(0);
    const out = new Float32Array(targetLen);
    const ratio = srcData.length / targetLen;
    for (let i = 0; i < targetLen; i++) {
      out[i] = srcData[Math.min(srcData.length - 1, Math.floor(i * ratio))];
    }
    return out;
  }

  function encodePcm16Wav(samples, sampleRate) {
    const numSamples = samples.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, numSamples * 2, true);
    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return buffer;
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

  // Snap segment boundaries to nearest natural silence/speech onset within +/- searchWindowMs
  function refineSegmentsWithVad(segments, vad, searchWindowMs = 600) {
    if (!vad || !vad.rms || !segments || segments.length === 0) return segments;
    const { rms, threshold, frameMs, durationMs, silences } = vad;

    function isSpeech(ms) {
      const f = Math.max(0, Math.min(rms.length - 1, Math.floor(ms / frameMs)));
      return rms[f] >= threshold;
    }

    function findNearestSilenceMid(targetMs, minMs, maxMs) {
      let best = null;
      let bestScore = Infinity;
      for (const s of silences) {
        if (s.midMs < minMs || s.midMs > maxMs) continue;
        const dist = Math.abs(s.midMs - targetMs);
        if (dist <= searchWindowMs) {
          // Prefer closer and longer pauses
          const score = dist - Math.min(200, s.durMs * 0.4);
          if (score < bestScore) {
            bestScore = score;
            best = s;
          }
        }
      }
      return best;
    }

    // Refine inter-segment boundaries first using silence midpoints
    const refined = segments.map((s) => ({ ...s }));
    for (let i = 0; i < refined.length - 1; i++) {
      const boundary = Math.round((refined[i].endMs + refined[i + 1].startMs) / 2);
      const minB = refined[i].startMs + 200;
      const maxB = refined[i + 1].endMs - 200;
      const sil = findNearestSilenceMid(boundary, minB, maxB);
      if (sil) {
        // Place end just after speech ends, start just before next speech begins (with 30ms padding)
        const pad = Math.min(40, Math.floor(sil.durMs / 3));
        refined[i].endMs = Math.min(sil.midMs - 10, sil.startMs + pad);
        refined[i + 1].startMs = Math.max(sil.midMs + 10, sil.endMs - pad);
      }
    }

    // Refine very first segment start (trim leading silence, keep 40ms onset cushion)
    if (refined.length > 0) {
      let f = Math.max(0, Math.floor((refined[0].startMs - searchWindowMs) / frameMs));
      const fMax = Math.min(rms.length - 1, Math.floor((refined[0].startMs + searchWindowMs) / frameMs));
      while (f < fMax && !isSpeech(f * frameMs)) f++;
      if (isSpeech(f * frameMs)) {
        refined[0].startMs = Math.max(0, f * frameMs - 40);
      }
    }

    // Refine very last segment end (trim trailing silence, keep 60ms tail cushion)
    if (refined.length > 0) {
      const last = refined[refined.length - 1];
      let f = Math.min(rms.length - 1, Math.floor((last.endMs + searchWindowMs) / frameMs));
      const fMin = Math.max(0, Math.floor((last.endMs - searchWindowMs) / frameMs));
      while (f > fMin && !isSpeech(f * frameMs)) f--;
      if (isSpeech(f * frameMs)) {
        last.endMs = Math.min(durationMs, f * frameMs + 60);
      }
    }

    return global.SopRules ? global.SopRules.normalizeTimings(refined, durationMs) : refined;
  }

  global.AudioVad = {
    analyzeAudioArrayBuffer,
    refineSegmentsWithVad
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
