const CLASS_RECOVERY = 'class-generation-recovery';
const GENERATION_KEY = 'spell.generation.v1';
const ONLINE_CONFIG = 'https://api.spellingcoach.mtomlinson.ca';
let ai = {root: '', token: '', role: '', config: {}, job: null, listId: '', published: '', generation: 0};
const teacherStatus = message => { $('teacher-status').textContent = message; };

function serviceOrigin(value) {
 const url = new URL(value);
 if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
     url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw Error('Enter an HTTPS service origin with no path.');
 }
 return url.origin;
}

async function service(path, {root = ai.root, token = ai.token, method = 'GET', body, requestId} = {}) {
 const headers = {Accept: 'application/json'};
 if (token) headers.Authorization = 'Bearer ' + token;
 if (body) headers['Content-Type'] = 'application/json';
 if (requestId) headers['Idempotency-Key'] = requestId;
 const response = await fetch(root + '/api' + path, {
  method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'omit',
  cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(45000)
 });
 let payload;
 try { payload = await response.json(); } catch (error) { throw Error('The service returned an invalid response.'); }
 if (!response.ok) throw Error(payload?.error?.message || 'The service could not complete the request.');
 return payload;
}

function saveJob() {
 if (!ai.job || !ai.listId) return;
 try {
  localStorage.setItem(GENERATION_KEY, JSON.stringify({root: ai.root, id: ai.job.id, listId: ai.listId, role: ai.role}));
 } catch (error) {
  teacherStatus('The browser could not save the job reference. Keep this tab open.');
 }
}

function refreshTeacher() {
 const teacher = ai.role === 'teacher', signedIn = !!ai.token;
 $('teacher-logout').hidden = !signedIn;
 $('teacher-url').disabled = signedIn;
 $('teacher-secret').disabled = signedIn;
 $('teacher-login').disabled = signedIn;
 $('class-login').disabled = signedIn;
 $('teacher-job').hidden = !signedIn;
 $('teacher-admin').hidden = !teacher;
 $('ai-context-wrap').hidden = !teacher;
 $('vocab-regenerate').disabled = !teacher || !editorRecords.find(row => row.word === $('vocab-word').value)?.vocabulary;
 $('teacher-selection').textContent = selectedWords().length + ' words selected from ' + (selectedList()?.name || 'no list');
 const active = ai.job && ['ready', 'processing', 'paused'].includes(ai.job.status);
 $('ai-generate').disabled = !signedIn || !selectedWords().length || active ||
  !(teacher ? ai.config.generationEnabled : ai.config.studentGenerationEnabled);
 $('ai-pause').disabled = !active || ai.job?.status === 'paused';
 $('ai-resume').disabled = !active;
 $('ai-cancel').disabled = !active;
 $('ai-apply').disabled = !ai.job?.words.length;
 $('ai-retry-words').disabled = active || !ai.job?.failedWords.length;
 $('ai-share').disabled = !ai.published;
 $('ai-qr').disabled = !ai.published;
 $('ai-stop').textContent = ai.config.generationEnabled ? 'Disable generation' : 'Enable generation';
 if (ai.job) {
  const {counts, status: current, message, retryAt, failedWords} = ai.job;
  $('ai-progress').textContent = counts.cached + counts.generated + ' of ' + counts.total + ' ready · ' +
   counts.cached + ' cached · ' + counts.generated + ' generated · ' + counts.failed + ' failed · ' + current +
   (message ? ' · ' + message : '') + (retryAt && retryAt > Date.now() ? ' Retry after ' + new Date(retryAt).toLocaleTimeString() + '.' : '') +
   (failedWords?.length ? ' Failed: ' + failedWords.join(', ') + '.' : '');
 } else $('ai-progress').textContent = '';
}

function applyJob(job) {
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
}

const teacherAction = task => async event => {
 if (event) event.preventDefault();
 try { await task(event); } catch (error) { teacherStatus(error.message); }
};

async function jobAction(action) {
 const id = ai.job?.id;
 if (!id) return;
 ++ai.generation;
 if (action === 'resume' && ai.job.status !== 'paused') { await runJob(); return; }
 applyJob(await service('/jobs/' + encodeURIComponent(id) + '/' + action, {method: 'POST'}));
 if (action === 'resume') await runJob();
}

