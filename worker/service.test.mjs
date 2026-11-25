import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { VocabularyService } from './service.mjs';
import { finishStreamedWav, synthesizeDictation } from './dictation.mjs';
import { providerChoices, requestVocabulary } from './provider.mjs';
import { ApiError } from './validation.mjs';

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
  let alarm;
  const env = {
    ADMIN_AUTH_SECRET: secret, SESSION_SIGNING_SECRET: 'session-secret-for-local-tests-only-200',
    GROQ_API_KEY: 'fake', OPENROUTER_API_KEY:'fake-router', AUDIO_ENABLED:'true', GROQ_FREE_TIER_CONFIRMED: 'true', AI_ENABLED: 'true', ALLOWED_ORIGINS: origin, ...vars
  };
  const storage = {
    async setAlarm(time) { alarm = time; },
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
  return { call, createClass, env, db, service, advance: (ms) => { clock += ms; },
    runAudioAlarm: async () => {
      assert(alarm >= clock);
      clock = alarm;
      alarm = undefined;
      await new VocabularyService(storage, env, {now: () => clock, fetcher, speechFetcher}).processAudioQueue();
    } };
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
  const wav = readFileSync(new URL('../demo-audio/matter-mixed/words/solid.wav', import.meta.url));
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
  const range = await call('GET','/packs/audio-test/audio/1/0-v0',undefined,'',{Range:'bytes=0-1'});
  assert.equal(range.status,206);
  assert.equal(range.headers.get('Content-Range'),'bytes 0-1/' + wav.length);
  assert.deepEqual(range.data,new Uint8Array(wav.subarray(0,2)));
  assert.equal((await call('GET','/packs/audio-test/audio/2/0-v0',undefined,'')).status, 404);
});

test('publishing queues practice recordings and alarms finish them without a teacher request', async () => {
  const wav = readFileSync(new URL('../demo-audio/matter-mixed/words/solid.wav', import.meta.url));
  const spoken = [];
  const {call, runAudioAlarm} = fixture({}, undefined, async (_key, text) => {
    spoken.push(text);
    if (spoken.length === 1) throw new ApiError(429, 'dictation_rate_limit', 'Try again');
    return wav;
  });
  const pack = {kind:'spellingcoach-pack',v:1,version:1,id:'auto-audio',name:'Automatic audio',words:[{word:'solid',vocabulary:null}]};
  const published = await call('POST','/admin/publish',{pack,visibility:'public',mode:'spelling'});
  assert.deepEqual(published.data.audioStatus,{ready:0,total:1,pending:true,recordings:[{key:"0-s",word:"solid",text:"solid",status:"pending"}]});
  assert.equal((await call('POST','/admin/packaudioqueue',{id:pack.id},'')).status,401);
  await runAudioAlarm();
  assert.equal((await call('GET','/packs/auto-audio',undefined,'')).data.audioStatus.pending,true);
  await runAudioAlarm();
  await runAudioAlarm();
  const student = await call('GET','/packs/auto-audio',undefined,'');
  assert.deepEqual(student.data.audioStatus,{ready:1,total:1,pending:false,recordings:[{key:"0-s",word:"solid",text:"solid",status:"ready"}]});
  assert.deepEqual(student.data.audio,['0-s']);
  assert.deepEqual((await call('GET','/packs/auto-audio/audio/1/0-s',undefined,'')).data,new Uint8Array(wav));
  assert.deepEqual(spoken,['solid','solid']);
});

test('operator retry wakes legacy public daily waits but preserves leases and provider retry times',async()=>{
  const now=Date.parse('2026-11-25T01:00:00Z');
  for(const delay of [3600000,70000,61000]) {
    const f=fixture({},undefined,async()=>audioFixture());
    const pack={kind:'spellingcoach-pack',v:1,version:1,id:'old-public-wait',name:'Old wait',words:[{word:'solid',vocabulary:null}]};
    await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'spelling'});
    f.db.prepare('UPDATE audio_queue SET due = ? WHERE pack = ?').run(now+delay,pack.id);
    assert.equal((await f.call('POST','/admin/packaudioqueue',{id:pack.id})).status,200);
    assert.equal(f.db.prepare('SELECT due FROM audio_queue WHERE pack = ?').get(pack.id).due,delay>70000?now:now+delay);
  }
});

test('the old demo link returns the canonical pack ID', async () => {
  const {call} = fixture();
  const pack = {kind:'spellingcoach-pack',v:1,version:1,id:'matter-mixed-troy',name:'Matter',words:[{word:'solid',vocabulary:null}]};
  assert.equal((await call('POST','/admin/publish',{pack,visibility:'public',mode:'spelling'})).status,200);
  for (const id of [pack.id, 'matter-mixed']) {
    const {data} = await call('GET','/packs/' + id,undefined,'');
    assert.equal(data.pack.id,'matter-mixed');
    assert.deepEqual(data.audioStatus,{ready:1,total:1,pending:false,recordings:[{key:"0-s",word:"solid",text:"solid",status:"ready"}]});
  }
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
  const paused = (await call('PUT', '/admin/settings', { generationEnabled: false })).data;
  assert.equal(paused.generationEnabled, false);
  assert.equal(paused.draftingAvailable, true);
  const held = await call('POST', '/jobs/' + job.id + '/step');
  assert.equal(held.data.status, 'paused');
  assert.equal(calls, 0);
  assert.equal((await call('PUT', '/admin/settings', { generationEnabled: true })).data.generationEnabled, true);
  assert.equal((await call('POST', '/jobs/' + job.id + '/step')).data.status, 'complete');
  assert.equal(calls, 1);
});

test('the site can offer Paul while AI vocabulary drafting is off at deployment', async () => {
  const {call} = fixture({AI_ENABLED: 'false', AUDIO_ENABLED: 'true'});
  const {data} = await call('PUT', '/admin/settings', {generationEnabled: true});
  assert.equal(data.draftingAvailable, false);
  assert.equal(data.generationEnabled, false);
  assert.equal(data.dictationEnabled, true);
});

