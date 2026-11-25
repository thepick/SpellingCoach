const CLASS_RECOVERY = 'class-generation-recovery';
const GENERATION_KEY = 'spell.generation.v1';
const ONLINE_CONFIG = 'https://wordlab.mtomlinson.ca';
let ai = {root: '', token: '', role: '', config: {}, job: null, listId: '', published: '', generation: 0};
let sharing = {list:null, records:null};
let publishing = false;
let preparingAudio = false;
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
  localStorage.setItem(GENERATION_KEY, JSON.stringify({root: ai.root, id: ai.job.id, listId: ai.listId, role: ai.role}));
 } catch (error) {
  teacherStatus('The browser could not save the job reference. Keep this tab open.');
 }
}

function refreshTeacher() {
 const teacher = ai.role === 'teacher', signedIn = !!ai.token;
 if (entryPage === 'teacher') $('setup-word-selection-title').closest('.stack').hidden = !ai.config.generationEnabled;
 $('teacher-logout').hidden = !signedIn;
 $('teacher-url').disabled = signedIn;
 $('teacher-secret').disabled = signedIn;
 $('teacher-login').disabled = signedIn;
 $('class-login').disabled = signedIn;
 $('teacher-job').hidden = !signedIn;
 $('teacher-admin').hidden = !teacher;
 $('ai-context-wrap').hidden = !teacher;
 $('vocab-regenerate').disabled = !teacher || !editorRecords.find(row => row.word === $('vocab-word').value)?.vocabulary;
 updateTroyControls();
 $('teacher-selection').textContent = selectedWords().length + ' words selected from ' + (selectedList()?.name || 'no list');
 const active = ai.job && ['ready', 'processing', 'paused'].includes(ai.job.status);
 $('ai-generate').disabled = !signedIn || !selectedWords().length || active ||
  !(teacher ? ai.config.generationEnabled : ai.config.studentGenerationEnabled);
 $('ai-pause').disabled = !active || ai.job?.status === 'paused';
 $('ai-resume').disabled = !active;
 $('ai-cancel').disabled = !active;
 $('ai-apply').disabled = !ai.job?.words.length;
 $('ai-retry-words').disabled = active || !ai.job?.failedWords.length;
 renderSharing();
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
 const args = new URLSearchParams({pack: id, service: root});
 site.hash = args.toString();
 return site.href;
}

function updateTeacherSelection(list, records) {
 if (entryPage !== 'teacher') return;
 $('teacher-open-publishing').disabled = !list;
 const summary = records && SharedReview.sharingContent(records, 'mixed');
 $('setup-set-summary').textContent = !list ? '' : list.words.length + (list.words.length === 1 ? ' word' : ' words') +
  (summary ? ' · ' + summary.approved.length + ' with approved vocabulary · ' + summary.drafts.length + ' to review' : '');
}

