import { ApiError, requireInput, shape, shortId, validatePack, parseSettings, DEFAULT_SETTINGS } from './validation.mjs';
import Learning from '../src/learning.js';
import { hasSpeechSignal } from './dictation.mjs';

const encode = new TextEncoder();
const DAY = 86400000;
const AUDIO_BLOCK = 'audioBlocked:openrouter:mistralai/voxtral-mini-tts-2603:en_paul_neutral:';
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64 = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const random = () => b64(crypto.getRandomValues(new Uint8Array(24)));
const digest = async value => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(value))));
const publicTeacher = record => ({id:record.id, username:record.username, name:record.name, isAdmin:record.id === 'operator'});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function secureEquals(left,right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i=0;i<left.length;i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encode.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', iterations:100000, salt:unb64(salt)}, key, 256)));
}

export class TeacherAccounts {
  constructor(service) {
    this.s = service;
    for (const sql of [
      'CREATE TABLE IF NOT EXISTS teachers (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS teacher_sets (owner TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner,id))',
      'CREATE TABLE IF NOT EXISTS teacher_audio (owner TEXT NOT NULL, key TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(owner,key))',
      'CREATE TABLE IF NOT EXISTS teacher_audio_queue (owner TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, due INTEGER, PRIMARY KEY(owner,id))'
    ]) service.sql.exec(sql);
  }

  read(id) {
    return JSON.parse(this.s.one('SELECT value FROM teachers WHERE id = ?', id)?.value ?? 'null');
  }

  write(record) {
    this.s.sql.exec('INSERT INTO teachers VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', record.id, record.username, JSON.stringify(record));
  }

  current(identity) {
    if (identity.isAdmin) return true;
    const teacher = this.read(identity.teacherId);
    return !!teacher && !teacher.revoked && teacher.epoch === identity.epoch;
  }

  publishedSnapshot(pack,mode) {
    return mode === 'spelling' ? {...pack,words:pack.words.map(r => r.vocabulary?.status === 'approved' ? r : {...r,vocabulary:null})} : pack;
  }

  unchanged(identity) {
    if (!this.current(identity)) return false;
    return identity.isAdmin && identity.keyRevision === undefined || (this.read(identity.teacherId)?.revision ?? 0) === identity.keyRevision;
  }

  async authenticate(identity) {
    if (identity.role !== 'teacher') return identity;
    const isAdmin = !identity.teacherId || identity.teacherId === 'operator';
    if (isAdmin) identity = {...identity,teacherId:'operator',isAdmin:true};
    const record = this.read(identity.teacherId) ?? (isAdmin ? this.ownerRecord() : null);
    if (!this.current(identity)) fail(401, 'unauthorized', 'Teacher access has expired or been revoked.');
    const credentials = {};
    const reconnect = [];
    for (const provider of ['groq','openrouter']) {
      if (record.keys[provider]) {
        try { credentials[provider] = await this.crypt('decrypt', record.id, provider, record.keys[provider]); }
        catch { reconnect.push(provider); }
      } else if (isAdmin && !Object.hasOwn(record.keys,provider)) credentials[provider] = this.s.env[provider === 'groq' ? 'GROQ_API_KEY' : 'OPENROUTER_API_KEY'];
    }
    if (!this.current(identity)) fail(401, 'unauthorized', 'Teacher access has been revoked.');
    return {...identity, sid:isAdmin ? identity.sid ?? 'operator' : record.id, isAdmin, credentials, reconnect,keyRevision:record.revision,
      personalKeys:!isAdmin || Object.keys(record.keys).length > 0 || record.settings.allowPaidText, settings:{allowPaidText:record.settings.allowPaidText === true}};
  }