test('Paul audio requires teacher access and a sentence containing the exact word', async () => {
  let spoken;
  const bytes = new Uint8Array(readFileSync(new URL('../demo-audio/matter-mixed/words/solid.wav',import.meta.url)));
  const { call, createClass } = fixture({ STUDENT_AI_ENABLED: 'true' }, undefined, async (key, sentence) => {
    assert.equal(key, 'fake-router');
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
  assert.equal((await call('POST', '/admin/dictation', body)).status, 200);
});

test('Paul WAV streaming headers are finalized without altering the PCM samples', () => {
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

test('Paul generation can exceed the retired application minute cap', async () => {
 const { call } = fixture({}, undefined, async () => audioFixture());
 const body = {word: 'contracts', sentence: 'Metal contracts as it cools.'};
 const calls = await Promise.all(Array.from({length:11}, () => call('POST', '/admin/dictation', body)));
 assert.equal(calls.filter(result => result.status === 200).length, 11);
 assert.equal((await call('GET', '/admin/usage')).data.dictationCalls, 11);
});

const invited = async (f, username = 'teacher-one') => {
  const invitation = await f.call('POST', '/admin/invitations', {label:username});
  assert.equal(invitation.status, 200);
  const access = await f.call('POST', '/teacher/accept', {invite:invitation.data.invite, username, name:username, password:'correct horse school battery'}, '');
  assert.equal(access.status, 200);
  return {...access.data, invite:invitation.data.invite};
};

test('teacher invitations are single use, expiring, revocable, and passwords permit stable isolated sessions', async () => {
  const f = fixture({TEACHER_KEY_ENCRYPTION_SECRET:'a-test-only-encryption-secret-32-bytes'});
  const one = await invited(f);
  assert.equal((await f.call('POST', '/teacher/accept', {invite:one.invite, username:'duplicate', name:'Duplicate', password:'correct horse school battery'}, '')).status, 401);
  const again = await f.call('POST','/teacher/login',{username:'TEACHER-ONE',password:'correct horse school battery'},'');
  assert.equal(again.data.teacher.id, one.teacher.id);
  assert.equal((await f.call('GET','/admin/teachers',undefined,one.token)).status,403);
  assert.equal((await f.call('GET','/admin/usage',undefined,one.token)).status,403);
  const invitation = await f.call('POST','/admin/invitations',{label:'revoked'});
  await f.call('POST','/admin/revokeinvite',{id:invitation.data.id});
  assert.equal((await f.call('POST','/teacher/accept',{invite:invitation.data.invite,username:'revoked',name:'Revoked',password:'correct horse school battery'},'')).status,401);
  await f.call('POST','/admin/revoketeacher',{id:one.teacher.id});
  assert.equal((await f.call('GET','/teacher/profile',undefined,again.data.token)).status,401);
});

test('personal keys never fall back to owner keys; teachers only see their own jobs', async () => {
  const targets = [];
  const f = fixture({TEACHER_KEY_ENCRYPTION_SECRET:'a-test-only-encryption-secret-32-bytes'}, async input => { targets.push(input.target); return {records:input.words.map(draft),tokens:100}; });
  const one = await invited(f), two = await invited(f,'teacher-two');
  assert.equal((await f.call('POST','/generate',{words:['textile']},one.token)).status,503);
  const connected = await f.call('PUT','/teacher/keys',{groq:'personal-groq-test-key'},one.token);
  assert.equal(connected.data.keys.groq,true);
  assert(!JSON.stringify(connected.data).includes('personal-groq-test-key'));
  const job = await f.call('POST','/generate',{words:['textile']},one.token);
  assert.equal(job.status,201);
  assert.equal((await f.call('GET',`/jobs/${job.data.id}`,undefined,two.token)).status,404);
  await f.call('POST',`/jobs/${job.data.id}/step`,undefined,one.token);
  assert.equal(targets[0].key,'personal-groq-test-key');
  const relogin = await f.call('POST','/teacher/login',{username:'teacher-one',password:'correct horse school battery'},'');
  assert.equal((await f.call('GET',`/jobs/${job.data.id}`,undefined,relogin.data.token)).status,200);
});

test('private sets autoschedule, isolate playback, reuse exact audio across reorder and reject stale saves', async () => {
  let calls = 0;
  const f = fixture({TEACHER_KEY_ENCRYPTION_SECRET:'a-test-only-encryption-secret-32-bytes'},undefined,async () => { calls++; return readFileSync(new URL('../demo-audio/matter-mixed/words/solid.wav',import.meta.url)); });
  const one = await invited(f), two = await invited(f,'teacher-two');
  await f.call('PUT','/teacher/keys',{groq:'personal-groq-test-key',openrouter:'personal-groq-test-key'},one.token);
  const pack = {kind:'spellingcoach-pack',v:1,id:'private-set',name:'My words',version:1,words:[{word:'textile',vocabulary:null},{word:'cloth',vocabulary:null}]};
  const saved = await f.call('POST','/teacher/sets',{pack,expectedVersion:0},one.token);
  assert.equal(saved.status,200);
  assert.equal(saved.data.audioStatus.pending,true);
  assert.equal((await f.call('GET','/teacher/sets/private-set',undefined,two.token)).status,404);
  await f.runAudioAlarm(); await f.runAudioAlarm();
  const ready = await f.call('GET','/teacher/sets/private-set',undefined,one.token);
  assert.equal(ready.data.audioStatus.ready,2);
  assert.equal((await f.call('GET','/teacher/sets/private-set/audio/0-s',undefined,one.token)).status,200);
  assert.equal((await f.call('GET','/teacher/sets/private-set/audio/0-s',undefined,two.token)).status,404);
  assert.equal((await f.call('POST','/teacher/sets',{pack:{...pack,name:'Stale'},expectedVersion:1},one.token)).status,409);
  const reordered = {...pack,version:2,words:pack.words.slice().reverse()};
  assert.equal((await f.call('POST','/teacher/sets',{pack:reordered,expectedVersion:1},one.token)).data.audioStatus.ready,2);
  assert.equal(calls,2);
  const pub = await f.call('POST','/admin/publish',{pack:reordered,visibility:'public',mode:'spelling'},one.token);
  assert.equal(pub.status,200);
  assert.equal(pub.data.audioStatus.ready,2);
  assert.equal((await f.call('GET','/packs/private-set',undefined,'')).data.pack.name,'My words');
  assert.equal((await f.call('POST','/admin/publish',{pack:{...reordered,version:3},visibility:'public',mode:'spelling'},two.token)).status,404);
});


const encryptionEnv = {TEACHER_KEY_ENCRYPTION_SECRET:'a-test-only-encryption-secret-32-bytes'};
const privatePack = (id = 'private-regression',words = ['textile']) => ({kind:'spellingcoach-pack',v:1,id,name:'Regression',version:1,words:words.map(word=>({word,vocabulary:null}))});
const audioFixture = () => readFileSync(new URL('../demo-audio/matter-mixed/words/solid.wav',import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(done => {resolve=done;}); return {promise,resolve}; };

test('credentials are encrypted with teacher/provider binding and rotation fails closed with reconnect status',async () => {
  const f = fixture(encryptionEnv);
  const one = await invited(f);
  await f.call('PUT','/teacher/keys',{groq:'private-key-never-in-sql',openrouter:'private-router-key-never-in-sql'},one.token);
  const stored = f.db.prepare('SELECT value FROM teachers WHERE id = ?').get(one.teacher.id).value;
  assert(!stored.includes('private-key-never-in-sql'));
  assert(!stored.includes('private-router-key-never-in-sql'));
  assert(!stored.includes('correct horse school battery'));
  const record = JSON.parse(stored);
  await assert.rejects(f.service.accounts.crypt('decrypt','another-teacher','groq',record.keys.groq));
  await assert.rejects(f.service.accounts.crypt('decrypt',one.teacher.id,'openrouter',record.keys.groq));
  f.env.TEACHER_KEY_ENCRYPTION_SECRET = 'a-new-encryption-secret-which-is-different';
  const profile = await f.call('GET','/teacher/profile',undefined,one.token);
  assert.equal(profile.status,200);
  assert.deepEqual(profile.data.keys,{groq:false,openrouter:false});
  assert.deepEqual(profile.data.reconnect,['groq','openrouter']);
  assert.equal((await f.call('POST','/generate',{words:['textile']},one.token)).status,503);
  assert.equal((await f.call('PUT','/teacher/keys',{groq:'new-personal-key'},one.token)).data.keys.groq,true);
});

test('owner supports encrypted keys and explicit deletion does not restore environment credentials',async () => {
  const targets = [];
  const f = fixture({...encryptionEnv,OPENROUTER_API_KEY:undefined},async input => {targets.push(input.target);return {records:input.words.map(draft),tokens:100};});
  const before = await f.call('GET','/teacher/profile');
  assert.equal(before.data.keys.groq,true);
  const profile = await f.call('PUT','/teacher/keys',{groq:'new-owner-private-key',allowPaidText:true,allowAlternateAudio:true});
  assert.equal(profile.status,200);
  assert.equal(profile.data.settings.allowAlternateAudio,undefined);
  const job = await f.call('POST','/generate',{words:['textile']});
  await f.call('POST',`/jobs/${job.data.id}/step`);
  assert.equal(targets[0].key,'new-owner-private-key');
  assert.equal((await f.call('PUT','/teacher/keys',{groq:null})).data.keys.groq,false);
  assert.equal((await f.call('POST','/generate',{words:['cloth']})).status,503);
  assert(!f.db.prepare("SELECT value FROM teachers WHERE id = 'operator'").get().value.includes('new-owner-private-key'));
});

test('invites expire, duplicate usernames stay unique and auth attempts are bounded',async () => {
  const f = fixture(encryptionEnv);
  const one = await invited(f);
  const invitation = await f.call('POST','/admin/invitations',{label:'Second'});
  const details = {invite:invitation.data.invite,username:'teacher-one',name:'Second',password:'correct horse school battery'};
  assert.equal((await f.call('POST','/teacher/accept',details,'')).status,409);
  f.advance(7*86400000+1);
  assert.equal((await f.call('POST','/teacher/accept',{...details,username:'teacher-new'},'')).status,401);
  for (let attempt=0; attempt<20; attempt++) assert.equal((await f.call('POST','/teacher/login',{username:'teacher-one',password:'incorrect long password'},'')).status,401);
  assert.equal((await f.call('POST','/teacher/login',{username:'teacher-one',password:'correct horse school battery'},'')).status,429);
  assert.equal((await f.call('GET','/teacher/profile',undefined,one.token)).status,401);
});

test('teacher provider delays and daily budgets are independent across accounts',async () => {
  const f = fixture(encryptionEnv,async ({target,words}) => target.key === 'personal-one-key'
    ? {records:[],rateLimited:true,retryInMs:60000} : {records:words.map(draft),tokens:100});
  const one = await invited(f), two = await invited(f,'teacher-two');
  await f.call('PUT','/teacher/keys',{groq:'personal-one-key'},one.token);
  await f.call('PUT','/teacher/keys',{groq:'personal-two-key'},two.token);
  const first = await f.call('POST','/generate',{words:['textile']},one.token);
  assert.equal((await f.call('POST',`/jobs/${first.data.id}/step`,undefined,one.token)).data.status,'paused');
  const second = await f.call('POST','/generate',{words:['textile']},two.token);
  assert.equal((await f.call('POST',`/jobs/${second.data.id}/step`,undefined,two.token)).data.status,'complete');
  const meters = f.db.prepare('SELECT key FROM meter').all().map(r=>r.key);
  assert(meters.includes(one.teacher.id+':calls'));
  assert(meters.includes(two.teacher.id+':calls'));
  assert(!meters.includes('calls'));
});

test('key deletion while a text request is in flight prevents stale generated content writes',async () => {
  const entered = deferred(), released = deferred();
  const f = fixture(encryptionEnv,async ({words}) => {entered.resolve();await released.promise;return {records:words.map(draft),tokens:100};});
  const one = await invited(f);
  await f.call('PUT','/teacher/keys',{groq:'personal-one-key'},one.token);
  const job = await f.call('POST','/generate',{words:['textile']},one.token);
  const running = f.call('POST',`/jobs/${job.data.id}/step`,undefined,one.token);
  await entered.promise;
  await f.call('PUT','/teacher/keys',{groq:null},one.token);
  released.resolve();
  const result = await running;
  assert.equal(result.data.counts.generated,0);
  assert.equal(result.data.status,'paused');
});

test('revocation while audio is in flight discards the clip and stops subsequent calls',async () => {
  const entered = deferred(), released = deferred();
  let calls=0;
  const f = fixture(encryptionEnv,undefined,async () => {calls++;entered.resolve();await released.promise;return audioFixture();});
  const one = await invited(f);
  await f.call('PUT','/teacher/keys',{groq:'personal-one-key',openrouter:'personal-one-key'},one.token);
  await f.call('POST','/teacher/sets',{pack:privatePack('revoked-audio',['textile','cloth']),expectedVersion:0},one.token);
  const running = f.runAudioAlarm();
  await entered.promise;
  await f.call('POST','/admin/revoketeacher',{id:one.teacher.id});
  released.resolve(); await running;
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM teacher_audio').get().n,0);
  assert.equal(calls,1);
  assert.equal(f.db.prepare('SELECT due FROM teacher_audio_queue WHERE owner = ?').get(one.teacher.id).due,null);
});

test('editing the set while audio is in flight prevents stale clips and removed manifest access',async () => {
  const entered = deferred(), released = deferred();
  let calls=0;
  const f = fixture(encryptionEnv,undefined,async () => {calls++;if(calls===1){entered.resolve();await released.promise;}return audioFixture();});
  const one = await invited(f);
  await f.call('PUT','/teacher/keys',{groq:'personal-one-key',openrouter:'personal-one-key'},one.token);
  const pack = privatePack();
  await f.call('POST','/teacher/sets',{pack,expectedVersion:0},one.token);
  const running = f.runAudioAlarm(); await entered.promise;
  await f.call('POST','/teacher/sets',{pack:{...pack,version:2,words:[{word:'cloth',vocabulary:null}]},expectedVersion:1},one.token);
  released.resolve(); await running;
  assert.equal((await f.call('GET','/teacher/sets/private-regression/audio/0-s',undefined,one.token)).status,404);
  await f.runAudioAlarm();
  const saved = await f.call('GET','/teacher/sets/private-regression',undefined,one.token);
  assert.equal(saved.data.audioStatus.recordings[0].text,'cloth');
  assert.equal(saved.data.audioStatus.ready,1);
  const keys = f.db.prepare('SELECT key FROM teacher_audio').all().map(r=>r.key);
  assert(keys.every(key=>!key.includes('textile')));
});

test('private draft vocabulary prepares full examples and blanks, while spelling publication strips drafts',async () => {
  const f = fixture(encryptionEnv,undefined,async()=>audioFixture());
  const one = await invited(f);
  await f.call('PUT','/teacher/keys',{groq:'personal-one-key',openrouter:'personal-one-key'},one.token);
  const record = approved('textile'); record.vocabulary.status='draft';
  const pack = {...privatePack(),words:[record]};
  const saved = await f.call('POST','/teacher/sets',{pack,expectedVersion:0},one.token);
  assert.equal(saved.status,200);
  assert(saved.data.audioStatus.recordings.some(r=>r.key==='0-e0' && r.text===record.vocabulary.examples[0]));
  assert(saved.data.audioStatus.recordings.some(r=>r.key==='0-v0' && r.text.includes('blank') && !r.text.includes('textile')));
  await f.runAudioAlarm();
  assert.equal((await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'mixed'},one.token)).status,400);
  const publicPack = {...pack,words:[{word:'textile',vocabulary:null}]};
  const published = await f.call('POST','/admin/publish',{pack:publicPack,visibility:'public',mode:'spelling'},one.token);
  assert.equal(published.status,200);
  const student = await f.call('GET','/packs/'+pack.id,undefined,'');
  assert.equal(student.data.pack.words[0].vocabulary,null);
  assert.deepEqual(student.data.audio,['0-s']);
  assert(!JSON.stringify(student.data).includes('provider'));
});

test('OpenRouter personal free-text fallback is zero-priced unless paid text is explicitly allowed',async () => {
  const env = {OPENROUTER_API_KEY:'personal-router-key',OPENROUTER_FREE_TIER_CONFIRMED:'true',OPENROUTER_FREE_MODEL:'openrouter/free',PERSONAL_KEYS:true};
  assert.equal(providerChoices(env).length,1);
  const choices = providerChoices({...env,ALLOW_PAID_TEXT:true});
  assert.equal(choices.length,2);
  for (const target of choices) {
    const result = await requestVocabulary({target,words:['textile'],settings:{readingLevel:5,practiceSentences:5,exampleSentences:2},maxCompletionTokens:2000,fetchRequest:async (_url,init)=>{
      const body=JSON.parse(init.body);
      assert.equal(body.response_format,undefined);
      assert.equal(!!body.provider.max_price,!target.allowPaid);
      if (!target.allowPaid) assert.equal(body.provider.max_price.completion,0);
      return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({records:[draft('textile')]})}}]});
    }});
    assert.equal(result.records[0].word,'textile');
  }
});

