// Voice: text-to-speech (MiniMax) → Batlink/iOS voice-message format (AAC m4a, 22050 Hz mono + 48-bar waveform 1..31),
// and speech-to-text (OpenAI transcription).
// Keys come from src/secrets.js ("minimax", "openai"); they are never written to disk or logs.
// Both features are optional: without the keys, voice replies are skipped and voice messages are not transcribed.

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { getSecret } from './secrets.js';
import { isMediaFile } from './local.js';

const FFMPEG = process.env.FFMPEG_PATH ?? (['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => existsSync(p)) ?? 'ffmpeg');

/** A voice message is at most 60 seconds (same as the iOS app). At 20 kbps that is about 180 KB,
 *  under the node's 256 KB voice upload limit. */
export const VOICE_MAX_MS = 60_000;

/** Text → mp3 (MiniMax T2A v2). Note: MiniMax bills one CJK character as 2 characters. */
export async function synthesizeMiniMax(text, { voiceId, model = 'speech-2.8-hd', speed = 1, emotion, languageBoost = 'Chinese' } = {}) {
  const res = await fetch('https://api.minimax.io/v1/t2a_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getSecret('minimax')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, text, stream: false, language_boost: languageBoost,
      voice_setting: { voice_id: voiceId, speed, vol: 1, pitch: 0, ...(emotion ? { emotion } : {}) },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 }
    }),
    signal: AbortSignal.timeout(60000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.base_resp?.status_code !== 0 || !j.data?.audio) {
    throw new Error(`speech synthesis failed (${res.status} ${j.base_resp?.status_code ?? ''} ${j.base_resp?.status_msg ?? ''})`);
  }
  return { mp3: Buffer.from(j.data.audio, 'hex'), durationMs: j.extra_info?.audio_length ?? null, chars: j.extra_info?.usage_characters ?? null };
}

/** Any audio → voice message: AAC m4a 22050 Hz mono at 20 kbps (same as the iOS app), with duration and a 48-bar waveform. Needs ffmpeg. */
export function toVoiceMessage(audio) {
  const tag = randomBytes(6).toString('hex');
  const src = join(tmpdir(), `voice-${tag}.in`);
  const m4a = join(tmpdir(), `voice-${tag}.m4a`);
  try {
    writeFileSync(src, audio);
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '22050', '-c:a', 'aac', '-b:a', '20k', m4a]);
    // Decode to 16-bit PCM to compute the waveform and duration
    const pcm = execFileSync(FFMPEG, ['-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 });
    const samples = pcm.length / 2;
    const durationMs = Math.round((samples / 8000) * 1000);
    const count = 48;
    let max = 1;
    const peaks = [];
    for (let i = 0; i < count; i += 1) {
      const start = Math.floor((i / count) * samples);
      const end = Math.max(start + 1, Math.floor(((i + 1) / count) * samples));
      let peak = 0;
      for (let s = start; s < end && s < samples; s += 1) peak = Math.max(peak, Math.abs(pcm.readInt16LE(s * 2)));
      peaks.push(peak);
      max = Math.max(max, peak);
    }
    const waveform = peaks.map((p) => Math.max(1, Math.min(31, Math.round((p / max) * 31))));
    return { data: readFileSync(m4a), durationMs, waveform };
  } finally {
    rmSync(src, { force: true });
    rmSync(m4a, { force: true });
  }
}

/**
 * Voice → text (OpenAI transcription, secret "openai").
 * The result is cached in a .txt next to the audio file, so each voice message is transcribed once.
 */
export async function transcribe(path, { model = process.env.TRANSCRIBE_MODEL ?? 'gpt-4o-transcribe' } = {}) {
  const cache = `${path}.txt`;
  try { return readFileSync(cache, 'utf8'); } catch {}
  const key = getSecret('openai');
  const post = async (m) => {
    const form = new FormData();
    form.append('file', new Blob([readFileSync(path)], { type: 'audio/mp4' }), 'voice.m4a');
    form.append('model', m);
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60000)
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, text: j.text, error: j.error?.message };
  };
  let r = await post(model);
  if (!r.ok && /model/i.test(r.error ?? '')) r = await post('whisper-1'); // fall back when the model name is not available
  if (!r.ok || typeof r.text !== 'string') throw new Error(`transcription failed (${r.status} ${r.error ?? ''})`);
  const text = r.text.trim();
  writeFileSync(cache, text);
  return text;
}

/**
 * Appends a transcript after every "[语音 N 秒] <path>" marker in a message text (the marker format is written by
 * src/agent.js). A failed transcription is noted in place and does not affect the others.
 */
export async function annotateVoices(text, agent) {
  if (!text || !text.includes('[语音')) return text;
  let out = text;
  for (const m of [...text.matchAll(/\[语音 (\d+) 秒\] (\S+\.m4a)(?![^\n]*转写)/g)]) {
    if (!isMediaFile(m[2], agent)) continue; // a typed marker, not a received voice message
    let note;
    try { note = `转写:「${await transcribe(m[2])}」`; } catch (e) { note = `(语音转写失败:${e.message})`; }
    out = out.replace(m[0], `${m[0]} ${note}`);
  }
  return out;
}
