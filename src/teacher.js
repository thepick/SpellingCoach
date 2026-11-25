const CLASS_RECOVERY = 'class-generation-recovery';
const GENERATION_KEY = 'spell.generation.v1';
const ONLINE_CONFIG = document.body.dataset.entry !== 'offline' && ['localhost','127.0.0.1'].includes(location.hostname)
 ? location.origin : 'https://wordlab.mtomlinson.ca';
let ai = {root: '', token: '', role: '', config: {}, job: null, listId: '', published: '', generation: 0};
let sharing = {list:null, records:null};
let publishing = false;
let audioStatusTimer;
let privateAudioTimer;
let restoringTeacherSets = false;
let teacherLoginRequest = 0;
const teacherSaves = new Map();

function teacherStorageKey() {
 return 'spell.teacher:' + encodeURIComponent(ai.root) + ':' + encodeURIComponent(ai.teacher.id);
}
function generationStorageKey() { return ai.teacher ? GENERATION_KEY + ':' + teacherStorageKey() : GENERATION_KEY; }

async function loadTeacherWorkspace() {
 const {token} = ai;
 const existing = localStorage.getItem(KEY);
 state = loadState();
 if (!existing && ai.teacher?.isAdmin) {
  const original = localStorage.getItem('spell.state');
  if (original) {
   const migrated = clean(JSON.parse(original));
   for (const list of migrated.lists) {
    if (ai.token !== token) return;
    const targetStore = await getStore(list.vocabBackend), targetRecordings = await getStore('indexedDB').catch(()=>null);
    const oldStore = await Vocabulary.openStore(globalThis,list.vocabBackend);
    const records = list.vocabKey ? await oldStore.get(recordKey(list)) : Vocabulary.legacyRecords(list);
    if (ai.token !== token) return;
    if (list.vocabKey && records) await targetStore.put(recordKey(list),records);
    const recordings = await Vocabulary.openStore(globalThis,'indexedDB').catch(()=>null);
    if (recordings) for (const word of list.words) {
     const vocabulary = (records || []).find(row=>row.word===word)?.vocabulary;
     const key = Dictation.recordingKey(list.id,word,vocabulary), clip = await recordings.get(key);
     if (ai.token !== token) return;
     if (clip && targetRecordings) await targetRecordings.put(key,clip);
    }
   }
   if (ai.token !== token) return;
   if (migrated.learningCheckpoint && !migrated.learningSession) {
    const marker = migrated.learningCheckpoint, targetStore = await getStore(marker.backend);
    const oldStore = await Vocabulary.openStore(globalThis,marker.backend);
    const entry = await oldStore.get(marker.key);
    if (ai.token !== token) return;
    if (!entry || !Learning.sessionOK(entry.session)) throw Error('The legacy checkpoint could not be restored. Its original browser copy is unchanged.');
    migrated.learningSession = entry;
    await targetStore.put(marker.key,entry);
   }
   if (ai.token !== token) return;
   state = migrated;
   save();
  }
 }
 if (ai.token === token) listId = state.lists[0]?.id || '';
}

function teacherKeyChanges() {
 const body = {allowPaidText:$('teacher-paid-text').checked, allowAlternateAudio:$('teacher-alternate-audio').checked};
 for (const provider of ['groq','openrouter']) {
  const value = $('teacher-' + provider + '-key').value.trim();
  if ($('teacher-delete-' + provider).checked) body[provider] = null;
  else if (value) body[provider] = value;
 }
 return body;
}

function renderTeacherProfile(profile) {
 ai.teacher = profile.teacher;
 ai.config = profile.config;
 $('teacher-account-name').textContent = profile.teacher.name + ' · ' + profile.teacher.username;
 for (const provider of ['groq','openrouter']) {
  $('teacher-' + provider + '-status').textContent = profile.keys[provider] ? '— key saved' : '— no key saved';
  $('teacher-' + provider + '-key').value = '';
  $('teacher-delete-' + provider).checked = false;
 }
 $('teacher-paid-text').checked = profile.settings.allowPaidText;
 $('teacher-alternate-audio').checked = profile.settings.allowAlternateAudio;
 if (profile.message || profile.reconnect?.length) $('teacher-account-status').textContent = profile.message || 'Reenter your '+profile.reconnect.join(' and ')+' key to reconnect.';
 refreshTeacher();
}

function resetTeacherWorkspace() {
 stopRecording(); clearTimeout(privateAudioTimer); clearTimeout(audioStatusTimer); clearTimeout(timer);
 clearTimeout(learningAdvanceTimer);
 if (speech) speechSynthesis.cancel();
 state = blank(); listId = ''; vocabCache = {key:'',records:null};
 editorList = null; editorRecords = []; undoVocabulary = null; pendingPack = null; studyState = null;
 listDraft = null; ++importRequest;
 sharing = {list:null,records:null}; sharedReview = null; previewRecords.clear();
 teacherSaves.clear();
 for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
 for (const form of document.querySelectorAll('form')) form.reset();
 for (const id of ['teacher-recordings','teacher-invitations','teacher-accounts','ai-class-status','word-chips','study-back']) $(id).replaceChildren();
 $('teacher-invite-link').value = ''; $('teacher-invite-result').hidden = true;
 localStorage.removeItem(LOCAL_PREVIEW_KEY);
 renderSetup();
}

async function restoreTeacherSets() {
 const {token,root} = ai, owner = state;
 const response = await service('/teacher/sets', {token,root});
 if (ai.token !== token || state !== owner) return;
 restoringTeacherSets = true;
 try {
  for (const saved of response.sets) {
   if (ai.token !== token || state !== owner) return;
   const pack = Vocabulary.validatePack(saved.pack || saved), local = findPackList(pack.id);
   if (local && (local.remoteConflict || local.remoteVersion !== undefined && local.packVersion > local.remoteVersion)) {
    if (pack.version !== local.remoteVersion) local.remoteConflict = true;
    save(); continue;
   }
   if (local && local.remoteVersion === undefined && JSON.stringify(outputPack(local,await loadVocabulary(local))) !== JSON.stringify(pack)) {
    if (ai.token !== token || state !== owner) return;
    local.remoteConflict = true; save(); continue;
   }
   try { await importPack(pack); }
   catch (error) {
    if (ai.token !== token || state !== owner) return;
    if (local) { local.remoteConflict = true; save(); }
    teacherStatus('A saved set conflicts with this browser. Local edits were kept. Export them before reloading saved sets.');
    continue;
   }
   const list = findPackList(pack.id);
   if (list && list.packVersion === pack.version) { list.remoteVersion = pack.version; list.audioStatus = saved.audioStatus; save(); }
  }
 } finally { restoringTeacherSets = false; }
 if (ai.token !== token || state !== owner) return;
 renderSetup(); renderPrivateAudio(); watchPrivateAudio();
}

