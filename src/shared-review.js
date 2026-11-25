const SharedReview = (() => {
 const instructions = {
  spelling: 'Listen and type the word you hear.',
  vocabulary: 'Read each question and choose or type your answer.',
  mixed: 'Listen, spell, and answer questions about the words.'
 };

 function reviewMode(assigned, words) {
  if (assigned === 'spelling' || !words.some(row => row.vocabulary?.definition)) return 'spelling';
  return assigned === 'vocabulary' ? 'vocabulary' : 'mixed';
 }

 function matchingPractice(saved, id, mode) {
  if (!id) return null;
  if ((!mode || mode === 'spelling') && saved.session?.listId === id && saved.session.phase !== 'done') return 'spelling';
  const entry = saved.learningSession;
  return entry?.listId === id && (!mode || mode === entry.session.mode) && entry.session.type === 'practice' && entry.session.status === 'active'
   ? 'learning' : null;
 }

 function sharingContent(records, mode) {
  const approved = [], drafts = [], missing = [];
  for (const row of records) {
   (row.vocabulary?.status === 'approved' ? approved : row.vocabulary ? drafts : missing).push(row.word);
  }
  const words = mode === 'spelling' ? records.map(row => row.vocabulary?.status === 'approved' ? row : {...row, vocabulary:null}) : records;
  return {approved, drafts, missing, words, ready:words.length > 0 && (mode === 'spelling' || !drafts.length && approved.length > 0)};
 }

 return {instructions, reviewMode, matchingPractice, sharingContent};
})();
if (typeof module === 'object' && module.exports) module.exports = SharedReview;

let sharedReview = null;
const LOCAL_PREVIEW_KEY = 'wordlab.local-preview';
// Saved RANDOM.ORG permutations for the published Changes in Matter demo.
const matterBankOrder = {solid:[1,3,0,2], liquid:[1,3,2,0], gas:[1,3,0,2], melt:[3,1,2,0]};
let sharedLoad = 0;
const parkedKey = (id, type) => 'paused-activity:' + JSON.stringify([id, type]);

function findPackList(id, origin) {
 const lists = state.lists.filter(list => Dictation.canonicalPackId(list.packId) === Dictation.canonicalPackId(id));
 return (origin && lists.find(list => list.sharedOrigin === origin)) ||
  lists.find(list => !list.sharedOrigin) || (!origin ? lists[0] : undefined);
}

async function parkedActivity(id, type = 'practice') {
 if (!id) return null;
 const saved = await getStore().then(store => store.get(parkedKey(id, type))).catch(() => null);
 if (saved?.session?.listId === id && sessionOK(saved.session)) return saved;
 const entry = saved?.learningSession;
 return entry?.listId === id && Learning.sessionOK(entry.session) ? saved : null;
}

async function parkCurrentActivity() {
 const previous = {session:state.session, learningSession:state.learningSession, learningCheckpoint:state.learningCheckpoint};
 const legacy = previous.session && previous.session.phase !== 'done' ? previous.session : null;
 const learning = previous.learningSession && previous.learningSession.session.status !== 'finished' ? previous.learningSession : null;
 const id = (legacy || learning)?.listId;
 if (id) await (await getStore()).put(parkedKey(id, learning?.session.type || 'practice'), {session:legacy, learningSession:learning});
 if (!previous.session && !previous.learningSession && !previous.learningCheckpoint) return;
 if (previous.learningCheckpoint && !previous.learningSession) throw Error('Reload to restore your saved activity first.');
 state.session = null;
 state.learningSession = null;
 if (!save()) {
  Object.assign(state, previous);
  throw Error('WordLab could not save your current activity.');
 }
 const checkpoint = previous.learningCheckpoint;
 if (checkpoint) await getStore(checkpoint.backend).then(store => store.remove(checkpoint.key)).catch(() => {});
}

async function resumeParkedActivity(list, activity) {
 state.session = activity.session || null;
 state.learningSession = activity.learningSession || null;
 listId = list.id;
 if (!save()) {
  state.session = null; state.learningSession = null;
  throw Error('WordLab could not restore this activity.');
 }
 await checkpointChain;
 if (storageOK) await getStore().then(store => store.remove(parkedKey(list.id, activity.learningSession?.session.type || 'practice'))).catch(() => {});
 resumeActivity();
}

