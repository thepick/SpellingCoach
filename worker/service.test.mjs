import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { VocabularyService } from './service.mjs';
import { finishStreamedWav } from './dictation.mjs';
import { providerChoices, requestVocabulary } from './provider.mjs';

const secret = 'admin-secret-for-local-tests-only-128';
const origin = 'https://spellingcoach.mtomlinson.ca';
const approved = (word) => ({
  word,
  vocabulary: {
    senseId: 'literal', partOfSpeech: 'noun', definition: 'A type of cloth.',
    examples: [`The tailor worked with the ${word}.`, `We cut the ${word} to the right size.`],
    clozeQuestions: Array.from({ length: 5 }, (_, i) => ({
      id: `q${i}`, sentence: `The tailor used the _____ for project ${i}.`, answer: word, explanation: 'It is a kind of cloth.'
    })),
    meaningDistractors: ['A tool for digging.', 'A large building.', 'A pair of socks.'],
    acceptedSpellings: [], readingLevel: 5, status: 'approved'
  }
});
const draft = (word) => {
  const { definition, partOfSpeech, examples, clozeQuestions, meaningDistractors, acceptedSpellings } = approved(word).vocabulary;
  return { word, definition, partOfSpeech, examples, clozeQuestions: clozeQuestions.map(({ id, ...question }) => question), meaningDistractors, acceptedSpellings };
};