async function autosaveTeacherSet(list) {
 if (!list || !ai.token || ai.role !== 'teacher' || restoringTeacherSets) return;
 const {root,token} = ai, owner = state;
 const previous = teacherSaves.get(list.id) || Promise.resolve();
 const task = previous.catch(()=>{}).then(async () => {
  if (ai.token !== token || state !== owner || !owner.lists.includes(list)) return;
  if (list.remoteConflict) throw Error('This set has a version conflict. Export your local changes, then reload saved sets before saving or sharing.');
  const rows = await loadVocabulary(list);
  if (ai.token !== token || state !== owner) return;
  const pack = outputPack(list, rows), stamp = list.updatedAt;
  $('teacher-private-audio-status').textContent = 'Saving privately and queuing recordings…';
  let saved;
  try { saved = await service('/teacher/sets', {root,token,method:'POST',body:{pack,expectedVersion:list.remoteVersion || 0}}); }
  catch (error) {
   if (ai.token !== token || state !== owner) return;
   if (error.status === 409) { list.remoteConflict = true; save(); throw Error('This set changed in another tab or browser. Export your local changes, then reload saved sets before editing again.'); }
   throw error;
  }
  if (ai.token !== token || state !== owner) return;
  list.packId = saved.pack.id; list.remoteVersion = saved.pack.version; save();
  if (list.updatedAt !== stamp) return;
  list.packVersion = saved.pack.version;
  list.audioStatus = saved.audioStatus; save(); renderPrivateAudio(); watchPrivateAudio();
  status('Set saved privately. Recordings prepare automatically.');
 });
 teacherSaves.set(list.id,task);
 try { await task; }
 catch (error) { if (ai.token === token && state === owner) { $('teacher-private-audio-status').textContent = error.message; teacherStatus(error.message); } throw error; }
 finally { if (teacherSaves.get(list.id) === task) teacherSaves.delete(list.id); }
}

async function deleteTeacherSet(list) {
 if (!ai.token || ai.role !== 'teacher') return true;
 const {root,token} = ai, owner = state;
 await (teacherSaves.get(list.id) || Promise.resolve()).catch(()=>{});
 if (ai.token !== token || state !== owner) return false;
 try { await service('/teacher/sets/'+encodeURIComponent(list.packId || list.id),{root,token,method:'DELETE'}); }
 catch (error) { if (error.status !== 404) throw error; }
 return ai.token === token && state === owner;
}

async function restoreTeacherGeneration(reference) {
 const {root,token,role} = ai, owner = state;
 if (reference?.root !== root || reference.role !== role || !/^[a-z0-9_-]+$/i.test(reference.id) || !owner.lists.some(row=>row.id===reference.listId)) return;
 const job = await service('/jobs/'+encodeURIComponent(reference.id),{root,token});
 if (ai.token !== token || state !== owner) return;
 ai.listId = reference.listId; ai.autoApply = role === 'teacher'; ai.recoveringJob = true; applyJob(job);
 if (['ready','processing'].includes(job.status)) runJob().catch(error=>{if(ai.token===token)teacherStatus(error.message);});
 else if (role === 'teacher') await applyTeacherDrafts();
}

function renderPrivateAudio() {
 const list = selectedList(), audio = list?.audioStatus;
 $('teacher-private-audio').hidden = !ai.token || ai.role !== 'teacher' || !list;
 $('teacher-recordings').replaceChildren();
 $('teacher-retry-audio').disabled = !!list?.remoteConflict || !audio || !!audio.pending || audio.ready === audio.total;
 $('teacher-private-audio-status').textContent = list?.remoteConflict ? 'This set has a version conflict. Export your local changes, then reload saved sets before saving or sharing.' : !audio ? 'Save this set to prepare word recordings.' :
  audio.ready + ' of ' + audio.total + ' recordings ready.' + (audio.pending ? ' Preparing the remaining recordings…' : '') +
  (audio.message ? ' ' + audio.message : '') + (audio.retryAt > Date.now() ? ' Retry after ' + new Date(audio.retryAt).toLocaleTimeString() + '.' : '');
 for (const clip of audio?.recordings || []) {
  const row = document.createElement('li'), description = document.createElement('span');
  description.textContent = clip.word + ' · ' + clip.text + ' · ' + clip.status +
   (clip.voice ? ' · '+clip.voice : '') + (clip.error ? ' · ' + clip.error : '');
  row.append(description);
  if (clip.status === 'ready') {
   const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost small';
   button.textContent = 'Listen'; button.setAttribute('aria-label','Listen to ' + clip.text);
   button.onclick = teacherAction(async () => {
    const {root,token} = ai; stopRecording(); const request = dictationRequest;
    const bytes = await service('/teacher/sets/' + encodeURIComponent(list.packId || list.id) + '/audio/' + encodeURIComponent(clip.key), {root,token,audio:true});
    if (ai.token !== token || selectedList() !== list || request !== dictationRequest) return;
    await playRecording(new Blob([bytes],{type:'audio/wav'}),1,request);
   });
   row.append(button);
  }
  $('teacher-recordings').append(row);
 }
 if (sharing.list === list) renderSharing();
}

function watchPrivateAudio() {
 clearTimeout(privateAudioTimer);
 const list = selectedList(), {root,token} = ai;
 if (!token || !list?.audioStatus?.pending) return;
 const stamp = list.updatedAt, version = list.packVersion || 1;
 privateAudioTimer = setTimeout(async () => {
  if (ai.token !== token || selectedList() !== list) return;
  try {
   const response = await service('/teacher/sets/' + encodeURIComponent(list.packId || list.id),{root,token});
   if (ai.token !== token || selectedList() !== list || list.updatedAt !== stamp || (list.packVersion || 1) !== version || response.pack.version !== version) return;
   list.audioStatus = response.audioStatus; renderPrivateAudio();
  } catch (error) { if (ai.token === token) $('teacher-private-audio-status').textContent = 'Could not refresh recordings. ' + error.message; }
  if (ai.token === token && selectedList() === list) watchPrivateAudio();
 },3500);
}

function invitationToken() { return new URLSearchParams(location.hash.slice(1)).get('invite') || ''; }
function refreshTeacherLogin() {
 const invite = invitationToken(), owner = $('teacher-login-kind').value === 'owner' && !invite;
 $('teacher-login-kind').disabled = !!ai.token || !!invite;
 $('teacher-username-field').hidden = owner;
 $('teacher-username').required = !owner;
 $('teacher-username').disabled = !!ai.token;
 $('teacher-name-field').hidden = !invite;
 $('teacher-name').required = !!invite;
 $('teacher-secret').autocomplete = invite ? 'new-password' : 'current-password';
 $('teacher-secret-label').textContent = owner ? 'Site owner password' : invite ? 'Choose a password (at least 12 characters)' : 'Password';
 $('teacher-secret').minLength = invite ? 12 : 0;
 $('teacher-secret').maxLength = 200;
 $('teacher-login').textContent = invite ? 'Create teacher account' : 'Sign in';
 $('teacher-signin-title').textContent = invite ? 'Create your teacher account' : 'Teacher sign-in';
}