function renderSharing() {
 const mode = $('shared-mode').value;
 const info = sharing.records && SharedReview.sharingContent(sharing.records, mode);
 const {approved, drafts, missing} = info || {approved:[], drafts:[], missing:[]};
 const shareReady = !!info?.ready && !publishing;
 const needsReview = !!info && mode !== 'spelling' && !info.ready;
 const hasLink = !!ai.published && ai.publishedListId === sharing.list?.id && ai.publishedMode === mode &&
  ai.publishedHints === $('shared-hints').checked;
 $('ai-publish-readiness').textContent = !sharing.list ? 'Create or select a set first.' :
  !info ? 'Checking which words are ready…' : mode === 'spelling' ?
   'Ready to share. Students will spell all ' + info.words.length + ' words.' : drafts.length ?
    'Review and approve the remaining vocabulary drafts before sharing.' : !approved.length ?
     'Add and approve vocabulary, or choose Spelling to share this word list.' : mode === 'mixed' ?
      'Ready to share. ' + approved.length + ' words include vocabulary' + (missing.length ? ' and ' + missing.length + ' are spelling only.' : '.') :
      'Ready to share. Students will practice ' + approved.length + ' words with approved vocabulary.';
 $('ai-publish-readiness').className = needsReview ? 'notice' : 'hint';
 $('ai-vocabulary-details').hidden = !info || mode === 'spelling';
 $('ai-vocabulary-words').textContent = [['Approved', approved], ['Needs review', drafts], ['No vocabulary', missing]]
  .filter(([, words]) => words.length).map(([label, words]) => label + ': ' + words.join(', ')).join('\n');
 $('ai-publish-review').hidden = !needsReview;
 $('ai-publish-review').textContent = drafts.length ? 'Review drafts' : 'Add vocabulary';
 $('ai-publish').disabled = !shareReady;
 $('ai-preview').disabled = entryPage === 'teacher' ? !shareReady : !hasLink;
 $('ai-link-actions').hidden = !hasLink;
 $('ai-student-link').value = hasLink ? ai.published : '';
 $('ai-share').disabled = !hasLink;
 $('ai-qr').disabled = !hasLink;
 $('ai-prepare-audio').hidden = !ai.config.dictationEnabled;
 $('ai-prepare-audio').disabled = preparingAudio || !hasLink;
 $('shared-mode').disabled = publishing;
 $('shared-hints').disabled = publishing || mode === 'spelling';
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
  view === 'admin' ? 'Generation and administration' : 'Online vocabulary tools';
 if (view !== 'share') teacherStatus(!ai.config.generationEnabled && view === 'admin' ?
  'Online generation is currently unavailable.' : 'Select the words you want to generate before opening these tools.');
 refreshTeacher();
 dialog.showModal();
 try {
  const rows = list ? await loadVocabulary(list) : null;
  if (sharing !== current) return;
  current.records = rows;
  if (changedSet && rows) $('shared-mode').value = rows.some(row => row.vocabulary) ? 'mixed' : 'spelling';
  renderSharing();
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
  $('setup-word-selection-title').textContent = 'Select words for generation';
  $('setup-word-selection-help').textContent = 'Generate content for selected words. Publishing shares the whole set.';
  renderSetup();
  show('setup-screen');
  $('setup-list-label').textContent = 'Practice set';
  $('new-list').textContent = 'Create a set';
  $('edit-list').textContent = 'Edit words';
  $('open-vocabulary').textContent = 'Edit content';
  $('open-teacher').textContent = 'Generation and administration';
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
 $('teacher-secret').focus();
}

function initTeacher() {
 $('open-teacher').onclick = () => showTeacherTools(entryPage === 'teacher' ? 'admin' : 'tools');
 $('teacher-open-publishing').onclick = () => showTeacherTools('share');
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
  if (!returnToSharing) return;
  const view = returnToSharing; returnToSharing = '';
  $('vocab-close').textContent = 'Close';
  $('ai-publish-status').textContent = '';
  showTeacherTools(view);
 });
 $('teacher-workspace-logout').onclick = () => $('teacher-logout').click();
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
  if (entryPage === 'teacher' && !shared.has('pack')) showTeacherEntry();
  else if (shared.has('pack') && serviceOrigin(shared.get('service') || ONLINE_CONFIG) === root) {
   $('teacher-dialog').close();
   await openSharedReview();
  }
 });
 $('teacher-logout').onclick = () => {
  if (ai.role === 'class') getStore().then(store => store.remove(CLASS_RECOVERY)).catch(() => {});
  ai = {root: ai.root, token: '', role: '', config: {}, job: null, listId: '', published: '', generation: ai.generation + 1};
  $('ai-context').value = ''; $('ai-qr-result').replaceChildren(); $('ai-qr-result').hidden = true;
  $('ai-class-status').replaceChildren(); $('ai-usage-result').textContent = '';
  teacherStatus('Signed out.'); refreshTeacher();
  if (entryPage === 'teacher') {
   $('teacher-dialog').close();
   showTeacherEntry();
  }
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
 $('ai-publish').onclick = async () => {
  const status = $('ai-publish-status');
  const mode = $('shared-mode').value, allowHints = $('shared-hints').checked;
  const reuse = $('ai-publish-cache').checked, {root, token} = ai;
  publishing = true; renderSharing();
  status.textContent = 'Publishing…';
  try {
   const list = selectedList();
   if (!list) throw Error('Create or select a set before publishing.');
   const records = await loadVocabulary(list);
   const info = SharedReview.sharingContent(records, mode);
   if (!info.ready) throw Error('Review the vocabulary before publishing, or choose Spelling.');
   const pack = outputPack(list, info.words);
   const cacheSettings = reuse && pack.words.some(row => row.vocabulary) ? {...aiSettings(), context: ''} : undefined;
   const {pack: published} = await service('/admin/publish', {root, token, method: 'POST',
    body: {pack, mode, allowHints, visibility: 'public', cacheSettings}, requestId: newListId()});
   if (ai.token !== token) return;
   if ((list.packVersion || 0) < published.version) { list.packVersion = published.version; save(); }
   ai.published = publicPackLink(published.id, root);
   ai.publishedListId = list.id;
   ai.publishedMode = mode;
   ai.publishedHints = allowHints;
   $('ai-qr-result').replaceChildren(); $('ai-qr-result').hidden = true;
   refreshTeacher();
   status.textContent = 'Published “' + published.name + '”. Preview or copy the student link.';
  } catch (error) {
   if (ai.token === token) status.textContent = error.status === 401 ? 'Your sign-in expired. Sign out, sign back in, and try again.' : error.message;
  } finally { publishing = false; renderSharing(); }
 };
 $('ai-share').onclick = teacherAction(async () => {
  $('ai-publish-status').textContent = await copy(ai.published) ? 'Student link copied.' : ai.published;
 });
 $('ai-prepare-audio').onclick = async () => {
  const {published, publishedMode, token, root} = ai;
  const status = $('ai-publish-status');
  preparingAudio = true; renderSharing();
  try {
   const id = new URLSearchParams(new URL(published).hash.slice(1)).get('pack');
   const {pack, audio} = await service('/packs/' + encodeURIComponent(id), {root, token});
   const saved = new Set(audio || []);
   const prompts = pack.words.flatMap((record, index) => Learning.practiceAudioPrompts(record, index))
    .filter(prompt => publishedMode === 'mixed' || prompt.skill === publishedMode);
   let ready = prompts.filter(prompt => saved.has(prompt.key)).length;
   for (const prompt of prompts) {
    if (ai.token !== token || ai.published !== published || ai.publishedMode !== publishedMode) return;
    if (saved.has(prompt.key)) continue;
    status.textContent = 'Preparing Troy audio. ' + ready + ' of ' + prompts.length + ' recordings ready.';
    await service('/admin/packaudio', {root, token, method:'POST', body:{packId:pack.id,version:pack.version,prompt:prompt.key}});
    ready++;
   }
   status.textContent = 'Troy audio is ready for this set.';
  } catch (error) {
   if (ai.token === token) status.textContent = error.message + ' Prepare Troy audio again to resume.';
  } finally { preparingAudio = false; renderSharing(); }
 };
 $('ai-preview').onclick = () => {
  try {
   let url;
   if (entryPage === 'teacher') {
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

}
function packQRCode(value) {
 const qr = qrcode(0, 'M');
 qr.addData(value);
 qr.make();
 return qr.createDataURL(5, 20);
}