test('Paul speech rejects JSON and incorrect PCM types/rates without accepting garbage',async () => {
  for (const type of ['application/json','audio/mpeg','audio/L16;rate=24000;channels=1','audio/pcm;rate=48000','audio/pcm;channels=2']) {
    await assert.rejects(synthesizeDictation('fake-key','textile',async()=>new Response(new Uint8Array([1,2,3,4]),{headers:{'Content-Type':type}})));
  }
  await assert.rejects(synthesizeDictation('fake-key','x'.repeat(201),async()=>{throw Error('must not call');}));
});

test('default connection transport preserves the Workers fetch receiver',async () => {
  const originalFetch=globalThis.fetch, requests=[];
  globalThis.fetch=async function(url,init) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    requests.push({url,method:init.method});
    return Response.json({data:url.includes('groq.com') ? [] : {label:'fixture'}});
  };
  try {
    const f=fixture(encryptionEnv), one=await invited(f);
    await f.call('PUT','/teacher/keys',{groq:'personal-groq-key',openrouter:'personal-router-key'},one.token);
    assert.deepEqual((await f.call('POST','/teacher/testkeys',undefined,one.token)).data,{groq:'connected',openrouter:'connected'});
    assert.deepEqual(requests.map(r=>r.method),['GET','GET']);
  } finally { globalThis.fetch=originalFetch; }
});

