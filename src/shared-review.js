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

 function matchingPractice(saved, id) {
  if (!id) return null;
  if (saved.session?.listId === id && saved.session.phase !== 'done') return 'spelling';
  const entry = saved.learningSession;
  return entry?.listId === id && entry.session.type === 'practice' && entry.session.status === 'active'
   ? 'learning' : null;
 }

 return {instructions, reviewMode, matchingPractice};
})();
if (typeof module === 'object' && module.exports) module.exports = SharedReview;

let sharedReview = null;
let sharedLoad = 0;
const parkedKey = (id, type) => 'paused-activity:' + JSON.stringify([id, type]);

function findPackList(id, origin) {
 const lists = state.lists.filter(list => list.packId === id);
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
 const list = findPackList(review.pack.id, review.origin);
 const completed = state.learningSession;
 if (list && completed?.listId === list.id && completed.session.mode === review.mode && Learning.practiceMastered(completed.session)) {
  finishLearningReport();
  return;
 }
 const saved = list && (SharedReview.matchingPractice(state, list.id) ? state : await parkedActivity(list.id));
 if (sharedReview !== review) return;
 const mode = SharedReview.matchingPractice(saved || {}, list?.id);
 const instruction = mode === 'learning' ? saved.learningSession.session.mode :
  mode === 'spelling' ? 'spelling' : review.mode;
 $('shared-title').textContent = review.pack.name;
 $('shared-instruction').textContent = SharedReview.instructions[instruction];
 $('shared-ready-status').textContent = '';
 $('shared-start').textContent = mode ? 'Continue practice' : 'Start practice';
 $('shared-start').disabled = false;
 $('shared-start').hidden = false;
 show('shared-ready');
 $('shared-title').focus();
}

async function startSharedReview() {
 const review = sharedReview, button = $('shared-start');
 if (!review || button.disabled) return;
 button.disabled = true;
 $('shared-ready-status').textContent = '';
 try {
  const oldList = findPackList(review.pack.id, review.origin);
  const activeMode = SharedReview.matchingPractice(state, oldList?.id);
  if (activeMode) {
   if (activeMode === 'learning') state.learningSession.session.settings.allowHints = review.allowHints;
   listId = oldList.id;
   resumeActivity();
   return;
  }
  const parked = await parkedActivity(oldList?.id);
  await parkCurrentActivity();
  const parkedMode = SharedReview.matchingPractice(parked || {}, oldList?.id);
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
   difficulty:'adaptive', audioReplay:true, masteryPractice:true});
 } catch (error) { $('shared-ready-status').textContent = error.message; }
 finally { button.disabled = false; }
}

async function openSharedReview() {
 const args = new URLSearchParams(location.hash.slice(1));
 if (!args.has('pack')) {
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
 show('shared-ready');
 const id = args.get('pack');
 try {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(id)) throw Error('Invalid pack link.');
  if (state.learningCheckpoint && !state.learningSession) await recoverCheckpoint(false);
  const origin = serviceOrigin(args.get('service') || ONLINE_CONFIG);
  const token = ai.root === origin ? ai.token : '';
  const response = await service('/packs/' + encodeURIComponent(id), {root:origin, token});
  const pack = Vocabulary.validatePack(response.pack);
  if (pack.id !== id) throw Error('Wrong review set.');
  if (load !== sharedLoad) return;
  sharedReview = {pack, origin, mode:SharedReview.reviewMode(args.get('mode'), pack.words), allowHints:args.get('hints') !== 'off'};
  await renderSharedReady();
 } catch (error) {
  if (load !== sharedLoad) return;
  $('shared-title').textContent = 'This set could not open';
  $('shared-instruction').textContent = 'Check your connection or ask your teacher for a new link.';
  if (error.status === 401 || error.status === 403 || error.status === 404) {
   $('shared-ready-status').textContent = 'If the set uses a class code, sign in from the WordLab home page.';
  }
  $('shared-title').focus();
 }
}

function showLanding() {
 if (state.learningSession) pauseLearning();
 else if (state.learningCheckpoint) recoverCheckpoint();
 else show(state.session ? 'resume-screen' : 'setup-screen');
}

function initSharedReview() {
 $('shared-start').onclick = startSharedReview;
 window.addEventListener('hashchange', openSharedReview);
}
