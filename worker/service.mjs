import {
  ApiError, DEFAULT_SETTINGS, MAX_WORD_LENGTH, MAX_WORDS, cacheEligible, cacheKey, dictationText, generatedRecords, integer,
  normalizedWords, parseSettings, requireInput, shape, shortId, validatePack, validatedRecord, vocabularyWord, wordKey
} from './validation.mjs';
import { GROQ_MODELS, providerChoices, requestVocabulary, tokenBudget } from './provider.mjs';
import { hasSpeechSignal, synthesizeDictation } from './dictation.mjs';
import Learning from '../src/learning.js';
import Dictation from '../src/dictation.js';
import { TeacherAccounts } from './accounts.mjs';

const DAY = 86_400_000;
const HOUR = 3600_000;
const LEASE = 45_000;
const JOB_LIFETIME = 7 * DAY;
const LIMITS = Object.freeze({
  calls: 200, tokens: 150_000, concurrent: 2, sessionJobs: 5, sessionWords: 200,
  cacheJobs: 50, openRouterCalls: 50, retries: 3
});
const INITIAL_BATCH = 10;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });
const ACTIVE = ['ready', 'paused'];
const schema = [
  'CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS classes (id TEXT PRIMARY KEY, code_hash TEXT UNIQUE, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, attempts INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, created INTEGER NOT NULL, value TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS jobs_lifetime ON jobs(created)',
  'CREATE INDEX IF NOT EXISTS owner_jobs ON jobs(owner, created)',
  'CREATE TABLE IF NOT EXISTS job_words (job TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, position INTEGER NOT NULL, word TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, content TEXT, PRIMARY KEY (job, position))',
  'CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, job TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS meter (day INTEGER NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(day, key))',
  'CREATE TABLE IF NOT EXISTS provider_delay (key TEXT PRIMARY KEY, until INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS packs (id TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS pack_audio (pack TEXT NOT NULL, version INTEGER NOT NULL, prompt TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(pack, version, prompt))',
  'CREATE TABLE IF NOT EXISTS audio_queue (pack TEXT PRIMARY KEY, version INTEGER NOT NULL, mode TEXT NOT NULL, cursor INTEGER NOT NULL, tries INTEGER NOT NULL, due INTEGER)',
  'CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, pack TEXT NOT NULL, word TEXT NOT NULL, content TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS cache_pack ON cache(pack)',
  'CREATE INDEX IF NOT EXISTS cache_word ON cache(word)'
];

const localDay = (now) => Math.floor(now / DAY);
const nextDay = (now) => (localDay(now) + 1) * DAY;
const terminal = (job) => !ACTIVE.includes(job.status);
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const json = (data, status = 200) => Response.json(data, { status });
const notFound = () => fail(404, 'not_found', 'This resource is unavailable.');
const denied = () => fail(401, 'unauthorized', 'Sign in with valid classroom or teacher access.');

function audioResponse(value, range) {
  const bytes = new Uint8Array(value);
  const size = bytes.length;
  const headers = new Headers({'Content-Type':'audio/wav', 'Accept-Ranges':'bytes', 'Content-Length':String(size)});
  if (!range) return new Response(bytes, {headers});
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return new Response(bytes, {headers});
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (start > end || start >= size) {
    headers.set('Content-Range', 'bytes */' + size);
    headers.set('Content-Length','0');
    return new Response(null, {status:416, headers});
  }
  headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(bytes.subarray(start, end + 1), {status:206, headers});
}

function base64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function unbase64(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
}

function randomId(bytes = 18) {
  return base64(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function bodyOf(request, limit = 24_000) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') ?? '')) {
    fail(415, 'unsupported_media', 'Send a JSON request.');
  }
  if (!request.body || Number(request.headers.get('Content-Length')) > limit) {
    fail(413, 'too_large', 'This request is too large.');
  }
  const reader = request.body.getReader();
  let size = 0;
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      fail(413, 'too_large', 'This request is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(DECODER.decode(bytes));
  } catch {
    fail(400, 'invalid_json', 'Check the JSON formatting.');
  }
}