test('connection tests use unbilled endpoints and return sanitized statuses for effective keys',async () => {
  const f=fixture(encryptionEnv), one=await invited(f);
  const requests=[];
  f.service.connectionFetcher=async (url,init)=>{
    requests.push({url,method:init.method});
    assert.equal(init.redirect,'manual');
    assert.equal(init.method,'GET');
    if (url.includes('groq.com')) {assert.equal(init.headers.Authorization,'Bearer personal-groq-key');return Response.json({data:[]});}
    assert.equal(init.headers.Authorization,'Bearer personal-router-key');
    return Response.json({error:'secret internal provider error'}, {status:401});
  };
  assert.deepEqual((await f.call('POST','/teacher/testkeys',undefined,one.token)).data,{groq:'missing',openrouter:'missing'});
  assert.equal(requests.length,0);
  await f.call('PUT','/teacher/keys',{groq:'personal-groq-key',openrouter:'personal-router-key'},one.token);
  assert.deepEqual((await f.call('POST','/teacher/testkeys',undefined,one.token)).data,{groq:'connected',openrouter:'invalid'});
  assert.deepEqual(requests.map(r=>r.url),['https://api.groq.com/openai/v1/models','https://openrouter.ai/api/v1/key']);
  f.service.connectionFetcher=async()=>{throw Error('secret exception');};
  assert.deepEqual((await f.call('POST','/teacher/testkeys',undefined,one.token)).data,{groq:'unavailable',openrouter:'unavailable'});
});

test('Paul audio propagates auth, account and provider errors without trying another voice',async () => {
  let calls=0,status=401,code='provider_auth';
  const f=fixture(encryptionEnv,undefined,async()=>{calls++;throw new ApiError(status,code,'Sanitized provider failure');}),one=await invited(f);
  await f.call('PUT','/teacher/keys',{groq:'groq-text-only-key',openrouter:'personal-router-key',allowAlternateAudio:true},one.token);
  const identity=await f.service.principal(new Request('https://worker.test/api/teacher/profile',{headers:{Authorization:'Bearer '+one.token}}));
  for(const failure of [[401,'provider_auth'],[400,'provider_request'],[402,'provider_request'],[502,'dictation_unavailable'],[429,'dictation_rate_limit']]) {
    [status,code]=failure;
    await assert.rejects(f.service.accounts.speech(identity,{text:'textile',skill:'spelling'}),error=>error.status===status);
  }
  assert.equal(calls,5);
});

test('Voxtral PCM is wrapped as a correctly sized mono 24kHz WAV and keeps samples unchanged',async()=>{
  const pcm=new Uint8Array([20,10,40,20]);
  const wav=await synthesizeDictation('test-router-key','Hello.',async (url,init)=>{
    assert.equal(url,'https://openrouter.ai/api/v1/audio/speech');
    const body=JSON.parse(init.body);
    assert.equal(body.model,'mistralai/voxtral-mini-tts-2603');assert.equal(body.voice,'en_paul_neutral');assert.equal(body.response_format,'pcm');
    return new Response(pcm,{headers:{'Content-Type':'audio/pcm;rate=24000;channels=1'}});
  });
  const view=new DataView(wav.buffer);
  assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(24,true),24000);assert.equal(view.getUint16(34,true),16);assert.equal(view.getUint32(40,true),pcm.length);
  assert.deepEqual(wav.subarray(44),pcm);
});

test('deleting an owned private set stops queued spending and in-flight work cannot resurrect it',async()=>{
  const entered=deferred(),released=deferred();let calls=0;
  const f=fixture(encryptionEnv,undefined,async()=>{calls++;entered.resolve();await released.promise;return audioFixture();});
  const one=await invited(f),two=await invited(f,'teacher-two');
  await f.call('PUT','/teacher/keys',{groq:'personal-groq-key',openrouter:'personal-groq-key'},one.token);
  const pack=privatePack();
  await f.call('POST','/teacher/sets',{pack,expectedVersion:0},one.token);
  await f.call('POST','/teacher/sets',{pack,expectedVersion:0},two.token);
  const running=f.runAudioAlarm();await entered.promise;
  assert.equal((await f.call('DELETE','/teacher/sets/private-regression',undefined,one.token)).status,200);
  released.resolve();await running;
  assert.equal(calls,1);
  assert.equal((await f.call('GET','/teacher/sets/private-regression',undefined,one.token)).status,404);
  assert.equal((await f.call('GET','/teacher/sets/private-regression',undefined,two.token)).status,200);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM teacher_audio WHERE owner = ?').get(one.teacher.id).n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM teacher_audio_queue WHERE owner = ?').get(one.teacher.id).n,0);
});