async function applyTeacherDrafts() {
 const {token,job} = ai, list = state.lists.find(row=>row.id===ai.listId);
 if (!job?.words.length || !list || ai.reviewDrafts === job.words.length) return;
 const lookup = new Map(job.words.map(row=>[wordKey(row.word),Vocabulary.validateRecord(row.word,row.vocabulary)]));
 const previous = await loadVocabulary(list);
 if (ai.token !== token || ai.job !== job || !state.lists.includes(list)) return;
 const records = previous.map(row=>lookup.has(wordKey(row.word)) && row.vocabulary?.status !== 'approved' && (!ai.recoveringJob || !row.vocabulary) ?
  {...row,vocabulary:lookup.get(wordKey(row.word))} : row);
 if (JSON.stringify(records) === JSON.stringify(previous)) { ai.reviewDrafts = job.words.length; refreshTeacher(); return; }
 await saveVocabulary(list,records,{packVersion:(list.packVersion || 0)+1});
 if (ai.token !== token || ai.job !== job) return;
 ai.reviewDrafts = job.words.length;
 if (sharing.list === list) sharing.records = records;
 refreshTeacher(); teacherStatus('Drafts saved. Full examples and blank-question recordings prepare automatically. Review and approve the vocabulary before sharing.');
}

async function refreshTeacherAccounts() {
 const {root,token} = ai;
 const [invitations,teachers] = await Promise.all([service('/admin/invitations',{root,token}),service('/admin/teachers',{root,token})]);
 if (ai.token !== token || !ai.teacher?.isAdmin) return;
 for (const [id,rows,kind] of [['teacher-invitations',invitations.invitations,'invite'],['teacher-accounts',teachers.teachers,'teacher']]) {
  const host = $(id); host.replaceChildren();
  for (const item of rows) {
   const li = document.createElement('li'), text = document.createElement('span');
   const ended = item.revoked || item.used || item.usedAt || item.acceptedAt || kind === 'invite' && item.expiresAt <= Date.now();
   text.textContent = (item.label || item.name || item.username || item.id) +
    (item.revoked ? ' · Revoked' : item.used || item.usedAt || item.acceptedAt ? ' · Accepted' : kind === 'invite' ? ' · Expires ' + new Date(item.expiresAt).toLocaleString() : ' · ' + item.username);
   li.append(text);
   if (!ended && !item.isAdmin) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost small'; button.textContent = 'Revoke';
    button.setAttribute('aria-label','Revoke '+(item.label || item.name || item.username || 'invitation'));
    button.onclick = teacherAction(async ()=>{
     button.disabled = true;
     try { await service(kind === 'invite' ? '/admin/revokeinvite' : '/admin/revoketeacher',{method:'POST',body:{id:item.id}}); await refreshTeacherAccounts(); }
     finally { button.disabled = false; }
    }); li.append(button);
   }
   host.append(li);
  }
  if (!rows.length) { const li = document.createElement('li'); li.textContent = kind === 'invite' ? 'No invitations yet.' : 'No invited teachers yet.'; host.append(li); }
 }
}

function initTeacherAccounts() {
 $('teacher-test-keys').onclick = teacherAction(async ()=>{
  const {root,token} = ai; $('teacher-test-keys').disabled = true;
  $('teacher-account-status').textContent = 'Testing saved connections without generating speech or text…';
  try {
   const result = await service('/teacher/testkeys',{root,token,method:'POST'});
   if (ai.token !== token) return;
   const labels = {connected:'connected',missing:'no key saved',invalid:'key rejected — reenter it',unavailable:'could not verify — retry later'};
   $('teacher-account-status').textContent = ['groq','openrouter'].map(provider=>(provider==='groq'?'Groq':'OpenRouter')+': '+(labels[result[provider]] || 'could not verify')).join('. ')+'.';
  } finally { $('teacher-test-keys').disabled = !ai.token; }
 });
 $('teacher-keys-form').onsubmit = async event => {
  event.preventDefault(); const {root,token} = ai; const body = teacherKeyChanges();
  $('teacher-keys-save').disabled = true;
  $('teacher-account-status').textContent = 'Saving AI connections…';
  try {
   const profile = await service('/teacher/keys',{root,token,method:'PUT',body});
   if (ai.token !== token) return;
   renderTeacherProfile(profile); $('teacher-account-status').textContent = 'Connections saved. Your key values are never returned to this browser.';
  } catch (error) { if (ai.token === token) $('teacher-account-status').textContent = error.message; }
  finally {
   if (ai.token === token) {
    for (const provider of ['groq','openrouter']) $('teacher-' + provider + '-key').value = '';
    $('teacher-keys-save').disabled = !ai.token;
   }
  }
 };
 $('teacher-reload-sets').onclick = teacherAction(async ()=>{
  if (!confirm('Reload server copies? Export a backup first if this browser has unsaved edits.')) return;
  // Reload explicitly replaces local revisions, including a locally newer conflicting copy.
  const {token,root} = ai, response = await service('/teacher/sets',{root,token});
  if (ai.token !== token) return;
  restoringTeacherSets = true;
  try {
   for (const saved of response.sets) {
    if (ai.token !== token) return;
    const pack = Vocabulary.validatePack(saved.pack || saved), list = findPackList(pack.id);
    if (list) {
     await saveVocabulary(list,pack.words,{name:pack.name,words:pack.words.map(row=>row.word),packId:pack.id,packVersion:pack.version});
     state.settings.selected[list.id] = list.words.slice(); save();
    } else await importPack(pack);
    const restored = findPackList(pack.id); if (restored) { restored.remoteVersion = pack.version; restored.remoteConflict = false; restored.audioStatus = saved.audioStatus; save(); }
   }
  } finally { restoringTeacherSets = false; }
  renderSetup(); renderPrivateAudio(); watchPrivateAudio();
  $('teacher-account-status').textContent = 'Saved sets reloaded.';
 });
 $('teacher-retry-audio').onclick = teacherAction(async ()=>{
  const list = selectedList(), {root,token} = ai; if (!list) return;
  $('teacher-retry-audio').disabled = true;
  try {
   await autosaveTeacherSet(list);
   const response = await service('/teacher/sets/'+encodeURIComponent(list.packId || list.id)+'/retry',{root,token,method:'POST'});
   if (ai.token !== token || selectedList() !== list) return;
   list.audioStatus = response.audioStatus; renderPrivateAudio(); watchPrivateAudio();
  } finally { if (ai.token === token) renderPrivateAudio(); }
 });
 $('teacher-create-invite').onclick = teacherAction(async ()=>{
  const {root,token} = ai; $('teacher-create-invite').disabled = true;
  try {
   const invite = await service('/admin/invitations',{root,token,method:'POST',body:{label:$('teacher-invite-label').value.trim()}});
   if (ai.token !== token) return;
   const link = new URL('./',location.href); link.hash = new URLSearchParams({invite:invite.invite}).toString();
   $('teacher-invite-link').value = link.href; $('teacher-invite-result').hidden = false;
   $('teacher-invite-status').textContent = 'Invitation created. Expires '+new Date(invite.expiresAt).toLocaleString()+'.';
   await refreshTeacherAccounts();
  } finally { $('teacher-create-invite').disabled = false; }
 });
 $('teacher-refresh-accounts').onclick = teacherAction(refreshTeacherAccounts);
 $('teacher-copy-invite').onclick = teacherAction(async ()=>{
  $('teacher-invite-status').textContent = await copy($('teacher-invite-link').value) ? 'Invitation link copied.' : 'Select and copy the invitation link above.';
 });
}
function teacherStatus(message) {
 $('teacher-status').textContent = message;
 $('teacher-signin-status').textContent = message;
}

