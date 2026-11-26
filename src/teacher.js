const CLASS_RECOVERY = 'class-generation-recovery';
const GENERATION_KEY = 'spell.generation.v1';
const ONLINE_CONFIG = document.body.dataset.entry !== 'offline' && ['localhost','127.0.0.1'].includes(location.hostname)
 ? location.origin : 'https://wordlab.mtomlinson.ca';
let ai = {root: '', token: '', role: '', config: {}, job: null, listId: '', published: '', generation: 0};
let sharing = {list:null, records:null};
let publishing = false;
let pendingGeneration = null;
let workspaceEdit = null;
let workspaceSaveTimer;
const workspaceHomes = new Map();
let audioStatusTimer;
let privateAudioTimer;
let restoringTeacherSets = false;
let teacherLoginRequest = 0;
const teacherSaves = new Map();
let teacherPresets = GenerationSettings.presets();
let preferencesIdentity = null;
let preferencesRequest = null;
let preferencesMutation = 0;
let pendingPresetSave = null;
let presetEditVersion = 0;
let hydratedGenerationList = null;
let hydratedGenerationText = '';
const generationFields = {readingLevel:'grade',practiceSentences:'sentences',exampleSentences:'examples',
 reuseApproved:'reuse',esl:'esl',distractors:'distractors',explanations:'explanations',dialect:'dialect',context:'context',sense:'sense'};

function writeGenerationForm(prefix,settings) {
 for (const [key,suffix] of Object.entries(generationFields)) {
  const input = $(prefix+'-'+(prefix==='ai'?suffix:key));
  if (!input) continue;
  if (typeof settings[key] === 'boolean') input.checked=settings[key]; else input.value=settings[key];
 }
}
function readGenerationForm(prefix,preset=false) {
 const value={};
 for (const [key,suffix] of Object.entries(generationFields)) {
  const input=$(prefix+'-'+(prefix==='ai'?suffix:key));
  value[key]=['reuseApproved','esl','distractors','explanations'].includes(key)?!!input?.checked:
   ['readingLevel','practiceSentences','exampleSentences'].includes(key)?Number(input?.value):input?.value || '';
 }
 if (preset) { value.context='';value.sense=''; }
 return GenerationSettings.validate(value,preset);
}
function presetForGrade(grade) {
 return GenerationSettings.validate(teacherPresets[grade],true) || GenerationSettings.defaults(grade);
}
function hydrateGenerationSettings(list) {
 const settings=GenerationSettings.validate(list?.generationSettings) || GenerationSettings.defaults();
 const text=JSON.stringify(settings);
 if (hydratedGenerationList===list && hydratedGenerationText===text) return;
 hydratedGenerationList=list; hydratedGenerationText=text;
 writeGenerationForm('ai',settings);
 validateGenerationForm();
}
function persistSetGenerationSettings(sync=false) {
 const list=selectedList();
 if (!validateGenerationForm()) return;
 const settings=readGenerationForm('ai');
 if (!list || !settings) return;
 if (JSON.stringify(list.generationSettings)!==JSON.stringify(settings)) {
  list.generationSettings=settings; list.packVersion=(list.packVersion || 1)+1; list.updatedAt=now();
  hydratedGenerationList=list; hydratedGenerationText=JSON.stringify(settings); save();
 }
 if (sync && ai.role==='teacher' && ai.token) autosaveTeacherSet(list).catch(error=>teacherStatus(error.message));
 renderSharing();
}
function validateGenerationForm(report=false) {
 for (const suffix of Object.values(generationFields)) $('ai-'+suffix)?.setCustomValidity?.('');
 let problem;
 for (const [suffix,min,max,label] of [['grade',1,12,'Reading grade'],['sentences',1,5,'Practice sentences'],['examples',1,2,'Examples']]) {
  const input=$('ai-'+suffix), value=Number(input?.value);
  if (!Number.isInteger(value) || value<min || value>max) { problem={input,message:label+' must be a whole number from '+min+' through '+max+'.'};break; }
 }
 if (!problem) for (const [suffix,max,label] of [['context',1000,'Textbook context'],['sense',160,'Intended meaning']]) {
  const input=$('ai-'+suffix), value=input?.value || '';
  if ([...value].length>max || /[<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value)) {
   problem={input,message:label+' must be plain text without angle brackets or control characters, up to '+max+' characters.'};break;
  }
 }
 if (!problem && !readGenerationForm('ai')) problem={input:$('ai-dialect'),message:'Choose a valid spelling dialect and generation settings.'};
 $('teacher-settings-status').textContent=problem?.message || '';
 if (problem) { problem.input?.setCustomValidity?.(problem.message);if(report)problem.input?.reportValidity?.(); }
 return !problem;
}
function preferenceOwner() { return {root:ai.root,token:ai.token,id:ai.teacher?.id,state}; }
function samePreferenceOwner(owner) { return owner.token===ai.token && owner.root===ai.root && owner.id===ai.teacher?.id && owner.state===state; }
async function loadTeacherPreferences() {
 const owner=preferenceOwner(), edit=presetEditVersion, mutation=preferencesMutation;
 if (!owner.token || !owner.id) return;
 if (preferencesIdentity && samePreferenceOwner(preferencesIdentity)) return;
 if (preferencesRequest && samePreferenceOwner(preferencesRequest.owner)) return preferencesRequest.promise;
 const request={owner};
 request.promise=(async()=>{
  const response=await service('/teacher/preferences',{root:owner.root,token:owner.token});
  if (!samePreferenceOwner(owner) || mutation!==preferencesMutation) return;
  const presets=GenerationSettings.presets();
  for (let grade=3;grade<=12;grade++) presets[grade]=GenerationSettings.validate(response.presets?.[grade],true) || presets[grade];
  teacherPresets=presets; preferencesIdentity=owner;
  if (edit===presetEditVersion) writeGenerationForm('preset',presetForGrade(Number($('preset-grade').value)||5));
 })();
 preferencesRequest=request;
 try { await request.promise; } finally { if (preferencesRequest===request) preferencesRequest=null; }
}
async function saveTeacherPreset() {
 if(pendingPresetSave && samePreferenceOwner(pendingPresetSave))return;
 const owner=preferenceOwner(), grade=Number($('preset-grade').value), edit=presetEditVersion;
 const settings=readGenerationForm('preset',true);
 if (!Number.isInteger(grade) || grade<3 || grade>12 || !settings) throw Error('Choose a grade from 3 through 12 and valid sentence counts.');
 pendingPresetSave=owner;
 ++preferencesMutation;
 $('preset-save').disabled=true;
 try {
  const response=await service('/teacher/preferences',{root:owner.root,token:owner.token,method:'PUT',body:{grade,settings}});
  if (!samePreferenceOwner(owner)) return;
  const saved=GenerationSettings.validate(response.presets?.[grade],true);
  if (!saved) throw Error('The saved grade defaults could not be read. Try loading them again.');
  ++preferencesMutation;
  teacherPresets[grade]=saved;
  if (edit===presetEditVersion && Number($('preset-grade').value)===grade) writeGenerationForm('preset',saved);
  $('preset-status').textContent='Grade '+grade+' defaults saved. Existing sets are unchanged.';
 } finally {
  if(pendingPresetSave===owner)pendingPresetSave=null;
  if(samePreferenceOwner(owner))$('preset-save').disabled=false;
 }
}

