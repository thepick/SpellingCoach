const assert = require('node:assert/strict');
const test = require('node:test');
const L = require('../src/learning.js');

function record(word, senseId = word) {
  return {word, vocabulary: {
    senseId, partOfSpeech: 'adverb', definition: 'With a longing for something.',
    examples: ['She smiled at the drawing.'],
    clozeQuestions: ['The dog gazed _____ at the treat.', 'She looked _____ at her old home.', 'He stared _____ at the empty park.']
      .map((sentence, index) => ({id: word + index, sentence, answer: word, explanation: 'He wished he could go.'})),
    meaningDistractors: ['With great anger.', 'In a noisy way.', 'Without thinking.'],
    acceptedSpellings: word === 'wistfully' ? ['wistfullee'] : [],
    status: 'approved',
  }};
}

const records = ['wistfully', 'wearily', 'slowly'].map(word => record(word));
const start = (settings = {}, progress = {}) => L.createSession(records, {mode: 'vocabulary', ...settings}, progress);

test('evaluation preserves case, apostrophes and spaces, and categorizes before fuzzy matching', () => {
  const q = {type: 'missing-word', answer: 'wistfully', word: 'wistfully', acceptedSpellings: ['wistfullee']};
  assert.equal(L.evaluate(q, 'wearily', records).kind, 'other-word');
  assert.equal(L.evaluate(q, 'wistful', records).kind, 'word-form');
  assert.equal(L.evaluate(q, 'wistfuly', records).kind, 'likely-spelling');
  assert.equal(L.evaluate(q, 'happily', records).kind, 'incorrect');
  assert.equal(L.evaluate(q, 'wistfullee', records).correct, false);
  assert.equal(L.evaluate(q, 'wistfullee', records, true).correct, true);
  assert.equal(L.evaluate({type: 'dictation', answer: "New York’s"}, " New   York's ").correct, true);
  assert.equal(L.evaluate({type: 'dictation', answer: "New York's"}, "new York's").correct, false);
});

test('supports six question types across settings and never speaks a hidden answer', () => {
  const types = new Set();
  for (const difficulty of ['adaptive', 'beginner', 'intermediate', 'advanced']) {
    const s = start({mode: 'mixed', type: 'test', perWord: 3, difficulty});
    for (const q of s.questions) {
      types.add(q.type);
      if (q.type === 'dictation') assert.equal(L.audio(q), q.answer);
      else if (q.type === 'missing-word' || q.type === 'word-bank' || q.type === 'sentence-choice') {
        assert.match(L.audio(q), /blank/);
        assert.equal(L.audio(q).includes(q.answer), false);
      } else assert.notEqual(L.audio(q), q.answer);
    }
  }
  assert.deepEqual([...types].sort(), ['definition-recall','dictation','meaning-choice','missing-word','sentence-choice','word-bank']);
});

test('test questions and settings persist through serialization and feedback waits for completion', () => {
  const s = start({mode: 'mixed', type: 'test', perWord: 2, audioReplay: false, order: [1, 0]});
  const expected = structuredClone(s.questions);
  assert.equal(expected.length, 9);
  assert.equal(expected[0].word, 'wearily');
  assert.equal(L.hint(s), null);
  assert.equal(L.audio(s), '');
  assert.deepEqual(L.submit(s, L.current(s).answer), {submitted: true});
  assert.equal(L.report(s).metrics.spelling.percent, null);
  const resumed = JSON.parse(JSON.stringify(s));
  assert.deepEqual(resumed.questions, expected);
  assert.equal(resumed.index, 1);
  assert.equal(L.sessionOK(resumed), true);
  const damaged = structuredClone(resumed);
  damaged.questions[1].recordIndex = 10000;
  assert.equal(L.sessionOK(damaged), false);
  L.finish(resumed);
  assert.equal(L.report(resumed).status, 'unfinished');
  assert.equal(L.sessionOK(resumed), true);
  L.resume(resumed);
  while (L.current(resumed)) L.submit(resumed, L.current(resumed).answer);
  assert.equal(resumed.status, 'finished');
  assert.equal(L.report(resumed).metrics.spelling.percent, 100);
  assert.equal(L.sessionOK(resumed), true);
});

test('a vocabulary mistake does not harm spelling and assisted retyping cannot earn mastery', () => {
  const s = start({difficulty: 'advanced'});
  const first = L.current(s);
  assert.equal(L.submit(s, 'wearily').kind, 'other-word');
  assert.equal(s.progress.wistfully.spelling.attempts, 0);
  L.advance(s);
  const q = L.current(s);
  assert.notEqual(q.word, first.word);
  let hint;
  do hint = L.hint(s); while (!hint.revealed);
  const restored = JSON.parse(JSON.stringify(s));
  assert.deepEqual(L.lastHint(restored), hint);
  assert.equal(L.sessionOK(restored), true);
  const feedback = L.submit(s, q.answer);
  assert.equal(feedback.assisted, true);
  assert.equal(feedback.correctionRequired, true);
  assert.equal(L.correct(s, q.answer), true);
  assert.equal(s.progress.wearily.vocabulary.streak, 0);
});