function serviceOrigin(value) {
 const url = new URL(value);
 if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
     url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw Error('Enter an HTTPS service origin with no path.');
 }
 return url.origin;
}

async function service(path, {root = ai.root, token = ai.token, method = 'GET', body, requestId, audio = false} = {}) {
 const headers = {Accept: audio ? 'audio/wav' : 'application/json'};
 if (token) headers.Authorization = 'Bearer ' + token;
 if (body) headers['Content-Type'] = 'application/json';
 if (requestId) headers['Idempotency-Key'] = requestId;
 const response = await fetch(root + '/api' + path, {
  method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'omit',
  cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(45000)
 });
 if (audio && response.ok && response.headers.get('Content-Type') === 'audio/wav') return response.arrayBuffer();
 let payload;
 try { payload = await response.json(); } catch (error) { throw Error('The service returned an invalid response.'); }
 if (!response.ok) {
  const error = Error(payload?.error?.message || 'The service could not complete the request.');
  error.status = response.status;
  throw error;
 }
 return payload;
}

function saveJob() {
 if (!ai.job || !ai.listId) return;
 try {
  localStorage.setItem(generationStorageKey(), JSON.stringify({root: ai.root, id: ai.job.id, listId: ai.listId, role: ai.role}));
 } catch (error) {
  teacherStatus('The browser could not save the job reference. Keep this tab open.');
 }
}

function refreshTeacher() {
 const teacher = ai.role === 'teacher', signedIn = !!ai.token;
 const canDraft = !!(teacher ? ai.config.generationEnabled : ai.config.studentGenerationEnabled);
 const administrator = teacher && !!ai.teacher?.isAdmin;
 $('teacher-operations').hidden = !administrator;
 $('teacher-open-invitations').hidden = !administrator;
 $('teacher-open-drafting').disabled = !teacher || !canDraft || !selectedList();
 $('teacher-account').hidden = !teacher || !signedIn;
 refreshTeacherLogin();
 if (entryPage === 'teacher') {
  const toolsTitle = canDraft ? 'Draft vocabulary with AI' : 'Online vocabulary tools';
  $('setup-word-selection-title').closest('.stack').hidden = !canDraft;
  $('open-teacher').textContent = toolsTitle;
  if ($('teacher-dialog').dataset.view === 'admin') $('teacher-title').textContent = toolsTitle;
 }
 $('teacher-logout').hidden = !signedIn;
 $('teacher-url').disabled = signedIn;
 $('teacher-secret').disabled = signedIn;
 $('teacher-login').disabled = signedIn;
 $('teacher-keys-save').disabled = !signedIn;
 $('teacher-test-keys').disabled = !signedIn;
 $('class-login').disabled = signedIn;
 $('teacher-job').hidden = !signedIn || !canDraft && !ai.job;
 $('teacher-draft-form').hidden = !canDraft;
 $('teacher-admin').hidden = !teacher;
 $('ai-context-wrap').hidden = !teacher;
 $('vocab-regenerate').hidden = !teacher || !canDraft;
 $('vocab-regenerate').disabled = !editorRecords.find(row => row.word === $('vocab-word').value)?.vocabulary;
 updateTroyControls();
 const list = selectedList(), selected = teacher ? list?.words.length || 0 : selectedWords().length;
 $('teacher-drafting-info').hidden = !signedIn || canDraft;
 $('teacher-drafting-status').textContent = teacher && ai.config.draftingAvailable
  ? 'AI drafting is paused. You can edit vocabulary by hand and still publish sets.'
  : 'AI drafting is off. You can edit vocabulary by hand and still publish sets.';
 $('teacher-write-vocabulary').disabled = !list;
 $('teacher-selection').textContent = !list ? 'Create a set to draft vocabulary.' : !selected
  ? 'Add words to the set to draft vocabulary.' : selected + (selected === 1 ? ' word in ' : ' words in ') + list.name + '. Drafts save automatically; review them before sharing.';
 const active = ai.job && ['ready', 'processing', 'paused'].includes(ai.job.status);
 $('ai-generate').disabled = !canDraft || !selected || active;
 $('teacher-job-actions').hidden = !ai.job;
 $('ai-pause').hidden = !active || ai.job?.status === 'paused';
 $('ai-resume').hidden = !canDraft || ai.job?.status !== 'paused';
 $('ai-cancel').hidden = !active;
 $('ai-apply').hidden = teacher || !ai.job?.words.length || ai.reviewDrafts === ai.job.words.length;
 $('ai-retry-words').hidden = !canDraft || active || !ai.job?.failedWords.length;
 $('ai-review-saved').hidden = !ai.reviewDrafts;
 renderSharing();
 $('ai-drafting-controls').hidden = !ai.config.draftingAvailable;
 $('ai-stop').textContent = ai.config.generationEnabled ? 'Pause AI drafting' : 'Resume AI drafting';
 if (ai.job) {
  const {counts, status: current, message, retryAt, failedWords} = ai.job;
  $('ai-progress').textContent = counts.cached + counts.generated + ' of ' + counts.total + ' ready · ' +
   counts.cached + ' cached · ' + counts.generated + ' generated · ' + counts.failed + ' failed · ' + current +
   (message ? ' · ' + message : '') + (retryAt && retryAt > Date.now() ? ' Retry after ' + new Date(retryAt).toLocaleTimeString() + '.' : '') +
   (failedWords?.length ? ' Failed: ' + failedWords.join(', ') + '.' : '');
 } else $('ai-progress').textContent = '';
}

function applyJob(job) {
 if (ai.job?.id !== job.id) ai.reviewDrafts = 0;
 ai.job = job;
 saveJob();
 refreshTeacher();
}

async function runJob() {
 const version = ++ai.generation, id = ai.job.id, token = ai.token, root = ai.root;
 while (version === ai.generation && ai.token === token && ['ready', 'processing'].includes(ai.job?.status)) {
  const delay = ai.job.retryAt ? ai.job.retryAt - Date.now() : 0;
  if (delay > 0 || ai.job.status === 'processing') {
   await new Promise(resolve => setTimeout(resolve, Math.max(500, Math.min(delay, 5000))));
   if (version !== ai.generation) return;
   const snapshot = await service('/jobs/' + encodeURIComponent(id), {root, token});
   if (version !== ai.generation) return;
   applyJob(snapshot);
   continue;
  }
  const job = await service('/jobs/' + encodeURIComponent(id) + '/step', {root, token, method: 'POST'});
  if (version !== ai.generation) return;
  applyJob(job);
 }
 if (version === ai.generation && ai.token === token && ai.role === 'teacher' && ai.autoApply) await applyTeacherDrafts();
}

const teacherAction = task => async event => {
 const token = ai.token;
 if (event) event.preventDefault();
 try { await task(event); } catch (error) { if (ai.token === token) teacherStatus(error.message); }
};