test('private-backed publications require every selected recording and deletion preserves prepared student links',async()=>{
  const f=fixture(encryptionEnv,undefined,async()=>audioFixture()), one=await invited(f);
  await f.call('PUT','/teacher/keys',{groq:'personal-groq-key',openrouter:'personal-groq-key'},one.token);
  const pack=privatePack();
  assert.equal((await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'spelling'},one.token)).data.error.code,'private_set_required');
  await f.call('POST','/teacher/sets',{pack,expectedVersion:0},one.token);
  const premature=await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'spelling'},one.token);
  assert.equal(premature.status,409);assert.equal(premature.data.error.code,'audio_not_ready');
  await f.runAudioAlarm();
  const published=await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'spelling'},one.token);
  assert.equal(published.status,200);assert.equal(published.data.preparedAudio,true);
  await f.call('DELETE','/teacher/sets/'+pack.id,undefined,one.token);
  const student=await f.call('GET','/packs/'+pack.id,undefined,'');
  assert.equal(student.data.preparedAudio,true);assert.equal(student.data.audioStatus.ready,1);
  assert.equal((await f.call('GET','/packs/'+pack.id+'/audio/1/0-s',undefined,'')).status,200);
  const legacy=await f.call('POST','/admin/publish',{pack:privatePack('legacy-fixture'),visibility:'public',mode:'spelling'});
  assert.equal(legacy.status,200);assert.equal(legacy.data.preparedAudio,undefined);
});

test('private set compare-and-swap rejects a stale expected version even when proposed version jumps forward',async()=>{
  const f=fixture(encryptionEnv),one=await invited(f),pack=privatePack('grade5.unit:1');
  assert.equal((await f.call('POST','/teacher/sets',{pack},one.token)).status,400);
  assert.equal((await f.call('POST','/teacher/sets',{pack,expectedVersion:0},one.token)).status,200);
  const current={...pack,version:3,name:'Current server copy'};
  assert.equal((await f.call('POST','/teacher/sets',{pack:current,expectedVersion:1},one.token)).status,200);
  assert.equal((await f.call('POST','/teacher/sets',{pack:{...pack,version:5,name:'Stale browser copy'},expectedVersion:1},one.token)).status,409);
  const loaded=await f.call('GET','/teacher/sets/'+encodeURIComponent(pack.id),undefined,one.token);
  assert.equal(loaded.status,200);assert.equal(loaded.data.pack.name,'Current server copy');
  assert.equal((await f.call('POST','/teacher/sets/'+encodeURIComponent(pack.id)+'/retry',undefined,one.token)).status,200);
  assert.equal((await f.call('DELETE','/teacher/sets/'+encodeURIComponent(pack.id),undefined,one.token)).status,200);
});

test('identical prompts saved in multiple pending private sets are billed once and valid dotted IDs play',async()=>{
  let calls=0;
  const f=fixture(encryptionEnv,undefined,async()=>{calls++;return audioFixture();}),one=await invited(f);
  await f.call('PUT','/teacher/keys',{groq:'personal-groq-key',openrouter:'personal-groq-key'},one.token);
  for (const id of ['grade5.unit:1','grade5.unit:2']) assert.equal((await f.call('POST','/teacher/sets',{pack:privatePack(id),expectedVersion:0},one.token)).status,200);
  await f.runAudioAlarm();await f.runAudioAlarm();
  assert.equal(calls,1);
  for (const id of ['grade5.unit:1','grade5.unit:2']) assert.equal((await f.call('GET','/teacher/sets/'+encodeURIComponent(id)+'/audio/0-s',undefined,one.token)).status,200);
});

test('concurrent published prompt requests share one provider call across the authentication await',async()=>{
  let calls=0;const entered=deferred(),released=deferred();
  const f=fixture({},undefined,async()=>{calls++;entered.resolve();await released.promise;return audioFixture();});
  const pack=privatePack('operator-concurrent');
  await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'spelling'});
  const body={packId:pack.id,version:1,prompt:'0-s'};
  const first=f.call('POST','/admin/packaudio',body),second=f.call('POST','/admin/packaudio',body);
  await entered.promise;released.resolve();
  assert.equal((await first).status,200);assert.equal((await second).status,200);assert.equal(calls,1);
});

test('owner cannot spend owner credentials by stepping an invited teacher job or recording that teacher publication',async()=>{
  let textCalls=0,audioCalls=0;
  const f=fixture(encryptionEnv,async({words})=>{textCalls++;return {records:words.map(draft),tokens:100};},async()=>{audioCalls++;return audioFixture();});
  const one=await invited(f);await f.call('PUT','/teacher/keys',{groq:'personal-groq-key',openrouter:'personal-groq-key'},one.token);
  const job=await f.call('POST','/generate',{words:['textile']},one.token);
  assert.equal((await f.call('POST','/jobs/'+job.data.id+'/step')).status,404);assert.equal(textCalls,0);
  assert.equal((await f.call('POST','/jobs/'+job.data.id+'/step',undefined,one.token)).status,200);assert.equal(textCalls,1);
  const pack=privatePack('teacher-own-publication');
  await f.call('POST','/teacher/sets',{pack,expectedVersion:0},one.token);await f.runAudioAlarm();
  await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'spelling'},one.token);
  f.db.prepare('DELETE FROM pack_audio WHERE pack = ?').run(pack.id);
  const attempted=await f.call('POST','/admin/packaudio',{packId:pack.id,version:1,prompt:'0-s'});
  assert.equal(attempted.status,403);assert.equal(audioCalls,1);
  const queue=await f.call('POST','/admin/packaudioqueue',{id:pack.id});
  assert.equal(queue.data.audioStatus.pending,false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM audio_queue WHERE pack = ?').get(pack.id).n,0);
});

test('legacy owner publications without an owner marker remain idempotent at the same version',async()=>{
  const f=fixture(),pack=privatePack('legacy-idempotent');
  const info={pack,visibility:'public',practice:{mode:'spelling',allowHints:true}};
  f.db.prepare('INSERT INTO packs VALUES (?,?,?)').run(pack.id,pack.version,JSON.stringify(info));
  const repeated=await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'spelling'});
  assert.equal(repeated.status,200);assert.equal(repeated.data.preparedAudio,undefined);
});

