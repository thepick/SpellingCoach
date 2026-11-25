import { ApiError } from './validation.mjs';

const MAX_WAV_BYTES = 1024 * 1024;
const unavailable = () => new ApiError(502, 'dictation_unavailable', 'WordLab could not create a recording.');
function providerFailure(response) {
  if (response.status === 401 || response.status === 403) return new ApiError(response.status,'provider_auth','The audio provider rejected this key. Replace or reconnect the key.');
  if (response.status >= 400 && response.status < 500) return new ApiError(response.status,'provider_request','The audio provider rejected the request or account. Check the key, account balance, and input.');
  return unavailable();
}

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

export async function synthesizeDictation(key, sentence, fetchRequest = fetch) {
  if (typeof sentence !== 'string' || !sentence.length || sentence.length > 200) throw new ApiError(400,'invalid_input','Audio text must contain 1–200 characters.');
  let response;
  try {
    response = await fetchRequest('https://openrouter.ai/api/v1/audio/speech',{
      method:'POST',redirect:'manual',signal:AbortSignal.timeout(25000),
      headers:{Authorization:'Bearer ' + key,'Content-Type':'application/json'},
      body:JSON.stringify({model:'mistralai/voxtral-mini-tts-2603',voice:'en_paul_neutral',input:sentence,response_format:'pcm',provider:{data_collection:'deny'}})
    });
  } catch { throw unavailable(); }
  if (response.status === 429) throw new ApiError(429,'dictation_rate_limit','Paul audio is busy. Try again later.');
  if (!response.ok) throw providerFailure(response);
  if (!response.body) throw unavailable();
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!/^audio\/(?:pcm|L16)(?:;|$)/i.test(contentType)) throw unavailable();
  const rate = /(?:^|;)\s*(?:rate|samplerate)\s*=\s*"?(\d+)/i.exec(contentType)?.[1];
  const channels = /(?:^|;)\s*channels\s*=\s*"?(\d+)/i.exec(contentType)?.[1];
  // Mistral's Voxtral TTS 2603 params/demo specify 24 kHz mono PCM; reject conflicting response metadata.
  if (rate && rate !== '24000' || channels && channels !== '1' || /^audio\/L16/i.test(contentType)) throw unavailable();
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const {done,value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_WAV_BYTES - 44) { await reader.cancel(); throw unavailable(); }
    chunks.push(value);
  }
  if (size < 2 || size % 2) throw unavailable();
  const bytes = new Uint8Array(44+size), view = new DataView(bytes.buffer);
  for (const [at,text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']]) bytes.set(new TextEncoder().encode(text),at);
  view.setUint32(4,36+size,true); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,24000,true); view.setUint32(28,48000,true); view.setUint16(32,2,true); view.setUint16(34,16,true); view.setUint32(40,size,true);
  let offset = 44;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  return finishStreamedWav(bytes);
}