async function jobAction(action) {
 const {root,token} = ai;
 const id = ai.job?.id;
 if (!id) return;
 ++ai.generation;
 if (action === 'resume' && ai.job.status !== 'paused') { await runJob(); return; }
 const job = await service('/jobs/' + encodeURIComponent(id) + '/' + action, {root,token,method: 'POST'});
 if (ai.token !== token) return;
 applyJob(job);
 if (action === 'resume') await runJob();
}

function aiSettings() {
 const settings = {
  readingLevel: Number($('ai-grade').value), dialect: 'original',
  practiceSentences: Number($('ai-sentences').value), exampleSentences: Number($('ai-examples').value),
  reuseApproved: $('ai-reuse').checked, esl: $('ai-esl').checked,
  distractors: $('ai-distractors').checked, explanations: $('ai-explanations').checked
 };
 if (ai.role === 'teacher' && $('ai-context').value.trim()) settings.context = $('ai-context').value.trim();
 return settings;
}

function publicPackLink(id, root) {
 const site = new URL('practice/', entryPage === 'offline' ? 'https://wordlab.mtomlinson.ca/' : location.href);
 const args = new URLSearchParams({pack: id});
 if (root !== ONLINE_CONFIG) args.set('service', root);
 site.hash = args.toString();
 return site.href;
}

function updateTeacherSelection(list, records) {
 if (entryPage !== 'teacher') return;
 $('teacher-open-publishing').disabled = !list;
 $('teacher-open-drafting').disabled = !list || ai.role !== 'teacher' || !ai.config.generationEnabled;
 renderPrivateAudio(); watchPrivateAudio();
 const summary = records && SharedReview.sharingContent(records, 'mixed');
 $('setup-set-summary').textContent = !list ? '' : list.words.length + (list.words.length === 1 ? ' word' : ' words') +
  (summary ? ' · ' + summary.approved.length + ' with approved vocabulary · ' + summary.drafts.length + ' to review' : '');
}

function renderSharing() {
 const mode = $('shared-mode').value;
 const info = sharing.records && SharedReview.sharingContent(sharing.records, mode);
 const {approved, drafts, missing} = info || {approved:[], drafts:[], missing:[]};
 const clips = sharing.list?.audioStatus?.recordings || [];
 const required = clips.filter(clip=>mode !== 'spelling' || /-s$/.test(clip.key));
 const audioReady = !ai.teacher || ai.teacher.isAdmin && !ai.config.dictationEnabled ||
  required.length >= (sharing.list?.words.length || 0) && required.every(clip=>clip.status === 'ready');
 const shareReady = !!info?.ready && !publishing && audioReady && !sharing.list?.remoteConflict;
 const needsReview = !!info && mode !== 'spelling' && !info.ready;
 const hasLink = !!ai.published && ai.publishedListId === sharing.list?.id && ai.publishedMode === mode &&
  ai.publishedHints === $('shared-hints').checked && ai.publishedUpdatedAt === sharing.list.updatedAt;
 $('ai-publish-readiness').textContent = !sharing.list ? 'Create or select a set first.' :
  !info ? 'Checking which words are ready…' : info.ready && !audioReady ?
   'Prepare the missing recordings before sharing. Check Prepared recordings below, then retry failed recordings.' : mode === 'spelling' ?
   'Ready to share. Students will spell all ' + info.words.length + ' words.' : drafts.length ?
    'Review and approve the remaining vocabulary drafts before sharing.' : !approved.length ?
     'Add and approve vocabulary, or choose Spelling to share this word list.' : mode === 'mixed' ?
      'Ready to share. All ' + info.words.length + (info.words.length === 1 ? ' word is' : ' words are') +
       ' included for spelling. ' + approved.length + (approved.length === 1 ? ' also has' : ' also have') + ' vocabulary.' +
       (missing.length ? ' Remaining words are spelling only.' : '') :
      'Ready to share. Students will practice ' + approved.length + (approved.length === 1 ? ' word' : ' words') + ' with approved vocabulary.';
 $('ai-publish-readiness').className = needsReview ? 'notice' : 'hint';
 $('ai-vocabulary-details').hidden = !info || mode === 'spelling';
 $('ai-vocabulary-words').textContent = [['Approved', approved], ['Needs review', drafts], ['No vocabulary', missing]]
  .filter(([, words]) => words.length).map(([label, words]) => label + ': ' + words.join(', ')).join('\n');
 $('ai-publish-review').hidden = !needsReview;
 $('ai-publish-review').textContent = drafts.length ? 'Review drafts' : 'Add vocabulary';
 $('ai-publish-readiness').hidden = hasLink;
 $('ai-share-help').hidden = hasLink;
 $('ai-publish').hidden = hasLink;
 $('ai-publish').disabled = !shareReady;
 const audioStatus = hasLink && ai.audioStatus;
 const pending = audioStatus?.pending;
 const incomplete = audioStatus && audioStatus.ready < audioStatus.total;
 const waitingForAudio = !!pending || !!incomplete && !!ai.config.dictationEnabled;
 $('ai-preview').disabled = entryPage === 'teacher' ? !info?.ready || publishing : !hasLink || !!pending;
 $('ai-link-actions').hidden = !hasLink;
 $('ai-publish-options').hidden = !ai.teacher?.isAdmin || !ai.config.draftingAvailable;
 $('ai-student-link').value = hasLink ? ai.published : '';
 $('ai-share').disabled = !hasLink || waitingForAudio;
 $('ai-qr').disabled = !hasLink || waitingForAudio;
 $('ai-share-audio').hidden = !ai.config.dictationEnabled;
 $('ai-prepare-audio').hidden = !incomplete || !!pending;
 $('ai-audio-status').textContent = !audioStatus ? '' : pending
  ? 'Preparing practice audio. ' + audioStatus.ready + ' of ' + audioStatus.total + ' recordings ready. You can close this tab.'
  : incomplete ? audioStatus.ready + ' of ' + audioStatus.total + ' recordings are ready. Retry to prepare the remaining recordings.'
  : 'Practice audio is ready.';
 $('shared-mode').disabled = publishing;
 $('shared-hints').disabled = publishing || mode === 'spelling';
 $('shared-hints-row').hidden = mode === 'spelling';
}

function watchPracticeAudio() {
 clearTimeout(audioStatusTimer);
 if (!ai.audioStatus?.pending) return;
 const {published, root, token} = ai;
 const id = new URLSearchParams(new URL(published).hash.slice(1)).get('pack');
 audioStatusTimer = setTimeout(async () => {
  if (ai.published !== published || ai.token !== token) return;
  try {
   const {audioStatus} = await service('/packs/' + encodeURIComponent(id), {root, token});
   if (ai.published === published && ai.token === token) {
    ai.audioStatus = audioStatus;
    renderSharing();
   }
  } catch {}
  if (ai.published === published && ai.token === token) watchPracticeAudio();
 }, 3500);
}