function clearParkedActivity(id) {
 getStore().then(store => Promise.all(['practice', 'test'].map(type => store.remove(parkedKey(id, type))))).catch(() => {});
}

async function renderSharedReady() {
 const review = sharedReview;
 if (!review) return;
 const workspace = state, session = state.session, learning = state.learningSession;
 const phase = session?.phase, status = learning?.session.status;
 let playback = dictationRequest;
 const current = () => sharedReview === review && state === workspace && state.session === session && state.learningSession === learning &&
  session?.phase === phase && learning?.session.status === status && dictationRequest === playback;
 if (review.audioStatus?.pending) {
  $('shared-title').textContent = review.pack.name;
  $('shared-instruction').textContent = 'Practice audio is being prepared. This page will update when it is ready.';
  $('shared-start').hidden = true;
  $('shared-study').hidden = true;
  show('shared-ready');
  playback = dictationRequest;
  setTimeout(async () => {
   if (!current()) return;
   try {
    const {audio, audioStatus} = await service('/packs/' + encodeURIComponent(review.pack.id), {root:review.origin});
    if (!current()) return;
    review.audio = new Set(audio);
    review.audioStatus = audioStatus;
   } catch {}
   if (current()) renderSharedReady();
  }, 5000);
  return;
 }
 const list = findPackList(review.pack.id, review.origin);
 const completed = state.learningSession;
 if (list && completed?.listId === list.id && completed.session.mode === review.mode && Learning.practiceMastered(completed.session)) {
  finishLearningReport();
  return;
 }
 const saved = list && (SharedReview.matchingPractice(state, list.id, review.mode) ? state : await parkedActivity(list.id));
 if (!current()) return;
 const mode = SharedReview.matchingPractice(saved || {}, list?.id, review.mode);
 const instruction = mode === 'learning' ? saved.learningSession.session.mode :
  mode === 'spelling' ? 'spelling' : review.mode;
 $('shared-title').textContent = review.pack.name;
 $('shared-instruction').textContent = SharedReview.instructions[instruction];
 $('shared-ready-status').textContent = '';
 $('shared-start').textContent = mode ? 'Continue practice' : 'Start practice';
 $('shared-start').disabled = false;
 $('shared-start').hidden = false;
 $('shared-study').hidden = review.mode === 'spelling' || !review.pack.words.some(row=>row.vocabulary?.status === 'approved');
 show('shared-ready');
}

async function startSharedReview() {
 const review = sharedReview, button = $('shared-start');
 if (!review || button.disabled) return;
 button.disabled = true;
 $('shared-ready-status').textContent = '';
 try {
  const oldList = findPackList(review.pack.id, review.origin);
  const activeMode = SharedReview.matchingPractice(state, oldList?.id, review.mode);
  if (activeMode) {
   if (activeMode === 'learning') state.learningSession.session.settings.allowHints = review.allowHints;
   listId = oldList.id;
   resumeActivity();
   return;
  }
  const parked = await parkedActivity(oldList?.id);
  await parkCurrentActivity();
  const parkedMode = SharedReview.matchingPractice(parked || {}, oldList?.id, review.mode);
  if (parkedMode) {
   if (parkedMode === 'learning') parked.learningSession.session.settings.allowHints = review.allowHints;
   await resumeParkedActivity(oldList, parked);
   return;
  }
  await importPack(review.pack, review.origin);
  const list = selectedList();
  const records = await loadVocabulary(list);
  if (sharedReview !== review) return;
  if (review.mode === 'spelling') await start(records.map(row => row.word), list);
  else beginLearning(list, records, {...coachOptions(), mode:review.mode, type:'practice', allowHints:review.allowHints,
   bankOrder:review.pack.id === Dictation.demoPackId && review.pack.version === 1 ? matterBankOrder : undefined,
   difficulty:'adaptive', audioReplay:true, masteryPractice:true});
 } catch (error) { $('shared-ready-status').textContent = error.message; }
 finally { button.disabled = false; }
}