  async crypt(action, owner, provider, value) {
    const secret = this.s.env.TEACHER_KEY_ENCRYPTION_SECRET;
    if (typeof secret !== 'string' || secret.length < 32) fail(503, 'key_encryption_unavailable', 'Provider key storage is unavailable. Contact the administrator.');
    const material = await crypto.subtle.digest('SHA-256', encode.encode(secret));
    const key = await crypto.subtle.importKey('raw', material, 'AES-GCM', false, [action]);
    const iv = action === 'encrypt' ? crypto.getRandomValues(new Uint8Array(12)) : unb64(value.iv);
    const params = {name:'AES-GCM', iv, additionalData:encode.encode(owner + ':' + provider)};
    if (action === 'encrypt') return {iv:b64(iv), ciphertext:b64(new Uint8Array(await crypto.subtle.encrypt(params, key, encode.encode(value))))};
    return new TextDecoder('utf-8', {fatal:true}).decode(await crypto.subtle.decrypt(params, key, unb64(value.ciphertext)));
  }

  async rateLimit(request, action) {
    const s = this.s, window = Math.floor(s.now() / 900000);
    const key = await s.signature('teacher-auth:' + action + ':' + window + ':' + (request.headers.get('CF-Connecting-IP') ?? 'unknown'));
    s.atomic(() => {
      for (const [id, limit] of [[key,20], ['teacher-auth:' + window,200]]) {
        if ((s.one('SELECT attempts FROM login_limits WHERE key = ?', id)?.attempts ?? 0) >= limit) fail(429,'access_limit','Too many access attempts. Try again later.');
        s.sql.exec('INSERT INTO login_limits VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1',id,window);
      }
      s.sql.exec('DELETE FROM login_limits WHERE window < ?',window);
    });
  }