test('skip locks an unanswered test item and practice can disable correction retyping', () => {
  const exam = start({mode: 'spelling', type: 'test'});
  assert.equal(L.submit(exam, ''), null);
  assert.deepEqual(L.skip(exam), {submitted: true});
  assert.equal(exam.results[0].kind, 'skipped');
  assert.equal(exam.index, 1);
  assert.equal(L.sessionOK(exam), true);
  const practice = start({mode: 'spelling', retypeOnMiss: false});
  assert.equal(L.skip(practice).correctionRequired, false);
  assert.equal(L.sessionOK(practice), true);
  L.advance(practice);
  assert.equal(L.sessionOK(practice), true);
});

test('spelling report counts only the first dictation attempt per word', () => {
  const practice = L.createSession(['other'], {mode: 'spelling', retypeOnMiss: false});
  L.submit(practice, 'wrong');
  L.advance(practice);
  L.submit(practice, 'other');
  L.advance(practice);
  L.submit(practice, 'other');
  L.advance(practice);
  assert.deepEqual(L.report(practice).metrics.spelling, {correct: 0, answered: 1, percent: 0});
  assert.equal(L.mastery(practice.progress, ['other']).spelling.mastered, 1);
});

test('shared mastery practice survives the normal retry limit and requires independent correct answers', () => {
  let session = L.createSession(['solid'], {mode: 'mixed', masteryPractice: true});
  for (let attempt = 0; attempt < 9; attempt++) {
    assert.equal(L.submit(session, 'sollid').correctionRequired, true);
    assert.equal(L.correct(session, 'solid'), true);
    L.advance(session);
  }
  session = JSON.parse(JSON.stringify(session));
  assert.equal(L.sessionOK(session), true);
  assert.equal(L.practiceMastered(session), false);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(L.submit(session, 'solid').correct, true);
    L.advance(session);
  }
  assert.equal(L.practiceMastered(session), true);

  const ended = start({mode: 'mixed', masteryPractice: true});
  L.finish(ended);
  assert.equal(L.practiceMastered(ended), false);
});

test('speech masks case, whitespace and apostrophe variants of a hidden answer', () => {
  const question = {type: 'definition-recall', answer: "Mary Jane's", prompt: 'One of MARY   JANE’S things.'};
  assert.equal(L.audio(question), 'One of blank things.');
});

test('200-word mixed assessments retain three vocabulary items and one dictation per word', () => {
  const full = Array.from({length: 200}, (_, index) => record('word-' + index));
  const s = L.createSession(full, {mode: 'mixed', type: 'test', perWord: 3});
  assert.equal(s.questions.length, 800);
  assert.equal(new Set(s.questions.map(q => q.id)).size, 800);
  assert.equal(L.sessionOK(JSON.parse(JSON.stringify(s))), true);
});

test('independent recall rotates distinct prompts and spaced review shortens after an error', () => {
  const one = [records[0]];
  const initial = Date.UTC(2026, 10, 25);
  const s = L.createSession(one, {mode: 'vocabulary', difficulty: 'advanced', now: initial});
  const first = L.current(s);
  L.submit(s, first.answer, initial);
  L.advance(s, initial);
  const second = L.current(s);
  assert.notEqual(second.prompt, first.prompt);
  L.submit(s, second.answer, initial);
  L.advance(s, initial);
  assert.equal(s.status, 'finished');
  const next = s.progress.wistfully.vocabulary.nextReview;
  assert.equal(L.mastery(s.progress, one, initial).vocabulary.mastered, 1);
  assert.equal(L.mastery(s.progress, one, next).vocabulary.due, 1);
  const review = L.createSession(one, {mode: 'vocabulary', difficulty: 'advanced', reviewOnly: true, now: next}, s.progress);
  L.submit(review, 'unknown', next);
  assert.ok(review.progress.wistfully.vocabulary.nextReview > next);
  assert.ok(review.progress.wistfully.vocabulary.nextReview <= next + (next - initial));
  assert.equal(L.mastery(s.progress, [record('wistfully', 'different')], next).vocabulary.mastered, 0);
});

test('beginner completion records recognition without recall and repeated misses stay finite', () => {
  const s = start({difficulty: 'beginner'});
  while (L.current(s)) {
    const q = L.current(s);
    assert.match(q.type, /choice/);
    L.submit(s, q.answer);
    L.advance(s);
  }
  const {metrics} = L.report(s);
  assert.equal(metrics.recognition.percent, 100);
  assert.equal(metrics.recall.percent, null);
  assert.equal(L.mastery(s.progress, records).vocabulary.mastered, 0);
  const repeat = start({difficulty: 'advanced'});
  for (let i = 0; i < 49 && L.current(repeat); i++) {
    L.submit(repeat, 'unknown');
    L.advance(repeat);
  }
  assert.equal(repeat.status, 'finished');
});
