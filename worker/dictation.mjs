import { ApiError } from './validation.mjs';

const MAX_WAV_BYTES = 1024 * 1024;
const unavailable = () => new ApiError(502, 'dictation_unavailable', 'WordLab could not create a recording.');

export function finishStreamedWav(bytes) {
  const wav = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (wav.byteLength < 44 || wav.getUint32(0) !== 0x52494646 || wav.getUint32(8) !== 0x57415645) throw unavailable();
  let pcm = false;
  for (let offset = 12; offset + 8 <= wav.byteLength;) {
    const chunk = wav.getUint32(offset);
    const size = wav.getUint32(offset + 4, true);
    if (chunk === 0x666d7420 && size >= 16) pcm = wav.getUint16(offset + 8, true) === 1;
    if (chunk === 0x64617461) {
      const dataBytes = size === 0xffffffff ? wav.byteLength - offset - 8 : size;
      if (!pcm || dataBytes < 2 || offset + 8 + dataBytes > wav.byteLength) throw unavailable();
      wav.setUint32(offset + 4, dataBytes, true);
      wav.setUint32(4, wav.byteLength - 8, true);
      return bytes;
    }
    offset += 8 + size + (size % 2);
  }
  throw unavailable();
}

export function hasSpeechSignal(bytes) {
  finishStreamedWav(bytes);
  const wav = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset + 8 <= wav.byteLength;) {
    const length = wav.getUint32(offset + 4, true);
    if (wav.getUint32(offset) === 0x64617461) {
      let squares = 0, nonzero = 0, count = 0;
      for (let at = offset + 8; at + 1 < offset + 8 + length; at += 2) {
        const sample = wav.getInt16(at, true);
        squares += sample * sample;
        if (sample) nonzero++;
        count++;
      }
      return nonzero >= count * .35 && squares >= count * 360000;
    }
    offset += 8 + length + (length % 2);
  }
  return false;
}

export async function synthesizeDictation(key, sentence) {
  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(25000),
      headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
      body: JSON.stringify({model: 'canopylabs/orpheus-v1-english', voice: 'troy', input: sentence, response_format: 'wav'})
    });
  } catch { throw unavailable(); }
  if (response.status === 429) throw new ApiError(429, 'dictation_rate_limit', 'Groq’s audio allowance is busy. Try again later.');
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_WAV_BYTES) { await reader.cancel(); throw unavailable(); }
      chunks.push(value);
    }
  } catch { throw unavailable(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return finishStreamedWav(bytes);
}