function renderTeacherView(view) {
 if(view==='tools' && ai.role==='teacher' && ai.token)view='setup';
 const workspace = view === 'workspace';
 const titles={settings:'Teacher settings',workspace:'Prepare & share',setup:'API keys',presets:'Grade defaults',prepare:'Prepare vocabulary',share:'Student link',administration:'Administration',tools:'Online teacher tools'};
 const list=selectedList();
 $('teacher-view-nav').hidden=entryPage!=='offline' || ai.role!=='teacher' || !ai.token;
 for (const name of ['setup','presets','prepare','share','administration']) {
  const button=$('teacher-nav-'+name);button.setAttribute?.('aria-pressed',String(name===view));
  button.disabled=['prepare','share'].includes(name) && !list;
  if(name==='administration')button.hidden=!ai.teacher?.isAdmin;
 }
 $('teacher-dialog').dataset.view=view;
 $('teacher-settings-menu').hidden=view!=='settings';
 $('teacher-settings-back').hidden=entryPage!=='teacher' || !ai.token || !['setup','presets','administration'].includes(view);
 $('settings-administration').hidden=!ai.teacher?.isAdmin;
 $('teacher-title').textContent=(titles[view] || titles.tools)+(['prepare','share'].includes(view)&&list?' · '+list.name:'');
 $('teacher-connect').hidden=!!ai.token;
 $('teacher-account').hidden=view!=='setup' || !ai.token;
 $('teacher-grade-defaults').hidden=view!=='presets' || !ai.token;
 $('teacher-private-audio').hidden=!(workspace || ['prepare','share'].includes(view)) || !ai.token || !list;
 $('teacher-job').hidden=!(workspace || ['prepare','tools'].includes(view)) || !ai.token;
 $('teacher-drafting-info').hidden=!(workspace || view==='prepare') || !ai.token || !!ai.config.generationEnabled;
 $('teacher-admin').hidden=!(workspace || view==='share') || ai.role!=='teacher';
 $('teacher-operations').hidden=view!=='administration' || ai.role!=='teacher' || !ai.teacher?.isAdmin;
 if(workspace)renderSetWorkspace();
}