function aiSettings() {
 const settings = {
  readingLevel: Number($('ai-grade').value), dialect: $('ai-dialect').value,
  practiceSentences: Number($('ai-sentences').value), exampleSentences: Number($('ai-examples').value),
  reuseApproved: $('ai-reuse').checked, esl: $('ai-esl').checked,
  distractors: $('ai-distractors').checked, explanations: $('ai-explanations').checked
 };
 if (ai.role === 'teacher' && $('ai-context').value.trim()) settings.context = $('ai-context').value.trim();
 return settings;
}

function publicPackLink(id) {
 const site = new URL(location.protocol === 'file:' ? 'https://spellingcoach.mtomlinson.ca/' : location.href);
 site.search = ''; site.hash = '';
 const args = new URLSearchParams({pack: id, service: ai.root});
 site.hash = args.toString();
 return site.href;
}

async function getSharedPack() {
 const args = new URLSearchParams(location.hash.slice(1));
 const id = args.get('pack');
 if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(id)) return;
 const root = serviceOrigin(args.get('service') || ONLINE_CONFIG);
 const get = async token => {
  const {pack} = await service('/packs/' + encodeURIComponent(id), {root, token});
  if (state.session || state.learningSession) {
   teacherStatus('Finish your active session before importing the shared pack.');
   return;
  }
  previewPack(pack);
 };
 try { await get(''); }
 catch (error) {
  if (!ai.token || ai.root !== root) {
   status('This pack could not open publicly. Sign in with the class code or ask your teacher for the JSON file.');
   return;
  }
  throw error;
 }
}