async function showTeacherTools(view = 'tools') {
 $('tools-dialog').close();
 if (!$('teacher-url').value) $('teacher-url').value = ONLINE_CONFIG;
 const list = selectedList(), changedSet = sharing.list !== list;
 const current = {list, records:null};
 sharing = current;
 if (changedSet) {
  $('shared-hints').checked = true;
  $('ai-publish-status').textContent = '';
  $('ai-qr-result').replaceChildren(); $('ai-qr-result').hidden = true;
 }
 const dialog = $('teacher-dialog');
 dialog.dataset.view = view;
 $('teacher-title').textContent = view === 'share' && list ? 'Share “' + list.name + '”' :
  view === 'admin' && ai.config.generationEnabled ? 'Draft vocabulary with AI' : 'Online vocabulary tools';
 dialog.querySelector('#teacher-operations').open = false;
 if (view !== 'share') teacherStatus('');
 refreshTeacher();
 dialog.showModal();
 try {
  const rows = list ? await loadVocabulary(list) : null;
  if (sharing !== current) return;
  current.records = rows;
  if (changedSet && rows) $('shared-mode').value = rows.some(row => row.vocabulary) ? 'mixed' : 'spelling';
  renderSharing();
  if (view === 'share' && changedSet && rows && ai.token) {
   const {token, root} = ai;
   const mode = $('shared-mode').value, hints = $('shared-hints').checked;
   const id = Dictation.canonicalPackId(list.packId) || list.id;
   const saved = await service('/packs/' + encodeURIComponent(id), {root, token}).catch(() => null);
   if (sharing !== current || ai.token !== token || !dialog.open ||
       $('shared-mode').value !== mode || $('shared-hints').checked !== hints || saved?.visibility !== 'public') return;
   const {pack, practice, audioStatus} = saved;
   const local = outputPack(list, SharedReview.sharingContent(rows, practice.mode).words);
   if (JSON.stringify(local) !== JSON.stringify(Vocabulary.validatePack(pack))) return;
   $('shared-mode').value = practice.mode;
   $('shared-hints').checked = practice.allowHints;
   Object.assign(ai, {published:publicPackLink(id, root), publishedListId:list.id, publishedMode:practice.mode,
    publishedHints:practice.allowHints, publishedUpdatedAt:list.updatedAt, audioStatus});
   renderSharing();
   watchPracticeAudio();
  }
 } catch (error) { $('ai-publish-readiness').textContent = error.message; }
}

function showTeacherEntry() {
 if (ai.role === 'teacher' && ai.token) {
  $('setup-title').textContent = 'Teacher workspace';
  $('setup-practice-settings').hidden = true;
  $('reset-progress').hidden = true;
  $('open-report').hidden = true;
  $('teacher-workspace-actions').hidden = false;
  $('teacher-workspace-logout').hidden = false;
  $('setup-word-selection-title').textContent = 'Words for AI drafting';
  $('setup-word-selection-help').textContent = 'Choose which words need AI-written vocabulary. When you publish, students get the whole set.';
  renderSetup();
  show('setup-screen');
  $('setup-list-label').textContent = 'Practice set';
  $('new-list').textContent = 'Create a set';
  $('edit-list').textContent = 'Edit words';
  $('open-vocabulary').textContent = 'Edit vocabulary';
  $(selectedList() ? 'list-select' : 'new-list').focus();
  return;
 }
 const form = $('teacher-connect');
 $('teacher-signin-slot').append(form);
 $('teacher-url').value = ONLINE_CONFIG;
 $('teacher-url-field').hidden = true;
 $('teacher-secret-label').textContent = 'Teacher password';
 $('teacher-secret').autocomplete = 'current-password';
 $('class-login').hidden = true;
 $('teacher-login').textContent = 'Sign in';
 refreshTeacher();
 show('teacher-signin-screen');
 refreshTeacherLogin();
 $(invitationToken() || $('teacher-login-kind').value === 'teacher' ? 'teacher-username' : 'teacher-secret').focus();
}