test('queue dispatch rechecks deletion during authentication and alarm scheduling before billing',async()=>{
  for (const pause of ['authenticate','schedule']) {
    let calls=0;const entered=deferred(),released=deferred();
    const f=fixture(encryptionEnv,undefined,async()=>{calls++;return audioFixture();}),one=await invited(f);
    await f.call('PUT','/teacher/keys',{groq:'personal-groq-key',openrouter:'personal-groq-key'},one.token);
    await f.call('POST','/teacher/sets',{pack:privatePack(),expectedVersion:0},one.token);
    if(pause==='authenticate') {
      const authenticate=f.service.accounts.authenticate.bind(f.service.accounts);
      f.service.accounts.authenticate=async identity=>{if(!identity.sid){entered.resolve();await released.promise;}return authenticate(identity);};
    } else {
      const schedule=f.service.scheduleAudio.bind(f.service);
      let first=true;
      f.service.scheduleAudio=async()=>{if(first){first=false;entered.resolve();await released.promise;}return schedule();};
    }
    const running=f.service.accounts.processQueue();await entered.promise;
    assert.equal((await f.call('DELETE','/teacher/sets/private-regression',undefined,one.token)).status,200);
    released.resolve();await running;
    assert.equal(calls,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM teacher_audio').get().n,0);
  }
});

test('silent owner audio cannot be marked ready after quality rejection',async()=>{
  const silent=Buffer.from(audioFixture());silent.fill(0,44);
  const f=fixture({},undefined,async()=>silent);
  await f.call('POST','/teacher/sets',{pack:privatePack(),expectedVersion:0});
  await f.runAudioAlarm();
  const saved=await f.call('GET','/teacher/sets/private-regression');
  assert.equal(saved.data.audioStatus.ready,0);assert.equal(saved.data.audioStatus.recordings[0].status,'failed');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM teacher_audio').get().n,0);
});

test('autosaved legacy owner snapshot can upgrade its prepared-audio marker without changing version',async()=>{
  const f=fixture({},undefined,async()=>audioFixture()),pack=privatePack('legacy-upgrade');
  const legacy={pack,visibility:'public',practice:{mode:'spelling',allowHints:true}};
  f.db.prepare('INSERT INTO packs VALUES (?,?,?)').run(pack.id,pack.version,JSON.stringify(legacy));
  await f.call('POST','/teacher/sets',{pack,expectedVersion:0});await f.runAudioAlarm();
  const response=await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'spelling'});
  assert.equal(response.status,200);assert.equal(response.data.preparedAudio,true);
  assert.equal((await f.call('GET','/packs/'+pack.id,undefined,'')).data.preparedAudio,true);
});

test('invalid audio keys pause the remaining recordings and replacement resumes only missing clips',async()=>{
  const calls=[];
  const f=fixture(encryptionEnv,undefined,async(key,text)=>{calls.push({key,text});if(key==='wrong-personal-key')throw new ApiError(401,'provider_auth','Reconnect your Groq key.');return audioFixture();}),one=await invited(f);
  await f.call('PUT','/teacher/keys',{groq:'good-personal-key',openrouter:'good-personal-key'},one.token);
  const pack=privatePack('key-recovery',['textile','cloth','fabric']);
  await f.call('POST','/teacher/sets',{pack,expectedVersion:0},one.token);await f.runAudioAlarm();
  await f.call('PUT','/teacher/keys',{groq:'wrong-personal-key',openrouter:'wrong-personal-key'},one.token);await f.runAudioAlarm();
  const failed=await f.call('GET','/teacher/sets/key-recovery',undefined,one.token);
  assert.equal(failed.data.audioStatus.ready,1);assert.equal(failed.data.audioStatus.pending,false);
  assert.equal(calls.length,2);
  assert(failed.data.audioStatus.recordings.slice(1).every(r=>r.status==='failed'));
  await f.call('PUT','/teacher/keys',{groq:'corrected-personal-key',openrouter:'corrected-personal-key'},one.token);
  await f.runAudioAlarm();await f.runAudioAlarm();
  const ready=await f.call('GET','/teacher/sets/key-recovery',undefined,one.token);
  assert.equal(ready.data.audioStatus.ready,3);assert.equal(calls.length,4);
  assert.equal(calls.filter(r=>r.text==='textile').length,1);
});

test('an old-key 429 response cannot put a replacement key into provider cooldown',async()=>{
  const entered=deferred(),released=deferred(),calls=[];
  const f=fixture(encryptionEnv,undefined,async(key)=>{
    calls.push(key);
    if(key==='old-personal-key'){entered.resolve();await released.promise;throw new ApiError(429,'dictation_rate_limit','The old key was throttled.');}
    return audioFixture();
  }),one=await invited(f);
  await f.call('PUT','/teacher/keys',{groq:'old-personal-key',openrouter:'old-personal-key'},one.token);
  const request=new Request('https://worker.test/api/teacher/profile',{headers:{Authorization:'Bearer '+one.token}});
  const stale=await f.service.principal(request);
  const running=assert.rejects(f.service.accounts.speech(stale,{text:'textile',skill:'spelling'}),error=>error.code==='dictation_rate_limit');
  await entered.promise;
  await f.call('PUT','/teacher/keys',{groq:'replacement-personal-key',openrouter:'replacement-personal-key'},one.token);
  released.resolve();await running;
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_delay WHERE key = ?').get(one.teacher.id+':audio:openrouter').n,0);
  const current=await f.service.principal(request);
  const clip=await f.service.accounts.speech(current,{text:'textile',skill:'spelling'});
  assert.equal(clip.provider,'openrouter');assert.deepEqual(calls,['old-personal-key','replacement-personal-key']);
});

test('Paul is the sole synthesis voice and Groq-only keys never fund audio',async()=>{
  const calls=[];
  const f=fixture({...encryptionEnv,AUDIO_ENABLED:'true',OPENROUTER_API_KEY:undefined},undefined,async(key,text)=>{calls.push({key,text});return audioFixture();});
  const one=await invited(f);
  await f.call('PUT','/teacher/keys',{groq:'groq-text-only-key',allowAlternateAudio:false},one.token);
  let identity=await f.service.principal(new Request('https://worker.test/api/teacher/profile',{headers:{Authorization:'Bearer '+one.token}}));
  await assert.rejects(f.service.accounts.speech(identity,{text:'textile',skill:'spelling'}),error=>error.code==='provider_key_required');
  assert.equal(calls.length,0);
  await f.call('PUT','/teacher/keys',{openrouter:'paul-personal-key',allowAlternateAudio:false},one.token);
  identity=await f.service.principal(new Request('https://worker.test/api/teacher/profile',{headers:{Authorization:'Bearer '+one.token}}));
  const clip=await f.service.accounts.speech(identity,{text:'textile',skill:'spelling'});
  assert.equal(clip.voice,'en_paul_neutral');assert.equal(clip.provider,'openrouter');
  assert.deepEqual(calls,[{key:'paul-personal-key',text:'textile'}]);
  assert.deepEqual((await f.call('GET','/teacher/profile',undefined,one.token)).data.settings,{allowPaidText:false});
  assert.equal(f.service.meter(Math.floor(Date.parse('2026-11-25T01:00:00Z')/86400000),one.teacher.id+':dictationCalls'),1);
});