function initTeacher() {
 $('open-teacher').onclick = () => {
  $('tools-dialog').close();
  if (!$('teacher-url').value) $('teacher-url').value = ONLINE_CONFIG;
  teacherStatus('Select the words you want to generate before opening these tools.');
  refreshTeacher();
  $('teacher-dialog').showModal();
 };
 $('teacher-close').onclick = () => $('teacher-dialog').close();
 $('teacher-connect').onsubmit = teacherAction(async event => {
  if (ai.token) return;
  const root = serviceOrigin($('teacher-url').value);
  const role = event.submitter?.id === 'class-login' ? 'class' : 'teacher';
  const field = $('teacher-secret'), password = field.value.trim();
  field.value = '';
  if (!password) throw Error('Enter a teacher secret or class access code.');
  const config = await service('/config', {root, token: ''});
  let previousToken;
  if (role === 'class') {
   const previous = await getStore().then(store => store.get(CLASS_RECOVERY)).catch(() => null);
   if (previous?.root === root) previousToken = previous.token;
  }
  const response = await service(role === 'teacher' ? '/admin/access' : '/access', {
   root, token: '', method: 'POST', body: role === 'teacher' ? {secret: password} : {code: password, previousToken}
  });
  ai = {...ai, root, role, token: response.token, config, job: null, listId: '', published: ''};
  teacherStatus('Signed in. ' + (config.generationEnabled ? '' : 'Generation is disabled on this service.'));
  refreshTeacher();
  if (role === 'class') await getStore().then(store => store.put(CLASS_RECOVERY, {root, token: response.token})).catch(() => teacherStatus('Signed in. This browser could not save private job recovery.'));
  const reference = JSON.parse(localStorage.getItem(GENERATION_KEY) || 'null');
  if (reference?.root === root && reference.role === role && /^[a-z0-9_-]+$/i.test(reference.id) &&
      state.lists.some(row => row.id === reference.listId)) {
   try {
    ai.listId = reference.listId;
    applyJob(await service('/jobs/' + encodeURIComponent(reference.id)));
    if (ai.job.status === 'ready' || ai.job.status === 'processing') runJob().catch(error => teacherStatus(error.message));
   } catch (error) { teacherStatus('Previous job could not be reopened. ' + error.message); }
  }
  const shared = new URLSearchParams(location.hash.slice(1));
  if (shared.has('pack') && serviceOrigin(shared.get('service') || ONLINE_CONFIG) === root) {
   try {
    const result = await service('/packs/' + encodeURIComponent(shared.get('pack')));
    $('teacher-dialog').close(); previewPack(result.pack);
   } catch (error) { teacherStatus(error.message); }
  }
 });
 $('teacher-logout').onclick = () => {
  if (ai.role === 'class') getStore().then(store => store.remove(CLASS_RECOVERY)).catch(() => {});
  ai = {root: ai.root, token: '', role: '', config: {}, job: null, listId: '', published: '', generation: ai.generation + 1};
  $('ai-context').value = ''; $('ai-qr-result').replaceChildren(); $('ai-qr-result').hidden = true;
  $('ai-class-status').replaceChildren(); $('ai-usage-result').textContent = '';
  teacherStatus('Signed out.'); refreshTeacher();
 };
 $('ai-generate').onclick = teacherAction(async () => {
  const list = selectedList();
  const words = ( $('ai-only-missing').checked ? selectedRecords().filter(row => !row.vocabulary) : selectedRecords()).map(row => row.word);
  if (!list || !words.length) throw Error('Selected words already have vocabulary. Clear “Generate only missing” to request new drafts.');
  $('ai-generate').disabled = true;
  try {
   ai.listId = list.id;
   applyJob(await service('/generate', {method: 'POST', body: {words, settings: aiSettings()}, requestId: newListId()}));
   await runJob();
  } finally { refreshTeacher(); }
 });
 for (const action of ['pause', 'resume', 'cancel']) $('ai-' + action).onclick = teacherAction(() => jobAction(action));
 $('ai-apply').onclick = teacherAction(async () => {
  const list = state.lists.find(row => row.id === ai.listId);
  if (!list) throw Error('The selected list was removed.');
  const lookup = new Map(ai.job.words.map(row => [wordKey(row.word), Vocabulary.validateRecord(row.word, row.vocabulary)]));
  const previous = await loadVocabulary(list);
  const records = previous.map(row => {
   const generated = lookup.get(wordKey(row.word));
   return generated && row.vocabulary?.status !== 'approved' ? {...row, vocabulary: generated} : row;
  });
  await saveVocabulary(list, records, {packVersion: (list.packVersion || 0) + 1});
  teacherStatus('Saved completed content. Review drafts in Vocabulary content. Existing approved records were kept.');
 });
 $('vocab-regenerate').onclick = teacherAction(async () => {
  if (ai.role !== 'teacher') { editorStatusText('Sign in to the generation service through Tools.'); return; }
  $('regenerate-dialog').showModal();
 });
 $('regenerate-close').onclick = () => $('regenerate-dialog').close();
 $('regenerate-submit').onclick = async () => {
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
   applyJob(await service('/regenerate', {method: 'POST', body: {word: previous.word, previous, item, questionId, settings: aiSettings()}, requestId: newListId()}));
   await runJob();
   const replacement = ai.job.words[0];
   if (!replacement) throw Error(ai.job.message || 'No replacement was generated. Existing content was kept.');
   await changeVocabulary(editorRecords.map(row => row.word === previous.word ? replacement : row), previous.word);
   $('regenerate-dialog').close(); editorStatusText('Replacement saved for review.');
  } catch (error) { $('regenerate-status').textContent = error.message; }
  finally { $('regenerate-submit').disabled = false; }
 };
 $('ai-publish').onclick = teacherAction(async () => {
  const list = selectedList();
  if (!list) throw Error('Choose a list before publishing.');
  const pack = outputPack(list, await loadVocabulary(list));
  if (!pack.words.some(row => row.vocabulary) || pack.words.some(row => row.vocabulary && row.vocabulary.status !== 'approved')) {
   throw Error('Review and approve each vocabulary entry before publishing.');
  }
  if (!confirm('Publish “' + pack.name + '” for anyone with the link?')) return;
  const {pack: published} = await service('/admin/publish', {method: 'POST',
   body: {pack, visibility: 'public', ...($('ai-publish-cache').checked ? {cacheSettings: {...aiSettings(), context: ''}} : {})}, requestId: newListId()});
  ai.published = publicPackLink(published.id);
  refreshTeacher();
  teacherStatus('Pack published. Copy the link or show the QR code.');
 });
 $('ai-share').onclick = teacherAction(async () => {
  teacherStatus(await copy(ai.published) ? 'Student link copied.' : ai.published);
 });
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
  ai.config = await service('/admin/settings', {method: 'PUT', body: {generationEnabled: !ai.config.generationEnabled}});
  refreshTeacher();
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
  const words = ai.job?.failedWords || [];
  if (!words.length) return;
  applyJob(await service('/generate', {method: 'POST', body: {words, settings: aiSettings()}, requestId: newListId()}));
  await runJob();
 });
 if (location.hash) getSharedPack().catch(error => status(error.message));
}
function packQRCode(value) {
 const qr = qrcode(0, 'M');
 qr.addData(value);
 qr.make();
 return qr.createDataURL(5, 20);
}