function workspaceSavePending() {
 return !!workspaceEdit && workspaceEdit.list===sharing.list && (workspaceEdit.pending || !!workspaceEdit.error);
}
function currentStudentLink() {
 return !workspaceSavePending() && !!ai.published && ai.publishedListId===sharing.list?.id &&
  linkOptionsMatch({mode:ai.publishedMode,allowHints:ai.publishedHints,retypeOnMiss:ai.publishedRetype,allowVariants:ai.publishedVariants}) &&
  ai.publishedUpdatedAt===sharing.list?.updatedAt;
}
function mountSetWorkspace() {
 for(const [slot,section] of [['workspace-generation-slot','teacher-job'],['workspace-share-slot','teacher-admin'],
  ['workspace-audio-slot','teacher-private-audio'],['workspace-mode-slot','shared-mode-field']]) {
  if(!workspaceHomes.has(section))workspaceHomes.set(section,$(section).parentElement);
  $(slot).append($(section));
 }
}
function renderSetWorkspace() {
 if($('prepare-share-screen').hidden || !sharing.list) return;
 const list=sharing.list, rows=sharing.records || [], vocabulary=rows.filter(row=>row.vocabulary);
 const approved=vocabulary.filter(row=>row.vocabulary.status==='approved').length;
 const allApproved=rows.length===list.words.length && approved===rows.length;
 $('workspace-title').textContent='Prepare & share';
 $('workspace-set-name').textContent=list.name;
 $('workspace-words-summary').textContent='· '+list.words.length+' words';
 $('workspace-vocabulary-summary').textContent=allApproved ? 'All '+approved+' words approved' :
  approved+' approved · '+(vocabulary.length-approved)+' to review · '+(list.words.length-vocabulary.length)+' missing';
 const settings=GenerationSettings.validate(list.generationSettings) || GenerationSettings.defaults();
 $('workspace-settings-summary').textContent='Grade '+settings.readingLevel+' · '+settings.practiceSentences+
  ' practice '+(settings.practiceSentences===1?'sentence':'sentences')+' · '+settings.exampleSentences+
  (settings.exampleSentences===1?' example':' examples');
 $('teacher-draft-form').hidden=!ai.config.generationEnabled;
 $('workspace-vocabulary-settings').hidden=false;
 $('ai-context-wrap').hidden=allApproved;
 $('workspace-edit-vocabulary').textContent=allApproved?'Edit vocabulary':vocabulary.length?'Review vocabulary':'Add vocabulary by hand';
 $('workspace-edit-vocabulary').disabled=workspaceSavePending() || !sharing.records;
 $('ai-generate').hidden=rows.length===list.words.length && vocabulary.length===rows.length;
 $('ai-generate').disabled=!!pendingGeneration || !ai.config.generationEnabled || !list.words.length || workspaceSavePending() || ['ready','processing','paused'].includes(ai.job?.status);
 $('teacher-draft-intro').hidden=true;
 $('teacher-selection').hidden=true;
 $('ai-publish-review').hidden=true;
 $('ai-review-saved').hidden=true;
 const ownJob=ai.listId===list.id;
 const settled=ai.job?.status==='complete' && !ai.job.failedWords?.length;
 $('ai-progress').hidden=!ownJob || allApproved || settled;
 $('teacher-job-actions').hidden=!ownJob || !ai.job || allApproved || settled;
 $('ai-retry-words').disabled=!!pendingGeneration;
 const audio=list.audioStatus, clips=(audio?.recordings || []).filter(clip=>/-s$/.test(clip.key));
 const ready=clips.filter(clip=>clip.status==='ready').length;
 $('workspace-fix-keys').hidden=ready===list.words.length || !!ai.keys?.openrouter;
 $('audio-word-summary').textContent=ready===list.words.length ? 'Word audio ready · Paul' :
  audio?.pending ? 'Preparing word audio · '+ready+' of '+list.words.length+' ready' :
   'Word audio needs attention · '+ready+' of '+list.words.length+' ready';
 $('workspace-save-retry').hidden=!workspaceEdit?.error;
 if(workspaceEdit?.error)$('workspace-words-editor').open=true;
 $('workspace-refresh-link').hidden=sharing.linkLookup!=='error';
 $('ai-generate').textContent='Generate vocabulary and audio';
 $('ai-only-missing').checked=true;
 $('ai-only-missing').disabled=true;
 $('ai-share-audio').hidden=!ai.audioStatus || ai.audioStatus.ready===ai.audioStatus.total;
}
async function refreshSetWorkspace() {
 const list=sharing.list, owner=state, token=ai.token, stamp=list?.updatedAt;
 if(!list || $('prepare-share-screen').hidden) return;
 const records=await loadVocabulary(list);
 if(sharing.list!==list || state!==owner || ai.token!==token || list.updatedAt!==stamp) return;
 sharing.records=records;
 renderSharing();renderSetWorkspace();
}
function validateWorkspaceWords() {
 const name=$('workspace-name').value.trim();
 let words;
 try {
  if(!name || name.length>80)throw Error('Enter a set name of up to 80 characters.');
  words=Vocabulary.normalizeWords($('workspace-words').value.split(/\r?\n/).filter(word=>word.trim()));
  if(!words.length)throw Error('Add at least one word. Your last saved words are kept until this is valid.');
 } catch(error) {
  $('workspace-word-status').textContent=error.message;
  return null;
 }
 return {name,words};
}
async function flushWorkspaceWords() {
 clearTimeout(workspaceSaveTimer);
 const edit=workspaceEdit;
 if(!edit || state!==edit.owner || ai.token!==edit.token || sharing.list!==edit.list) return false;
 const values=validateWorkspaceWords();
 if(!values) {edit.pending=true;renderSharing();return false;}
 const list=edit.list, revision=edit.revision;
 edit.error='';edit.pending=true;
 const changed=list.name!==values.name || JSON.stringify(list.words)!==JSON.stringify(values.words);
 if(changed) {
  const before={...list}, selection=state.settings.selected[list.id];
  const selected=new Set(selection || list.words), oldWords=list.words;
  Object.assign(list,{...values,packVersion:(list.packVersion || 1)+1,updatedAt:now(),audioStatus:null});
  state.settings.selected[list.id]=values.words.filter(word=>selected.has(word)||!oldWords.includes(word));
  if(!save()) {
   Object.assign(list,before);state.settings.selected[list.id]=selection;
   edit.error='Browser storage could not save your changes. Export a backup or free storage, then retry.';
   edit.pending=false;$('workspace-word-status').textContent=edit.error;renderSharing();return false;
  }
 }
 $('workspace-word-status').textContent='Saving privately…';renderSharing();
 try {
  await autosaveTeacherSet(list);
  if(workspaceEdit!==edit || state!==edit.owner || ai.token!==edit.token || edit.revision!==revision) return false;
  edit.pending=false;
  $('workspace-word-status').textContent='Saved automatically. Changes stay private until you update the student link.';
  renderSetup();await refreshSetWorkspace();
 } catch(error) {
  if(workspaceEdit!==edit || state!==edit.owner || ai.token!==edit.token || edit.revision!==revision) return false;
  edit.pending=false;edit.error=error.message;
  $('workspace-word-status').textContent='Saved in this browser. '+error.message;
 }
 renderSharing();renderSetWorkspace();
 return !edit.error;
}
function initTeacherViewNavigation() {
 for (const view of ['setup','presets','prepare','share','administration']) $('teacher-nav-'+view).onclick=()=>showTeacherTools(view);
}
function sharedDraftCacheSettings(reuse) {
 if (!reuse || !ai.teacher?.isAdmin) return undefined;
 const settings=GenerationSettings.validate(selectedList()?.generationSettings) || GenerationSettings.defaults();
 return settings.context || settings.sense ? undefined : settings;
}

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
 const body = {allowPaidText:$('teacher-paid-text').checked};
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
 ai.keys = {...profile.keys};
 $('teacher-account-name').textContent = profile.teacher.name + ' · ' + profile.teacher.username;
 for (const provider of ['groq','openrouter']) {
  $('teacher-' + provider + '-status').textContent = profile.keys[provider] ? '— key saved' : '— no key saved';
  $('teacher-' + provider + '-key').value = '';
  $('teacher-delete-' + provider).checked = false;
 }
 $('teacher-paid-text').checked = profile.settings.allowPaidText;
 if (profile.message || profile.reconnect?.length) $('teacher-account-status').textContent = profile.message || 'Reenter your '+profile.reconnect.join(' and ')+' key to reconnect.';
 refreshTeacher();
}