test('teacher grade presets are private, merged per grade, validated, and leave credentials/revision intact',async()=>{
  const f=fixture(encryptionEnv),one=await invited(f),two=await invited(f,'teacher-two');
  const defaults=await f.call('GET','/teacher/preferences',undefined,one.token);
  assert.equal(defaults.status,200);assert.equal(Object.keys(defaults.data.presets).length,10);
  assert.equal(defaults.data.presets['3'].readingLevel,3);assert.equal(defaults.data.presets['12'].readingLevel,12);
  assert.equal(defaults.data.presets['5'].practiceSentences,1);assert.equal(defaults.data.presets['5'].exampleSentences,1);
  const before=f.service.accounts.read(one.teacher.id);
  const result=await f.call('PUT','/teacher/preferences',{grade:3,settings:{...defaults.data.presets['3'],dialect:'american',esl:false}},one.token);
  assert.equal(result.status,200);assert.equal(result.data.presets['3'].esl,false);assert.equal(result.data.presets['4'].esl,true);
  const after=f.service.accounts.read(one.teacher.id);assert.equal(after.revision,before.revision);assert.deepEqual(after.keys,before.keys);
  assert.equal((await f.call('GET','/teacher/preferences',undefined,two.token)).data.presets['3'].esl,true);
  for(const input of [{grade:2,settings:{}},{grade:13,settings:{}},{grade:3.5,settings:{}},{grade:3,settings:{context:'private textbook'}},{grade:3,settings:{sense:'private sense'}},{grade:3,settings:{bad:true}}])assert.equal((await f.call('PUT','/teacher/preferences',input,one.token)).status,400);
  assert.equal((await f.call('PUT','/teacher/preferences',{grade:12,settings:{...defaults.data.presets['12'],dialect:'canadian'}})).status,200);
  assert.deepEqual(f.service.accounts.read('operator').keys,{});
});

test('private generation settings round-trip and settings-only saves obey CAS without invalidating clips',async()=>{
  let calls=0;
  const f=fixture({...encryptionEnv,AUDIO_ENABLED:'true'},undefined,async()=>{calls++;return audioFixture();}),one=await invited(f);
  await f.call('PUT','/teacher/keys',{openrouter:'paul-personal-key'},one.token);
  const pack=privatePack('set-settings'),settings={readingLevel:3,practiceSentences:1,exampleSentences:1,context:'Chapter 2',sense:''};
  const saved=await f.call('POST','/teacher/sets',{pack,expectedVersion:0,generationSettings:settings},one.token);
  assert.equal(saved.status,200);assert.equal(saved.data.generationSettings.context,'Chapter 2');
  await f.runAudioAlarm();
  assert.equal((await f.call('POST','/teacher/sets',{pack,expectedVersion:1,generationSettings:{...settings,readingLevel:4}},one.token)).status,409);
  const nextPack={...pack,version:2};
  const edited=await f.call('POST','/teacher/sets',{pack:nextPack,expectedVersion:1,generationSettings:{...settings,readingLevel:4}},one.token);
  assert.equal(edited.status,200);assert.equal(edited.data.audioStatus.ready,1);assert.equal(edited.data.generationSettings.readingLevel,4);
  assert.equal((await f.call('POST','/teacher/sets',{pack:nextPack,expectedVersion:1,generationSettings:{...settings,readingLevel:5}},one.token)).status,409);
  const unchanged=await f.call('POST','/teacher/sets',{pack:nextPack,expectedVersion:0},one.token);
  assert.equal(unchanged.status,200);assert.equal(unchanged.data.generationSettings.readingLevel,4);assert.equal(calls,1);
  const later=await f.call('POST','/teacher/sets',{pack:{...nextPack,version:3},expectedVersion:2},one.token);
  assert.equal(later.data.generationSettings.readingLevel,4);assert.equal(later.data.audioStatus.ready,1);
  assert.equal((await f.call('GET','/teacher/sets/set-settings',undefined,one.token)).data.generationSettings.context,'Chapter 2');
  assert.equal((await f.call('GET','/teacher/sets',undefined,one.token)).data.sets[0].generationSettings.readingLevel,4);
});

test('new or resaved private sets ignore Troy cache while existing published WAVs stay untouched',async()=>{
  let calls=0;
  const f=fixture(encryptionEnv,undefined,async()=>{calls++;return audioFixture();}),one=await invited(f);
  await f.call('PUT','/teacher/keys',{openrouter:'paul-personal-key'},one.token);
  const pack=privatePack('voice-migration'),wav=audioFixture();
  const troyKey=JSON.stringify(['spelling','textile','groq','canopylabs/orpheus-v1-english','troy']);
  f.db.prepare('INSERT INTO teacher_audio VALUES(?,?,?)').run(one.teacher.id,troyKey,wav);
  const initial=await f.call('POST','/teacher/sets',{pack,expectedVersion:0},one.token);
  assert.equal(initial.data.audioStatus.ready,0);
  const old={pack,recordings:[{key:'0-s',skill:'spelling',word:'textile',text:'textile',status:'ready',provider:'groq',voice:'troy',cacheKey:troyKey}]};
  f.db.prepare('UPDATE teacher_sets SET value = ? WHERE owner = ? AND id = ?').run(JSON.stringify(old),one.teacher.id,pack.id);
  f.db.prepare('INSERT INTO packs VALUES(?,?,?)').run(pack.id,1,JSON.stringify({pack,visibility:'public',owner:one.teacher.id,practice:{mode:'spelling',allowHints:true}}));
  f.db.prepare('INSERT INTO pack_audio VALUES(?,?,?,?)').run(pack.id,1,'0-s',wav);
  const resaved=await f.call('POST','/teacher/sets',{pack,expectedVersion:1},one.token);
  assert.equal(resaved.data.audioStatus.ready,0);await f.runAudioAlarm();
  const ready=await f.call('GET','/teacher/sets/'+pack.id,undefined,one.token);
  assert.equal(ready.data.audioStatus.recordings[0].voice,'en_paul_neutral');assert.equal(calls,1);
  assert.deepEqual((await f.call('GET','/packs/'+pack.id+'/audio/1/0-s',undefined,'')).data,new Uint8Array(wav));
});

test('Paul audio kill switch is independent of vocabulary pause and each request is counted once',async()=>{
  let calls=0;
  const f=fixture(encryptionEnv,undefined,async()=>{calls++;return audioFixture();});
  await f.call('PUT','/admin/settings',{generationEnabled:false});
  assert.equal((await f.call('POST','/admin/dictation',{word:'textile',sentence:'We cut the textile.'})).status,200);
  const day=Math.floor(Date.parse('2026-11-25T01:00:00Z')/86400000);
  assert.equal(f.service.meter(day,'operator:dictationCalls'),1);assert.equal(calls,1);
  f.env.AUDIO_ENABLED='false';
  assert.equal((await f.call('POST','/admin/dictation',{word:'textile',sentence:'We cut the textile.'})).status,503);
  assert.equal(calls,1);
  f.env.AUDIO_ENABLED='true';f.service.charge(day,'operator:dictationCalls',99);
  assert.equal((await f.call('POST','/admin/dictation',{word:'textile',sentence:'We cut the textile.'})).status,200);
  assert.equal(f.service.meter(day,'operator:dictationCalls'),101);assert.equal(calls,2);
});