  async access(request, input, accept) {
    await this.rateLimit(request, accept ? 'accept' : 'login');
    requireInput(shape(input, accept ? ['invite','username','name','password'] : ['username','password'])
      && typeof input.username === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,39}$/.test(input.username)
      && typeof input.password === 'string' && input.password.length >= 12 && input.password.length <= 200, 'Use a username of 3–40 letters, numbers, underscores or hyphens and a password of 12–200 characters.');
    const username = input.username.toLowerCase();
    let record;
    if (accept) {
      requireInput(typeof input.invite === 'string' && input.invite.length <= 100 && typeof input.name === 'string'
        && input.name.trim().length > 0 && input.name.length <= 80 && !/[<>\p{C}]/u.test(input.name), 'Enter a valid invitation and display name.');
      const hash = await digest(input.invite), salt = random();
      const password = await passwordHash(input.password, salt);
      record = this.s.atomic(() => {
        const row = this.s.one('SELECT id, value FROM invitations WHERE hash = ?',hash);
        const invite = row && JSON.parse(row.value);
        if (!invite || invite.used || invite.revoked || invite.expiresAt <= this.s.now()) fail(401,'invitation_invalid','This invitation is expired, revoked, or already used.');
        if (this.s.one('SELECT id FROM teachers WHERE username = ?',username)) fail(409,'username_taken','Choose another username.');
        const teacher = {id:crypto.randomUUID(),username,name:input.name.trim(),salt,password,epoch:0,revision:0,keys:{},settings:{allowPaidText:false},createdAt:this.s.now(),revoked:false};
        this.write(teacher);
        this.s.sql.exec('UPDATE invitations SET value = ? WHERE id = ?',JSON.stringify({...invite,used:true}),row.id);
        return teacher;
      });
    } else {
      const row = this.s.one('SELECT value FROM teachers WHERE username = ?',username);
      record = row && JSON.parse(row.value);
      const actual = await passwordHash(input.password,record?.salt ?? b64(new Uint8Array(24)));
      if (!record || record.revoked || !secureEquals(actual,record.password) || this.read(record.id)?.epoch !== record.epoch) fail(401,'unauthorized','The username or password is incorrect.');
    }
    const session = await this.s.session('teacher',this.s.now() + 7 * DAY,{teacherId:record.id,epoch:record.epoch});
    const identity = await this.authenticate({role:'teacher',teacherId:record.id,epoch:record.epoch});
    return {...session,teacher:publicTeacher(record),config:this.config(identity)};
  }

  config(identity) {
    if (identity.isAdmin && !identity.credentials) return this.s.publicConfig();
    const draftingAvailable = this.s.env.AI_ENABLED === 'true' && this.s.providers(identity).length > 0;
    return {...this.s.publicConfig(),draftingAvailable,
      generationEnabled:this.s.enabled(true) && draftingAvailable,
      dictationEnabled:this.s.env.AUDIO_ENABLED === 'true' && !!identity.credentials.openrouter,
      studentGenerationEnabled:identity.isAdmin && this.s.publicConfig().studentGenerationEnabled};
  }

  profile(identity) {
    const record = identity.isAdmin ? {id:'operator',username:'owner',name:'Owner'} : this.read(identity.teacherId);
    return {teacher:publicTeacher(record),config:this.config(identity),keys:{groq:!!identity.credentials?.groq,openrouter:!!identity.credentials?.openrouter},
      settings:identity.settings ?? {allowPaidText:false},
      ...(identity.reconnect?.length ? {reconnect:identity.reconnect,message:'Reconnect your provider key. The saved key could not be decrypted.'} : {})};
  }

  async updateKeys(identity,input) {
    requireInput(shape(input,['groq','openrouter','allowPaidText','allowAlternateAudio']), 'Unknown provider setting.');
    const keys = {};
    for (const provider of ['groq','openrouter']) if (Object.hasOwn(input,provider)) {
      const value = input[provider];
      requireInput(value === null || typeof value === 'string' && value.length >= 8 && value.length <= 512 && !/[\s\p{C}]/u.test(value),'Enter a valid provider key, or delete it.');
      keys[provider] = value === null ? null : await this.crypt('encrypt',identity.teacherId,provider,value);
    }
    for (const option of ['allowPaidText','allowAlternateAudio']) requireInput(input[option] === undefined || typeof input[option] === 'boolean','Choose a valid fallback setting.');
    if (!Object.keys(keys).length && input.allowPaidText === undefined) return this.profile(identity);
    this.s.atomic(() => {
      if (!this.unchanged(identity)) fail(409,'account_changed','Your account changed. Reload and try again.');
      const record = this.read(identity.teacherId) ?? this.ownerRecord();
      for (const [provider,value] of Object.entries(keys)) value === null && !identity.isAdmin ? delete record.keys[provider] : record.keys[provider] = value;
      record.settings = {allowPaidText:input.allowPaidText ?? (record.settings.allowPaidText === true)};
      record.revision++;
      this.write(record);
      this.s.save(AUDIO_BLOCK+record.id,null);
      for (const {value} of this.s.rows('SELECT value FROM teacher_sets WHERE owner = ?',record.id)) {
        const saved = JSON.parse(value);
        for (const r of saved.recordings) if (r.status === 'failed' && r.errorCode !== 'invalid_input') { r.status='pending'; delete r.error; delete r.errorCode; }
        this.writeSet(record.id,saved);
      }
      this.s.sql.exec('UPDATE teacher_audio_queue SET due = ? WHERE owner = ?',this.s.now(),record.id);
    });
    await this.s.scheduleAudio();
    return this.profile(await this.authenticate(identity));
  }

  async admin(route, method, input) {
    if (route === 'invitations' && method === 'POST') {
      requireInput(shape(input,['label']) && typeof input.label === 'string' && input.label.length <= 80 && !/[<>\p{C}]/u.test(input.label),'Enter an invitation label.');
      const invite = random(), id = crypto.randomUUID(), expiresAt = this.s.now() + 7 * DAY;
      this.s.sql.exec('INSERT INTO invitations VALUES (?, ?, ?)',id,await digest(invite),JSON.stringify({label:input.label,expiresAt,used:false,revoked:false}));
      return {id,invite,expiresAt};
    }
    if (route === 'invitations' && method === 'GET') return {invitations:this.s.rows('SELECT id,value FROM invitations').map(({id,value}) => ({id,...JSON.parse(value)}))};
    if (route === 'teachers' && method === 'GET') return {teachers:this.s.rows("SELECT value FROM teachers WHERE id <> 'operator'").map(({value}) => { const r = JSON.parse(value); return {...publicTeacher(r),revoked:r.revoked,createdAt:r.createdAt}; })};
    requireInput(shape(input,['id']) && shortId(input.id), 'Choose a valid account or invitation.');
    if (route === 'revokeinvite' && method === 'POST') {
      const row = this.s.one('SELECT value FROM invitations WHERE id = ?',input.id);
      if (!row) fail(404,'not_found','Invitation unavailable.');
      this.s.sql.exec('UPDATE invitations SET value = ? WHERE id = ?',JSON.stringify({...JSON.parse(row.value),revoked:true}),input.id);
      return {revoked:true};
    }
    if (route === 'revoketeacher' && method === 'POST') {
      if (input.id === 'operator') fail(400,'owner_account','The owner account cannot be revoked.');
      const record = this.read(input.id);
      if (!record) fail(404,'not_found','Teacher unavailable.');
      record.revoked = true; record.epoch++; record.revision++; this.write(record);
      this.s.sql.exec('UPDATE teacher_audio_queue SET due = NULL WHERE owner = ?',record.id);
      for (const {value} of this.s.rows('SELECT value FROM jobs WHERE owner = ?',record.id)) {
        const job = JSON.parse(value); job.status = 'cancelled'; job.message = 'Teacher access was revoked.'; this.s.writeJob(job);
      }
      return {revoked:true};
    }
    fail(404,'not_found','Resource unavailable.');
  }

  readSet(owner,id) {
    return JSON.parse(this.s.one('SELECT value FROM teacher_sets WHERE owner = ? AND id = ?',owner,id)?.value ?? 'null');
  }

  ownerRecord() {
    return {id:'operator',username:'__operator__',name:'Owner',revision:0,epoch:0,keys:{},settings:{allowPaidText:false}};
  }

  preferences(identity,input) {
    if (input !== undefined) {
      requireInput(shape(input,['grade','settings']) && Number.isInteger(input.grade) && input.grade >= 3 && input.grade <= 12
        && shape(input.settings,Object.keys(DEFAULT_SETTINGS)),'Choose a grade from 3 to 12 and valid generation settings.');
      this.s.atomic(() => {
        if (!this.current(identity)) fail(401,'unauthorized','Teacher access has been revoked.');
        const record = this.read(identity.teacherId) ?? this.ownerRecord();
        const prior = record.presets?.[input.grade] ?? parseSettings({readingLevel:input.grade,practiceSentences:1,exampleSentences:1},true);
        const settings = parseSettings({...prior,...input.settings},true);
        requireInput(!settings.context && !settings.sense,'Save context and intended meaning with the set, not a grade preset.');
        record.presets = {...record.presets,[input.grade]:settings};
        this.write(record);
      });
    }
    const saved = this.read(identity.teacherId)?.presets ?? {};
    return {presets:Object.fromEntries(Array.from({length:10},(_,index) => {
      const grade = index + 3;
      return [String(grade),saved[grade] ?? parseSettings({readingLevel:grade,practiceSentences:1,exampleSentences:1},true)];
    }))};
  }

  setDetail(owner,record) {
    const queue = this.s.one('SELECT due FROM teacher_audio_queue WHERE owner = ? AND id = ? AND version = ?',owner,record.pack.id,record.pack.version);
    const teacher = owner === 'operator' ? null : this.read(owner);
    const revoked = teacher?.revoked;
    const recordings = record.recordings.map(({cacheKey,skill,...r}) => revoked && r.status !== 'ready' ? {...r,status:'failed',error:'Teacher access was revoked.'} : r);
    return {pack:record.pack,...(record.generationSettings ? {generationSettings:record.generationSettings} : {}),audio:recordings.filter(r => r.status === 'ready').map(r => r.key),audioStatus:{
      ready:recordings.filter(r => r.status === 'ready').length,total:recordings.length,pending:!revoked && queue?.due != null,
      recordings,...(queue?.due > this.s.now() ? {retryAt:queue.due} : {})}};
  }

  async saveSet(identity,input) {
    requireInput(shape(input,['pack','expectedVersion','generationSettings']) && Number.isSafeInteger(input.expectedVersion) && input.expectedVersion >= 0,'Provide a private set and its last saved version.');
    const pack = validatePack(input.pack,{allowSpellingOnly:true,allowDraft:true});
    const generationSettings = input.generationSettings === undefined ? undefined : parseSettings(input.generationSettings,true);
    const owner = identity.teacherId;
    const record = this.s.atomic(() => {
      if (!this.unchanged(identity)) fail(409,'account_changed','Your account changed. Reload and try again.');
      const existing = this.readSet(owner,pack.id);
      const samePack = existing && existing.pack.version === pack.version && same(existing.pack,pack);
      const oldVoice = existing?.recordings.some(r => r.status === 'ready' && r.cacheKey !== JSON.stringify([r.skill,r.text,'openrouter','mistralai/voxtral-mini-tts-2603','en_paul_neutral']));
      if (samePack && !oldVoice && (generationSettings === undefined || same(existing.generationSettings,generationSettings))) return existing;
      if ((existing?.pack.version ?? 0) !== input.expectedVersion) fail(409,'pack_version','The saved set changed. Reload before saving again.');
      if (samePack && generationSettings !== undefined && !same(existing.generationSettings,generationSettings)) fail(409,'pack_version','Increase the set version when changing generation settings.');
      if (existing && existing.pack.version >= pack.version && !samePack) {
        fail(409,'pack_version','The saved set changed. Reload before saving again.');
      }
      const recordings = pack.words.flatMap((word,index) => Learning.practiceAudioPrompts(word,index).map(prompt => {
        const old = existing?.recordings.find(r => r.text === prompt.text && r.skill === prompt.skill && r.status === 'ready'
          && r.cacheKey === JSON.stringify([prompt.skill,prompt.text,'openrouter','mistralai/voxtral-mini-tts-2603','en_paul_neutral']));
        const cached = old || this.cachedPrompt(owner,prompt);
        return {...prompt,word:word.word,status:cached ? 'ready' : 'pending',...(cached ? {cacheKey:cached.cacheKey,provider:cached.provider,voice:cached.voice} : {})};
      }));
      const saved = {pack,recordings,...((generationSettings ?? existing?.generationSettings) ? {generationSettings:generationSettings ?? existing.generationSettings} : {})};
      this.writeSet(owner,saved);
      this.s.sql.exec('INSERT OR REPLACE INTO teacher_audio_queue VALUES (?, ?, ?, ?)',owner,pack.id,pack.version,recordings.some(r => r.status !== 'ready') ? this.s.now() : null);
      return saved;
    });
    await this.s.scheduleAudio();
    return this.setDetail(owner,record);
  }

  cachedPrompt(owner,prompt) {
    const provider='openrouter', model='mistralai/voxtral-mini-tts-2603', voice='en_paul_neutral';
    const cacheKey = JSON.stringify([prompt.skill,prompt.text,provider,model,voice]);
    if (this.s.one('SELECT key FROM teacher_audio WHERE owner = ? AND key = ?',owner,cacheKey)) return {cacheKey,provider,voice};
    return null;
  }

  writeSet(owner,record) {
    this.s.sql.exec('INSERT INTO teacher_sets VALUES (?, ?, ?, ?) ON CONFLICT(owner,id) DO UPDATE SET version = excluded.version, value = excluded.value',owner,record.pack.id,record.pack.version,JSON.stringify(record));
  }

  async retry(identity,id) {
    const record = this.readSet(identity.teacherId,id);
    if (!record) fail(404,'not_found','Saved set unavailable.');
    for (const r of record.recordings) if (r.status !== 'ready') { r.status = 'pending'; delete r.error; delete r.errorCode; }
    this.s.save(AUDIO_BLOCK+identity.teacherId,null);
    this.writeSet(identity.teacherId,record);
    this.s.sql.exec('INSERT OR REPLACE INTO teacher_audio_queue VALUES (?, ?, ?, ?)',identity.teacherId,id,record.pack.version,record.recordings.some(r => r.status !== 'ready') ? this.s.now() : null);
    await this.s.scheduleAudio();
    return this.setDetail(identity.teacherId,record);
  }

  async processQueue() {
    const s = this.s;
    const job = s.one('SELECT * FROM teacher_audio_queue WHERE due <= ? ORDER BY due LIMIT 1',s.now());
    if (!job) return;
    const {owner,id,version} = job;
    let record = this.readSet(owner,id);
    if (!record || record.pack.version !== version) { s.sql.exec('DELETE FROM teacher_audio_queue WHERE owner = ? AND id = ?',owner,id); return; }
    let identity;
    try { identity = await this.authenticate({role:'teacher',teacherId:owner,epoch:this.read(owner)?.epoch}); }
    catch { s.sql.exec('UPDATE teacher_audio_queue SET due = NULL WHERE owner = ? AND id = ?',owner,id); return; }
    if (owner === 'operator') identity.isAdmin = true;
    const prompt = record.recordings.find(r => r.status === 'pending');
    if (!prompt) { s.sql.exec('UPDATE teacher_audio_queue SET due = NULL WHERE owner = ? AND id = ?',owner,id); return; }
    const lease = s.now() + 70000;
    const snapshot = record.pack;
    if (!same(this.readSet(owner,id)?.pack,snapshot)) return;
    const claimed = s.sql.exec('UPDATE teacher_audio_queue SET due = ? WHERE owner = ? AND id = ? AND version = ? AND due = ?',lease,owner,id,version,job.due);
    if (!claimed.rowsWritten) return;
    const dispatch = () => {
      const latest = this.readSet(owner,id);
      return same(latest?.pack,snapshot) && latest.recordings.some(r => r.key === prompt.key && r.text === prompt.text && r.skill === prompt.skill && r.status === 'pending')
        && s.one('SELECT due FROM teacher_audio_queue WHERE owner = ? AND id = ? AND version = ?',owner,id,version)?.due === lease;
    };
    await s.scheduleAudio();
    let due = s.now(), generated;
    try {
      const cached = this.cachedPrompt(owner,prompt);
      if (cached) {
        const [, ,provider,model,voice] = JSON.parse(cached.cacheKey);
        generated = {bytes:new Uint8Array(s.one('SELECT bytes FROM teacher_audio WHERE owner = ? AND key = ?',owner,cached.cacheKey).bytes),provider,model,voice};
      } else {
        const key = JSON.stringify(['private',owner,identity.keyRevision,prompt.skill,prompt.text]);
        if (!s.audioInFlight.has(key)) s.audioInFlight.set(key,this.speech(identity,prompt,dispatch).finally(() => s.audioInFlight.delete(key)));
        generated = await s.audioInFlight.get(key);
      }
      if (!hasSpeechSignal(generated.bytes)) fail(502,'audio_quality','The recording was mostly silent.');
    } catch (error) {
      generated = undefined;
      prompt.error = error instanceof ApiError ? error.message : 'The recording could not be created.';
      prompt.errorCode = error instanceof ApiError ? error.code : 'dictation_unavailable';
      if (error.status === 429) due = error.code === 'dictation_daily' ? (Math.floor(s.now()/DAY)+1)*DAY : error.retryAt ?? s.now()+61000;
      else { prompt.status = 'failed'; }
    }
    if (!this.unchanged(identity)) { s.sql.exec('UPDATE teacher_audio_queue SET due = ? WHERE owner = ? AND id = ? AND version = ? AND due = ?',this.current(identity) ? s.now() : null,owner,id,version,lease); return; }
    if (s.one('SELECT due FROM teacher_audio_queue WHERE owner = ? AND id = ? AND version = ?',owner,id,version)?.due !== lease) return;
    record = this.readSet(owner,id);
    if (record?.pack.version !== version) return;
    const current = record.recordings.find(r => r.key === prompt.key && r.text === prompt.text && r.skill === prompt.skill);
    if (!current) return;
    if (generated) {
      const {bytes,provider,model,voice} = generated;
      const cacheKey = JSON.stringify([prompt.skill,prompt.text,provider,model,voice]);
      s.sql.exec('INSERT OR IGNORE INTO teacher_audio VALUES (?, ?, ?)',owner,cacheKey,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
      Object.assign(current,{status:'ready',cacheKey,provider,voice}); delete current.error; delete current.errorCode;
    } else {
      Object.assign(current,{status:prompt.status,error:prompt.error,errorCode:prompt.errorCode});
      if (['provider_auth','provider_request','provider_key_required'].includes(prompt.errorCode)) {
        s.save(AUDIO_BLOCK+owner,{revision:identity.keyRevision,code:prompt.errorCode,message:prompt.error});
        for (const r of record.recordings) if (r.status === 'pending') Object.assign(r,{status:'failed',error:prompt.error,errorCode:prompt.errorCode});
      }
    }
    this.writeSet(owner,record);
    if (generated) {
      const published = s.one('SELECT value FROM packs WHERE id = ?',id);
      const info = published && JSON.parse(published.value);
      if (info && (info.owner ?? 'operator') === owner && same(this.publishedSnapshot(record.pack,info.practice?.mode),info.pack)) this.copyPublished(identity,info.pack,info.practice?.mode);
    }
    if (!record.recordings.some(r => r.status === 'pending')) due = null;
    s.sql.exec('UPDATE teacher_audio_queue SET due = ? WHERE owner = ? AND id = ? AND version = ? AND due = ?',due,owner,id,version,lease);
  }

  async speech(identity,prompt,dispatch = () => true) {
    requireInput(typeof prompt.text === 'string' && prompt.text.length > 0 && prompt.text.length <= 200,'Audio text must contain 1-200 characters. Edit the sentence and try again.');
    if (!this.unchanged(identity)) fail(409,'account_changed','Provider settings changed. Retry the recording.');
    if (!dispatch()) fail(409,'set_changed','The set changed before the recording could start.');
    if (this.s.env.AUDIO_ENABLED !== 'true') fail(503,'generation_offline','Paul audio generation is disabled.');
    if (!identity.credentials.openrouter) fail(503,'provider_key_required',identity.reconnect?.includes('openrouter')
      ? 'Reconnect your OpenRouter key to prepare Paul audio.' : 'Connect your OpenRouter key to prepare Paul audio.');
    const s = this.s, owner = identity.teacherId, day = Math.floor(s.now()/DAY), minute = Math.floor(s.now()/60000);
    const blocked = s.saved(AUDIO_BLOCK+owner);
    if (blocked?.revision === identity.keyRevision) fail(503,blocked.code,blocked.message);
    const retryAt = s.one('SELECT until FROM provider_delay WHERE key = ?',owner+':audio:openrouter')?.until ?? 0;
    if (retryAt > s.now()) { const error = new ApiError(429,'dictation_rate_limit','Paul audio is busy. Prepared recordings are saved.'); error.retryAt = retryAt; throw error; }
    s.atomic(() => {
      if (!this.unchanged(identity)) fail(409,'account_changed','Provider settings changed. Retry the recording.');
      if (!dispatch()) fail(409,'set_changed','The set changed before the recording could start.');
      const legacyCalls = owner === 'operator' ? s.meter(day,'dictationCalls') : 0;
      const legacyWindow = owner === 'operator' ? s.saved('dictationMinute') : null;
      const legacyMinute = legacyWindow?.minute === minute ? legacyWindow.calls : 0;
      if (s.meter(day,owner+':dictationCalls') + legacyCalls >= 100) fail(429,'dictation_daily','Your daily audio allowance is used up.');
      if (s.meter(day,owner+':audio-minute:'+minute) + legacyMinute >= 10) fail(429,'dictation_budget','Your minute audio allowance is used up.');
      s.charge(day,owner+':dictationCalls',1); s.charge(day,owner+':audio-minute:'+minute,1);
    });
    let bytes;
    try { bytes = await s.speechFetcher(identity.credentials.openrouter,prompt.text); }
    catch (error) {
      if (this.unchanged(identity) && error.code === 'dictation_rate_limit') s.sql.exec('INSERT INTO provider_delay VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET until = MAX(until, excluded.until)',owner+':audio:openrouter',s.now()+61000);
      throw error;
    }
    if (!hasSpeechSignal(bytes)) fail(502,'audio_quality','The recording was mostly silent.');
    return {bytes,provider:'openrouter',model:'mistralai/voxtral-mini-tts-2603',voice:'en_paul_neutral'};
  }

  copyPublished(identity,pack,mode) {
    const record = this.readSet(identity.teacherId,pack.id);
    if (!record) return;
    if (!same(this.publishedSnapshot(record.pack,mode),pack)) fail(409,'pack_version','The private set changed. Reload before sharing.');
    const manifest = pack.words.flatMap((word,index) => Learning.practiceAudioPrompts(word,index)).filter(p => mode !== 'spelling' || p.skill === 'spelling');
    for (const prompt of manifest) {
      const clip = record.recordings.find(r => r.key === prompt.key && r.text === prompt.text && r.skill === prompt.skill && r.status === 'ready');
      if (!clip) continue;
      const bytes = this.s.one('SELECT bytes FROM teacher_audio WHERE owner = ? AND key = ?',identity.teacherId,clip.cacheKey)?.bytes;
      if (bytes) this.s.sql.exec('INSERT OR IGNORE INTO pack_audio VALUES (?, ?, ?, ?)',pack.id,pack.version,prompt.key,bytes);
    }
  }

  async testKeys(identity) {
    const day = Math.floor(this.s.now()/DAY), minute = Math.floor(this.s.now()/60000), meter = identity.teacherId+':key-tests:'+minute;
    this.s.atomic(() => {
      if (this.s.meter(day,meter) >= 10) fail(429,'key_test_limit','Wait a minute before testing the connections again.');
      this.s.charge(day,meter,1);
    });
    const results = await Promise.all(['groq','openrouter'].map(async provider => {
      if (!identity.credentials[provider]) return [provider,'missing'];
      let status = 'unavailable';
      try {
        if (!this.unchanged(identity)) return [provider,status];
        const response = await this.s.connectionFetcher(provider === 'groq' ? 'https://api.groq.com/openai/v1/models' : 'https://openrouter.ai/api/v1/key',{
          method:'GET',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer ' + identity.credentials[provider]}
        });
        if (response.status === 401 || response.status === 403) status = 'invalid';
        else if (response.ok) {
          const data = await response.json();
          if (provider === 'groq' ? Array.isArray(data.data) : data.data && typeof data.data === 'object') status = 'connected';
        }
      } catch { /* Provider details and credentials never leave this boundary. */ }
      return [provider,this.unchanged(identity) ? status : 'unavailable'];
    }));
    return Object.fromEntries(results);
  }
}