function fixture(vars = {}, fetcher = async ({ words }) => ({ records: words.map(draft), tokens: 100 }), speechFetcher) {
  const db = new DatabaseSync(':memory:');
  let clock = Date.parse('2026-11-25T01:00:00Z');
  const env = {
    ADMIN_AUTH_SECRET: secret, SESSION_SIGNING_SECRET: 'session-secret-for-local-tests-only-200',
    GROQ_API_KEY: 'fake', GROQ_FREE_TIER_CONFIRMED: 'true', AI_ENABLED: 'true', ALLOWED_ORIGINS: origin, ...vars
  };
  const storage = {
    sql: { exec(query, ...args) {
      const statement = db.prepare(query);
      args = args.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      const output = statement.columns().length
        ? { rows: statement.all(...args), changes: 0 }
        : { rows: [], changes: Number(statement.run(...args).changes) };
      return { toArray: () => output.rows, rowsWritten: output.changes };
    } },
    transactionSync(work) {
      db.exec('BEGIN');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
  const service = new VocabularyService(storage, env, { now: () => clock, fetcher, speechFetcher });
  const call = async (method, path, body, token = secret, extraHeaders = {}) => {
    const headers = { Origin: origin, ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const result = await service.fetch(new Request(`https://worker.test/api${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    }));
    return { status: result.status, data: result.status === 204 ? null : result.headers.get('Content-Type') === 'audio/wav' ? new Uint8Array(await result.arrayBuffer()) : await result.json(), headers: result.headers };
  };
  const createClass = async (classId, dailyWords = 200) => {
    const saved = await call('POST', '/admin/classes', {
      classId, name: classId, dailyWords, expiresAt: clock + 3600_000
    });
    assert.equal(saved.status, 200);
    const access = await call('POST', '/access', { code: saved.data.code }, '');
    assert.equal(access.status, 200);
    return access.data.token;
  };
  return { call, createClass, env, advance: (ms) => { clock += ms; } };
}

test('teacher access is authenticated and CORS has an exact origin allowlist', async () => {
  const { call } = fixture();
  assert.equal((await call('GET', '/admin/usage', undefined, '')).status, 401);
  assert.equal((await call('GET', '/health', undefined, '', { Origin: `${origin}.example.test` })).status, 403);
  const session = await call('POST', '/admin/access', { secret }, '');
  assert.equal(session.status, 200);
  assert.equal((await call('GET', '/admin/usage', undefined, session.data.token)).status, 200);
});

test('a configured teacher password is separate from the operator bearer secret', async () => {
  const password = 'fixture-teacher-password';
  const signingSecret = 'test-signing-secret-for-separate-password';
  const hash = createHmac('sha256', signingSecret).update('teacher-password:' + password).digest('base64url');
  const { call } = fixture({ SESSION_SIGNING_SECRET: signingSecret, TEACHER_PASSWORD_HASH: hash });
  assert.equal((await call('POST', '/admin/access', { secret }, '')).status, 401);
  assert.equal((await call('POST', '/admin/access', { secret: 'wrong' }, '')).status, 401);
  assert.equal((await call('GET', '/admin/usage', undefined, password)).status, 401);
  const session = await call('POST', '/admin/access', { secret: password }, '');
  assert.equal(session.status, 200);
  assert.equal((await call('GET', '/admin/usage', undefined, session.data.token)).status, 200);
  assert.equal((await call('GET', '/admin/usage')).status, 200);
});

test('class codes are revocable and student generation defaults to disabled', async () => {
  const { call, createClass } = fixture();
  const token = await createClass('ip5-9');
  const denied = await call('POST', '/generate', { words: ['textile'] }, token);
  assert.equal(denied.status, 403);
  await call('POST', '/admin/classes', { classId: 'ip5-9', revoked: true });
  assert.equal((await call('POST', '/generate', { words: ['textile'] }, token)).status, 401);
});

test('class jobs are scoped to their issuing session and obey class daily quotas', async () => {
  const { call, createClass } = fixture({ STUDENT_AI_ENABLED: 'true' });
  const one = await createClass('one', 1);
  const two = await createClass('two');
  const job = await call('POST', '/generate', { words: ['textile'] }, one);
  assert.equal(job.status, 201);
  assert.equal((await call('GET', `/jobs/${job.data.id}`, undefined, two)).status, 404);
  assert.equal((await call('POST', `/jobs/${job.data.id}/step`, undefined, one)).data.status, 'complete');
  assert.equal((await call('POST', '/generate', { words: ['cloth'] }, one)).status, 429);
});

test('input validation accepts 200 unique normalized words and rejects 201, unapproved settings and markup', async () => {
  const { call } = fixture();
  const words = Array.from({ length: 201 }, (_, i) => `word${String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)}`);
  assert.equal((await call('POST', '/generate', { words })).status, 400);
  assert.equal((await call('POST', '/generate', { words: ['<button>word</button>'] })).status, 400);
  assert.equal((await call('POST', '/generate', { words: ['word'], settings: { model: 'paid' } })).status, 400);
  const job = await call('POST', '/generate', { words: [...words.slice(0, 200), 'Wordaa'] });
  assert.equal(job.status, 201);
  assert.equal(job.data.counts.total, 200);
});

test('duplicate steps remain atomic and completed work survives pause and resume', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { call } = fixture({}, async ({ words }) => {
    calls++;
    await pending;
    return { records: words.map(draft), tokens: 100 };
  });
  const created = await call('POST', '/generate', { words: ['textile'] }, secret, { 'Idempotency-Key': 'example-1' });
  const again = await call('POST', '/generate', { words: ['textile'] }, secret, { 'Idempotency-Key': 'example-1' });
  assert.equal(again.data.id, created.data.id);
  const path = `/jobs/${created.data.id}`;
  const step = call('POST', `${path}/step`);
  while (!calls) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await call('POST', `${path}/step`)).data.status, 'processing');
  assert.equal((await call('POST', `${path}/pause`)).data.status, 'paused');
  release();
  assert.equal((await step).data.counts.generated, 1);
  assert.equal((await call('POST', `${path}/resume`)).data.status, 'complete');
  assert.equal(calls, 1);
  assert.equal((await call('GET', '/admin/usage')).data.tokens, 100);
});

test('429 pauses a job and preserves an already validated word after a partial response', async () => {
  let calls = 0;
  const { call, advance } = fixture({}, async ({ words }) => {
    calls++;
    if (calls === 2) return { records: [], rateLimited: true, retryInMs: 20_000 };
    return { records: [draft(words[0])], tokens: 120 };
  });
  const job = await call('POST', '/generate', { words: ['textile', 'fabric'] });
  const path = `/jobs/${job.data.id}/step`;
  assert.equal((await call('POST', path)).data.counts.generated, 1);
  const paused = (await call('POST', path)).data;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.counts.generated, 1);
  await call('POST', path);
  assert.equal(calls, 2);
  advance(20_000);
  assert.equal((await call('POST', path)).data.status, 'complete');
});

test('approved public packs are versioned, validated, and reusable at zero provider cost', async () => {
  const { call } = fixture();
  const pack = { kind: 'spellingcoach-pack', v: 1, id: 'week-12', name: 'Week 12', version: 1, words: [approved('textile')] };
  assert.equal((await call('POST', '/admin/publish', { pack, visibility: 'public', cacheSettings: {} })).status, 200);
  assert.equal((await call('GET', '/packs/week-12', undefined, '')).data.pack.name, 'Week 12');
  const changed = { ...pack, name: 'Different name' };
  assert.equal((await call('POST', '/admin/publish', { pack: changed, visibility: 'public' })).status, 409);
  const job = await call('POST', '/generate', { words: ['textile'] });
  assert.equal(job.data.status, 'complete');
  assert.equal(job.data.counts.cached, 1);
  assert.equal((await call('GET', '/admin/usage')).data.calls, 0);
});

test('teachers can publish words without definitions for spelling practice', async () => {
  const { call } = fixture();
  const pack = { kind: 'spellingcoach-pack', v: 1, id: 'spelling-only', name: 'Spelling', version: 1,
    words: [{ word: 'textile', vocabulary: null }] };
  const publish = (mode, extras) => call('POST', '/admin/publish', { pack, mode, visibility: 'public', ...extras });
  assert.equal((await publish('mixed')).status, 400);
  assert.equal((await publish('spelling', { cacheSettings: {} })).status, 400);
  assert.equal((await publish('spelling')).status, 200);
  assert.deepEqual((await call('GET', '/packs/spelling-only', undefined, '')).data.pack, pack);
});

test('a published pack carries the teacher’s mode and hint policy', async () => {
  const {call} = fixture();
  const pack = {kind:'spellingcoach-pack', v:1, version:1, id:'settings-test', name:'Settings', words:[approved('textile')]};
  const publish = (mode, allowHints) => call('POST','/admin/publish',{pack,visibility:'public',mode,allowHints});
  assert.equal((await publish('mixed', false)).status, 200);
  const load = () => call('GET','/packs/settings-test?mode=spelling&hints=on',undefined,'');
  assert.deepEqual((await load()).data.practice, {mode:'mixed',allowHints:false});
  assert.equal((await publish('vocabulary', true)).status, 200);
  assert.deepEqual((await load()).data.practice, {mode:'vocabulary',allowHints:true});
});

test('shared practice audio is prepared by teachers from saved prompts and reused by students', async () => {
  const wav = readFileSync(new URL('../demo-audio/matter-mixed-troy/words/solid.wav', import.meta.url));
  const spoken = [];
  const {call} = fixture({}, undefined, async (_key, text) => {spoken.push(text); return wav;});
  const pack = {kind:'spellingcoach-pack', v:1, version:1, id:'audio-test', name:'Audio test', words:[approved('textile')]};
  assert.equal((await call('POST','/admin/publish',{pack,visibility:'public'})).status, 200);
  const input = {packId:pack.id, version:1, prompt:'0-v0'};
  assert.equal((await call('POST','/admin/packaudio',input,'')).status, 401);
  assert.equal((await call('POST','/admin/packaudio',input)).status, 200);
  assert.equal((await call('POST','/admin/packaudio',input)).status, 200);
  assert.deepEqual(spoken, ['The tailor used the blank for project 0.']);
  assert.deepEqual((await call('GET','/packs/audio-test',undefined,'')).data.audio, ['0-v0']);
  assert.deepEqual((await call('GET','/packs/audio-test/audio/1/0-v0',undefined,'')).data, new Uint8Array(wav));
  assert.equal((await call('GET','/packs/audio-test/audio/2/0-v0',undefined,'')).status, 404);
});

test('provider routing is fail closed and requests use the fixed schema and target', async () => {
  assert.deepEqual(providerChoices({ AI_ENABLED: 'true', GROQ_API_KEY: 'fake' }), []);
  const env = { GROQ_FREE_TIER_CONFIRMED: 'true', GROQ_API_KEY: 'fake', GROQ_MODELS: 'paid-model' };
  assert.deepEqual(providerChoices(env), []);
  delete env.GROQ_MODELS;
  const [target] = providerChoices(env);
  const result = await requestVocabulary({
    target, words: ['textile'], settings: { readingLevel: 5, practiceSentences: 5, exampleSentences: 2 }, maxCompletionTokens: 2000,
    fetchRequest: async (url, init) => {
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(init.redirect, 'manual');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'openai/gpt-oss-120b');
      assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(Object.hasOwn(body, 'tools'), false);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ records: [draft('textile')] }) } }], usage: { total_tokens: 100 } });
    }
  });
  assert.equal(result.tokens, 100);
  assert.equal(result.records[0].word, 'textile');
});

test('renewed classroom access retains the same private job after a token expires', async () => {
  const { call, advance } = fixture({ STUDENT_AI_ENABLED: 'true' });
  const first = await call('POST', '/admin/classes', {
    classId: 'one', name: 'One', expiresAt: Date.parse('2026-11-25T10:00:00Z'), dailyWords: 5
  });
  const access = (await call('POST', '/access', { code: first.data.code }, '')).data;
  const job = (await call('POST', '/generate', { words: ['textile'] }, access.token)).data;
  advance(2 * 3600_000);
  assert.equal((await call('GET', '/jobs/' + job.id, undefined, access.token)).status, 401);
  const renewed = await call('POST', '/access', { code: first.data.code, previousToken: access.token }, '');
  assert.equal(renewed.status, 200);
  assert.equal((await call('GET', '/jobs/' + job.id, undefined, renewed.data.token)).data.id, job.id);
});

test('single-question regeneration preserves the other questions and their stable IDs', async () => {
  let selected;
  const { call } = fixture({}, async ({ words, regeneration }) => {
    selected = regeneration.item;
    return { records: [{ word: words[0], clozeQuestions: [
      { sentence: 'The maker bought new _____ for the school play.', answer: words[0], explanation: 'It is a type of cloth.' }
    ] }], tokens: 90 };
  });
  const previous = approved('textile');
  const job = await call('POST', '/regenerate', { word: 'textile', previous, item: 'cloze', questionId: 'q2' });
  const finished = (await call('POST', '/jobs/' + job.data.id + '/step')).data;
  assert.equal(selected, 'cloze');
  assert.equal(finished.status, 'complete');
  assert.equal(finished.words[0].vocabulary.definition, previous.vocabulary.definition);
  assert.equal(finished.words[0].vocabulary.clozeQuestions[2].id, 'q2');
  assert.match(finished.words[0].vocabulary.clozeQuestions[2].sentence, /school play/);
  assert.deepEqual(finished.words[0].vocabulary.clozeQuestions[1], previous.vocabulary.clozeQuestions[1]);
});

test('a 200-word job checkpoints each adaptive batch and respects the daily token ceiling', async () => {
  const words = Array.from({ length: 200 }, (_, i) => 'word' + String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26));
  let calls = 0;
  const { call } = fixture({}, async ({ words: batch }) => {
    calls++;
    assert.ok(batch.length <= 20);
    return { records: batch.map(draft), tokens: 700 };
  });
  const created = (await call('POST', '/generate', { words })).data;
  let job = created;
  while (job.status === 'ready' && calls < 25) job = (await call('POST', '/jobs/' + created.id + '/step')).data;
  assert.equal(job.counts.generated, 200);
  assert.equal(job.words.length, 200);
  assert.equal(job.status, 'complete');
  assert.ok(calls > 10);
  const { call: budgetCall } = fixture({}, async ({ words: batch }) => ({ records: [draft(batch[0])], tokens: 150_000 }));
  const budgetJob = (await budgetCall('POST', '/generate', { words: ['textile', 'fabric'] })).data;
  const step = '/jobs/' + budgetJob.id + '/step';
  await budgetCall('POST', step);
  const paused = (await budgetCall('POST', step)).data;
  assert.equal(paused.counts.generated, 1);
  assert.equal(paused.status, 'paused');
  assert.match(paused.message, /daily AI budget/);
});

test('only two provider reservations are live across teacher sessions', async () => {
  let calls = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { call, advance } = fixture({}, async ({ words }) => {
    calls++;
    await waiting;
    return { records: words.map(draft), tokens: 100 };
  });
  const logins = await Promise.all(Array.from({ length: 3 }, () => call('POST', '/admin/access', { secret }, '')));
  const tokens = logins.map(({ data }) => data.token);
  const jobs = await Promise.all(tokens.map((token) => call('POST', '/generate', { words: ['textile'] }, token)));
  const step = (index) => call('POST', '/jobs/' + jobs[index].data.id + '/step', undefined, tokens[index]);
  const first = step(0);
  const second = step(1);
  while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  const held = await step(2);
  assert.equal(held.data.status, 'paused');
  assert.equal(calls, 2);
  assert.equal((await call('GET', '/admin/usage')).data.active, 2);
  release();
  await Promise.all([first, second]);
  advance(3000);
  assert.equal((await step(2)).data.status, 'complete');
  assert.equal(calls, 3);
});

test('the emergency switch holds pending work and rejects a paid model change', async () => {
  let calls = 0;
  const { call } = fixture({}, async ({ words }) => {
    calls++;
    return { records: words.map(draft), tokens: 100 };
  });
  const job = (await call('POST', '/generate', { words: ['textile'] })).data;
  assert.equal((await call('PUT', '/admin/settings', { groqModels: ['paid'] })).status, 400);
  assert.equal((await call('PUT', '/admin/settings', { generationEnabled: false })).data.generationEnabled, false);
  const held = await call('POST', '/jobs/' + job.id + '/step');
  assert.equal(held.data.status, 'paused');
  assert.equal(calls, 0);
  assert.equal((await call('PUT', '/admin/settings', { generationEnabled: true })).data.generationEnabled, true);
  assert.equal((await call('POST', '/jobs/' + job.id + '/step')).data.status, 'complete');
  assert.equal(calls, 1);
});

test('Troy audio requires teacher access and a sentence containing the exact word', async () => {
  let spoken;
  const bytes = Uint8Array.of(82, 73, 70, 70);
  const { call, createClass } = fixture({ STUDENT_AI_ENABLED: 'true' }, undefined, async (key, sentence) => {
    assert.equal(key, 'fake');
    spoken = sentence;
    return bytes;
  });
  const body = { word: 'contracts', sentence: 'The metal contracts when it cools.' };
  assert.equal((await call('POST', '/admin/dictation', body, '')).status, 401);
  assert.equal((await call('POST', '/admin/dictation', body, await createClass('one'))).status, 403);
  assert.equal((await call('POST', '/admin/dictation', { ...body, word: 'contract' })).status, 400);
  assert.equal((await call('POST', '/admin/dictation', { ...body, voice: 'other' })).status, 400);
  assert.equal((await call('GET', '/config')).data.dictationEnabled, true);
  const result = await call('POST', '/admin/dictation', body);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, bytes);
  assert.equal(spoken, body.sentence);
  await call('PUT', '/admin/settings', { generationEnabled: false });
  assert.equal((await call('POST', '/admin/dictation', body)).status, 503);
});

test('Troy WAV streaming headers are finalized without altering the PCM samples', () => {
 const wav = Buffer.alloc(46);
 wav.write('RIFF', 0);
 wav.writeUInt32LE(0xffffffff, 4);
 wav.write('WAVEfmt ', 8);
 wav.writeUInt32LE(16, 16);
 wav.writeUInt16LE(1, 20);
 wav.write('data', 36);
 wav.writeUInt32LE(0xffffffff, 40);
 wav.writeInt16LE(1234, 44);
 assert.equal(finishStreamedWav(wav).readUInt32LE(4), 38);
 assert.equal(wav.readUInt32LE(40), 2);
 assert.equal(wav.readInt16LE(44), 1234);
 assert.throws(() => finishStreamedWav(wav.subarray(0, 44)));
});

test('Troy generation has its own minute budget', async () => {
 const { call, advance } = fixture({}, undefined, async () => Uint8Array.of(1));
 const body = {word: 'contracts', sentence: 'Metal contracts as it cools.'};
 const calls = await Promise.all(Array.from({length:11}, () => call('POST', '/admin/dictation', body)));
 assert.equal(calls.filter(result => result.status === 200).length, 10);
 assert.equal(calls.filter(result => result.status === 429).length, 1);
 assert.equal((await call('GET', '/admin/usage')).data.dictationCalls, 10);
 advance(60000);
 assert.equal((await call('POST', '/admin/dictation', body)).status, 200);
});