test('legacy voice blocks do not poison Paul and retired alternate settings are a true no-op',async()=>{
  let calls=0;
  const f=fixture(encryptionEnv,undefined,async()=>{calls++;return audioFixture();}),one=await invited(f);
  await f.call('PUT','/teacher/keys',{openrouter:'paul-personal-key'},one.token);
  const before=f.service.accounts.read(one.teacher.id).revision;
  f.service.save('audioBlocked:'+one.teacher.id,{revision:before,code:'provider_auth',message:'Old Groq failure'});
  await f.call('PUT','/teacher/keys',{allowAlternateAudio:false},one.token);
  assert.equal(f.service.accounts.read(one.teacher.id).revision,before);
  const identity=await f.service.principal(new Request('https://worker.test/api/teacher/profile',{headers:{Authorization:'Bearer '+one.token}}));
  await f.service.accounts.speech(identity,{text:'textile',skill:'spelling'});assert.equal(calls,1);
  f.service.save('audioBlocked:openrouter:mistralai/voxtral-mini-tts-2603:en_paul_neutral:'+one.teacher.id,{revision:before,code:'provider_auth',message:'New OpenRouter failure'});
  await assert.rejects(f.service.accounts.speech(identity,{text:'cloth',skill:'spelling'}),error=>error.code==='provider_auth');assert.equal(calls,1);
});

test('partial preset updates merge the selected grade defaults and its latest saved fields',async()=>{
  const f=fixture(encryptionEnv),one=await invited(f);
  let saved=await f.call('PUT','/teacher/preferences',{grade:12,settings:{esl:false}},one.token);
  assert.equal(saved.status,200);assert.equal(saved.data.presets['12'].readingLevel,12);assert.equal(saved.data.presets['12'].practiceSentences,1);assert.equal(saved.data.presets['12'].exampleSentences,1);
  saved=await f.call('PUT','/teacher/preferences',{grade:12,settings:{practiceSentences:4,dialect:'american'}},one.token);
  assert.equal(saved.data.presets['12'].esl,false);
  saved=await f.call('PUT','/teacher/preferences',{grade:12,settings:{explanations:false}},one.token);
  assert.equal(saved.data.presets['12'].practiceSentences,4);assert.equal(saved.data.presets['12'].dialect,'american');assert.equal(saved.data.presets['12'].readingLevel,12);
  assert.equal((await f.call('PUT','/teacher/preferences',{grade:12,settings:{context:'Not a preset'}},one.token)).status,400);
  assert.equal((await f.call('PUT','/teacher/preferences',{grade:12},one.token)).status,400);
});

test('retired owner daily and minute counters do not block Paul or erase usage',async()=>{
  const now=Date.parse('2026-11-25T01:00:00Z'),day=Math.floor(now/86400000),minute=Math.floor(now/60000);
  for(const [daily,perMinute] of [[100,0],[0,10],[100,10]]) {
    let calls=0;
    const f=fixture(encryptionEnv,undefined,async()=>{calls++;return audioFixture();});
    f.service.charge(day,'dictationCalls',daily);f.service.charge(day,'operator:dictationCalls',daily);
    f.service.save('dictationMinute',{minute,calls:perMinute});
    f.service.charge(day,'operator:audio-minute:'+minute,perMinute);
    assert.equal((await f.call('POST','/admin/dictation',{word:'textile',sentence:'We cut the textile.'})).status,200);
    assert.equal(calls,1);
    assert.equal((await f.call('GET','/admin/usage')).data.dictationCalls,daily*2+1);
  }
});

test('an invited teacher can exceed retired audio caps while provider cooldown still applies',async()=>{
  let calls=0;
  const f=fixture(encryptionEnv,undefined,async(key)=>{
    assert.equal(key,'personal-paul-key');calls++;
    if(calls===2) throw new ApiError(429,'dictation_rate_limit','Try again');
    return audioFixture();
  }),one=await invited(f);
  await f.call('PUT','/teacher/keys',{openrouter:'personal-paul-key'},one.token);
  const day=Math.floor(Date.parse('2026-11-25T01:00:00Z')/86400000),minute=Math.floor(Date.parse('2026-11-25T01:00:00Z')/60000);
  f.service.charge(day,one.teacher.id+':dictationCalls',100);
  f.service.charge(day,one.teacher.id+':audio-minute:'+minute,10);
  const identity=await f.service.principal(new Request('https://worker.test/api/teacher/profile',{headers:{Authorization:'Bearer '+one.token}}));
  await f.service.accounts.speech(identity,{text:'textile',skill:'spelling'});
  await assert.rejects(f.service.accounts.speech(identity,{text:'cloth',skill:'spelling'}),error=>error.code==='dictation_rate_limit');
  await assert.rejects(f.service.accounts.speech(identity,{text:'fabric',skill:'spelling'}),error=>error.code==='dictation_rate_limit');
  assert.equal(calls,2);assert.equal(f.service.meter(day,one.teacher.id+':dictationCalls'),102);
  f.advance(61000);
  await f.service.accounts.speech(identity,{text:'fabric',skill:'spelling'});
  assert.equal(calls,3);assert.equal(f.service.meter(day,one.teacher.id+':dictationCalls'),103);
});

test('reading a set wakes a retired daily cap wait without stealing a lease or provider retry',async()=>{
  const now=Date.parse('2026-11-25T01:00:00Z');
  for(const [code,delay,wakes] of [['dictation_daily',3600000,true],['dictation_daily',70000,false],['dictation_rate_limit',3600000,false]]) {
    let calls=0;
    const f=fixture(encryptionEnv,undefined,async()=>{calls++;return audioFixture();}),pack=privatePack('waiting-audio');
    await f.call('POST','/teacher/sets',{pack,expectedVersion:0});
    const record=f.service.accounts.readSet('operator',pack.id);
    Object.assign(record.recordings[0],{status:'pending',errorCode:code,error:'Old wait'});
    f.service.accounts.writeSet('operator',record);
    f.db.prepare('UPDATE teacher_audio_queue SET due = ? WHERE owner = ? AND id = ?').run(now+delay,'operator',pack.id);
    const detail=await f.call('GET','/teacher/sets/'+pack.id);
    assert.equal(detail.status,200);
    assert.equal(f.db.prepare('SELECT due FROM teacher_audio_queue WHERE owner = ? AND id = ?').get('operator',pack.id).due,wakes?now:now+delay);
    assert.equal(calls,0);
    if(wakes) {await f.runAudioAlarm();assert.equal(calls,1);assert.equal((await f.call('GET','/teacher/sets/'+pack.id)).data.audioStatus.ready,1);}
  }
});

test('ready private audio from a different model is not reused even with Paul provider and voice labels',async()=>{
  const f=fixture(encryptionEnv,undefined,async()=>audioFixture()),one=await invited(f),pack=privatePack('different-model');
  await f.call('PUT','/teacher/keys',{openrouter:'paul-personal-key'},one.token);
  await f.call('POST','/teacher/sets',{pack,expectedVersion:0},one.token);
  const key=JSON.stringify(['spelling','textile','openrouter','different-model','en_paul_neutral']);
  f.db.prepare('INSERT INTO teacher_audio VALUES(?,?,?)').run(one.teacher.id,key,audioFixture());
  f.service.accounts.writeSet(one.teacher.id,{pack,recordings:[{key:'0-s',skill:'spelling',text:'textile',word:'textile',status:'ready',provider:'openrouter',voice:'en_paul_neutral',cacheKey:key}]});
  const saved=await f.call('POST','/teacher/sets',{pack,expectedVersion:1},one.token);
  assert.equal(saved.data.audioStatus.ready,0);assert.equal(saved.data.audioStatus.pending,true);
});
