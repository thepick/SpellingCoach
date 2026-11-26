const Dictation = (() => {
 const MAX_WAV_BYTES = 2 * 1024 * 1024;
 const demoPackId = 'matter-mixed';
 const legacyDemoPackId = 'matter-mixed-troy';
 const canonicalPackId = id => id === legacyDemoPackId ? demoPackId : id;
 const demoPrompts = {
  solid: ['An ice cube is a blank.', 'A form of matter that keeps its own shape.'],
  liquid: ['When you pour milk into a glass, the blank takes the shape of the glass.', 'A form of matter that flows and takes the shape of its container.'],
  gas: ['The helium blank spreads out inside the balloon.', 'A form of matter that spreads out to fill its container.'],
  melt: ['Leave an ice cube in the sun and it will blank.', 'To change from a solid to a liquid.']
 };

 function publishedClip(pack, word, type, spoken) {
  if (canonicalPackId(pack?.id) !== demoPackId || !Object.hasOwn(demoPrompts, word)) return null;
  const [cloze, definition] = demoPrompts[word];
  const sense = pack.words?.find(row => row.word === word)?.vocabulary?.definition;
  const folder = type === 'dictation' && spoken === word && (!sense || sense === definition) ? 'words' :
   ['definition-recall', 'word-bank'].includes(type) && spoken === definition ? 'definitions' :
    ['sentence-choice', 'missing-word', 'word-bank'].includes(type) && spoken === cloze ? 'cloze' : '';
  return folder ? '/demo-audio/' + demoPackId + '/' + folder + '/' + word + '.wav' : null;
 }

 const pronunciationWord = value => String(value).normalize('NFC').trim().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').toLowerCase();

 function containsTarget(sentence, word) {
  const escaped = pronunciationWord(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:^|[^\\p{L}\\p{M}\\p{N}])' + escaped +
   '(?=$|[^\\p{L}\\p{M}\\p{N}])', 'u').test(pronunciationWord(sentence));
 }

 function recordingKey(listId, word, vocabulary) {
  const target = pronunciationWord(word);
  return 'dictation:' + JSON.stringify([listId, target, vocabulary?.senseId || '',
   vocabulary?.partOfSpeech || '', vocabulary?.definition || '']);
 }

 function validateRecording(bytes) {
  if (bytes.byteLength > MAX_WAV_BYTES) throw Error('Choose a WAV file up to 2 MB.');
  const wav = new DataView(bytes);
  const invalid = () => { throw Error('Choose a complete PCM WAV recording.'); };
  if (wav.byteLength < 44 || wav.getUint32(0) !== 0x52494646 ||
      wav.getUint32(8) !== 0x57415645 || wav.getUint32(4, true) + 8 !== wav.byteLength) invalid();
  let format = false;
  let audio = false;
  for (let offset = 12; offset + 8 <= wav.byteLength;) {
   const chunk = wav.getUint32(offset);
   const size  = wav.getUint32(offset + 4, true);
   const next = offset + 8 + size + (size % 2);
   if (next > wav.byteLength) invalid();
   if (chunk === 0x666d7420) format = size >= 16 && wav.getUint16(offset + 8, true) === 1;
   if (chunk === 0x64617461) audio = size > 0;
   offset = next;
  }
  if (!format || !audio) invalid();
 }

 return { containsTarget, recordingKey, validateRecording, publishedClip, canonicalPackId, demoPackId, legacyDemoPackId, MAX_WAV_BYTES };
})();
if (typeof module === 'object' && module.exports) module.exports = Dictation;
