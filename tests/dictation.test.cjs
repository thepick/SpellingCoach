const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { containsTarget, recordingKey, validateRecording, publishedClip } = require('../src/dictation.js');

test('recordings are scoped to a list and an intended pronunciation', () => {
 const noun = {senseId: 'contract', partOfSpeech: 'noun', definition: 'An agreement.'};
 const verb = {senseId: 'contract', partOfSpeech: 'verb', definition: 'Become smaller.'};
 assert.equal(recordingKey('one', ' Contract ', noun), recordingKey('one', 'contract', noun));
 assert.notEqual(recordingKey('one', 'contract', noun), recordingKey('one', 'contract', verb));
 assert.notEqual(recordingKey('one', 'contract', noun), recordingKey('two', 'contract', noun));
});

test('dictation accepts a bounded WAV and rejects truncated or mislabeled data', () => {
 const wave = Buffer.alloc(46);
 wave.write('RIFF', 0);
 wave.writeUInt32LE(38, 4);
 wave.write('WAVEfmt ', 8);
 wave.writeUInt32LE(16, 16);
 wave.writeUInt16LE(1, 20);
 wave.writeUInt16LE(1, 22);
 wave.writeUInt32LE(24000, 24);
 wave.writeUInt32LE(48000, 28);
 wave.writeUInt16LE(2, 32);
 wave.writeUInt16LE(16, 34);
 wave.write('data', 36);
 wave.writeUInt32LE(2, 40);
 const view = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
 assert.doesNotThrow(() => validateRecording(view(wave)));
 assert.throws(() => validateRecording(view(wave.subarray(0, 44))), /WAV/);
 assert.throws(() => validateRecording(new ArrayBuffer(1048577)), /1 MB/);
});

test('dictation suggestions match multiword targets and reject changed endings', () => {
 assert.equal(containsTarget('The metal contracts when it cools.', 'contract'), false);
 assert.equal(containsTarget('The metal contracts when it cools.', 'contracts'), true);
 assert.equal(containsTarget('They turned the light off.', 'turn the light off'), false);
 assert.equal(containsTarget('Please turn the light off.', 'turn the light off'), true);
});

test('published audio is scoped to the demo version and the exact spoken prompt', () => {
 const pack = {id:'matter-mixed-troy', version:1};
 assert.equal(publishedClip(pack, 'solid', 'dictation', 'solid'), '/demo-audio/matter-mixed-troy/words/solid.wav');
 assert.equal(publishedClip(pack, 'solid', 'sentence-choice', 'An ice cube is a blank.'), '/demo-audio/matter-mixed-troy/cloze/solid.wav');
 assert.equal(publishedClip(pack, 'gas', 'definition-recall', 'A form of matter that spreads out to fill its container.'), '/demo-audio/matter-mixed-troy/definitions/gas.wav');
 assert.equal(publishedClip(pack, 'solid', 'sentence-choice', 'The block is a blank.'), null);
 assert.equal(publishedClip({...pack, version:2}, 'solid', 'dictation', 'solid'), null);
 assert.equal(publishedClip(pack, 'constructor', 'dictation', 'constructor'), null);
});

test('the published demo ships valid PCM WAVs for every recording path', () => {
 for (const kind of ['words', 'cloze', 'definitions']) {
  for (const word of ['solid', 'liquid', 'gas', 'melt']) {
   const bytes = readFileSync(join(__dirname, '../demo-audio/matter-mixed-troy', kind, word + '.wav'));
   assert.doesNotThrow(() => validateRecording(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  }
 }
});