async function openSharedReview() {
 const args = new URLSearchParams(location.hash.slice(1));
 if (!args.has('pack')) {
  $('local-preview-notice').hidden = true;
  $('shared-study').hidden = true;
  sharedReview = null;
  sharedLoad++;
  showLanding();
  return;
 }
 const load = ++sharedLoad;
 sharedReview = null;
 $('shared-title').textContent = 'Opening your practice';
 $('shared-instruction').textContent = '';
 $('shared-ready-status').textContent = '';
 $('shared-start').hidden = true;
 $('shared-study').hidden = true;
 show('shared-ready');
 const oldId = args.get('pack');
 const id = Dictation.canonicalPackId(oldId);
 if (oldId !== id) {
  args.set('pack', id);
  history.replaceState(history.state, '', location.pathname + location.search + '#' + args);
 }
 const previewTicket = studentPreview ? args.get('draft') : null;
 $('local-preview-notice').hidden = !previewTicket;
 try {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(id)) throw Error('Invalid pack link.');
  if (state.learningCheckpoint && !state.learningSession) await recoverCheckpoint(false);
  const origin = previewTicket ? location.origin : serviceOrigin(entryPage === 'offline' ? args.get('service') || ONLINE_CONFIG : ONLINE_CONFIG);
  let pack, practice, audio, audioStatus, preparedAudio = false;
  if (previewTicket) {
   const local = JSON.parse(localStorage.getItem(LOCAL_PREVIEW_KEY) || 'null');
   if (local?.ticket !== previewTicket || local.expiresAt < Date.now()) throw Error('Preview expired.');
   localStorage.removeItem(LOCAL_PREVIEW_KEY);
   pack = Vocabulary.validatePack(local.pack);
   practice = local.practice;
  } else {
   const token = ai.root === origin ? ai.token : '';
   const response = await service('/packs/' + encodeURIComponent(id), {root:origin, token});
   preparedAudio = response.preparedAudio === true;
   pack = Vocabulary.validatePack(response.pack);
   practice = response.practice;
   if (response.visibility === 'public' && Array.isArray(response.audio)) {
    audio = new Set(response.audio);
    audioStatus = response.audioStatus;
   }
  }
  if (pack.id !== id) throw Error('Wrong review set.');
  if (load !== sharedLoad) return;
  sharedReview = {pack, origin, audio, audioStatus, preparedAudio, localPreview:!!previewTicket, mode:SharedReview.reviewMode(practice?.mode, pack.words), allowHints:practice?.allowHints !== false};
  $('local-preview-notice').hidden = preparedAudio;
  $('local-preview-notice').textContent = previewTicket ? 'Draft preview uses this device’s voice. Use recording previews in the teacher workspace to check Paul. This preview makes no AI requests.' : 'This older set uses this device’s voice when a saved recording is unavailable.';
  await renderSharedReady();
 } catch (error) {
  if (load !== sharedLoad) return;
  $('shared-title').textContent = previewTicket ? 'Preview unavailable' : 'This set could not open';
  $('shared-instruction').textContent = previewTicket ? 'Open a fresh preview from the teacher workspace.' : 'Check your connection or ask your teacher for a new link.';
  if (error.status === 401 || error.status === 403 || error.status === 404) {
   $('shared-ready-status').textContent = entryPage === 'offline' ? 'If the set uses a class code, sign in from Tools.' : 'Ask your teacher for a public practice link.';
  }
 }
}

function showLanding() {
 if (entryPage === 'teacher') { showTeacherEntry(); return; }
 if (entryPage === 'student') {
  $('shared-title').textContent = 'Open a practice set';
  $('shared-instruction').textContent = 'Use the practice link your teacher gave you.';
  $('shared-ready-status').textContent = '';
  $('shared-start').hidden = true;
  show('shared-ready');
  return;
 }
 if (state.learningSession) pauseLearning();
 else if (state.learningCheckpoint) recoverCheckpoint();
 else show(state.session ? 'resume-screen' : 'setup-screen');
}

function initSharedReview() {
 $('shared-study').onclick = async () => {
  const review = sharedReview, owner = state;
  if (!review || review.mode === 'spelling') return;
  try {
   await importPack(review.pack,review.origin);
   if (sharedReview !== review || state !== owner) return;
   const list = selectedList(), rows = await loadVocabulary(list);
   if (sharedReview !== review || state !== owner) return;
   beginStudy(list,rows.filter(row=>row.vocabulary?.status === 'approved'));
  } catch (error) { if(sharedReview===review)$('shared-ready-status').textContent=error.message; }
 };
 $('shared-start').onclick = startSharedReview;
 window.addEventListener('hashchange', openSharedReview);
}
