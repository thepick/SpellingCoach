const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const Vocabulary = require('../src/vocabulary.js');

function pack() {
  return {
    kind: 'spellingcoach-pack', v: 1, id: 'week-12', version: 1, name: 'Week 12',
    words: [{
      word: 'textile',
      vocabulary: {
        senseId: 'textile-cloth', partOfSpeech: 'noun',
        definition: 'Cloth that can be used to make things.',
        examples: ['Cotton is a common textile.'],
        clozeQuestions: [{
          id: 'clue-01', sentence: 'The curtain was made from a soft _____.',
          answer: 'textile', explanation: 'Curtains are often made from cloth.'
        }],
        meaningDistractors: ['A type of thread cutter.', 'A piece of metal.', 'A printing tool.'],
        acceptedSpellings: [], readingLevel: 5, status: 'approved'
      }
    }]
  };
}

test('caps normalized unique words at 200 and keeps the first display spelling', () => {
  const words = ['  Don’t   go  ', "don't go", ...Array.from({ length: 199 }, (_, i) => 'word ' + i)];
  assert.equal(Vocabulary.normalizeWords(words).length, 200);
  assert.equal(Vocabulary.normalizeWords(words)[0], 'Don’t   go');
  assert.throws(() => Vocabulary.normalizeWords([...words, 'one more']), /200/);
  assert.throws(() => Vocabulary.normalizeWords(['w'.repeat(81)]), /80/);
  assert.throws(() => Vocabulary.normalizeWords(['w' + ' '.repeat(79) + 'w']), /80/);
  const payload = { ...pack(), words: words.map(word => ({ word })) };
  assert.equal(Vocabulary.validatePack(JSON.stringify(payload)).words.length, 200);
  payload.words.push({ word: 'one more' });
  assert.throws(() => Vocabulary.validatePack(payload), /200/);
});

test('rejects impossible or unsafe vocabulary record structure', () => {
  for (const [edit, error] of [
    [r => { r.definition = '<img src=x onerror=alert(1)>'; }, /plain text/],
    [r => { r.definition = 'A textile is a kind of cloth.'; }, /reveals/],
    [r => { r.clozeQuestions[0].sentence = '_____ and _____.'; }, /blank/],
    [r => { r.clozeQuestions[0].sentence = 'The textile is a _____.'; }, /reveals/],
    [r => { r.clozeQuestions[0].answer = 'curtain'; }, /target/],
    [r => { r.clozeQuestions.push({ ...r.clozeQuestions[0], id: 'clue-02' }); }, /duplicate/i],
    [r => { r.meaningDistractors[0] = 'A PRINTING TOOL.'; }, /duplicate/i],
    [r => { r.meaningDistractors.pop(); }, /three/],
    [r => { r.extra = true; }, /unexpected/i],
  ]) {
    const p = pack();
    edit(p.words[0].vocabulary);
    assert.throws(() => Vocabulary.validatePack(p), error);
  }
  assert.throws(() => Vocabulary.validatePack(' '.repeat(4 * 1024 * 1024 + 1)), /4 MB/);
  const p = pack();
  p.words.push({ word: 'TEXTILE' });
  assert.throws(() => Vocabulary.validatePack(p), /conflict/i);
  p.words[1] = { ...p.words[0], word: 'TEXTILE' };
  assert.equal(Vocabulary.validatePack(p).words.length, 1);
});

test('preserves progress across question edits and recognizes sense changes', () => {
  const before = pack();
  const after = pack();
  after.version = 2;
  after.words[0].vocabulary.clozeQuestions[0].explanation = 'The fabric clue points to textile.';
  const result = Vocabulary.planPackUpdate(before, after);
  assert.equal(result.action, 'update');
  assert.deepEqual(result.unchangedWords, ['textile']);
  assert.deepEqual(result.changedWords, []);
  assert.equal(Vocabulary.planPackUpdate(after, before).action, 'older');
  assert.equal(Vocabulary.planPackUpdate(after, after).action, 'unchanged');
  assert.throws(() => Vocabulary.planPackUpdate(before, { ...before, name: 'Another name' }), /version/);
  after.words[0].vocabulary.senseId = 'textile-industry';
  const change = Vocabulary.planPackUpdate(before, after);
  assert.deepEqual(change.changedWords, ['textile']);
});

test('converts legacy definitions to draft senses using normalized word matching', () => {
  const list = { words: ['Don’t go', 'Book', 'constructor'], defs: { "don't go": 'Stay here.' } };
  const records = Vocabulary.legacyRecords(list);
  assert.deepEqual(records.map(r => r.word), ['Don’t go']);
  assert.equal(records[0].vocabulary.definition, 'Stay here.');
  assert.equal(records[0].vocabulary.status, 'draft');
  assert.deepEqual(records[0].vocabulary.clozeQuestions, []);
  assert.equal(Vocabulary.validateRecord(records[0].word, records[0].vocabulary).definition, 'Stay here.');
  const reordered = Vocabulary.legacyRecords({ ...list, words: ['Book', 'Don’t go'] });
  assert.equal(reordered[0].vocabulary.senseId, records[0].vocabulary.senseId);
});

test('local fallback keeps the last successful record when a write fails', async () => {
  class LocalStorage {
    data = new Map();
    blocked = false;
    get length() { return this.data.size; }
    key(i) { return [...this.data.keys()][i] ?? null; }
    getItem(key) { return this.data.get(key) ?? null; }
    setItem(key, value) {
      if (this.blocked) throw new DOMException('Full', 'QuotaExceededError');
      this.data.set(key, value);
    }
    removeItem(key) { this.data.delete(key); }
  }
  const localStorage = new LocalStorage();
  const store = await Vocabulary.openStore({ localStorage });
  assert.equal(store.kind, 'localStorage');
  await store.put('week-12', { version: 1 });
  localStorage.blocked = true;
  await assert.rejects(store.put('week-12', { version: 2 }), /storage is full/i);
  const reopened = await Vocabulary.openStore({ localStorage });
  assert.deepEqual(await reopened.get('week-12'), { version: 1 });
  assert.deepEqual(await reopened.entries(), [['week-12', { version: 1 }]]);
  await reopened.remove('week-12');
  assert.equal(await reopened.get('week-12'), undefined);
});

test('classroom sample contains 12 complete Grade 5 draft entries', () => {
  const sample = Vocabulary.validatePack(readFileSync(
    join(__dirname, '../examples/weekly-vocabulary-sample.json'), 'utf8'
  ));
  assert.deepEqual(sample.words.map(r => r.word), [
    'agency', 'arthritis', 'bade', 'contract', 'levying', 'mill',
    'obliged', 'posh', 'textile', 'tittered', 'wearily', 'wistfully'
  ]);
  for (const { vocabulary: v } of sample.words) {
    assert.equal(v.status, 'draft');
    assert.equal(v.readingLevel, 5);
    assert.equal(v.clozeQuestions.length, 5);
    assert.equal(v.examples.length, 2);
    assert.equal(v.meaningDistractors.length, 3);
  }
});