function initTeacher() {
 $('teacher-open-drafting').onclick = async ()=>{await showTeacherTools('admin');$('ai-generate').scrollIntoView({block:'center'});$('ai-generate').focus();};
 $('teacher-open-connections').onclick = async ()=>{await showTeacherTools('admin');$('teacher-groq-key').scrollIntoView({block:'center'});$('teacher-groq-key').focus();};
 $('teacher-open-invitations').onclick = teacherAction(async ()=>{await showTeacherTools('admin');$('teacher-operations').open=true;await refreshTeacherAccounts();$('teacher-invite-label').scrollIntoView({block:'center'});$('teacher-invite-label').focus();});
 $('open-teacher').onclick = () => showTeacherTools(entryPage === 'teacher' ? 'admin' : 'tools');
 $('teacher-open-publishing').onclick = () => showTeacherTools('share');
 $('teacher-write-vocabulary').onclick = () => {
  $('teacher-dialog').close();
  openVocabularyEditor();
 };
 $('ai-review-saved').onclick = async () => {
  const list = state.lists.find(row => row.id === ai.listId);
  if (!list) { teacherStatus('This set was deleted.'); return; }
  $('teacher-dialog').close();
  listId = list.id;
  renderSetup();
  await openVocabularyEditor('draft');
 };
 for (const id of ['shared-mode', 'shared-hints']) $(id).onchange = () => {
  $('ai-publish-status').textContent = '';
  $('ai-qr-result').hidden = true;
  renderSharing();
 };
 let returnToSharing = '';
 $('ai-publish-review').onclick = async () => {
  const dialog = $('teacher-dialog');
  const info = SharedReview.sharingContent(sharing.records, $('shared-mode').value);
  const view = dialog.dataset.view;
  dialog.close();
  if (await openVocabularyEditor(info.drafts.length ? 'draft' : 'missing')) {
   returnToSharing = view;
   $('vocab-close').textContent = 'Back to sharing';
  } else showTeacherTools(view);
 };
 $('vocab-dialog').addEventListener('close', () => {
  if (!returnToSharing || $('vocab-dialog').open) return;
  const view = returnToSharing; returnToSharing = '';
  $('vocab-close').textContent = 'Close';
  $('ai-publish-status').textContent = '';
  showTeacherTools(view);
 });
 $('teacher-workspace-logout').onclick = () => $('teacher-logout').click();
 $('teacher-close').onclick = () => $('teacher-dialog').close();
 $('teacher-login-kind').onchange = refreshTeacherLogin;
 initTeacherAccounts();
 $('teacher-connect').onsubmit = teacherAction(async event => {
  if (ai.token) return;
  const request = ++teacherLoginRequest, previousState = state, previousKey = KEY;
  const root = serviceOrigin($('teacher-url').value);
  const role = event.submitter?.id === 'class-login' ? 'class' : 'teacher';
  const owner = $('teacher-login-kind').value === 'owner', invite = invitationToken();
  const password = $('teacher-secret').value;
  $('teacher-secret').value = '';
  if (!password) throw Error('Enter your password or class access code.');
  const username = $('teacher-username').value.trim(), name = $('teacher-name').value.trim();
  $('teacher-login').disabled = true;
  let response;
  try {
   const path = role === 'class' ? '/access' : invite ? '/teacher/accept' : owner ? '/admin/access' : '/teacher/login';
   const recovery = role === 'class' ? await getStore().then(store=>store.get(CLASS_RECOVERY)).catch(()=>null) : null;
   if (request !== teacherLoginRequest) return;
   const body = role === 'class' ? {code:password.trim(),...(recovery?.root===root?{previousToken:recovery.token}:{})} : invite ? {invite,username,name,password} : owner ? {secret:password} : {username,password};
   response = await service(path,{root,token:'',method:'POST',body});
  } finally { if (request === teacherLoginRequest) $('teacher-login').disabled = false; }
  if (request !== teacherLoginRequest) return;
  if (role === 'teacher' && !response.teacher?.id) throw Error('The service did not identify this teacher. Update the service before signing in.');
  resetTeacherWorkspace();
  ai = {...ai,root,role,token:response.token,teacher:response.teacher,config:response.config || {},job:null,listId:'',published:''};
  KEY = role === 'teacher' ? teacherStorageKey() : previousKey;
  if (role === 'teacher') await loadTeacherWorkspace();
  else { state = previousState; listId = state.lists[0]?.id || ''; }
  if (request !== teacherLoginRequest || ai.token !== response.token) return;
  if (invite) { const hash = new URLSearchParams(location.hash.slice(1)); hash.delete('invite'); history.replaceState(null,'',location.pathname+location.search+(hash.size?'#'+hash:'')); }
  if (role === 'teacher') {
   try {
    const profile = await service('/teacher/profile');
    if (request !== teacherLoginRequest || ai.token !== response.token) return;
    renderTeacherProfile(profile); await restoreTeacherSets();
   }
   catch (error) { teacherStatus('Signed in. Saved sets could not reload. ' + error.message); }
  } else {
   const classStore = await getStore();
   const config = await service('/config',{root,token:response.token});
   if (request !== teacherLoginRequest || ai.token !== response.token) return;
   ai.config = config; await classStore.put(CLASS_RECOVERY,{root,token:response.token}).catch(()=>{});
  }
  if (request !== teacherLoginRequest || ai.token !== response.token) return;
  const reference = JSON.parse(localStorage.getItem(generationStorageKey()) || 'null');
  try { await restoreTeacherGeneration(reference); }
  catch (error) { if (ai.token === response.token) teacherStatus('Previous job could not be reopened. '+error.message); }
  if (request !== teacherLoginRequest || ai.token !== response.token) return;
  refreshTeacher();
  const shared = new URLSearchParams(location.hash.slice(1));
  if (entryPage === 'teacher' && !shared.has('pack')) showTeacherEntry();
  else if (shared.has('pack') && serviceOrigin(shared.get('service') || ONLINE_CONFIG) === root) { $('teacher-dialog').close(); await openSharedReview(); }
  if (invite) { await showTeacherTools('admin'); teacherStatus('Account created. Add your Groq key to prepare recordings and vocabulary.'); $('teacher-groq-key').focus(); }
 });
 $('teacher-logout').onclick = () => {
  ++teacherLoginRequest;
  if (ai.role === 'class') getStore().then(store=>store.remove(CLASS_RECOVERY)).catch(()=>{});
  const root = ai.root, generation = ai.generation + 1;
  ai = {root,token:'',role:'',config:{},job:null,listId:'',published:'',generation};
  resetTeacherWorkspace(); KEY = entryPage === 'teacher' ? 'spell.teacher.signed-out' : 'spell.state';
  $('ai-context').value = ''; $('ai-qr-result').replaceChildren(); $('ai-qr-result').hidden = true;
  $('ai-usage-result').textContent = '';
  for (const id of ['teacher-groq-status','teacher-openrouter-status','teacher-account-name','teacher-account-status','teacher-invite-status','ai-progress','teacher-private-audio-status']) $(id).textContent = '';
  teacherStatus('Signed out.'); refreshTeacher();
  if (entryPage === 'teacher') showTeacherEntry();
  else { state = loadState(); listId = state.lists[0]?.id || ''; renderSetup(); }
 };
 $('ai-generate').onclick = teacherAction(async () => {
  const {root,token} = ai, owner = state;
  const list = selectedList();
  const records = ai.role === 'teacher' && list ? await loadVocabulary(list) : selectedRecords();
  if (ai.token !== token || state !== owner) return;
  const words = ($('ai-only-missing').checked ? records.filter(row => !row.vocabulary) : records).map(row => row.word);
  if (!list || !words.length) throw Error('The selected words already have vocabulary. To draft them again, clear “Skip words with vocabulary” under More drafting options.');
  $('ai-generate').disabled = true;
  try {
   ai.listId = list.id;
   ai.autoApply = true; ai.recoveringJob = false;
   const job = await service('/generate', {root,token,method: 'POST', body: {words, settings: aiSettings()}, requestId: newListId()});
   if (ai.token !== token || state !== owner) return;
   applyJob(job);
   await runJob();
  } finally { refreshTeacher(); }
 });
 for (const action of ['pause', 'resume', 'cancel']) $('ai-' + action).onclick = teacherAction(() => jobAction(action));
 $('ai-apply').onclick = teacherAction(applyTeacherDrafts);
 $('vocab-regenerate').onclick = teacherAction(async () => {
  if (ai.role !== 'teacher') { editorStatusText('Sign in to the generation service through Tools.'); return; }
  $('regenerate-dialog').showModal();
 });
 $('regenerate-close').onclick = () => $('regenerate-dialog').close();
 $('regenerate-submit').onclick = async () => {
  const {root,token} = ai, owner = state;
  const previous = editorRecords.find(row => row.word === $('vocab-word').value);
  const item = $('regenerate-item').value, index = Number($('regenerate-sentence').value) - 1;
  const questionId = item === 'cloze' ? previous.vocabulary.clozeQuestions[index]?.id : undefined;
  if (item === 'cloze' && !questionId) { $('regenerate-status').textContent = 'Choose the position of an existing sentence.'; return; }
  if (ai.job && ['ready', 'processing', 'paused'].includes(ai.job.status)) {
   $('regenerate-status').textContent = 'Finish the active generation job first.'; return;
  }
  $('regenerate-submit').disabled = true;
  try {
   ai.listId = editorList.id;
   ai.autoApply = false; ai.recoveringJob = false;
   const job = await service('/regenerate', {root,token,method: 'POST', body: {word: previous.word, previous, item, questionId, settings: aiSettings()}, requestId: newListId()});
   if (ai.token !== token || state !== owner) return;
   applyJob(job); await runJob();
   if (ai.token !== token || state !== owner) return;
   const replacement = ai.job.words[0];
   if (!replacement) throw Error(ai.job.message || 'No replacement was generated. Existing content was kept.');
   await changeVocabulary(editorRecords.map(row => row.word === previous.word ? replacement : row), previous.word);
   $('regenerate-dialog').close(); editorStatusText('Replacement saved for review.');
  } catch (error) { $('regenerate-status').textContent = error.message; }
  finally { $('regenerate-submit').disabled = false; }
 };
 $('ai-publish').onclick = async () => {
  const status = $('ai-publish-status');
  const mode = $('shared-mode').value, allowHints = $('shared-hints').checked;
  const reuse = $('ai-publish-cache').checked, {root, token} = ai;
  publishing = true; renderSharing();
  status.textContent = 'Publishing…';
  try {
   const list = selectedList();
   if (!list) throw Error('Create or select a set before publishing.');
   const stamp = list.updatedAt;
   const records = await loadVocabulary(list);
   await autosaveTeacherSet(list);
   if (list.updatedAt !== stamp || ai.token !== token) throw Error('The set changed while preparing to publish. Try again with the current version.');
   const info = SharedReview.sharingContent(records, mode);
   if (!info.ready) throw Error('Review the vocabulary before publishing, or choose Spelling.');
   const pack = outputPack(list, info.words);
   const cacheSettings = ai.teacher?.isAdmin && reuse && pack.words.some(row => row.vocabulary) ? {...aiSettings(), context: ''} : undefined;
   const {pack: published, audioStatus} = await service('/admin/publish', {root, token, method: 'POST',
    body: {pack, mode, allowHints, visibility: 'public', cacheSettings}, requestId: newListId()});
   if (ai.token !== token) return;
   if (list.updatedAt !== stamp) throw Error('The set changed while publishing. Publish again to share the current version.');
   if ((list.packVersion || 0) < published.version) { list.packVersion = published.version; save(); }
   ai.published = publicPackLink(published.id, root);
   ai.publishedListId = list.id;
   ai.publishedMode = mode;
   ai.publishedHints = allowHints;
   ai.publishedUpdatedAt = list.updatedAt;
   ai.audioStatus = audioStatus;
   $('ai-qr-result').replaceChildren(); $('ai-qr-result').hidden = true;
   refreshTeacher();
   status.textContent = 'Set published.';
   watchPracticeAudio();
  } catch (error) {
   if (ai.token === token) status.textContent = error.status === 401 ? 'Your sign-in expired. Sign out, sign back in, and try again.' : error.message;
  } finally { publishing = false; renderSharing(); }
 };
 $('ai-share').onclick = teacherAction(async () => {
  $('ai-publish-status').textContent = await copy(ai.published) ? 'Student link copied.' : ai.published;
 });
 $('ai-prepare-audio').onclick = async () => {
  const {published, token, root} = ai;
  const button = $('ai-prepare-audio');
  button.disabled = true;
  try {
   const id = new URLSearchParams(new URL(published).hash.slice(1)).get('pack');
   const {audioStatus} = await service('/admin/packaudioqueue', {root, token, method:'POST', body:{id}});
   if (ai.published !== published || ai.token !== token) return;
   ai.audioStatus = audioStatus;
   renderSharing();
   watchPracticeAudio();
  } catch (error) { $('ai-publish-status').textContent = error.message; }
  finally { button.disabled = false; }
 };
 $('ai-preview').onclick = () => {
  try {
   let url;
   if (entryPage === 'teacher' && $('ai-link-actions').hidden) {
    const mode = $('shared-mode').value;
    const {ready, words} = SharedReview.sharingContent(sharing.records, mode);
    if (!ready) return;
    const pack = outputPack(sharing.list, words), ticket = newListId();
    url = new URL(publicPackLink(pack.id, ai.root));
    const args = new URLSearchParams(url.hash.slice(1));
    args.set('draft', ticket); url.hash = args.toString();
    const practice = {mode, allowHints:$('shared-hints').checked};
    localStorage.setItem(LOCAL_PREVIEW_KEY, JSON.stringify({ticket, pack, practice, expiresAt: Date.now() + 60000}));
    setTimeout(() => {
     try {
      const pending = JSON.parse(localStorage.getItem(LOCAL_PREVIEW_KEY) || 'null');
      if (pending?.ticket === ticket) localStorage.removeItem(LOCAL_PREVIEW_KEY);
     } catch {}
    }, 60000);
   } else {
    if (!ai.published) return;
    url = new URL(ai.published);
   }
   url.searchParams.set('preview', '1');
   window.open(url.href, '_blank', 'noopener');
  } catch (error) { $('ai-publish-status').textContent = error.message; }
 };
 $('ai-qr').onclick = teacherAction(async () => {
  const box = $('ai-qr-result');
  const image = document.createElement('img');
  image.alt = 'QR code for the published vocabulary pack';
  image.src = packQRCode(ai.published);
  box.replaceChildren(image);
  box.hidden = false;
 });
 $('ai-usage').onclick = teacherAction(async () => {
  const result = await service('/admin/usage');
  $('ai-usage-result').textContent = result.calls + ' calls · ' + result.tokens + ' tokens · ' + result.cacheRecords +
   ' cached records · ' + Math.round(result.cacheHitRate * 100) + '% cache hits · ' + result.active + ' active';
  const list = $('ai-job-history'); list.replaceChildren();
  for (const job of result.jobs || []) {
   const li = document.createElement('li'); li.textContent = new Date(job.createdAt).toLocaleString() + ' · ' + job.status;
   list.append(li);
  }
 });
 $('ai-stop').onclick = teacherAction(async () => {
  const button = $('ai-stop');
  button.disabled = true;
  try {
   ai.config = await service('/admin/settings', {method: 'PUT', body: {generationEnabled: !ai.config.generationEnabled}});
   refreshTeacher();
  } finally { button.disabled = false; }
 });
 $('ai-classes').onclick = teacherAction(async () => {
  const {classes} = await service('/admin/classes');
  const list = $('ai-class-status'); list.replaceChildren();
  for (const entry of classes) {
   const li = document.createElement('li');
   li.textContent = entry.name + ' (' + entry.classId + ')' + ' · ' + entry.dailyWords + ' words/day' + (entry.revoked ? ' · Revoked' : ' · Expires ' + new Date(entry.expiresAt).toLocaleDateString());
   list.append(li);
  }
 });
 for (const [id, action] of [['ai-class-save', 'save'], ['ai-class-revoke', 'revoke'], ['ai-class-rotate', 'rotate']]) {
  $(id).onclick = teacherAction(async () => {
   const body = {classId: $('ai-class-id').value.trim()};
   if (action === 'revoke') body.revoked = true;
   else if (action === 'rotate') body.rotateCode = true;
   else {
    const expiresAt = new Date($('ai-class-expiry').value + 'T23:59:59').getTime();
    if (!Number.isFinite(expiresAt)) throw Error('Choose a class expiration date.');
    Object.assign(body, {name: $('ai-class-name').value.trim(), expiresAt, dailyWords: Number($('ai-class-limit').value), revoked: false});
   }
   const result = await service('/admin/classes', {method: 'POST', body});
   teacherStatus(result.code ? 'Class code: ' + result.code + '. Copy it now. It is shown once.' : 'Class updated.');
   $('ai-classes').click();
  });
 }
 $('ai-retry-words').onclick = teacherAction(async () => {
  const {root,token} = ai, owner = state;
  const words = ai.job?.failedWords || [];
  if (!words.length) return;
  ai.autoApply = true; ai.recoveringJob = false;
  const job = await service('/generate', {root,token,method: 'POST', body: {words, settings: aiSettings()}, requestId: newListId()});
  if (ai.token !== token || state !== owner) return;
  applyJob(job);
  await runJob();
 });

}
function packQRCode(value) {
 const qr = qrcode(0, 'M');
 qr.addData(value);
 qr.make();
 return qr.createDataURL(5, 20);
}