function resetTeacherWorkspace() {
 clearTimeout(workspaceSaveTimer);workspaceEdit=null;pendingGeneration=null;
 teacherPresets=GenerationSettings.presets(); preferencesIdentity=null; preferencesRequest=null; preferencesMutation=0; pendingPresetSave=null;
 ++presetEditVersion; hydratedGenerationList=null; hydratedGenerationText='';
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
   if (list && list.packVersion === pack.version) {
    const settings=GenerationSettings.validate(saved.generationSettings);
    if(settings)list.generationSettings=settings;else delete list.generationSettings;
    list.remoteVersion = pack.version; list.audioStatus = saved.audioStatus; save();
   }
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
  try { saved = await service('/teacher/sets', {root,token,method:'POST',body:{pack,expectedVersion:list.remoteVersion || 0,
   ...(GenerationSettings.validate(list.generationSettings)?{generationSettings:GenerationSettings.validate(list.generationSettings)}:{})}}); }
  catch (error) {
   if (ai.token !== token || state !== owner) return;
   if (error.status === 409) { list.remoteConflict = true; save(); throw Error('This set changed in another tab or browser. Export your local changes, then reload saved sets before editing again.'); }
   throw error;
  }
  if (ai.token !== token || state !== owner) return;
  list.packId = saved.pack.id; list.remoteVersion = saved.pack.version; save();
  if (list.updatedAt !== stamp || (list.packVersion || 1)!==pack.version) return;
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
 $('teacher-retry-audio').hidden = !audio || !!audio.pending || audio.ready === audio.total;
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
 renderTeacherView($('teacher-dialog').dataset.view || 'setup');
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
 const invite = invitationToken();
 if (invite) $('teacher-login-kind').value = 'teacher';
 const owner = $('teacher-login-kind').value === 'owner' && !invite;
 $('teacher-login-kind').disabled = !!ai.token || !!invite;
 $('teacher-username-field').hidden = owner;
 $('teacher-username').required = !owner;
 $('teacher-username').disabled = owner || !!ai.token;
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
 const revision=list.updatedAt, vocabKey=list.vocabKey, version=list.packVersion;
 const previous = await loadVocabulary(list);
 if (ai.token !== token || ai.job !== job || !state.lists.includes(list)) return;
 if(list.updatedAt!==revision || list.vocabKey!==vocabKey || list.packVersion!==version)throw Error('Vocabulary changed while drafts were loading. Reopen this set to recover the completed drafts.');
 const records = previous.map(row=>lookup.has(wordKey(row.word)) && !row.vocabulary ?
  {...row,vocabulary:lookup.get(wordKey(row.word))} : row);
 if (JSON.stringify(records) === JSON.stringify(previous)) { ai.reviewDrafts = job.words.length; refreshTeacher(); return; }
 await saveVocabulary(list,records,{packVersion:(list.packVersion || 0)+1});
 if (ai.token !== token || ai.job !== job) return;
 ai.reviewDrafts = job.words.length;
 if (sharing.list === list) sharing.records = records;
 refreshTeacher(); teacherStatus($('prepare-share-screen').hidden ? 'Drafts saved. Full examples and blank-question recordings prepare automatically. Review and approve the vocabulary before sharing.' : '');
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
  $('teacher-account-status').textContent = 'Testing saved keys without generating speech or text…';
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
    $('teacher-keys-save').disabled = !ai.token;
   }
  }
 };
 $('teacher-reload-sets').onclick = async ()=>{
  try {
  if (!confirm('Reload server copies? Export a backup first if this browser has unsaved edits.')) return;
  $('tools-recovery-status').textContent='Loading saved server copies…';
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
    const restored = findPackList(pack.id); if (restored) {
     const settings=GenerationSettings.validate(saved.generationSettings);
     if(settings)restored.generationSettings=settings;else delete restored.generationSettings;
     restored.remoteVersion = pack.version; restored.remoteConflict = false; restored.audioStatus = saved.audioStatus; save();
    }
   }
  } finally { restoringTeacherSets = false; }
  renderSetup(); renderPrivateAudio(); watchPrivateAudio();
  $('tools-recovery-status').textContent = 'Saved server copies reloaded.';
  } catch(error) { $('tools-recovery-status').textContent=error.message; }
 };
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
 if(!$('prepare-share-screen').hidden)$('workspace-status').textContent=message;
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
  const toolsTitle = 'API keys';
  $('setup-word-selection-title').closest('.stack').hidden = true;
  $('open-teacher').textContent = toolsTitle;
 }
 $('teacher-logout').hidden = !signedIn;
 $('teacher-workspace-logout').hidden = !signedIn;
 $('teacher-url').disabled = signedIn;
 $('teacher-secret').disabled = signedIn;
 $('teacher-login').disabled = signedIn;
 $('teacher-keys-save').disabled = !signedIn;
 $('teacher-test-keys').disabled = !signedIn;
 $('preset-save').disabled = !signedIn || !!(pendingPresetSave && samePreferenceOwner(pendingPresetSave));
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
  ? 'AI drafting is paused. You can edit vocabulary by hand and still create student links.'
  : 'AI drafting is off. You can edit vocabulary by hand and still create student links.';
 $('teacher-write-vocabulary').disabled = !list;
 $('teacher-selection').textContent = !list ? 'Create a set to draft vocabulary.' : !selected
  ? 'Add words to the set to draft vocabulary.' : selected + (selected === 1 ? ' word in ' : ' words in ') + list.name + '. Drafts save automatically; review them before sharing.';
 const active = ai.job && ['ready', 'processing', 'paused'].includes(ai.job.status);
 $('ai-generate').disabled = !!pendingGeneration || !canDraft || !selected || active;
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
 renderTeacherView($('teacher-dialog').dataset.view || 'setup');
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
 if (!validateGenerationForm(true)) throw Error($('teacher-settings-status').textContent);
 const settings = GenerationSettings.validate(selectedList()?.generationSettings) || readGenerationForm('ai') || GenerationSettings.defaults();
 if (ai.role !== 'teacher') {settings.context='';settings.sense='';}
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
 hydrateGenerationSettings(list);
 if (sharing.list===list && records) {sharing.records=records;renderSharing();}
 if (entryPage !== 'teacher') return;
 $('teacher-open-publishing').disabled = !list;
 $('teacher-open-drafting').disabled = !list || ai.role !== 'teacher' || !ai.config.generationEnabled;
 renderPrivateAudio(); watchPrivateAudio();
 const summary = records && SharedReview.sharingContent(records, 'mixed');
 $('setup-set-summary').textContent = !list ? '' : list.words.length + (list.words.length === 1 ? ' word' : ' words') +
  (summary ? ' · ' + summary.approved.length + ' with approved vocabulary · ' + summary.drafts.length + ' to review' : '');
}