function secureEquals(first, second) {
  const left = ENCODER.encode(first);
  const right = ENCODER.encode(second);
  if (left.length !== right.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(left, right);
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

export class VocabularyService {
  constructor(storage, env, { now = Date.now, fetcher = requestVocabulary, speechFetcher = synthesizeDictation, connectionFetcher = (...args) => fetch(...args) } = {}) {
    this.storage = storage;
    this.sql = storage.sql;
    this.atomic = (work) => storage.transactionSync(work);
    this.env = env;
    this.now = now;
    this.fetcher = fetcher;
    this.speechFetcher = speechFetcher;
    this.connectionFetcher = connectionFetcher;
    this.audioInFlight = new Map();
    this.origins = new Set((env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim())
      .filter((origin) => /^https?:\/\/[^/]+$/i.test(origin)));
    for (const statement of schema) this.sql.exec(statement);
    this.accounts = new TeacherAccounts(this);
    this.atomic(() => {
      const {legacyDemoPackId, demoPackId} = Dictation;
      const old = this.one('SELECT value FROM packs WHERE id = ?', legacyDemoPackId);
      if (!old || this.one('SELECT id FROM packs WHERE id = ?', demoPackId)) return;
      const value = JSON.parse(old.value);
      value.pack.id = demoPackId;
      this.sql.exec('UPDATE packs SET id = ?, value = ? WHERE id = ?', demoPackId, JSON.stringify(value), legacyDemoPackId);
      this.sql.exec('UPDATE pack_audio SET pack = ? WHERE pack = ?', demoPackId, legacyDemoPackId);
      this.sql.exec('UPDATE cache SET pack = ? WHERE pack = ?', demoPackId, legacyDemoPackId);
    });
  }

  rows(query, ...args) {
    return this.sql.exec(query, ...args).toArray();
  }

  one(query, ...args) {
    return this.rows(query, ...args)[0];
  }

  saved(key) {
    return JSON.parse(this.one('SELECT value FROM config WHERE key = ?', key)?.value ?? 'null');
  }

  save(key, value) {
    this.sql.exec('INSERT INTO config VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  enabled(teacher) {
    return this.env.AI_ENABLED === 'true' && this.saved('generationEnabled') !== false
      && (teacher || this.env.STUDENT_AI_ENABLED === 'true');
  }

  providers(teacher) {
    if (teacher && typeof teacher === 'object' && teacher.role === 'teacher' && (!teacher.isAdmin || teacher.personalKeys)) {
      if (!this.accounts.unchanged(teacher)) return [];
      return providerChoices({...this.env,GROQ_API_KEY:teacher.credentials.groq,
        GROQ_FREE_TIER_CONFIRMED:'true',OPENROUTER_API_KEY:teacher.credentials.openrouter,
        OPENROUTER_FREE_TIER_CONFIRMED:'true',OPENROUTER_FREE_MODEL:'openrouter/free',
        OPENROUTER_APPROVED_PROVIDER:undefined,PERSONAL_KEYS:true,ALLOW_PAID_TEXT:teacher.settings.allowPaidText},true,this.saved('groqModels'));
    }
    return providerChoices(this.env, teacher, this.saved('groqModels'));
  }

  dictationEnabled() {
    return this.env.AUDIO_ENABLED === 'true' && !!this.env.OPENROUTER_API_KEY;
  }

  publicConfig() {
    const draftingAvailable = this.env.AI_ENABLED === 'true' && this.providers(true).length > 0;
    return {
      draftingAvailable,
      generationEnabled: draftingAvailable && this.enabled(true),
      dictationEnabled: this.dictationEnabled(),
      studentGenerationEnabled: this.enabled(false) && this.providers(false).length > 0,
      maxWords: MAX_WORDS, maxWordLength: MAX_WORD_LENGTH, defaults: DEFAULT_SETTINGS
    };
  }

  async signature(input) {
    const secret = this.env.SESSION_SIGNING_SECRET;
    if (typeof secret !== 'string' || secret.length < 32) fail(503, 'unavailable', 'Access is temporarily unavailable.');
    this.signingKey ??= crypto.subtle.importKey('raw', ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const key = await this.signingKey;
    return base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, ENCODER.encode(input))));
  }

  async session(role, expiresAt, classRecord, sid = randomId()) {
    const identity = {
      role, sid, expiresAt,
      ...(classRecord ? classRecord.teacherId ? {teacherId:classRecord.teacherId,epoch:classRecord.epoch} : { classId: classRecord.classId, epoch: classRecord.epoch } : {})
    };
    const payload = base64(ENCODER.encode(JSON.stringify(identity)));
    return { token: payload + '.' + await this.signature('session:' + payload), expiresAt, ...(classRecord ? { classId: classRecord.classId } : {}) };
  }

  isTeacher(secret) {
    return typeof this.env.ADMIN_AUTH_SECRET === 'string' && this.env.ADMIN_AUTH_SECRET.length >= 32
      && typeof secret === 'string' && secureEquals(secret, this.env.ADMIN_AUTH_SECRET);
  }

  readClass(classId) {
    return JSON.parse(this.one('SELECT value FROM classes WHERE id = ?', classId)?.value ?? 'null');
  }

  validClass(record, epoch) {
    return record && !record.revoked && record.expiresAt > this.now() && record.epoch === epoch;
  }

  async principal(request) {
    const token = /^Bearer ([^\s]{1,700})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
    if (!token) denied();
    if (this.isTeacher(token)) return this.accounts.authenticate({ role: 'teacher', sid: 'operator', teacherId:'operator', isAdmin:true });
    const identity = await this.verifiedSession(token);
    if (identity.expiresAt <= this.now()) denied();
    if (identity.role === 'class' && !this.validClass(this.readClass(identity.classId), identity.epoch)) denied();
    return this.accounts.authenticate(identity);
  }

  async verifiedSession(token) {
    const pieces = token.split('.');
    if (pieces.length !== 2 || !pieces.every((piece) => /^[\w-]+$/.test(piece))) denied();
    const [payload, mac] = pieces;
    if (!secureEquals(mac, await this.signature('session:' + payload))) denied();
    return JSON.parse(DECODER.decode(unbase64(payload)));
  }

  async login(request, admin) {
    const input = await bodyOf(request, 2048);
    const field = admin ? 'secret' : 'code';
    requireInput(shape(input, admin ? [field] : [field, 'previousToken']) && typeof input[field] === 'string'
      && input[field].length <= 300 && (input.previousToken === undefined
        || (typeof input.previousToken === 'string' && input.previousToken.length <= 700)), 'Enter a valid access credential.');
    const now = this.now();
    const window = Math.floor(now / (15 * 60_000));
    const client = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const key = await this.signature('login:' + field + ':' + window + ':' + client);
    this.atomic(() => {
      const limit = admin ? 12 : 250;
      const count = this.one('SELECT attempts FROM login_limits WHERE key = ?', key)?.attempts ?? 0;
      const globalKey = field + ':' + window;
      const overall = this.one('SELECT attempts FROM login_limits WHERE key = ?', globalKey)?.attempts ?? 0;
      if (count >= limit || overall >= limit * 10) fail(429, 'access_limit', 'Too many access attempts. Try again later.');
      this.sql.exec('DELETE FROM login_limits WHERE window < ?', window);
      for (const item of [key, globalKey]) {
        this.sql.exec('INSERT INTO login_limits VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1', item, window);
      }
    });
    if (admin) {
      const passwordHash = this.env.TEACHER_PASSWORD_HASH;
      const allowed = passwordHash === undefined ? this.isTeacher(input.secret) :
        secureEquals(passwordHash, await this.signature('teacher-password:' + input.secret));
      if (!allowed) denied();
      return {...await this.session('teacher', now + 2 * HOUR),...this.accounts.profile(await this.accounts.authenticate({role:'teacher',teacherId:'operator',isAdmin:true}))};
    }
    const code = input.code.trim();
    const hash = await this.signature('class-code:' + code);
    const record = JSON.parse(this.one('SELECT value FROM classes WHERE code_hash = ?', hash)?.value ?? 'null');
    if (!this.validClass(record, record?.epoch)) denied();
    let sid;
    if (input.previousToken) {
      const previous = await this.verifiedSession(input.previousToken);
      if (previous.role !== 'class' || previous.classId !== record.classId || previous.epoch !== record.epoch
        || previous.expiresAt <= now - JOB_LIFETIME) denied();
      sid = previous.sid;
    }
    return this.session('class', Math.min(now + 2 * HOUR, record.expiresAt), record, sid);
  }

  publicClass({ epoch, ...info }) {
    return info;
  }

  async writeClass(input) {
    requireInput(shape(input, ['classId', 'name', 'expiresAt', 'dailyWords', 'revoked', 'rotateCode'])
      && shortId(input.classId)
      && (input.revoked === undefined || typeof input.revoked === 'boolean')
      && (input.rotateCode === undefined || typeof input.rotateCode === 'boolean'), 'Invalid classroom settings.');
    // Hash before opening the transaction. Check the current state again before writing.
    const code = randomId(12);
    const hash = await this.signature('class-code:' + code);
    return this.atomic(() => {
      const old = this.one('SELECT value, code_hash FROM classes WHERE id = ?', input.classId);
      const prior = old ? JSON.parse(old.value) : null;
      const record = {
        classId: input.classId, name: input.name ?? prior?.name,
        expiresAt: input.expiresAt ?? prior?.expiresAt, dailyWords: input.dailyWords ?? prior?.dailyWords,
        revoked: input.revoked ?? prior?.revoked ?? false, epoch: prior?.epoch ?? 0
      };
      requireInput(typeof record.name === 'string' && record.name.trim().length > 0 && record.name.length <= 80
        && !/[<>\p{C}]/u.test(record.name) && integer(record.expiresAt, 0, Number.MAX_SAFE_INTEGER)
        && integer(record.dailyWords, 0, 5000), 'Provide a class name, expiry time, and daily allowance.');
      const issueCode = !record.revoked && (!old?.code_hash || input.rotateCode || prior?.revoked);
      if (issueCode || record.revoked !== prior?.revoked) record.epoch++;
      this.sql.exec('INSERT INTO classes VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET code_hash = excluded.code_hash, value = excluded.value',
        record.classId, record.revoked ? null : issueCode ? hash : old.code_hash, JSON.stringify(record));
      return { ...this.publicClass(record), ...(issueCode ? { code } : {}) };
    });
  }

  meter(day, key) {
    return this.one('SELECT value FROM meter WHERE day = ? AND key = ?', day, key)?.value ?? 0;
  }

  charge(day, key, amount) {
    this.sql.exec('INSERT INTO meter VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET value = value + excluded.value', day, key, amount);
  }

  readJob(id, identity, mutation = false) {
    const entry = this.one('SELECT owner, value FROM jobs WHERE id = ? AND created > ?', id, this.now() - JOB_LIFETIME);
    if (!entry || (!identity.isAdmin && entry.owner !== identity.sid)) notFound();
    if (mutation && identity.isAdmin && entry.owner !== 'operator' && this.accounts.read(entry.owner)) notFound();
    return JSON.parse(entry.value);
  }

  writeJob(job) {
    this.sql.exec('UPDATE jobs SET value = ? WHERE id = ?', JSON.stringify(job), job.id);
  }

  jobDetail(job) {
    const words = this.rows('SELECT word, status, content FROM job_words WHERE job = ? ORDER BY position', job.id);
    const counts = { total: words.length, cached: 0, generated: 0, failed: 0, pending: 0 };
    for (const word of words) counts[word.status]++;
    const lease = this.one('SELECT expires FROM leases WHERE job = ? AND expires > ?', job.id, this.now());
    const status = job.status === 'ready' && lease ? 'processing' : job.status;
    return {
      id: job.id, status, counts,
      words: words.filter((word) => word.content).map((word) => JSON.parse(word.content)),
      failedWords: words.filter((word) => word.status === 'failed').map((word) => word.word),
      ...(job.retryAt ? { retryAt: job.retryAt } : {}),
      ...(job.message ? { message: job.message } : {})
    };
  }

  createJob(input, identity, idempotencyKey, regenerate) {
    const teacher = identity.role === 'teacher';
    requireInput(shape(input, regenerate
      ? ['word', 'settings', 'item', 'questionId', 'previous'] : ['words', 'settings']), 'Unrecognized generation parameters.');
    const settings = parseSettings(input.settings ?? {}, teacher);
    const words = normalizedWords(regenerate ? [input.word] : input.words);
    let regeneration = null;
    if (regenerate) {
      const item = input.item ?? 'all';
      requireInput(['all', 'definition', 'examples', 'cloze', 'distractors'].includes(item), 'Choose a valid content item.');
      requireInput(item === 'all' || teacher, 'Individual content edits are for teachers.');
      if (input.previous || item !== 'all') {
        requireInput(teacher, 'Supplying previous vocabulary content is for teachers.');
        const previous = validatedRecord(input.previous);
        requireInput(previous.word === words[0], 'The previous vocabulary must match the target word.');
        if (item === 'cloze') requireInput(previous.vocabulary.clozeQuestions.some((q) => q.id === input.questionId), 'Choose an existing practice sentence.');
      }
      regeneration = { item, previous: input.previous, questionId: input.questionId };
    }
    if (idempotencyKey !== null) requireInput(shortId(idempotencyKey), 'Invalid request identifier.');
    const fingerprint = JSON.stringify({ words, settings, regeneration });
    return this.atomic(() => {
      const now = this.now();
      const day = localDay(now);
      if (!teacher && !this.validClass(this.readClass(identity.classId), identity.epoch)) denied();
      if (!teacher && this.env.STUDENT_AI_ENABLED !== 'true') fail(403, 'student_generation_disabled', 'Student AI generation is disabled.');
      const jobs = this.rows('SELECT value FROM jobs WHERE owner = ? AND created > ? ORDER BY created DESC', identity.sid, now - JOB_LIFETIME)
        .map((row) => JSON.parse(row.value));
      if (idempotencyKey) {
        const previous = jobs.find((job) => job.idempotencyKey === idempotencyKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail(409, 'request_conflict', 'This request identifier was used for a different job.');
          return { detail: this.jobDetail(previous), existing: true };
        }
      }
      const entries = words.map((word) => {
        const cache = settings.reuseApproved && !regenerate
          ? this.one('SELECT content FROM cache WHERE key = ?', cacheKey(word, settings)) : null;
        const entry = cache && JSON.parse(cache.content);
        return { word, status: entry?.word === word ? 'cached' : 'pending', content: entry?.word === word ? cache.content : null };
      });
      const uncached = entries.filter((entry) => entry.status === 'pending').length;
      const cached = entries.length - uncached;
      const owner = 'session:' + identity.sid + ':';
      if (uncached) {
        if (!this.enabled(teacher) || !this.providers(teacher ? identity : false).length) fail(503, 'generation_offline', 'AI generation is unavailable. Connect your provider key or import approved content.');
        const active = jobs.find((job) => !terminal(job));
        if (active) {
          if (active.fingerprint === fingerprint) return { detail: this.jobDetail(active), existing: true };
          fail(409, 'active_job', 'Finish or cancel your current generation job first.');
        }
        if (this.meter(day, owner + 'jobs') >= LIMITS.sessionJobs
          || this.meter(day, owner + 'words') + uncached > LIMITS.sessionWords) {
          fail(429, 'session_quota', 'This session has reached its daily generation allowance.');
        }
        if (!teacher) {
          const classKey = 'class:' + identity.classId + ':words';
          if (this.meter(day, classKey) + uncached > this.readClass(identity.classId).dailyWords) {
            fail(429, 'class_quota', 'This class has reached its daily generation allowance.');
          }
          this.charge(day, classKey, uncached);
        }
        this.charge(day, owner + 'jobs', 1);
        this.charge(day, owner + 'words', uncached);
      } else {
        if (this.meter(day, owner + 'cache') >= LIMITS.cacheJobs) fail(429, 'cache_quota', 'This session has reached its daily cache-only allowance.');
        this.charge(day, owner + 'cache', 1);
      }
      this.sql.exec('DELETE FROM jobs WHERE created <= ?', now - JOB_LIFETIME);
      this.sql.exec('DELETE FROM meter WHERE day < ?', day - 8);
      if (cached) this.charge(day, 'cacheHits', cached);
      this.charge(day, 'wordLookups', entries.length);
      const job = {
        id: crypto.randomUUID(), classId: identity.classId, epoch: identity.epoch, createdAt: now, settings, regeneration,
        status: uncached ? 'ready' : 'complete', batchSize: INITIAL_BATCH, failures: 0, idempotencyKey, fingerprint
      };
      this.sql.exec('INSERT INTO jobs VALUES (?, ?, ?, ?)', job.id, identity.sid, now, JSON.stringify(job));
      const insert = 'INSERT INTO job_words (job, position, word, status, content) VALUES (?, ?, ?, ?, ?)';
      entries.forEach((entry, index) => this.sql.exec(insert, job.id, index, entry.word, entry.status, entry.content));
      return { detail: this.jobDetail(job), existing: false };
    });
  }

  adjustJob(id, identity, action) {
    return this.atomic(() => {
      const job = this.readJob(id, identity,true);
      if (job.status === 'cancelled') return this.jobDetail(job);
      if (action === 'resume' && job.status === 'complete') return this.jobDetail(job);
      if (action === 'pause' && job.status !== 'complete') {
        job.status = 'paused';
        job.manualPause = true;
        job.message = 'Generation paused.';
      }
      if (action === 'resume') {
        job.manualPause = false;
        if (!job.retryAt || job.retryAt <= this.now()) {
          const pending = this.one("SELECT position FROM job_words WHERE job = ? AND status = 'pending' LIMIT 1", id);
          job.status = pending ? 'ready' : 'complete';
          job.retryAt = 0;
          job.message = '';
        }
      }
      if (action === 'cancel' && !terminal(job)) {
        job.status = 'cancelled';
        job.retryAt = 0;
        job.message = 'Generation cancelled. Completed words remain available.';
      }
      this.writeJob(job);
      return this.jobDetail(job);
    });
  }

  reserveBatch(id, identity) {
    return this.atomic(() => {
      const job = this.readJob(id, identity,true);
      const now = this.now();
      if (terminal(job) || job.manualPause || job.retryAt > now) return { detail: this.jobDetail(job) };
      this.sql.exec('DELETE FROM leases WHERE expires <= ?', now);
      if (this.one('SELECT id FROM leases WHERE job = ?', id)) return { detail: this.jobDetail(job) };
      const teacher = !job.classId;
      if (!teacher && !this.validClass(this.readClass(job.classId), job.epoch)) {
        return { detail: this.defer(job, 'Classroom access to this job has expired or changed.') };
      }
      if (!this.enabled(teacher) || !this.providers(teacher ? identity : false).length) {
        return { detail: this.defer(job, 'AI generation is unavailable. Your completed words are saved.') };
      }
      const batch = this.rows("SELECT position, word, attempts FROM job_words WHERE job = ? AND status = 'pending' ORDER BY attempts, position LIMIT ?", id, job.batchSize);
      if (!batch.length) {
        job.status = 'complete';
        this.writeJob(job);
        return { detail: this.jobDetail(job) };
      }
      const nextLease = identity.role === 'teacher' && !identity.isAdmin
        ? this.one('SELECT MIN(l.expires) AS expires, COUNT(*) AS count FROM leases l JOIN jobs j ON l.job = j.id WHERE j.owner = ?',identity.sid)
        : this.one('SELECT MIN(expires) AS expires, COUNT(*) AS count FROM leases');
      if (nextLease.count >= LIMITS.concurrent) {
        return { detail: this.defer(job, 'The generation slots are busy.', Math.min(nextLease.expires, now + 3000)) };
      }
      const day = localDay(now);
      const words = batch.map(({ word }) => word);
      let budget = tokenBudget(words, job.settings, job.regeneration);
      const prefix = identity.role === 'teacher' && !identity.isAdmin ? identity.teacherId + ':' : '';
      const tokensLeft = LIMITS.tokens - this.meter(day, prefix + 'tokens');
      while (words.length > 1 && budget.reservedTokens > tokensLeft) {
        words.pop();
        batch.pop();
        budget = tokenBudget(words, job.settings, job.regeneration);
      }
      if (this.meter(day, prefix + 'calls') >= LIMITS.calls || budget.reservedTokens > tokensLeft) {
        return { detail: this.defer(job, 'The daily AI budget is used up.', nextDay(now)) };
      }
      const routerAvailable = this.meter(day, prefix + 'openRouterCalls') < LIMITS.openRouterCalls;
      const providers = this.providers(teacher ? identity : false).filter((target) => target.provider !== 'openrouter' || routerAvailable);
      const offset = providers.length ? (job.providerOffset ?? 0) % providers.length : 0;
      const order = [...providers.slice(offset), ...providers.slice(0, offset)];
      const delay = (target) => this.one('SELECT until FROM provider_delay WHERE key = ?', prefix + target.model)?.until ?? 0;
      const target = order.find((option) => delay(option) <= now);
      if (!target) {
        return { detail: this.defer(job, 'Free AI capacity is temporarily unavailable.', order.length
          ? Math.min(...order.map(delay)) : nextDay(now)) };
      }
      // Groq's Free tier reserves a share of its minute-wide budget for each request.
      while (target.provider === 'groq' && words.length > 1 && budget.providerTokens > 8000) {
        words.pop();
        batch.pop();
        budget = tokenBudget(words, job.settings, job.regeneration);
      }
      const lease = randomId();
      this.sql.exec('INSERT INTO leases VALUES (?, ?, ?)', lease, id, now + LEASE);
      this.charge(day, prefix + 'calls', 1);
      this.charge(day, prefix + 'tokens', budget.reservedTokens);
      if (target.provider === 'openrouter') this.charge(day, prefix + 'openRouterCalls', 1);
      job.status = 'ready';
      job.retryAt = 0;
      job.message = '';
      this.writeJob(job);
      return { job, lease, batch, words, target, day, budget, now, prefix, providerOffset: providers.indexOf(target) };
    });
  }

  defer(job, message, retryAt = 0) {
    job.status = 'paused';
    job.retryAt = retryAt;
    job.message = message;
    this.writeJob(job);
    return this.jobDetail(job);
  }

  async runBatch(id, identity) {
    const reservation = this.reserveBatch(id, identity);
    if (reservation.detail) return reservation.detail;
    const { job: reservedJob, lease, batch, words, target, day, budget, now, prefix, providerOffset } = reservation;
    let result;
    try {
      result = await this.fetcher({
        target, words, settings: reservedJob.settings, regeneration: reservedJob.regeneration,
        maxCompletionTokens: budget.maxCompletionTokens, now
      });
    } catch {
      result = { records: [], unavailable: true };
    }
    const valid = generatedRecords(result.records, words, reservedJob.settings, reservedJob.regeneration);
    return this.atomic(() => {
      const job = this.readJob(id, identity);
      // An expired reservation stays charged when its outcome is unknown.
      if (!this.one('SELECT id FROM leases WHERE id = ?', lease)) return this.jobDetail(job);
      this.sql.exec('DELETE FROM leases WHERE id = ?', lease);
      if (identity.role === 'teacher' && !this.accounts.unchanged(identity)) {
        if (!this.accounts.current(identity)) return this.jobDetail(job);
        return this.defer(job,'Teacher access or provider settings changed. Reload and retry.');
      }
      const used = integer(result.tokens, 1, 1_000_000) ? result.tokens : result.rateLimited ? 0 : budget.reservedTokens;
      this.charge(day, prefix + 'tokens', used - budget.reservedTokens);
      if (result.retryInMs) {
        const retryAt = now + result.retryInMs;
        this.sql.exec('INSERT INTO provider_delay VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET until = MAX(until, excluded.until)', prefix + target.model, retryAt);
      }
      if (job.status === 'cancelled') return this.jobDetail(job);
      if (result.rateLimited) {
        job.providerOffset = providerOffset;
        job.batchSize = Math.max(5, Math.ceil(batch.length / 2));
        return this.defer(job, job.manualPause ? 'Generation paused.' : 'The AI provider reached a rate limit.', now + (result.retryInMs || 60_000));
      }
      for (const entry of batch) {
        const record = valid.get(entry.word);
        if (record) {
          this.sql.exec("UPDATE job_words SET status = 'generated', content = ? WHERE job = ? AND position = ?",
            JSON.stringify(record), id, entry.position);
        } else {
          const attempts = entry.attempts + 1;
          this.sql.exec('UPDATE job_words SET status = ?, attempts = ? WHERE job = ? AND position = ?',
            attempts > LIMITS.retries ? 'failed' : 'pending', attempts, id, entry.position);
        }
      }
      const remaining = this.one("SELECT position FROM job_words WHERE job = ? AND status = 'pending' LIMIT 1", id);
      if (!remaining && !job.manualPause) job.status = 'complete';
      if (valid.size === batch.length) {
        job.batchSize = Math.min(20, Math.max(job.batchSize, batch.length + 2));
        job.failures = 0;
      } else {
        job.batchSize = Math.max(5, Math.ceil(job.batchSize / 2));
        job.failures += 1;
      }
      job.providerOffset = result.unavailable || (!valid.size && job.failures > 1) ? providerOffset + 1 : providerOffset;
      if (result.unavailable && remaining && !job.manualPause) {
        return this.defer(job, 'The AI service is temporarily unavailable. Completed words are saved.', this.now() + 2000);
      }
      this.writeJob(job);
      return this.jobDetail(job);
    });
  }

  async publish(input, identity = {isAdmin:true,teacherId:'operator'}) {
    requireInput(shape(input, ['pack', 'visibility', 'classId', 'cacheSettings', 'mode', 'allowHints', 'retypeOnMiss', 'allowVariants'])
      && ['public', 'class', 'private'].includes(input.visibility), 'Choose a valid pack visibility.');
    requireInput(input.mode === undefined || ['spelling', 'vocabulary', 'mixed'].includes(input.mode), 'Choose a valid practice mode.');
    requireInput(input.allowHints === undefined || typeof input.allowHints === 'boolean', 'Choose whether to allow hints.');
    for (const key of ['retypeOnMiss','allowVariants']) requireInput(input[key] === undefined || typeof input[key] === 'boolean','Practice rules must be true or false.');
    const { visibility } = input;
    const pack = validatePack(input.pack, { allowSpellingOnly: input.mode === 'spelling' });
    pack.id = Dictation.canonicalPackId(pack.id);
    const classId = input.classId;
    if (!identity.isAdmin && (visibility === 'class' || input.cacheSettings !== undefined)) fail(403,'forbidden','Only the owner manages classrooms and the shared vocabulary cache.');
    requireInput(visibility === 'class' ? shortId(classId) && this.readClass(classId) : classId == null || classId === '',
      'Class packs must have a valid classroom.');
    let settings = input.cacheSettings === undefined ? null : parseSettings(input.cacheSettings, true);
    const vocabularyEntries = pack.words.filter((entry) => entry.vocabulary !== null);
    requireInput(!settings || (visibility === 'public' && vocabularyEntries.length > 0 && !settings.context && !settings.sense
      && vocabularyEntries.every((entry) => cacheEligible(entry, settings))), 'Reusable packs must be public and match the declared settings.');
    const practice = {mode:input.mode || 'mixed', allowHints:input.allowHints !== false,
      ...Object.fromEntries(['retypeOnMiss','allowVariants'].filter(key => input[key] !== undefined).map(key => [key,input[key]]))};
    const privateSet = this.accounts.readSet(identity.teacherId,pack.id);
    const info = {pack, visibility, practice, ...(privateSet ? {preparedAudio:true} : {}), ...(visibility === 'class' ? {classId} : {})};
    const storage = { ...info, owner:identity.teacherId, ...(settings ? { cacheSettings: settings } : {}) };
    return this.atomic(() => {
      const existing = this.one('SELECT version, value FROM packs WHERE id = ?', pack.id);
      const prior = existing && JSON.parse(existing.value);
      if (!this.accounts.unchanged(identity)) fail(409,'account_changed','Teacher access or provider settings changed.');
      if (existing && !identity.isAdmin && (prior.owner ?? 'operator') !== identity.teacherId) notFound();
      if (input.cacheSettings === undefined && existing?.version === pack.version && canonical(prior.pack) === canonical(pack) && prior.cacheSettings) {
        settings = prior.cacheSettings;
        storage.cacheSettings = settings;
      }
      if (!identity.isAdmin && !privateSet) fail(409,'private_set_required','Save this set privately and prepare its recordings before sharing.');
      if (privateSet && canonical(this.accounts.publishedSnapshot(privateSet.pack,practice.mode)) !== canonical(pack)) fail(409,'pack_version','The private set changed. Reload before sharing.');
      if (privateSet) {
        const prompts = pack.words.flatMap((word,index) => Learning.practiceAudioPrompts(word,index)).filter(prompt => practice.mode !== 'spelling' || prompt.skill === 'spelling');
        const ready = prompts.every(prompt => privateSet.recordings.some(r => r.key === prompt.key && r.text === prompt.text && r.skill === prompt.skill && r.status === 'ready'
          && this.one('SELECT key FROM teacher_audio WHERE owner = ? AND key = ?',identity.teacherId,r.cacheKey)));
        if (!ready) fail(409,'audio_not_ready','Prepare all recordings for this practice mode before sharing.');
      }
      if (existing && existing.version >= pack.version) {
        const {practice: previousPractice, preparedAudio:previousPrepared, ...previous} = {owner:'operator',...prior};
        const {practice: currentPractice, preparedAudio:currentPrepared, ...current} = storage;
        if (existing.version !== pack.version || canonical(previous) !== canonical(current)) {
          fail(409, 'pack_version', 'Increase the pack version to publish changes.');
        }
        if (canonical(previousPractice) === canonical(currentPractice) && previousPrepared === currentPrepared) {
          this.accounts.copyPublished(identity,pack,practice.mode);
          return info;
        }
      }
      this.sql.exec('INSERT INTO packs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, value = excluded.value',
        pack.id, pack.version, JSON.stringify(storage));
      this.sql.exec('DELETE FROM pack_audio WHERE pack = ? AND version <> ?', pack.id, pack.version);
      this.sql.exec('DELETE FROM audio_queue WHERE pack = ?', pack.id);
      this.sql.exec('DELETE FROM cache WHERE pack = ?', pack.id);
      if (settings) for (const entry of vocabularyEntries) {
        this.sql.exec('INSERT INTO cache VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET pack = excluded.pack, content = excluded.content',
          cacheKey(entry.word, settings), pack.id, wordKey(entry.word), JSON.stringify(entry));
      }
      this.accounts.copyPublished(identity,pack,practice.mode);
      return info;
    });
  }

  async pack(id, request) {
    const record = this.one('SELECT value FROM packs WHERE id = ?', id);
    if (!record) notFound();
    const { cacheSettings, owner = 'operator', ...info } = JSON.parse(record.value);
    info.practice ??= {mode:info.pack.words.some(row => row.vocabulary) ? 'mixed' : 'spelling', allowHints:true};
    if (info.visibility === 'public') return info;
    if (!request.headers.has('Authorization')) notFound();
    const identity = await this.principal(request);
    if (!(identity.isAdmin || identity.role === 'teacher' && identity.teacherId === owner || info.visibility === 'class' && identity.classId === info.classId)) notFound();
    return info;
  }

  usage() {
    const now = this.now();
    const day = localDay(now);
    const calls = this.meter(day, 'calls');
    const cacheHits = this.meter(day, 'cacheHits');
    const wordLookups = this.meter(day, 'wordLookups');
    return {
      day: new Date(day * DAY).toISOString().slice(0, 10), calls, dictationCalls: this.meter(day, 'operator:dictationCalls') + this.meter(day, 'dictationCalls'),
      tokens: this.meter(day, 'tokens'), cacheHits, wordLookups,
      cacheHitRate: wordLookups ? cacheHits / wordLookups : 0,
      cacheRecords: this.one('SELECT COUNT(*) AS count FROM cache').count,
      limits: LIMITS, active: this.one('SELECT COUNT(*) AS count FROM leases WHERE expires > ?', now).count,
      models: this.providers(true).map(({ provider, model }) => ({ provider, model })),
      generationEnabled: this.publicConfig().generationEnabled,
      jobs: this.rows('SELECT value FROM jobs WHERE created > ? ORDER BY created DESC LIMIT 30', now - JOB_LIFETIME)
        .map(({ value }) => {
          const { id, classId, createdAt, status } = JSON.parse(value);
          return { id, classId, createdAt, status };
        })
    };
  }

  async preparePackAudio(request) {
    const input = await bodyOf(request, 2048);
    requireInput(shape(input, ['packId', 'version', 'prompt']) && shortId(input.packId) &&
      integer(input.version, 1, Number.MAX_SAFE_INTEGER) && typeof input.prompt === 'string' &&
      /^\d{1,3}-(?:s|[ve]\d)$/.test(input.prompt), 'Choose a valid saved audio prompt.');
    const { pack } = await this.pack(Dictation.canonicalPackId(input.packId), request);
    if (pack.version !== input.version) fail(409, 'pack_version', 'Publish the latest set before preparing its audio.');
    const wordIndex = Number(input.prompt.split('-')[0]);
    const record = pack.words[wordIndex];
    const prompt = record && Learning.practiceAudioPrompts(record, wordIndex).find(item => item.key === input.prompt);
    if (!prompt) notFound();
    await this.savePackPrompt(pack, prompt);
    return json({ ready: true });
  }

  async savePackPrompt(pack, prompt) {
    requireInput(typeof prompt.text === 'string' && prompt.text.length > 0 && prompt.text.length <= 200,'Audio text must contain 1–200 characters.');
    const args = [pack.id, pack.version, prompt.key];
    if (this.one('SELECT prompt FROM pack_audio WHERE pack = ? AND version = ? AND prompt = ?', ...args)) return;
    const id = JSON.stringify(args);
    if (!this.audioInFlight.has(id)) {
      const pending = (async () => {
        const publication = this.one('SELECT value FROM packs WHERE id = ?',pack.id);
        if (!publication || (JSON.parse(publication.value).owner ?? 'operator') !== 'operator') fail(403,'pack_owner','Prepare this teacher’s recordings through their own private set.');
        const ownerIdentity = await this.accounts.authenticate({role:'teacher',teacherId:'operator',isAdmin:true});
        const {bytes} = await this.accounts.speech(ownerIdentity,prompt);
        if (!hasSpeechSignal(bytes)) fail(502, 'audio_quality', 'The recording was mostly silent.');
        if (!this.accounts.unchanged(ownerIdentity)) fail(409,'account_changed','Provider settings changed. Retry the recording.');
        if (this.one('SELECT version FROM packs WHERE id = ?', pack.id)?.version !== pack.version) {
          fail(409, 'pack_version', 'The set changed while generating audio. Publish and try again.');
        }
        this.sql.exec('INSERT OR IGNORE INTO pack_audio VALUES (?, ?, ?, ?)', ...args,
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      })().finally(() => this.audioInFlight.delete(id));
      this.audioInFlight.set(id, pending);
    }
    await this.audioInFlight.get(id);
  }

  audioPlan(pack, mode) {
    const saved = this.rows('SELECT prompt FROM pack_audio WHERE pack = ? AND version = ?', pack.id, pack.version).map(row => row.prompt);
    const ready = new Set(saved);
    const prompts = pack.words.flatMap((record, index) => Learning.practiceAudioPrompts(record, index)
      .filter(prompt => mode !== 'spelling' || prompt.skill === 'spelling')
      .map(prompt => {
        const type = prompt.skill === 'spelling' ? 'dictation' : 'word-bank';
        if (Dictation.publishedClip(pack, record.word, type, prompt.text)) ready.add(prompt.key);
        return prompt;
      }));
    const published = this.one('SELECT value FROM packs WHERE id = ?',pack.id);
    const owner = published && (JSON.parse(published.value).owner ?? 'operator');
    const privateSet = owner && this.accounts.readSet(owner,pack.id);
    const privateQueue = privateSet && canonical(this.accounts.publishedSnapshot(privateSet.pack,mode)) === canonical(pack)
      ? this.one('SELECT due FROM teacher_audio_queue WHERE owner = ? AND id = ? AND version = ?',owner,pack.id,pack.version) : null;
    return {prompts, saved, ready, audioStatus: {
      ready: prompts.filter(prompt => ready.has(prompt.key)).length,
      total: prompts.length,
      pending: this.one('SELECT due FROM audio_queue WHERE pack = ? AND version = ?', pack.id, pack.version)?.due != null || privateQueue?.due != null && prompts.some(prompt => !ready.has(prompt.key)),
      recordings:prompts.map(prompt => ({key:prompt.key,word:pack.words[Number(prompt.key.split('-')[0])].word,text:prompt.text,status:ready.has(prompt.key) ? 'ready' : 'pending'}))
    }};
  }

  async scheduleAudio() {
    const next = this.one('SELECT MIN(due) AS due FROM (SELECT due FROM audio_queue UNION ALL SELECT due FROM teacher_audio_queue)')?.due;
    if (next != null) await this.storage.setAlarm(Math.max(this.now() + 1000, next));
  }

  async queueAudio({pack, practice}, retry = false, identity = {isAdmin:true}) {
    const {audioStatus} = this.audioPlan(pack, practice.mode);
    if (!identity.isAdmin) return audioStatus;
    const publication = this.one('SELECT value FROM packs WHERE id = ?',pack.id);
    if (publication && (JSON.parse(publication.value).owner ?? 'operator') !== 'operator') return audioStatus;
    const audioEnabled = identity.credentials ? this.accounts.config(identity).dictationEnabled : this.dictationEnabled();
    const queued = retry && this.one('SELECT due FROM audio_queue WHERE pack = ? AND version = ?',pack.id,pack.version);
    // Only the retired daily cap scheduled this legacy queue beyond normal lease and retry windows.
    if (audioEnabled && queued?.due > this.now()+70000) {
      this.sql.exec('UPDATE audio_queue SET due = ? WHERE pack = ? AND version = ? AND due = ?',this.now(),pack.id,pack.version,queued.due);
      await this.scheduleAudio();
    }
    if (audioEnabled && audioStatus.ready < audioStatus.total && !audioStatus.pending) {
      const existing = this.one('SELECT pack FROM audio_queue WHERE pack = ? AND version = ?', pack.id, pack.version);
      if (!existing || retry) {
        this.sql.exec('INSERT OR REPLACE INTO audio_queue VALUES (?, ?, ?, 0, 0, ?)', pack.id, pack.version, practice.mode, this.now());
        await this.scheduleAudio();
        audioStatus.pending = true;
      }
    }
    return audioStatus;
  }

  async processAudioQueue() {
    await this.accounts.processQueue();
    const now = this.now();
    const job = this.one('SELECT * FROM audio_queue WHERE due <= ? ORDER BY due LIMIT 1', now);
    if (!job) { await this.scheduleAudio(); return; }
    const {pack, version, mode, cursor, tries} = job;
    const row = this.one('SELECT value FROM packs WHERE id = ? AND version = ?', pack, version);
    const current = row && JSON.parse(row.value).pack;
    const plan = current && this.audioPlan(current, mode);
    const index = plan?.prompts.findIndex((prompt, i) => i >= cursor && !plan.ready.has(prompt.key)) ?? -1;
    const ownerIdentity = await this.accounts.authenticate({role:'teacher',teacherId:'operator',isAdmin:true});
    if (index < 0 || !this.accounts.config(ownerIdentity).dictationEnabled) {
      this.sql.exec('UPDATE audio_queue SET due = NULL WHERE pack = ?', pack);
      await this.scheduleAudio();
      return;
    }
    const lease = now + LEASE;
    this.sql.exec('UPDATE audio_queue SET due = ? WHERE pack = ?', lease, pack);
    await this.scheduleAudio();
    let next = index + 1, attempts = 0, due = this.now();
    try {
      await this.savePackPrompt(current, plan.prompts[index]);
    } catch (error) {
      if (error.status === 429 || tries < 1) {
        next = index;
        attempts = error.status === 429 ? tries : tries + 1;
        due = error.status === 429 ? now + 61_000 : this.now() + 1500;
      }
    }
    this.sql.exec('UPDATE audio_queue SET cursor = ?, tries = ?, due = ? WHERE pack = ? AND version = ? AND due = ?',
      next, attempts, due, pack, version, lease);
    await this.scheduleAudio();
  }

  async admin(request, route, method) {
    if (route === 'access' && method === 'POST') return json(await this.login(request, true));
    const identity = await this.principal(request);
    if (identity.role !== 'teacher') fail(403, 'forbidden', 'Teacher access is required.');
    if (['invitations','teachers','revokeinvite','revoketeacher'].includes(route)) {
      if (!identity.isAdmin) fail(403,'forbidden','Administrator access is required.');
      return json(await this.accounts.admin(route,method,method === 'POST' ? await bodyOf(request,2048) : undefined));
    }
    if (!identity.isAdmin && !['publish','packaudioqueue','packs'].includes(route)) fail(403,'forbidden','Administrator access is required.');
    if (route === 'dictation' && method === 'POST') {
      const {bytes} = await this.accounts.speech(identity,{text:dictationText(await bodyOf(request,2048)),skill:'custom'});
      return new Response(bytes, {headers: {'Content-Type': 'audio/wav'}});
    }
    if (route === 'packaudio' && method === 'POST') return this.preparePackAudio(request);
    if (route === 'usage' && method === 'GET') return json(this.usage());
    if (route === 'publish' && method === 'POST') {
      const info = await this.publish(await bodyOf(request, 1_500_000),identity);
      return json({...info, audioStatus: await this.queueAudio(info,false,identity)});
    }
    if (route === 'packaudioqueue' && method === 'POST') {
      const {id} = await bodyOf(request, 2048);
      requireInput(shortId(id), 'Choose a published set.');
      const canonicalId = Dictation.canonicalPackId(id);
      const row = this.one('SELECT value FROM packs WHERE id = ?',canonicalId);
      if (!row || !identity.isAdmin && (JSON.parse(row.value).owner ?? 'operator') !== identity.teacherId) notFound();
      if (!identity.isAdmin) {
        const info = JSON.parse(row.value);
        const privateSet = this.accounts.readSet(identity.teacherId,canonicalId);
        if (!privateSet || canonical(this.accounts.publishedSnapshot(privateSet.pack,info.practice.mode)) !== canonical(info.pack)) fail(409,'pack_version','Reload and share the current private set before retrying.');
        await this.accounts.retry(identity,canonicalId);
        this.accounts.copyPublished(identity,info.pack,info.practice.mode);
      }
      return json({audioStatus: await this.queueAudio(await this.pack(canonicalId, request), true,identity)});
    }
    if (route === 'packs' && method === 'GET') {
      const packs = this.rows('SELECT value FROM packs ORDER BY id LIMIT 200').filter(({value}) => identity.isAdmin || (JSON.parse(value).owner ?? 'operator') === identity.teacherId).map(({ value }) => {
        const { pack, visibility, classId } = JSON.parse(value);
        return { id: pack.id, version: pack.version, name: pack.name, wordCount: pack.words.length, visibility, classId };
      });
      return json({ packs });
    }
    if (route === 'classes' && method === 'GET') {
      const classes = this.rows('SELECT value FROM classes ORDER BY id LIMIT 200').map(({ value }) => this.publicClass(JSON.parse(value)));
      return json({ classes });
    }
    if (route === 'classes' && method === 'POST') return json(await this.writeClass(await bodyOf(request, 4096)));
    if (route === 'cache' && method === 'DELETE') {
      const requestedWord = new URL(request.url).searchParams.get('word');
      if (requestedWord === null) fail(400, 'invalid_input', 'Specify the word to remove from cache.');
      const result = this.sql.exec('DELETE FROM cache WHERE word = ?', wordKey(vocabularyWord(requestedWord)));
      return json({ removed: result.rowsWritten });
    }
    if (route === 'settings' && method === 'PUT') {
      const input = await bodyOf(request, 4096);
      requireInput(shape(input, ['generationEnabled', 'groqModels']) && Object.keys(input).length > 0, 'Unknown administrator setting.');
      const { generationEnabled, groqModels } = input;
      requireInput(generationEnabled === undefined || typeof generationEnabled === 'boolean', 'Choose an AI availability setting.');
      requireInput(groqModels === undefined || (Array.isArray(groqModels) && groqModels.length > 0
        && groqModels.length <= GROQ_MODELS.length && groqModels.every((model) => GROQ_MODELS.includes(model))
        && new Set(groqModels).size === groqModels.length), 'Specify approved Groq models only.');
      this.atomic(() => {
        if (generationEnabled !== undefined) this.save('generationEnabled', generationEnabled);
        if (groqModels !== undefined) this.save('groqModels', groqModels);
      });
      return json(this.publicConfig());
    }
    notFound();
  }

  async route(request) {
    const { pathname } = new URL(request.url);
    const method = request.method;
    if (pathname === '/api/health' && method === 'GET') return json({ ok: true, apiVersion: 1 });
    if (pathname === '/api/config' && method === 'GET') return json(this.publicConfig());
    if (pathname === '/api/access' && method === 'POST') return json(await this.login(request, false));
    const teacherRoute = pathname.match(/^\/api\/teacher\/(login|accept|profile|keys|testkeys|preferences|sets)(?:\/([^/]{1,288})(?:\/(retry|audio)(?:\/(\d{1,3}-(?:s|[ve]\d)))?)?)?$/);
    if (teacherRoute) {
      let [,action,id,operation,prompt] = teacherRoute;
      if (id) { try { id = decodeURIComponent(id); } catch { notFound(); } if (!shortId(id)) notFound(); }
      if (['login','accept'].includes(action) && method === 'POST' && !id) return json(await this.accounts.access(request,await bodyOf(request,2048),action === 'accept'));
      const identity = await this.principal(request);
      if (identity.role !== 'teacher') fail(403,'forbidden','Teacher access is required.');
      if (action === 'profile' && method === 'GET' && !id) return json(this.accounts.profile(identity));
      if (action === 'keys' && method === 'PUT' && !id) return json(await this.accounts.updateKeys(identity,await bodyOf(request,2048)));
      if (action === 'preferences' && !id && ['GET','PUT'].includes(method)) return json(this.accounts.preferences(identity,method === 'PUT' ? await bodyOf(request,8192) : undefined));
      if (action === 'testkeys' && method === 'POST' && !id) return json(await this.accounts.testKeys(identity));
      if (action === 'sets') {
        if (!id && method === 'POST') return json(await this.accounts.saveSet(identity,await bodyOf(request,1500000)));
        if (!id && method === 'GET') return json({sets:await Promise.all(this.rows('SELECT value FROM teacher_sets WHERE owner = ? ORDER BY id',identity.teacherId).map(({value}) => this.accounts.setDetail(identity.teacherId,JSON.parse(value))))});
        const record = this.accounts.readSet(identity.teacherId,id);
        if (!record) notFound();
        if (!operation && method === 'DELETE') {
          this.atomic(() => {
            if (!this.accounts.unchanged(identity)) fail(409,'account_changed','Your account changed. Reload and try again.');
            this.sql.exec('DELETE FROM teacher_audio_queue WHERE owner = ? AND id = ?',identity.teacherId,id);
            this.sql.exec('DELETE FROM teacher_sets WHERE owner = ? AND id = ?',identity.teacherId,id);
          });
          await this.scheduleAudio();
          return json({deleted:true});
        }
        if (operation === 'retry' && method === 'POST') return json(await this.accounts.retry(identity,id));
        if (operation === 'audio' && prompt && method === 'GET') {
          const entry = record.recordings.find(r => r.key === prompt && r.status === 'ready');
          const clip = entry && this.one('SELECT bytes FROM teacher_audio WHERE owner = ? AND key = ?',identity.teacherId,entry.cacheKey);
          if (!clip) notFound();
          return audioResponse(clip.bytes,request.headers.get('Range'));
        }
        if (!operation && method === 'GET') return json(await this.accounts.setDetail(identity.teacherId,record));
      }
      notFound();
    }
    const admin = pathname.match(/^\/api\/admin\/([a-z]+)$/);
    if (admin) return this.admin(request, admin[1], method);
    const pack = pathname.match(/^\/api\/packs\/([^/]{1,288})(?:\/audio\/(\d{1,16})\/(\d{1,3}-(?:s|[ve]\d)))?$/);
    if (pack && method === 'GET') {
      let id;
      try { id = decodeURIComponent(pack[1]); } catch { notFound(); }
      if (!shortId(id)) notFound();
      id = Dictation.canonicalPackId(id);
      const info = await this.pack(id, request);
      const version = info.pack.version;
      if (pack[2]) {
        if (Number(pack[2]) !== version) notFound();
        const clip = this.one('SELECT bytes FROM pack_audio WHERE pack = ? AND version = ? AND prompt = ?', id, version, pack[3]);
        if (!clip) notFound();
        return audioResponse(clip.bytes, request.headers.get('Range'));
      }
      const {saved:audio, audioStatus} = this.audioPlan(info.pack, info.practice.mode);
      return json({...info, audio, audioStatus});
    }
    if ((pathname === '/api/generate' || pathname === '/api/regenerate') && method === 'POST') {
      const identity = await this.principal(request);
      const input = await bodyOf(request);
      const { detail, existing } = this.createJob(input, identity, request.headers.get('Idempotency-Key'), pathname.endsWith('/regenerate'));
      return json(detail, existing ? 200 : 201);
    }
    const job = pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/(step|resume|pause|cancel))?$/);
    if (job && (job[2] ? method === 'POST' : method === 'GET')) {
      const identity = await this.principal(request);
      if (!job[2]) return json(this.jobDetail(this.readJob(job[1], identity)));
      return json(job[2] === 'step' ? await this.runBatch(job[1], identity) : this.adjustJob(job[1], identity, job[2]));
    }
    notFound();
  }

  async fetch(request) {
    const origin = request.headers.get('Origin');
    const headers = new Headers({
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin'
    });
    const allowed = origin && this.origins.has(origin);
    if (allowed) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      headers.set('Access-Control-Max-Age', '600');
    }
    let response;
    try {
      if (origin !== null && !allowed) fail(403, 'origin_forbidden', 'This browser origin is not permitted.');
      response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await this.route(request);
    } catch (error) {
      response = error instanceof ApiError
        ? json({ error: { code: error.code, message: error.message } }, error.status)
        : json({ error: { code: 'internal', message: 'The vocabulary service is temporarily unavailable.' } }, 500);
    }
    for (const [key, value] of headers) response.headers.set(key, value);
    return response;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