function linkPracticeOptions() {
 return {mode:$('shared-mode').value,allowHints:$('shared-hints').checked,
  retypeOnMiss:$('shared-retype').checked,allowVariants:$('shared-variants').checked};
}
function linkOptionsMatch(options) {
 const current=linkPracticeOptions();
 return Object.keys(current).every(key=>current[key]===options[key]);
}
function linkLookupProblem() {
 return sharing.linkLookup==='loading'?'Loading existing link settings…':sharing.linkLookup==='error'?
  'Could not load existing link settings. Retry loading the link before sharing.':'';
}

function renderSharing() {
 const mode = $('shared-mode').value;
 $('shared-practice-summary').textContent='· '+($('shared-hints').checked?'Hints on':'Hints off')+' · '+($('shared-retype').checked?'Corrections on':'Corrections off');
 const info = sharing.records && SharedReview.sharingContent(sharing.records, mode);
 const {approved, drafts, missing} = info || {approved:[], drafts:[], missing:[]};
 const clips = sharing.list?.audioStatus?.recordings || [];
 const required = clips.filter(clip=>mode !== 'spelling' || /-s$/.test(clip.key));
 const lookupProblem=linkLookupProblem();
 const audioReady = !ai.teacher ||
  required.length >= (sharing.list?.words.length || 0) && required.every(clip=>clip.status === 'ready');
 const shareReady = !!info?.ready && !publishing && !lookupProblem && audioReady && !sharing.list?.remoteConflict && !workspaceSavePending();
 const needsReview = !!info && mode !== 'spelling' && !info.ready;
 const existingLink=!!ai.published && ai.publishedListId===sharing.list?.id;
 const hasLink = !lookupProblem && currentStudentLink();
 const legacyRules=existingLink && (typeof ai.publishedRetype!=='boolean' || typeof ai.publishedVariants!=='boolean');
 $('ai-publish-readiness').textContent = sharing.list?.remoteConflict ? 'This set has a version conflict. Export a backup, then use Tools → Recover saved sets. Your published link is unchanged.' : workspaceSavePending() ? 'Finish saving valid words before preparing or sharing this set.' : lookupProblem || (!sharing.list ? 'Create or select a set first.' :
  !info ? 'Checking which words are ready…' : info.ready && !audioReady ?
   (!ai.config.dictationEnabled ? ai.keys?.openrouter ? 'Paul audio is unavailable. Check API keys and retry before creating this student link.' : 'Connect OpenRouter in API keys to prepare paid Paul recordings before creating this student link.' : 'Waiting for recordings. Open Recording details under Words to check progress or retry failed recordings.') : mode === 'spelling' ?
   'Ready to share. Students will spell all ' + info.words.length + ' words.' : drafts.length ?
    'Review and approve the remaining vocabulary drafts before sharing.' : !approved.length ?
     'Add and approve vocabulary, or choose Spelling to share this word list.' : mode === 'mixed' ?
      'Ready to share. All ' + info.words.length + (info.words.length === 1 ? ' word is' : ' words are') +
       ' included for spelling. ' + approved.length + (approved.length === 1 ? ' also has' : ' also have') + ' vocabulary.' +
       (missing.length ? ' Remaining words are spelling only.' : '') :
      'Ready to share. Students will practice ' + approved.length + (approved.length === 1 ? ' word' : ' words') + ' with approved vocabulary.');
 if(legacyRules && !lookupProblem)$('ai-publish-readiness').textContent+=' This older link still works. Update the student link to save the explicit student rules shown here.';
 $('ai-publish-readiness').className = needsReview ? 'notice' : 'hint';
 $('ai-vocabulary-details').hidden = !info || mode === 'spelling';
 $('ai-vocabulary-words').textContent = [['Approved', approved], ['Needs review', drafts], ['No vocabulary', missing]]
  .filter(([, words]) => words.length).map(([label, words]) => label + ': ' + words.join(', ')).join('\n');
 $('ai-publish-review').hidden = !needsReview;
 $('ai-publish-review').textContent = drafts.length ? 'Review drafts' : 'Add vocabulary';
 $('ai-publish-readiness').hidden = false;
 $('ai-share-help').hidden = hasLink;
 $('ai-publish').hidden = false;
 $('ai-publish').textContent=hasLink?'Copy student link':existingLink?'Update student link':'Create student link';
 $('ai-publish').disabled = hasLink ? publishing : !shareReady;
 $('ai-share').hidden=hasLink;
 $('workspace-unshared').hidden=!existingLink || hasLink;
 $('workspace-unshared').textContent='Changes not shared yet. Students still use the last published version.';
 const audioStatus = existingLink && ai.audioStatus;
 const pending = audioStatus?.pending;
 const incomplete = audioStatus && audioStatus.ready < audioStatus.total;
 const waitingForAudio = !!pending || !!incomplete && !!ai.config.dictationEnabled;
 if(hasLink)$('ai-publish').disabled=publishing || waitingForAudio;
 $('ai-preview').textContent=hasLink?'Preview shared set':'Preview draft (device voice)';
 $('ai-preview').disabled = workspaceSavePending() || !!lookupProblem || (entryPage === 'teacher' ? !info?.ready || publishing : !hasLink || !!pending);
 $('ai-link-actions').hidden = !existingLink;
 $('ai-publish-options').hidden = !ai.teacher?.isAdmin || !ai.config.draftingAvailable;
 const settings=GenerationSettings.validate(sharing.list?.generationSettings);
 const contextual=!!(settings?.context || settings?.sense);
 $('ai-publish-cache').disabled=contextual;
 if(contextual)$('ai-publish-cache').checked=false;
 $('ai-publish-cache-help').textContent=contextual ? 'This set’s context or intended meaning stays out of the shared drafting cache. You can still create its student link.' : 'Optionally contribute approved vocabulary for reuse in other sets.';
 $('ai-student-link').value = existingLink ? ai.published : '';
 $('ai-share').disabled = !existingLink || waitingForAudio;
 $('ai-qr').disabled = !existingLink || waitingForAudio;
 $('ai-share-audio').hidden = !ai.config.dictationEnabled;
 $('ai-prepare-audio').hidden = !incomplete || !!pending;
 $('ai-audio-status').textContent = !audioStatus ? '' : pending
  ? 'Preparing practice audio. ' + audioStatus.ready + ' of ' + audioStatus.total + ' recordings ready. You can close this tab.'
  : incomplete ? audioStatus.ready + ' of ' + audioStatus.total + ' recordings are ready. Retry to prepare the remaining recordings.'
  : 'Practice audio is ready.';
 $('shared-mode').disabled = publishing || !!lookupProblem;
 $('shared-hints').disabled = publishing || !!lookupProblem || mode === 'spelling';
 $('shared-retype').disabled=publishing || !!lookupProblem || mode==='vocabulary';
 if($('shared-retype-row'))$('shared-retype-row').hidden=mode==='vocabulary';
 $('shared-variants').disabled=publishing || !!lookupProblem || mode==='spelling';
 if($('shared-variants-row'))$('shared-variants-row').hidden=mode==='spelling';
 $('shared-hints-row').hidden = mode === 'spelling';
 renderSetWorkspace();
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
 if(view==='admin')view='prepare';
 if(view==='workspace' && (!selectedList() || ai.role!=='teacher' || !ai.token))return;
 if(ai.role!=='teacher')for(const [section,home] of workspaceHomes)home?.append($(section));
 if(view==='tools' && ai.role==='teacher')view='setup';
 $('tools-dialog').close();
 if (!$('teacher-url').value) $('teacher-url').value = ONLINE_CONFIG;
 const list = selectedList(), changedSet = sharing.list !== list;
 const current = {list, records:null,linkOptionsInitialized:!changedSet && sharing.linkOptionsInitialized,
  linkLoaded:!changedSet && sharing.linkLoaded,linkOptionsTouched:!changedSet && sharing.linkOptionsTouched,
  linkLookup:!changedSet && sharing.linkLookup};
 if(['share','workspace'].includes(view) && !current.linkLoaded && list && ai.token)current.linkLookup='loading';
 sharing = current;
 if (changedSet) {
  $('ai-publish-status').textContent = '';
  $('ai-qr-result').replaceChildren(); $('ai-qr-result').hidden = true;
 }
 if(['share','workspace'].includes(view) && !current.linkOptionsInitialized) {
  $('shared-hints').checked=true;
  $('shared-retype').checked=state.settings.retypeOnMiss!==false;
  $('shared-variants').checked=state.settings.allowVariants===true;
  current.linkOptionsInitialized=true;
 }
 const dialog = $('teacher-dialog');
 dialog.dataset.view = view;
 dialog.querySelector('#teacher-operations').open = view==='administration';
 if (!['share','workspace'].includes(view)) teacherStatus('');
 refreshTeacher();
 if(view==='workspace') {
  dialog.close();mountSetWorkspace();show('prepare-share-screen');
  if(!workspaceEdit || workspaceEdit.list!==list || workspaceEdit.owner!==state || workspaceEdit.token!==ai.token) {
   workspaceEdit={list,owner:state,token:ai.token,revision:0,pending:false,error:''};
   $('workspace-name').value=list.name;$('workspace-words').value=list.words.join('\n');
   $('workspace-word-status').textContent='Settings and words save automatically.';
   $('workspace-review').hidden=true;
  }
  $('workspace-title').focus();
 } else dialog.showModal();
 if(view==='presets') {
  writeGenerationForm('preset',presetForGrade(Number($('preset-grade').value)||5));
  try { await loadTeacherPreferences(); } catch(error) { if(sharing===current)$('preset-status').textContent='Could not load saved defaults. Built-in defaults are available. '+error.message; }
 }
 try {
  if(view==='workspace' && ai.listId===list?.id && ai.job?.status==='complete' && ai.reviewDrafts!==ai.job.words.length)
   await applyTeacherDrafts();
  const rows = list ? await loadVocabulary(list) : null;
  if (sharing !== current) return;
  current.records = rows;
  if (changedSet && rows) $('shared-mode').value = rows.some(row => row.vocabulary) ? 'mixed' : 'spelling';
  renderSharing();
  if(view==='workspace') {renderTeacherView('workspace');$('workspace-vocabulary').open=$('shared-mode').value!=='spelling';}
  if (['share','workspace'].includes(view) && !current.linkLoaded && rows && ai.token) {
   const {token, root} = ai;
   const options=linkPracticeOptions(), generation=ai.linkGeneration || 0;
   const id = Dictation.canonicalPackId(list.packId) || list.id;
   let saved;
   try { saved=await service('/packs/' + encodeURIComponent(id), {root, token}); }
   catch(error) {
    if(sharing!==current || ai.token!==token || !(dialog.open || !$('prepare-share-screen').hidden))return;
    current.linkLookup=error.status===404?'missing':'error';
    current.linkLoaded=error.status===404;renderSharing();return;
   }
   if (sharing !== current || ai.token !== token || !(dialog.open || !$('prepare-share-screen').hidden)) return;
   if((ai.linkGeneration || 0)!==generation || publishing) {current.linkLookup='error';renderSharing();return;}
   if(saved?.visibility!=='public') {current.linkLookup='missing';current.linkLoaded=true;renderSharing();return;}
   const {pack, practice, audioStatus} = saved;
   const remote=Vocabulary.validatePack(pack);
   if(remote.id!==id)throw Error('The service returned another set’s student link.');
   const local = outputPack(list, SharedReview.sharingContent(rows, practice.mode).words);
   if(!current.linkOptionsTouched && linkOptionsMatch(options)) {
    $('shared-mode').value = practice.mode;
    $('shared-hints').checked = practice.allowHints;
    if(typeof practice.retypeOnMiss==='boolean')$('shared-retype').checked=practice.retypeOnMiss;
    if(typeof practice.allowVariants==='boolean')$('shared-variants').checked=practice.allowVariants;
   }
   current.linkLoaded=true;current.linkLookup='ready';
   Object.assign(ai, {published:publicPackLink(id, root), publishedListId:list.id, publishedMode:practice.mode,
    publishedHints:practice.allowHints,publishedRetype:practice.retypeOnMiss,publishedVariants:practice.allowVariants,
    publishedUpdatedAt:JSON.stringify(local)===JSON.stringify(remote)?list.updatedAt:null, audioStatus});
   renderSharing();
   if(view==='workspace')$('workspace-vocabulary').open=$('shared-mode').value!=='spelling';
   watchPracticeAudio();
  }
 } catch (error) { if(sharing===current){current.linkLookup='error';renderSharing();} }
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
  $('setup-word-selection-help').textContent = 'Prepare vocabulary for the set, review its drafts, then create a student link. Spelling links include every word.';
  renderSetup();
  show('setup-screen');
  $('setup-list-label').textContent = 'Practice set';
  $('new-list').textContent = 'Create a set';
  $('edit-list').textContent = 'Edit words';
  $('delete-list').textContent = 'Delete private set';
  $('open-vocabulary').textContent = 'Edit vocabulary';
  $('open-vocabulary').hidden = true;
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
 initTeacherViewNavigation();
 $('workspace-teacher-settings').onclick=()=>showTeacherTools('settings');
 $('tools-open-presets').onclick=()=>showTeacherTools('presets');
 $('workspace-fix-keys').onclick=()=>showTeacherTools('setup');
 $('teacher-settings-back').onclick=()=>showTeacherTools('settings');
 for(const [id,view] of [['settings-connections','setup'],['settings-presets','presets'],['settings-administration','administration']])
  $(id).onclick=teacherAction(async()=>{await showTeacherTools(view);if(view==='administration')await refreshTeacherAccounts();});
 $('teacher-dialog').addEventListener('close',()=>{
  if(!$('prepare-share-screen').hidden && ai.token && $('teacher-dialog').dataset.view!=='workspace') {
   if(sharing.linkLookup==='loading' && !sharing.linkLoaded)showTeacherTools('workspace');
   else renderTeacherView('workspace');
  }
 });
 for(const id of ['workspace-name','workspace-words']) $(id).oninput=()=>{
  if(!workspaceEdit)return;
  workspaceEdit.revision++;workspaceEdit.pending=true;workspaceEdit.error='';
  $('ai-publish-status').textContent='';$('ai-qr-result').hidden=true;
  clearTimeout(workspaceSaveTimer);
  const valid=validateWorkspaceWords();
  if(valid){$('workspace-word-status').textContent='Saving changes…';workspaceSaveTimer=setTimeout(flushWorkspaceWords,500);}
  renderSharing();
 };
 $('workspace-save-retry').onclick=flushWorkspaceWords;
 $('workspace-refresh-link').onclick=()=>showTeacherTools('workspace');
 $('workspace-back').onclick=async()=>{
  if(workspaceEdit?.pending && !await flushWorkspaceWords())return;
  if(typeof canLeaveVocabularyEditor==='function' && !canLeaveVocabularyEditor())return;
  if(typeof closeVocabularyEditor==='function')await closeVocabularyEditor(true);
  clearTimeout(workspaceSaveTimer);
  workspaceEdit=null;
  renderSetup();show('setup-screen');$('teacher-open-publishing').focus();
 };
 $('workspace-edit-vocabulary').onclick=teacherAction(async()=>{
  if(workspaceSavePending())return;
  $('workspace-vocabulary').open=true;
  const filter=sharing.records?.some(row=>row.vocabulary && row.vocabulary.status!=='approved')?'draft':'';
  await openVocabularyEditor(filter,true);
 });
 $('teacher-open-drafting').onclick = ()=>showTeacherTools('workspace');
 $('teacher-open-connections').onclick = ()=>showTeacherTools('setup');
 $('teacher-open-presets').onclick = ()=>showTeacherTools('presets');
 $('teacher-open-invitations').onclick = teacherAction(async ()=>{await showTeacherTools('administration');await refreshTeacherAccounts();});
 $('open-teacher').onclick = () => showTeacherTools(ai.role==='teacher'?'setup':'tools');
 $('preset-grade').onchange=()=>{++presetEditVersion;writeGenerationForm('preset',presetForGrade(Number($('preset-grade').value)));$('preset-status').textContent='';};
 $('preset-form').oninput=()=>{++presetEditVersion;};
 $('preset-form').onsubmit=teacherAction(saveTeacherPreset);
 for(const suffix of Object.values(generationFields)) {
  const input=$('ai-'+suffix); if(!input)continue;
  input.addEventListener('input',()=>persistSetGenerationSettings(false));
  input.addEventListener('change',()=>persistSetGenerationSettings(true));
 }
 $('teacher-open-publishing').onclick = () => showTeacherTools('workspace');
 $('teacher-write-vocabulary').onclick = () => {
  if(!$('prepare-share-screen').hidden){$('workspace-edit-vocabulary').click();return;}
  $('teacher-dialog').close();
  openVocabularyEditor();
 };
 $('ai-review-saved').onclick = async () => {
  const list = state.lists.find(row => row.id === ai.listId);
  if (!list) { teacherStatus('This set was deleted.'); return; }
  if(!$('prepare-share-screen').hidden && sharing.list===list){await openVocabularyEditor('draft',true);return;}
  $('teacher-dialog').close();
  listId = list.id;
  renderSetup();
  await openVocabularyEditor('draft');
 };
 for (const id of ['shared-mode', 'shared-hints','shared-retype','shared-variants']) $(id).onchange = () => {
  sharing.linkOptionsTouched=true;
  if(id==='shared-mode')$('workspace-vocabulary').open=$('shared-mode').value!=='spelling';
  $('ai-publish-status').textContent = '';
  $('ai-qr-result').hidden = true;
  renderSharing();
 };
 let returnToSharing = '';
 $('ai-publish-review').onclick = async () => {
  const dialog = $('teacher-dialog');
  const info = SharedReview.sharingContent(sharing.records, $('shared-mode').value);
  if(!$('prepare-share-screen').hidden){$('workspace-vocabulary').open=true;await openVocabularyEditor(info.drafts.length?'draft':'missing',true);return;}
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
    try { await loadTeacherPreferences(); } catch(error) { if(ai.token===response.token)teacherStatus('Saved grade defaults could not load. Built-in defaults are available.'); }
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
  if (invite) { await showTeacherTools('setup'); teacherStatus('Account created. Add Groq for vocabulary text and OpenRouter for paid Paul recordings.'); $('teacher-groq-key').focus(); }
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
  $('teacher-login-kind').value = invitationToken() ? 'teacher' : 'owner';
  teacherStatus('Signed out.'); refreshTeacher();
  if (entryPage === 'teacher') showTeacherEntry();
  else { state = loadState(); listId = state.lists[0]?.id || ''; renderSetup(); }
 };
 $('ai-generate').onclick = teacherAction(async () => {
  if(pendingGeneration || ['ready','processing','paused'].includes(ai.job?.status))return;
  if(workspaceSavePending())throw Error('Finish saving valid words before generating vocabulary.');
  const {root,token} = ai, owner = state;
  const list = selectedList();
  if(!list)return;
  const request={list,stamp:list.updatedAt,version:list.packVersion,settings:aiSettings()};
  pendingGeneration=request;$('ai-generate').disabled=true;
  try {
   const records = ai.role === 'teacher' ? await loadVocabulary(list) : selectedRecords();
   if(ai.token!==token || state!==owner || selectedList()!==list || list.updatedAt!==request.stamp || list.packVersion!==request.version || workspaceSavePending())return;
   const words=(ai.role==='teacher' || $('ai-only-missing').checked ? records.filter(row=>!row.vocabulary) : records).map(row=>row.word);
   if(!words.length)throw Error('Every word already has vocabulary. Review the drafts, or edit an individual item to replace it.');
   ai.listId = list.id;
   ai.autoApply = true; ai.recoveringJob = false;
   const job = await service('/generate', {root,token,method: 'POST', body: {words, settings: request.settings}, requestId: newListId()});
   if (ai.token !== token || state !== owner || !owner.lists.includes(list)) return;
   ai.listId=list.id;
   applyJob(job);
   await runJob();
  } finally { if(pendingGeneration===request)pendingGeneration=null;if(ai.token===token && state===owner)refreshTeacher(); }
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
  const lookupProblem=linkLookupProblem();
  if(currentStudentLink()) {await $('ai-share').onclick();return;}
  if(workspaceSavePending()) {status.textContent='Finish saving valid words before sharing.';return;}
  if(publishing || lookupProblem) {if(lookupProblem)status.textContent=lookupProblem;return;}
  const generation=(ai.linkGeneration || 0)+1;ai.linkGeneration=generation;
  const options=linkPracticeOptions(), {mode,allowHints,retypeOnMiss,allowVariants}=options;
  const reuse = $('ai-publish-cache').checked, {root, token} = ai, owner=state;
  publishing = true; renderSharing();
  status.textContent = 'Creating student link…';
  try {
   const list = selectedList();
   if (!list) throw Error('Create or select a set before creating a student link.');
   const stamp = list.updatedAt;
   const records = await loadVocabulary(list);
   await autosaveTeacherSet(list);
   if (list.updatedAt !== stamp || ai.token !== token || state!==owner || selectedList()!==list) throw Error('The set changed while preparing the link. Try again with the current version.');
   if(!linkOptionsMatch(options))throw Error('Student rules changed while preparing the link. Try again with the current choices.');
   const info = SharedReview.sharingContent(records, mode);
   if (!info.ready) throw Error('Review the vocabulary before creating a student link, or choose Spelling.');
   const pack = outputPack(list, info.words);
   const cacheSettings = pack.words.some(row => row.vocabulary) ? sharedDraftCacheSettings(reuse) : undefined;
   const {pack: published, audioStatus} = await service('/admin/publish', {root, token, method: 'POST',
    body: {pack, mode, allowHints,retypeOnMiss,allowVariants, visibility: 'public', cacheSettings}, requestId: newListId()});
   if (ai.token !== token || ai.linkGeneration!==generation || state!==owner || selectedList()!==list) return;
   if (list.updatedAt !== stamp) throw Error('The set changed while creating the link. Create it again for the current version.');
   if(!linkOptionsMatch(options))throw Error('Student rules changed while creating the link. Update the link again with the current choices.');
   if ((list.packVersion || 0) < published.version) { list.packVersion = published.version; save(); }
   ai.published = publicPackLink(published.id, root);
   ai.publishedListId = list.id;
   ai.publishedMode = mode;
   ai.publishedHints = allowHints;
   ai.publishedRetype=retypeOnMiss;
   ai.publishedVariants=allowVariants;
   ai.publishedUpdatedAt = list.updatedAt;
   ai.audioStatus = audioStatus;
   $('ai-qr-result').replaceChildren(); $('ai-qr-result').hidden = true;
   refreshTeacher();
   const copied=await copy(ai.published).catch(()=>false);
   if(ai.token===token && state===owner && selectedList()===list)status.textContent=copied?'Student link created and copied.':'Student link ready. Use Copy student link below.';
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
  if(workspaceSavePending() || linkLookupProblem())return;
  try {
   let url;
   if (entryPage === 'teacher' && !currentStudentLink()) {
    const mode = $('shared-mode').value;
    const {ready, words} = SharedReview.sharingContent(sharing.records, mode);
    if (!ready) return;
    const pack = outputPack(sharing.list, words), ticket = newListId();
    url = new URL(publicPackLink(pack.id, ai.root));
    const args = new URLSearchParams(url.hash.slice(1));
    args.set('draft', ticket); url.hash = args.toString();
    const practice = linkPracticeOptions();
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
  image.alt = 'QR code for the student link';
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
  if(pendingGeneration)return;
  const {root,token} = ai, owner = state;
  const list=selectedList();
  if(!list || ai.listId!==list.id || workspaceSavePending())return;
  const request={list,stamp:list.updatedAt,version:list.packVersion,settings:aiSettings()};pendingGeneration=request;
  try {
   const rows=await loadVocabulary(list);
   if(ai.token!==token || state!==owner || selectedList()!==list || list.updatedAt!==request.stamp || list.packVersion!==request.version || workspaceSavePending())return;
   const failed=new Set(ai.job?.failedWords || []);
   const words=rows.filter(row=>failed.has(row.word) && !row.vocabulary).map(row=>row.word);
   if (!words.length) return;
   ai.autoApply = true; ai.recoveringJob = false;
   const job = await service('/generate', {root,token,method: 'POST', body: {words, settings: request.settings}, requestId: newListId()});
   if (ai.token !== token || state !== owner || !owner.lists.includes(list)) return;
   ai.listId=list.id;applyJob(job);await runJob();
  } finally {if(pendingGeneration===request)pendingGeneration=null;if(ai.token===token && state===owner)refreshTeacher();}
 });

}
function packQRCode(value) {
 const qr = qrcode(0, 'M');
 qr.addData(value);
 qr.make();
 return qr.createDataURL(5, 20);
}
