const vocabularyStores = new Map();
const previewRecords = new Map();
const previewStore = {
 kind: 'localStorage',
 async get(key) { return structuredClone(previewRecords.get(key)); },
 async put(key, value) { previewRecords.set(key, structuredClone(value)); },
 async remove(key) { previewRecords.delete(key); }
};
let vocabCache = {key: '', records: null};
let pendingPack = null;
let undoVocabulary = null;
const wordKey = Vocabulary.wordKey;
const recordKey = list => list.vocabKey || 'list:' + list.id;
const vocabularyRevision = list => ({vocabKey:list.vocabKey,packVersion:list.packVersion,updatedAt:list.updatedAt});
const sameVocabularyRevision = (list, revision) => revision && list.vocabKey === revision.vocabKey && list.packVersion === revision.packVersion && list.updatedAt === revision.updatedAt;
const VOCABULARY_CHANGED = 'Vocabulary changed. Close and reopen vocabulary review before saving again.';
function getStore(backend) {
 if (studentPreview) return Promise.resolve(previewStore);
 if (!vocabularyStores.has(backend)) {
  vocabularyStores.set(backend, Vocabulary.openStore(globalThis, backend).catch(error => {
   vocabularyStores.delete(backend);
   throw error;
  }));
 }
 const namespace = KEY.startsWith('spell.teacher:') ? KEY + ':' : '';
 return vocabularyStores.get(backend).then(store => !namespace ? store : {
  kind:store.kind,
  get:key=>store.get(namespace+key), put:(key,value)=>store.put(namespace+key,value), remove:key=>store.remove(namespace+key)
 });
}
const titleForType = {
 dictation: 'Listen, then spell',
 'missing-word': 'Fill in the blank',
 'definition-recall': 'Name the word',
 'sentence-choice': 'Choose the missing word',
 'meaning-choice': 'Choose the meaning',
 'word-bank': 'Fill in the blank with help'
};

async function loadVocabulary(list) {
 if (!list) return [];
 const stored = list.vocabKey ? await (await getStore(list.vocabBackend)).get(recordKey(list)) : [];
 if (list.vocabKey && !Array.isArray(stored)) throw Error('Saved vocabulary is unavailable. Reload or restore it from a backup.');
 const records = new Map(Vocabulary.legacyRecords(list).map(row => [wordKey(row.word), row.vocabulary]));
 for (const row of stored || []) records.set(wordKey(row.word), row.vocabulary);
 return list.words.map(word => ({word, vocabulary: records.get(wordKey(word)) || null}));
}

function removeVocabulary(list) {
 if (list.vocabKey) getStore(list.vocabBackend).then(store => store.remove(recordKey(list))).catch(() => {});
}

function queueVocabulary() {
 const list = selectedList();
 const key = list ? recordKey(list) + ':' + list.updatedAt + ':' + list.words.join('\n') : '';
 if (vocabCache.key === key) return;
 const pending = {key, records: null};
 vocabCache = pending;
 updateCoachSetup();
 loadVocabulary(list).catch(error => {
  status('Vocabulary could not load. ' + error.message);
  return list ? list.words.map(word => ({word, vocabulary: null})) : [];
 }).then(records => {
  if (vocabCache !== pending) return;
  pending.records = records;
  updateCoachSetup();
 });
}

function selectedRecords() {
 const records = new Map((vocabCache.records || []).map(row => [row.word, row]));
 return selectedWords().map(word => records.get(word) || {word, vocabulary: null});
}

function coachOptions() {
 return {
  mode: $('learning-mode').value,
  type: $('learning-type').value,
  difficulty: $('learning-difficulty').value,
  perWord: Number($('test-per-word').value),
  audioReplay: $('test-audio-replay').checked,
  multipleChoice: $('test-choices').checked,
  allowVariants: $('allow-variants').checked,
  roundSize: state.settings.roundSize,
  retypeOnMiss: state.settings.retypeOnMiss
 };
}

function updateCoachSetup() {
 const list = selectedList(), options = coachOptions(), records = selectedRecords();
 updateTeacherSelection(list, vocabCache.records);
 const study = options.mode === 'study', test = !study && options.type === 'test';
 const available = records.filter(row => row.vocabulary && (!test || row.vocabulary.status === 'approved')).length;
 $('open-vocabulary').disabled = !list;
 $('open-report').disabled = !list;
 $('sample-pack').hidden = state.lists.some(row => row.packId === SAMPLE_PACK.id);
 $('type-setting').hidden = study;
 $('difficulty-setting').hidden = true;
 $('test-settings').hidden = !test;
 $('per-word-setting').hidden = options.mode === 'spelling';
 $('test-choices-setting').hidden = options.mode === 'spelling';
 $('start-session').disabled = !records.length || (study || options.mode === 'vocabulary') && !available || options.mode === 'mixed' && !!list?.vocabKey && !vocabCache.records;
 $('start-session').textContent = study ? 'Open flashcards' : test ? 'Begin test' : 'Begin practice';
 $('mode-help').textContent = !records.length || options.mode === 'spelling' ? '' :
  (available === 0 ? (test ? 'Approve vocabulary content before using it in a test.' : 'Import a vocabulary pack or add definitions in Vocabulary content.') :
   available < records.length ? (records.length - available) + (options.mode === 'mixed' ? ' selected words will be used for spelling only.' : ' selected words have no usable vocabulary content.') : '');
 if (test) {
  const plan = Learning.createSession(records, options);
  const count = plan.questions.length;
  const min = Math.ceil(count / 4), max = Math.ceil(count / 2);
  $('test-preview').textContent = count + ' questions' + (count ? ' · About ' + min + '–' + max + ' min' : '');
 }
}

function learningProgress(list) {
 return state.learning[list.id] || dictionary();
}

async function beginCoach() {
 settingsChanged();
 const options = coachOptions(), list = selectedList(), records = selectedRecords();
 if (!list || !records.length) return;
 const parked = await parkedActivity(list.id, options.type);
 if (selectedList() !== list || state.session || state.learningSession) return;
 if (parked) {
  try { await resumeParkedActivity(list, parked); } catch (error) { status(error.message); }
  return;
 }
 if (options.mode === 'study') {
  beginStudy(list, records);
  return;
 }
 if (options.mode === 'spelling' && options.type === 'practice') {
  await start(records.map(row => row.word), list);
  return;
 }
 const preview = Learning.createSession(records, options, learningProgress(list));
 if (options.type === 'test' && !speech) {
  const prompts = preview.questions.filter(question => question.type === 'dictation');
  const recordings = await Promise.all(prompts.map(question =>
   readRecording(list.id, question.word, preview.records[question.recordIndex]?.vocabulary)));
  if (recordings.some(recording => !recording)) {
   status('Add a recording for each dictation word or enable browser speech before starting the test.');
   return;
  }
 }
 try {
  const receiptFile = $('test-order').files[0];
  if (options.type === 'test' && receiptFile) {
   options.receipt = await readImport(receiptFile);
   options.order = orderFromReceipt(options.receipt, preview.questions.length);
  }
  if (selectedList() !== list || state.session || state.learningSession) return;
  if (options.mode === 'mixed' && records.some(row => !row.vocabulary || options.type === 'test' && row.vocabulary.status !== 'approved') &&
      !confirm('Some selected words only have spelling content. Include them for spelling only?')) return;
  beginLearning(list, records, options);
 } catch (error) { status(error.message); }
}

function beginLearning(list, records, options, dueLists) {
 if (options.type === 'practice') options = {...options, phasedVocabulary:true};
 const session = Learning.createSession(records, options, dueLists ? dueLists.progress : learningProgress(list));
 if (!session.questions.length) { status('There are no questions for this selection.'); return; }
 state.learningSession = {listId: list.id, listName: list.name, session, dueLists: dueLists?.owners || null};
 save();
 renderLearning(true);
}

let stopMasteryCelebration = () => {};
function celebrateMastery(session) {
 if (session.celebrationShown) return;
 session.celebrationShown = true;
 save();
 stopMasteryCelebration();
 const motion = matchMedia('(prefers-reduced-motion: reduce)');
 if (motion.matches || document.hidden) return;
 const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
 if (!ctx) return;
 canvas.className = 'mastery-confetti';
 canvas.setAttribute('aria-hidden', 'true');
 const width = innerWidth, height = innerHeight, scale = Math.min(devicePixelRatio || 1, 2);
 canvas.width = width*scale; canvas.height = height*scale;
 ctx.setTransform(scale, 0, 0, scale, 0, 0);
 document.body.append(canvas);
 const colors = ['#26ccff','#a25afd','#ff5e7e','#88ff5a','#fcff42','#ffa62d','#ff36ff'];
 const particles = [], started = performance.now();
 let frame, previous = started, nextBurst = started, stopped = false;
 function stop() {
  if (stopped) return;
  stopped = true;
  cancelAnimationFrame(frame); canvas.remove();
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', stop);
  window.removeEventListener('resize', stop);
  stopMasteryCelebration = () => {};
 }
 function onVisibility() { if (document.hidden) stop(); }
 stopMasteryCelebration = stop;
 document.addEventListener('visibilitychange', onVisibility);
 window.addEventListener('pagehide', stop);
 window.addEventListener('resize', stop);
 function burst() {
  for (const side of [0,1]) for (let i=0;i<36;i++) {
   const angle = ((side ? 125 : 55) + (Math.random()-.5)*68)*Math.PI/180;
   const speed = 14 + Math.random()*12;
   particles.push({x:width*(side ? .94 : .06),y:height*.82,
    vx:Math.cos(angle)*speed,vy:-Math.sin(angle)*speed,
    rotation:Math.random()*Math.PI,spin:(Math.random()-.5)*.35,
    color:colors[i%colors.length],age:0});
  }
 }
 function draw(time) {
  if (motion.matches || document.hidden) { stop(); return; }
  const step = Math.min(50, time-previous)/(1000/60); previous = time;
  if (time-started < 1800 && time >= nextBurst) { burst(); nextBurst = time+260; }
  ctx.clearRect(0,0,width,height);
  for (let i=particles.length-1;i>=0;i--) {
   const p=particles[i]; p.age+=step;
   if (p.age>=95) { particles.splice(i,1); continue; }
   p.x+=p.vx*step; p.y+=p.vy*step; p.vy+=.5*step;
   p.vx*=Math.pow(.98,step); p.rotation+=p.spin*step;
   ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rotation);
   ctx.fillStyle=p.color; ctx.globalAlpha=Math.min(1,(95-p.age)/25);
   ctx.fillRect(-4,-2,8,4); ctx.restore();
  }
  if (time-started>=3600 || time-started>=1800 && !particles.length) stop();
  else frame=requestAnimationFrame(draw);
 }
 frame=requestAnimationFrame(draw);
}

function renderMasteryProgress(id, mastered, total, progress = total ? mastered/total : 0) {
 const meter = $(id), bar = meter.querySelector('[role="progressbar"]');
 const complete = total > 0 && mastered === total;
 const fraction = complete ? 1 : Math.min(.99, Math.max(0, progress));
 const percent = complete ? 100 : Math.min(99,Math.round(100*fraction));
 const label = mastered + ' of ' + total + ' ' + (total === 1 ? 'word' : 'words') + ' fully mastered';
 const count = meter.querySelector('.mastery-count');
 if (count.textContent !== label) count.textContent = label;
 meter.querySelector('.mastery-percent').textContent = percent + '%';
 meter.querySelector('.progressfill').style.width = 100*fraction + '%';
 meter.classList.toggle('is-complete', complete);
 bar.setAttribute('aria-valuemax', 100);
 bar.setAttribute('aria-valuenow', percent);
 bar.setAttribute('aria-valuetext', percent + '% progress toward mastery. ' + label);
}

let audioReady = false;
let audioQuestion = null;
let lastHint = null;
let learningAdvanceTimer;
const learningEntry = () => state.learningSession;

function renderVocabularyAutoplay() {
 const enabled=state.settings.vocabularyAutoplay!==false;
 for(const id of ['learning-autoplay','study-autoplay']) {
  $(id).textContent='Auto audio: '+(enabled?'on':'off');
  $(id).setAttribute('aria-pressed',String(enabled));
 }
}
function toggleVocabularyAutoplay() {
 const enabled=state.settings.vocabularyAutoplay===false;
 state.settings.vocabularyAutoplay=enabled;
 if(!enabled) {stopRecording();if(speech)speechSynthesis.cancel();}
 save();renderVocabularyAutoplay();
}

function playQuestion(initial, slow) {
 const entry = learningEntry();
 const session = entry?.session;
 const question = session && Learning.current(session);
 if (!question || !initial && !session.settings.audioReplay || session.feedback) return;
 if (!initial && !$('learning-typed').hidden) $('learning-input').focus();
 const message = Learning.audio(question, {choices: true});
 if (!message) return;
 const failed = () => {
  if (audioQuestion !== question) return;
  $('learning-audio-error').textContent = question.type === 'dictation' ?
   'Audio is unavailable. Pause or end this session to keep your place.' : 'Audio is unavailable. You can read the question and continue.';
  $('learning-audio-error').hidden = false;
 };
 const ready = () => {
  if (audioQuestion !== question) return;
  audioReady = true;
  $('learning-audio-error').hidden = true;
  $('learning-submit').disabled = false;
  $('learning-skip').disabled = false;
 };
 const rate = slow ? state.settings.rate * .65 : state.settings.rate;
 const owner = entry.dueLists?.[wordKey(question.word)] || entry.listId;
 const fallback = question.type === 'dictation' ?
  () => dictate(owner, message, session.records[question.recordIndex]?.vocabulary, rate, failed, ready) :
  () => speak(message, rate, failed, ready);
 const clip = sharedAudioPath(owner, question.word, question.type, Learning.audio(question));
 if (clip) playPublishedRecording(clip, slow, failed, ready);
 else if (sharedReview?.preparedAudio) failed();
 else fallback();
}

function renderLearning(play, corrected = false) {
 clearTimeout(learningAdvanceTimer);
 const entry = learningEntry();
 if (!entry) return;
 const session = entry.session, question = Learning.current(session);
 if (!question) { finishLearningReport(); return; }
 if (session.type === 'practice' && session.settings.difficulty === 'adaptive' && sharedReview &&
     findPackList(sharedReview.pack.id, sharedReview.origin)?.id === entry.listId) session.settings.masteryPractice = true;
 const test = session.type === 'test', result = session.feedback, correction = result?.correctionRequired;
 if (question !== audioQuestion) { audioQuestion = question; audioReady = false; lastHint = Learning.lastHint(session); }
 show('learning-screen');
 $('learning-label').textContent = entry.listName + ' · ' + (test ? 'Test' : 'Practice');
 $('learning-title').textContent = titleForType[question.type];
 $('learning-count').hidden = !test;
 const progress = 'Question ' + (session.index + 1) + ' of ' + session.questions.length;
 if ($('learning-count').textContent !== progress) $('learning-count').textContent = progress;
 $('learning-mastery').hidden = test;
 if (!test) {
  const {mastered, total, progress} = Learning.practiceWordProgress(session);
  renderMasteryProgress('learning-mastery', mastered, total, progress);
 }
 $('learning-prompt').textContent = question.type === 'dictation' ? 'Listen to the word, then type it.' : question.prompt;
 $('learning-audio-actions').hidden = !session.settings.audioReplay || !!result;
 $('learning-autoplay').hidden=test || question.type==='dictation';
 renderVocabularyAutoplay();
 const recordedPrompt = sharedAudioPath(entry.listId, question.word, question.type, Learning.audio(question));
 const audioAvailable = speech || question.type === 'dictation' || !!recordedPrompt;
 $('learning-audio').disabled = !audioAvailable;
 $('learning-slow').disabled = !audioAvailable;
 $('learning-audio-error').hidden = audioAvailable;
 if (!audioAvailable) $('learning-audio-error').textContent = 'Audio is unavailable.';
 $('learning-answer').hidden = !!result && !correction;
 const choices = question.choices || [], bank = question.bank || [];
 $('learning-choices').replaceChildren();
 if (bank.length && !result) {
  const list = document.createElement('p');
  list.className = 'word-bank'; list.textContent = bank.join(' · ');
  $('learning-choices').append(list);
 }
 if (!result) for (const choice of choices) {
  const label = document.createElement('label'), input = document.createElement('input');
  label.className = 'choice';
  input.type = 'radio'; input.name = 'learning-choice'; input.value = choice;
  const text = document.createElement('span');
  text.textContent = choice;
  label.append(input, text);
  $('learning-choices').append(label);
 }
 $('learning-typed').hidden = choices.length > 0 && !correction;
 $('learning-input').value = '';
 $('learning-submit').textContent = correction ? 'Check correction' : test ? 'Submit answer' : 'Check answer';
 $('learning-input').setCustomValidity('');
 $('learning-submit').disabled = test && question.type === 'dictation' && !audioReady;
 $('learning-skip').disabled = $('learning-submit').disabled;
 $('learning-skip').hidden = !!result;
 const hintsDisabled = test || session.settings.allowHints === false;
 $('learning-hint').hidden = hintsDisabled || !!result || session.revealed;
 $('learning-hint-text').hidden = hintsDisabled || !lastHint || !!result;
 $('learning-hint-text').textContent = hintsDisabled ? '' : lastHint?.text || '';
 const box = $('learning-feedback');
 renderCorrection('learning-correction', 'learning-input', correction ? result.answer : null, result?.explanation);
 if (!correction) $('learning-input').setAttribute('aria-describedby', bank.length ? 'learning-prompt learning-choices' : 'learning-prompt');
 box.hidden = !result || !!correction;
 box.className = 'feedback' + (result ? result.correct ? ' good' : ' bad' : '');
 if (result) {
  const message = {'other-word': 'That is a different word.', 'word-form': 'Check the word form.', 'likely-spelling': 'Check the spelling.'};
  box.textContent = result.correct ? (result.assisted ? 'Correct with help. You’ll try this word again.' : 'Correct.') :
   message[result.kind] || 'Incorrect.';
  if (!result.correct) {
   const answer = document.createElement('strong');
   answer.textContent = result.answer;
   const label = document.createElement('div');
   label.className = 'feedback-answer';
   label.append('Correct answer', answer);
   box.append(label);
  }
  if (result.explanation) {
   const detail = document.createElement('p');
   detail.className = 'correction-detail';
   detail.textContent = result.explanation;
   box.append(detail);
  }
 }
 const next = $('learning-next');
 const advance = result && !correction && (result.correct || corrected ||
   question.type === 'dictation' && result.kind !== 'skipped');
 next.hidden = !result || !!correction || !!advance;
 $('learning-end').hidden = test;
 $('learning-pause').textContent = test ? 'Save and pause' : 'Pause';
 $('learning-end').textContent = 'End practice';
 if (correction || play && !result && !$('learning-typed').hidden) $('learning-input').focus();
 else if (!next.hidden) next.focus();
 else if (play && !result) $('learning-choices').querySelector('input')?.focus();
 if (play && !result && question.type === 'dictation') playQuestion(true, false);
 else if(play && !result && !test && session.settings.audioReplay && state.settings.vocabularyAutoplay!==false) playQuestion(true,false);
 if (advance) advanceAfterFeedback(entry, result.correct && !result.assisted || corrected ? state.settings.autoAdvanceMs : state.settings.feedbackMs);
}

function advanceLearning() {
 const entry = learningEntry();
 if (!entry) return;
 const wasActive = entry.session.status === 'active';
 Learning.advance(entry.session); save(); renderLearning(true);
 if (wasActive && Learning.practiceMastered(entry.session)) celebrateMastery(entry.session);
}

function advanceAfterFeedback(entry, delay) {
 const feedback = entry.session.feedback;
 learningAdvanceTimer = setTimeout(() => {
  if (!$('learning-screen').hidden && learningEntry() === entry && entry.session.feedback === feedback) advanceLearning();
 }, delay);
}

function submitLearning(value) {
 const item = learningEntry();
 if (!item || $('learning-submit').disabled) return;
 const session = item.session;
 const correcting = session.feedback?.correctionRequired;
 if (correcting) {
  if (!Learning.correct(session, value)) { $('learning-input').setCustomValidity('Type the answer shown above.'); $('learning-input').reportValidity(); return; }
 } else {
  if (!Learning.submit(session, value)) return;
 }
 save();
 renderLearning(session.type === 'test', correcting);
}

function updateLearningProgress(entry) {
 if (entry.dueLists) {
  for (const [word, owner] of Object.entries(entry.dueLists)) {
   if (!entry.session.progress[word]) continue;
   if (!state.learning[owner]) state.learning[owner] = dictionary();
   state.learning[owner][word] = entry.session.progress[word];
  }
 } else state.learning[entry.listId] = entry.session.progress;
}

function finishLearningReport() {
 const entry = learningEntry();
 if (!entry) return;
 const report = Learning.report(entry.session);
 if (!entry.recorded && entry.session.status !== 'active') {
  if (entry.session.status === 'finished') updateLearningProgress(entry);
  state.learningHistory = state.learningHistory.filter(row => row.id !== entry.session.startedAt || row.listId !== entry.listId);
  const progress = Learning.mastery(entry.session.progress, entry.session.records);
  state.learningHistory.push({mastery: {spelling: progress.spelling.percent, vocabulary: progress.vocabulary.percent}, id: entry.session.startedAt, listId: entry.listId,
   at: now(), report, missed: missedFor(entry.session), mode: entry.session.mode});
  state.learningHistory = state.learningHistory.slice(-100);
  entry.recorded = true;
  if (entry.session.status === 'finished') archiveQuestions(entry);
  save();
 }
 if (Learning.practiceMastered(entry.session)) showPracticeComplete(entry);
 else showReport(report, entry);
}

function showPracticeComplete(entry) {
 $('practice-complete-list').textContent = entry.listName;
 $('practice-complete-message').textContent = entry.session.mode === 'mixed'
  ? 'You mastered all the spelling and vocabulary in this set.' : 'You mastered all the vocabulary in this set.';
 show('practice-complete-screen');
}

function missedFor(session) {
 if (session.type === 'test' && session.status !== 'finished') return [];
 return [...new Set(session.results.filter(result => !result.correct).map(result => result.question.word))];
}

function endLearning() {
 const entry = learningEntry();
 if (!entry) return;
 if (entry.session.type === 'test' && entry.session.status === 'active') {
  pauseLearning();
  return;
 }
 Learning.finish(entry.session);
 finishLearningReport();
}

function pauseLearning() {
 const entry = learningEntry();
 if (!entry) return;
 if (speech) speechSynthesis.cancel();
 $('resume-screen').querySelector('h1').textContent = entry.session.type === 'test' ? 'Continue your test?' : 'Continue your session?';
 $('end-saved-button').textContent = entry.session.type === 'test' ? 'View unfinished test' : 'End session';
 save();
 show('resume-screen');
 $('resume-button').focus();
}
function makeStat(label, headline, detail) {
 const node = document.createElement('div');
 node.className = 'stat';
 for (const [tag, text] of [['span', label], ['strong', headline], ['small', detail]]) {
  const child = document.createElement(tag);
  if (tag !== 'strong') child.className = 'hint';
  child.textContent = text;
  node.append(child);
 }
 return node;
}

const metricLabels = {
 spelling: 'Spelling accuracy', recognition: 'Vocabulary recognition',
 recall: 'Independent vocabulary recall', combined: 'Spelling and vocabulary'
};

function showReport(report, entry) {
 const list = state.lists.find(row => row.id === entry?.listId) || selectedList();
 const records = vocabCache.records || [];
 const stats = $('report-stats');
 stats.replaceChildren();
 $('report-list').textContent = entry?.listName || list?.name || '';
 $('report-title').textContent = report ? (report.type === 'test' ? report.status === 'unfinished' ? 'Unfinished test' : 'Test results' :
  entry?.session.settings.masteryPractice ? 'Practice ended' : 'Practice results') : 'Learning progress';
 $('report-exit').textContent = report?.status === 'unfinished' ? 'Leave unfinished test' : sharedReview ? 'Back to set' : 'Return to setup';
 $('report-resume').hidden = report?.status !== 'unfinished';
 const previous = state.learningHistory.filter(row => row.listId === list?.id).slice().reverse();
 if (report) {
  for (const [skill, label] of Object.entries(metricLabels)) {
   const metric = report.metrics[skill];
   stats.append(makeStat(label, metric.percent === null ? 'Not assessed' : metric.percent + '%',
    metric.answered ? metric.correct + ' correct / ' + metric.answered + ' answered' : '0 questions scored'));
  }
  stats.append(makeStat('Assisted answers', report.assisted, report.hints + ' hints used'));
  stats.append(makeStat('Questions answered', report.answered, report.type === 'test' ? report.total + ' planned' : 'This practice session'));
 } else if (list) {
  const mastery = Learning.mastery(learningProgress(list), records);
  for (const [skill, info] of Object.entries(mastery)) {
   const title = skill === 'spelling' ? 'Spelling mastery' : 'Vocabulary mastery';
   stats.append(makeStat(title, info.percent === null ? 'Not assessed' : info.percent + '%',
    (info.mastered + info.due) + ' mastered / ' + info.total + ' words'));
  }
  const old = (state.history[list.id]?.sessions || []).filter(row => Number.isFinite(row.attempts));
  const attempts = old.reduce((total, row) => total + row.attempts, 0);
  const correct = old.reduce((total, row) => total + (Number(row.correct) || 0), 0);
  stats.append(makeStat('First-attempt spelling', attempts ? Math.round(correct * 100 / attempts) + '%' : 'Not assessed',
   correct + ' correct / ' + attempts + ' answered in recent spelling sessions'));
 }
 const trend = $('report-trend-body');
 trend.replaceChildren();
 for (const row of previous.filter(item => item.mastery && item.report.status === 'finished').slice(0, 10).reverse()) {
  const line = document.createElement('tr');
  for (const value of [new Date(row.at).toLocaleDateString(), ...['spelling', 'vocabulary'].map(skill =>
   Number.isFinite(row.mastery[skill]) ? row.mastery[skill] + '%' : 'Not assessed')]) {
   const cell = document.createElement('td'); cell.textContent = value; line.append(cell);
  }
  trend.append(line);
 }
 $('report-trend').hidden = !!report || !trend.children.length;
 const history = $('report-history');
 history.replaceChildren();
 for (const row of previous.slice(0, 10)) {
  const li = document.createElement('li');
  li.textContent = new Date(row.at).toLocaleDateString() + ' · ' +
   (row.report.type === 'test' ? (row.report.status === 'finished' ? 'Completed test' : 'Unfinished test') : 'Practice') +
   ' · ' + row.report.answered + ' answered' +
   (row.report.status === 'finished' && row.report.answered ? ' · ' + Math.round(row.report.correct * 100 / row.report.answered) + '%' : '');
  history.append(li);
 }
 for (const row of (state.history[list?.id]?.sessions || []).slice(-4).reverse()) {
  const li = document.createElement('li');
  li.textContent = new Date(row.at).toLocaleDateString() + ' · Spelling practice · ' + (Number(row.attempts) || 0) + ' first attempts';
  history.append(li);
 }
 const mastery = list ? Learning.mastery(learningProgress(list), records) : null;
 const missed = entry ? missedFor(entry.session) : (previous[0]?.missed || state.history[list?.id]?.sessions?.slice(-1)[0]?.missed || []);
 $('report-review').textContent = (mastery ? mastery.spelling.learning + ' spelling and ' + mastery.vocabulary.learning +
  ' vocabulary words need practice. ' : '') + 'Due review combines words from saved lists.';
 $('review-due').disabled = !state.lists.length || report?.status === 'unfinished';
 $('review-missed').disabled = !missed.length || !list;
 $('review-missed').onclick = () => {
  const selected = records.filter(row => missed.includes(row.word));
  if (!selected.length) return;
  state.learningSession = null; delete state.learningCheckpoint;
  const mode = entry?.session.mode || previous[0]?.mode || 'spelling';
  const assigned = sharedReview && findPackList(sharedReview.pack.id,sharedReview.origin)?.id === list.id;
  const rules = assigned ? {...SharedReview.practiceRules(entry?.session.settings || sharedReview.practice),allowHints:entry?.session.settings.allowHints ?? sharedReview.allowHints} : {};
  if (mode === 'spelling') start(selected.map(row => row.word), list, rules);
  else beginLearning(list, selected, {...coachOptions(), mode, type: 'practice', difficulty: 'adaptive',...rules});
 };
 show('report-screen');
}

async function beginDueReview() {
 try {
  const records = [], progress = dictionary(), owners = dictionary();
  for (const list of state.lists) {
   const content = await loadVocabulary(list);
   const saved = learningProgress(list);
   const mastery = Learning.mastery(saved, content);
   const due = new Set([...mastery.spelling.words.due, ...mastery.vocabulary.words.due]);
   for (const row of content) {
    const key = wordKey(row.word);
    if (!due.has(row.word) || owners[key]) continue;
    records.push(row); owners[key] = list.id; progress[key] = saved[key];
    if (records.length === 200) break;
   }
   if (records.length === 200) break;
  }
  if (!records.length) { $('report-review').textContent = 'No mastered words are due for review yet.'; return; }
  if (!speech && records.some(row => progress[wordKey(row.word)]?.spelling?.nextReview <= Date.now())) {
   $('report-review').textContent = 'Some due words require pronunciation. Enable speech synthesis first.';
   return;
  }
  beginLearning({id: selectedList().id, name: 'Review across saved lists'}, records,
   {...coachOptions(), mode: 'mixed', type: 'practice', difficulty: 'adaptive', reviewOnly: true}, {owners, progress});
 } catch (error) { $('report-review').textContent = error.message; }
}

let studyState;
function beginStudy(list, rows) {
 studyState = {list, rows, index: 0, revealed: false};
 $('study-reverse').checked = false;
 $('study-unfamiliar').checked = false;
 renderStudy();
}

function studyCards() {
 const familiar = state.familiar[studyState.list.id] || [];
 const cards = Learning.flashcards(studyState.rows, {reverse: $('study-reverse').checked});
 return $('study-unfamiliar').checked ? cards.filter(card => !familiar.includes(wordKey(card.word))) : cards;
}

function renderStudy() {
 const cards = studyCards(), study = studyState;
 study.index = Math.max(0, Math.min(study.index, cards.length - 1));
 const card = cards[study.index], reverse = $('study-reverse').checked;
 const noUnfamiliar = !card && $('study-unfamiliar').checked;
 show('study-screen');
 $('study-count').textContent = card ? 'Card ' + (study.index + 1) + ' of ' + cards.length :
  noUnfamiliar ? 'No unfamiliar cards in this selection.' : 'No flashcards in this selection.';
 $('study-show-all').hidden = !noUnfamiliar;
 $('study-front').textContent = card?.front || '';
 $('study-back').hidden = !study.revealed || !card;
 $('study-back').replaceChildren();
 if (card && study.revealed) {
  for (const line of [card.back, card.partOfSpeech, ...card.examples].filter(Boolean)) {
   const p = document.createElement('p'); p.textContent = line; $('study-back').append(p);
   if (card.examples.includes(line)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost small';
    button.textContent = 'Listen to example'; button.setAttribute('aria-label','Listen to example: '+line);
    button.onclick = ()=>playStudyRecordings(card,line); $('study-back').append(button);
   }
  }
 }
 $('study-reveal').textContent = study.revealed ? 'Hide answer' : 'Reveal answer';
 $('study-listen').disabled = !card || !speech && !sharedReview;
 $('study-reveal').disabled = !card;
 $('study-familiar').disabled = !card || reverse && !study.revealed;
 $('study-familiar').textContent = card && state.familiar[study.list.id]?.includes(wordKey(card.word)) ? 'Mark as unfamiliar' : 'Mark as familiar';
 $('study-prev').disabled = study.index < 1;
 $('study-next').disabled = study.index + 1 >= cards.length;
 $('study-shuffle').disabled = study.rows.length < 2;
 $('study-shuffle-undo').hidden = !canUndoShuffle('study');
 renderVocabularyAutoplay();
 const example=study.revealed && card?.examples[0];
 const exampleKey=example && JSON.stringify([study.index,reverse,card.word,example]);
 if(!example)study.autoExample=null;
 else if(state.settings.vocabularyAutoplay!==false && study.autoExample!==exampleKey) {
  study.autoExample=exampleKey;
  playStudyRecordings(card,example);
 }
}

function outputPack(list, records) {
 return Vocabulary.validatePack({kind: 'spellingcoach-pack', v: 1,
  id: Dictation.canonicalPackId(list.packId) || list.id, version: list.packVersion || 1, name: list.name, words: records});
}

async function saveVocabulary(list, records, metadata, commit) {
 const owner = state, revision = vocabularyRevision(list);
 const store = await getStore();
 if (state !== owner || !owner.lists.includes(list)) throw Error('This workspace changed. Sign in again to continue.');
 if (!sameVocabularyRevision(list,revision)) throw Error(VOCABULARY_CHANGED);
 const before = list.vocabKey, beforeBackend = list.vocabBackend;
 const next = 'list:' + list.id + ':' + newListId();
 await store.put(next, records);
 if (state !== owner || !owner.lists.includes(list) || !sameVocabularyRevision(list,revision)) {
  await store.remove(next).catch(()=>{});
  throw Error(state !== owner || !owner.lists.includes(list) ? 'This workspace changed. Sign in again to continue.' : VOCABULARY_CHANGED);
 }
 const snapshot = {...list};
 let rollback, writtenRevision;
 try {
  Object.assign(list, metadata, {vocabKey: next, vocabBackend: store.kind, audioStatus:null, updatedAt: now()});
  writtenRevision = vocabularyRevision(list);
  if (commit) rollback = commit();
  if (!save()) throw Error('Browser storage could not save your changes.');
 } catch (error) {
  if (rollback) rollback();
  for (const key of Object.keys(list)) delete list[key];
  Object.assign(list, snapshot);
  await store.remove(next).catch(() => {});
  throw error;
 }
 if (before) getStore(beforeBackend).then(oldStore => oldStore.remove(before)).catch(() => {});
 renderSetup();
 if (ai.role === 'teacher' && ai.token && !restoringTeacherSets) await autosaveTeacherSet(list);
 if (state !== owner) throw Error('This workspace changed. Sign in again to continue.');
 return writtenRevision;
}

function previewPack(pack) {
 pendingPack = Vocabulary.validatePack(pack);
 $('pack-preview-text').textContent = pendingPack.name + ' · ' + pendingPack.words.length + ' words · Version ' + pendingPack.version +
  ' · ' + pendingPack.words.filter(row => row.vocabulary?.status === 'approved').length + ' approved definitions';
 $('pack-preview-status').textContent = '';
 $('pack-preview').showModal();
}

async function importPack(pack, origin) {
 const owner = state;
 let list = findPackList(pack.id, origin);
 const fresh = !list;
 const before = list && structuredClone({progress: state.progress[list.id], learning: state.learning[list.id],
  familiar: state.familiar[list.id], selection: state.settings.selected[list.id]});
 const previousListId = listId;
 const words = pack.words.map(row => row.word);
 if (fresh) {
  list = {id: newListId(), name: pack.name, words, defs: dictionary(), updatedAt: now()};
 } else {
  const current = outputPack(list, await loadVocabulary(list));
  if (state !== owner) throw Error('The workspace changed. Import cancelled.');
  const plan = Vocabulary.planPackUpdate(current, pack);
  if (plan.action === 'older' || plan.action === 'unchanged') {
   if (origin && !list.sharedOrigin) { list.sharedOrigin = origin; save(); }
   listId = list.id; renderSetup(); return 'This pack is already up to date.';
  }
  for (const key of [...plan.changedWords, ...plan.removedWords]) {
   const data = state.learning[list.id]?.[key];
   if (data) delete data.vocabulary;
   if (state.familiar[list.id]) state.familiar[list.id] = state.familiar[list.id].filter(word => word !== key);
  }
  const oldWords = new Map(list.words.map(word => [wordKey(word), word]));
  const oldProgress = state.progress[list.id]?.words;
  const chosen = new Set((state.settings.selected[list.id] || list.words).map(wordKey));
  for (const word of words) {
   const previous = oldWords.get(wordKey(word));
   if (oldProgress && previous && previous !== word && oldProgress[previous]) oldProgress[word] = oldProgress[previous];
  }
  state.settings.selected[list.id] = words.filter(word => !oldWords.has(wordKey(word)) || chosen.has(wordKey(word)));
 }
 if (fresh) {
  state.lists.push(list);
  state.settings.selected[list.id] = words.slice();
 }
 listId = list.id;
 try {
  await saveVocabulary(list, pack.words, {name: pack.name, words, packId: pack.id, packVersion: pack.version, ...(origin ? {sharedOrigin: origin} : {})});
 } catch (error) {
  if (state !== owner) throw error;
  if (fresh) { state.lists = state.lists.filter(row => row !== list); delete state.settings.selected[list.id]; }
  else for (const [target, key] of [[state.progress, 'progress'], [state.learning, 'learning'], [state.familiar, 'familiar'], [state.settings.selected, 'selection']]) {
   if (before[key] === undefined) delete target[list.id];
   else target[list.id] = before[key];
  }
  listId = previousListId;
  throw error;
 }
 return 'Imported “' + pack.name + '”.';
}

async function exportFullBackup() {
 const owner = state, token = ai.token, snapshot = structuredClone(state), historyStore = getStore('indexedDB');
 const packs = [];
 for (const list of snapshot.lists) if (list.vocabKey) {
  if (state !== owner || ai.token !== token) return;
  packs.push({listId: list.id, records: await loadVocabulary(list)});
 }
 const archived = await historyStore.then(async store => {
  const entries = await Promise.all(snapshot.learningHistory.filter(row => row.report.status === 'finished')
   .map(row => store.get('history:' + row.listId + ':' + row.id)));
  return entries.filter(Boolean);
 }).catch(() => []);
 if (state !== owner || ai.token !== token) return;
 delete snapshot.learningCheckpoint;
 const contents = JSON.stringify({kind: 'spellingcoach-backup', v: 1, state: snapshot, packs, questionHistory: archived,
  theme: themePreference.value});
 if (new Blob([contents]).size > MAX_IMPORT) throw Error('The backup is too large. Export individual vocabulary packs first.');
 download('WordLab full backup.json', contents, 'application/json');
}

async function restoreFullBackup(backup) {
 const old = state, token = ai.token;
 if (backup.v !== 1 || backup.state?.v !== 2 || !Array.isArray(backup.state.lists) || !Array.isArray(backup.packs)) {
  throw Error('This full backup format is unsupported.');
 }
 if (!backup.state.lists.every(listOK) || new Set(backup.state.lists.map(list => list.id)).size !== backup.state.lists.length) {
  throw Error('Backup contains invalid or duplicate word lists.');
 }
 const restored = clean(backup.state);
 delete restored.learningCheckpoint;
 if (backup.state.session && !restored.session || backup.state.learningSession && !restored.learningSession) {
  throw Error('Backup contains an invalid session.');
 }
 const staged = new Map();
 for (const item of backup.packs) {
  const list = restored.lists.find(row => row.id === item?.listId);
  if (!list || staged.has(list.id)) throw Error('Backup links vocabulary to an unknown or duplicate list.');
  const pack = outputPack(list, item.records);
  if (pack.words.length !== list.words.length || pack.words.some((row, index) => wordKey(row.word) !== wordKey(list.words[index]))) {
   throw Error('A backup vocabulary pack does not match its list.');
  }
  staged.set(list.id, pack.words);
 }
 for (const list of restored.lists) {
  if (list.vocabKey && !staged.has(list.id)) throw Error('Backup is missing vocabulary for “' + list.name + '”.');
  delete list.vocabKey;
  delete list.vocabBackend;
 }
 if (!confirm('Replace all lists, settings, and progress in this browser with this full backup?')) return 'Restore cancelled.';
 const store = staged.size ? await getStore() : null;
 const stagedKeys = [];
 try {
  for (const list of restored.lists) if (staged.has(list.id)) {
   if (state !== old || ai.token !== token) throw Error('The workspace changed. Restore cancelled.');
   list.vocabKey = 'list:' + list.id + ':' + newListId();
   list.vocabBackend = store.kind;
   stagedKeys.push(list.vocabKey);
   await store.put(list.vocabKey, staged.get(list.id));
  }
  if (state !== old || ai.token !== token) throw Error('The workspace changed. Restore cancelled.');
  state = restored;
  if (!save()) throw Error('Browser storage could not restore the backup.');
 } catch (error) {
  if (ai.token === token && state === restored) state = old;
  if (store) for (const key of stagedKeys) await store.remove(key).catch(() => {});
  throw error;
 }
 if (Array.isArray(backup.questionHistory)) {
  await getStore('indexedDB').then(async historyStore => {
   for (const entry of backup.questionHistory.slice(-100)) {
    if (state !== restored || ai.token !== token) return;
    if (restored.lists.some(list => list.id === entry?.listId) && Number.isSafeInteger(entry.sessionId) &&
        Array.isArray(entry.questions) && entry.questions.length <= 3200) {
     await historyStore.put('history:' + entry.listId + ':' + entry.sessionId, entry);
    }
   }
  }).catch(() => {});
 }
 if (state !== restored || ai.token !== token) return 'Restore stopped because the workspace changed.';
 for (const list of old.lists) removeVocabulary(list);
 themePreference.set(backup.theme);
 renderTheme();
 listId = (state.session || state.learningSession || {}).listId || state.lists[0]?.id || '';
 vocabCache = {key: null, records: null};
 renderSetup();
 show(state.session || state.learningSession ? 'resume-screen' : 'setup-screen');
 return 'Full backup restored.';
}
let editorRecords = [];
let editorList = null;
let editorPage = 0;
let editorInline = false;
let editorWorkspace = null;
let editorToken = '';
let vocabularyEditorRequest = 0;
let editorRevision = null;
let editorSaving = false;
let editorSelection = {word: '', search: '', filter: '', values: []};
const editorPageSize = 30;
const fields = {
 definition: 'vocab-definition', examples: 'vocab-examples', meaningDistractors: 'vocab-distractors',
 acceptedSpellings: 'vocab-variants', partOfSpeech: 'vocab-pos', readingLevel: 'vocab-grade'
};
const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const editorStatusText = message => { $('vocab-status').textContent = message; };
const editableVocabularyFields = [...Object.values(fields), 'vocab-cloze', 'vocab-explanations'];
const vocabularyFieldValues = () => editableVocabularyFields.map(id => $(id).value);
const isVocabularyDraft = row => row.vocabulary && row.vocabulary.status !== 'approved';

function nextVocabularyDraft(rows, index) {
 return rows.slice(index + 1).find(isVocabularyDraft) || rows.slice(0, index).find(isVocabularyDraft);
}

function canLeaveVocabularyEditor() {
 if (editorSaving) {
  editorStatusText('Wait for the vocabulary save to finish.');
  return false;
 }
 if (!editorInline && !$('vocab-dialog').open) return true;
 return !editorSelection.values.some((value,index) => value !== $(editableVocabularyFields[index]).value) ||
  confirm('Discard unsaved changes to “' + editorSelection.word + '”?');
}

function filteredEditorRecords() {
 const search = wordKey($('vocab-search').value), filter = $('vocab-filter').value;
 return editorRecords.filter(row => wordKey(row.word).includes(search) &&
  (!filter || (filter === 'draft' ? isVocabularyDraft(row) :
   (row.vocabulary?.status || 'missing') === filter)));
}

function renderVocabularyEditor(preferred) {
 const chosen = preferred || $('vocab-word').value;
 const filtered = filteredEditorRecords();
 const lastPage = Math.max(0, Math.ceil(filtered.length / editorPageSize) - 1);
 editorPage = Math.min(editorPage, lastPage);
 const index = filtered.findIndex(row => row.word === preferred);
 if (index >= 0) editorPage = Math.floor(index / editorPageSize);
 const page = filtered.slice(editorPage * editorPageSize, (editorPage + 1) * editorPageSize);
 const approved = editorRecords.filter(row => row.vocabulary?.status === 'approved').length;
 $('vocab-count').textContent = approved + ' approved · ' +
  (editorRecords.filter(row => row.vocabulary).length - approved) + ' need review · ' +
  editorRecords.filter(row => !row.vocabulary).length + ' missing';
 $('vocab-page').textContent = 'Page ' + (editorPage + 1) + ' of ' + (lastPage + 1);
 $('vocab-pagination').hidden = lastPage === 0;
 $('vocab-prev').disabled = !editorPage;
 $('vocab-next').disabled = editorPage >= lastPage;
 const select = $('vocab-word');
 select.replaceChildren();
 for (const row of page) {
  const status = row.vocabulary?.status === 'approved' ? 'Approved' : row.vocabulary ? 'Review' : 'Missing';
  select.add(new Option(row.word + ' · ' + status, row.word));
 }
 select.disabled = !page.length;
 if (!page.length) select.add(new Option('No matching words', ''));
 select.value = page.some(row => row.word === chosen) ? chosen : page[0]?.word || '';
 $('vocab-undo').disabled = !undoVocabulary;
 $('vocab-bulk').disabled = !editorRecords.some(isVocabularyDraft);
 renderEditFields(filtered);
}

function displayVocabularyEditor(editing) {
 const toggle = $('vocab-edit-toggle');
 toggle.textContent = editing ? 'Preview wording' : 'Edit wording';
 toggle.setAttribute('aria-expanded', String(editing));
 $('vocab-edit-fields').hidden = !editing;
 $('vocab-save-draft').hidden = !editing;
 $('vocab-review-content').hidden = editing;
 if (editing) return;
 $('vocab-review-definition').textContent = $('vocab-definition').value;
 for (const [target, source] of [['vocab-review-examples', 'vocab-examples'], ['vocab-review-cloze', 'vocab-cloze']]) {
  const container = $(target), sentences = lines($(source).value);
  container.hidden = !sentences.length;
  container.replaceChildren();
  for (const sentence of sentences) {
   const paragraph = document.createElement('p');
   paragraph.textContent = sentence;
   container.append(paragraph);
  }
 }
}

function renderEditFields(filtered = filteredEditorRecords()) {
 const word = $('vocab-word').value, index = filtered.findIndex(row => row.word === word);
 const row = filtered[index];
 editorSelection = {word, search: $('vocab-search').value, filter: $('vocab-filter').value, values: []};
 $('vocab-word-prev').disabled = index < 1;
 $('vocab-word-next').disabled = index < 0 || index + 1 >= filtered.length;
 $('vocab-form').hidden = !row;
 const v = row?.vocabulary;
 $('vocab-edit-toggle').hidden = !v;
 if (!row) { $('vocab-review-content').hidden = true; return; }
 prefillTroySentence(row);
 for (const [key, id] of Object.entries(fields)) {
  const value = v?.[key];
  $(id).value = Array.isArray(value) ? value.join('\n') : value || (key === 'readingLevel' ? '5' : '');
 }
 $('vocab-cloze').value = (v?.clozeQuestions || []).map(question => question.sentence).join('\n');
 $('vocab-explanations').value = (v?.clozeQuestions || []).map(question => question.explanation).join('\n');
 editorSelection.values = vocabularyFieldValues();
 displayVocabularyEditor(!v);
 $('vocab-approve').textContent = v?.status === 'approved' ? 'Save changes' :
  nextVocabularyDraft(filtered, index) ? 'Approve & next' : 'Save and approve';
 $('vocab-regenerate').disabled = !v || ai.role !== 'teacher';
 renderRecordingControls();
}

async function changeVocabulary(next, preferred, submittedValues) {
 if (editorSaving) throw Error('A vocabulary save is already in progress. Wait for it to finish before saving again.');
 const owner = state, token = ai.token, request = vocabularyEditorRequest;
 const list = editorList, before = editorRecords;
 const current = () => state === owner && ai.token === token && editorWorkspace === owner && editorToken === token && editorList === list && selectedList() === list && vocabularyEditorRequest === request;
 if (!list || !current()) throw Error('This workspace changed. Sign in again to continue.');
 const revision = editorRevision, selection = editorSelection;
 if (!sameVocabularyRevision(list,revision)) throw Error(VOCABULARY_CHANGED);
 editorSaving = true;
 try {
  const invalidated = new Set();
  const oldRows = new Map(before.map(row => [wordKey(row.word), row.vocabulary]));
  for (const row of next) {
   const key = wordKey(row.word), previous = oldRows.get(key);
   if (previous && (previous.senseId !== row.vocabulary?.senseId || previous.definition !== row.vocabulary.definition ||
       previous.partOfSpeech !== row.vocabulary.partOfSpeech)) {
    invalidated.add(key);
   }
  }
  const writtenRevision = await saveVocabulary(list, next, {packVersion: (list.packVersion || 0) + 1}, () => {
   if (!current()) throw Error('This workspace changed. Sign in again to continue.');
   if (!invalidated.size) return;
   const oldLearning = owner.learning[list.id], oldFamiliar = owner.familiar[list.id];
   const learning = oldLearning && structuredClone(oldLearning);
   const familiar = oldFamiliar && oldFamiliar.filter(key => !invalidated.has(key));
   for (const key of invalidated) if (learning?.[key]) delete learning[key].vocabulary;
   if (oldLearning) owner.learning[list.id] = learning;
   if (oldFamiliar) owner.familiar[list.id] = familiar;
   return () => {
    if (oldLearning) owner.learning[list.id] = oldLearning;
    if (oldFamiliar) owner.familiar[list.id] = oldFamiliar;
   };
  });
  if (!current()) return;
  if (!sameVocabularyRevision(list,writtenRevision)) throw Error(VOCABULARY_CHANGED);
  editorRevision = writtenRevision;
  editorRecords = next;
  undoVocabulary = before;
  const {word, values} = editorSelection;
  const baseline = (selection === editorSelection && submittedValues) || values;
  const unsaved = vocabularyFieldValues().map((value,index) => baseline.length && value !== baseline[index] ? value : undefined);
  const hasUnsaved = unsaved.some(value => value !== undefined), editing = !$('vocab-edit-fields').hidden;
  if (hasUnsaved) {
   // Keep the edited word in view if saving changed its filter status.
   if (!filteredEditorRecords().some(row => row.word === word)) $('vocab-filter').value = '';
   preferred = word;
  } else if (selection !== editorSelection) preferred = word;
  renderVocabularyEditor(preferred);
  if (hasUnsaved) {
   unsaved.forEach((value,index) => { if (value !== undefined) $(editableVocabularyFields[index]).value = value; });
   displayVocabularyEditor(editing);
  }
  if (editorInline && typeof refreshSetWorkspace === 'function') await refreshSetWorkspace();
  return current();
 } finally {
  editorSaving = false;
 }
}

async function closeVocabularyEditor(discardConfirmed = false) {
 if ((editorSaving || editorInline && !discardConfirmed) && !canLeaveVocabularyEditor()) return false;
 // Cancel an open that is still loading before its panel mounts.
 vocabularyEditorRequest++;
 if (!editorInline) return false;
 const owner = editorWorkspace, token = editorToken, list = editorList;
 editorInline = false;
 stopRecording();
 $('workspace-review').hidden = true;
 $('vocab-dialog').append($('vocab-editor-panel'));
 $('vocab-close').textContent = 'Close';
 if (state === owner && ai.token === token && selectedList() === list && typeof refreshSetWorkspace === 'function') await refreshSetWorkspace();
 return true;
}

async function openVocabularyEditor(filter = '', inline = false) {
 const list = selectedList();
 if (!list || !canLeaveVocabularyEditor()) return;
 const selection = editorSelection, values = vocabularyFieldValues();
 const owner = state, token = ai.token, revision = vocabularyRevision(list), request = ++vocabularyEditorRequest;
 const current = () => state === owner && ai.token === token && selectedList() === list && sameVocabularyRevision(list,revision) && vocabularyEditorRequest === request;
 try {
  const records = await loadVocabulary(list);
  if (!current()) return;
  const changed = selection !== editorSelection || values.some((value,index) => value !== $(editableVocabularyFields[index]).value);
  if ((editorSaving || changed) && !canLeaveVocabularyEditor()) return;
  editorRecords = records;
  editorRevision = revision;
  editorList = list; editorPage = 0; undoVocabulary = null;
  editorInline = inline; editorWorkspace = owner; editorToken = token;
  const dialog = $('vocab-dialog'), panel = $('vocab-editor-panel');
  if (inline) {
   if (dialog.open) dialog.close();
   $('workspace-review').append(panel);
   $('workspace-review').hidden = false;
  } else {
   $('workspace-review').hidden = true;
   dialog.append(panel);
  }
  $('vocab-close').textContent = inline ? 'Finish reviewing' : 'Close';
  $('vocab-search').value = ''; $('vocab-filter').value = filter;
  $('vocab-filters').open = !!filter;
  $('vocab-advanced').open = false;
  $('vocab-audio').open = false;
  editorStatusText('');
  renderVocabularyEditor();
  if (!inline) dialog.showModal();
  return true;
 } catch (error) { if (current()) status(error.message); }
}

function initCoach() {
 for(const id of ['learning-autoplay','study-autoplay'])$(id).onclick=toggleVocabularyAutoplay;
 for (const id of ['learning-mode', 'learning-difficulty', 'learning-type', 'test-per-word', 'test-choices', 'test-audio-replay']) {
  $(id).addEventListener('change', updateCoachSetup);
 }
 $('sample-pack').onclick = () => previewPack(SAMPLE_PACK);
 $('open-vocabulary').onclick = () => openVocabularyEditor();
 $('open-report').onclick = () => showReport();
 $('practice-complete-done').onclick = backToSetup;
 $('report-exit').onclick = () => {
  if (learningEntry()?.session.status === 'unfinished' && !confirm('Leave this unfinished test? Its answers will remain locked and the test cannot be resumed.')) return;
  backToSetup();
 };
 $('report-resume').onclick = () => {
  const entry = learningEntry(); if (!entry) return;
  Learning.resume(entry.session); entry.recorded = false; save(); renderLearning(true);
 };
 $('review-due').onclick = beginDueReview;
 $('learning-pause').onclick = pauseLearning;
 $('learning-end').onclick = endLearning;
 $('learning-audio').onclick = () => playQuestion(false, false);
 $('learning-slow').onclick = () => playQuestion(false, true);
 $('learning-input').oninput = () => $('learning-input').setCustomValidity('');
 $('learning-answer').onsubmit = event => {
  event.preventDefault();
  const chosen = $('learning-choices').querySelector('input:checked');
  submitLearning(chosen ? chosen.value : $('learning-input').value);
 };
 $('learning-skip').onclick = () => {
  const entry = learningEntry();
  if (!entry || $('learning-skip').disabled) return;
  if (Learning.skip(entry.session)) { save(); renderLearning(entry.session.type === 'test'); }
 };
 $('learning-hint').onclick = () => {
  const entry = learningEntry(); if (!entry) return;
  const hint = Learning.hint(entry.session);
  if (!hint) return;
  lastHint = hint; save();
  $('learning-hint-text').textContent = lastHint?.text || '';
  $('learning-hint-text').hidden = !lastHint;
  if (entry.session.revealed) $('learning-hint').hidden = true;
  if (!$('learning-typed').hidden) $('learning-input').focus();
 };
 $('learning-next').onclick = advanceLearning;
 $('study-exit').onclick = backToSetup;
 for (const id of ['study-reverse', 'study-unfamiliar']) $(id).onchange = () => {
  studyState.index = 0; studyState.revealed = false; renderStudy();
 };
 $('study-show-all').onclick = () => {
  $('study-unfamiliar').checked = false;
  $('study-unfamiliar').onchange();
  if (!$('study-reveal').disabled) $('study-reveal').focus();
 };
 $('study-listen').onclick = () => {
  const card = studyCards()[studyState.index];
  if (card) playStudyRecordings(card);
 };
 $('study-reveal').onclick = () => { studyState.revealed = !studyState.revealed; renderStudy(); };
 for (const [id, delta] of [['study-prev', -1], ['study-next', 1]]) $(id).onclick = () => {
  studyState.index += delta; studyState.revealed = false; renderStudy();
 };
 $('study-familiar').onclick = () => {
  const card = studyCards()[studyState.index], list = studyState.list.id;
  if (!card) return;
  const key = wordKey(card.word), previous = state.familiar[list] || [];
  state.familiar[list] = previous.includes(key) ? previous.filter(word => word !== key) : previous.concat(key);
  studyState.revealed = false; save(); renderStudy();
  if (!$('study-show-all').hidden) $('study-show-all').focus();
 };
 $('study-shuffle').onclick = () => openShuffle('study');
 $('shuffle-undo').onclick = () => undoWordShuffle('list');
 $('study-shuffle-undo').onclick = () => undoWordShuffle('study');
 $('vocab-close').onclick = () => {
  if (editorInline) return closeVocabularyEditor();
  if (canLeaveVocabularyEditor()) $('vocab-dialog').close();
 };
 $('vocab-dialog').addEventListener('cancel', event => { if (!canLeaveVocabularyEditor()) event.preventDefault(); });
 for (const key of ['search', 'filter']) $('vocab-' + key).oninput = () => {
  if (!canLeaveVocabularyEditor()) { $('vocab-' + key).value = editorSelection[key]; return; }
  editorPage = 0; editorStatusText(''); renderVocabularyEditor();
 };
 for (const [direction, delta] of [['prev', -1], ['next', 1]]) {
  $('vocab-' + direction).onclick = () => {
   if (!canLeaveVocabularyEditor()) return;
   editorPage += delta; editorStatusText(''); renderVocabularyEditor();
  };
  $('vocab-word-' + direction).onclick = () => {
   const filtered = filteredEditorRecords(), index = filtered.findIndex(row => row.word === editorSelection.word);
   const next = filtered[index + delta];
   if (index < 0 || !next || !canLeaveVocabularyEditor()) return;
   editorStatusText(''); renderVocabularyEditor(next.word);
  };
 }
 $('vocab-word').onchange = () => {
  if (!canLeaveVocabularyEditor()) { $('vocab-word').value = editorSelection.word; return; }
  editorStatusText(''); renderEditFields();
 };
 $('vocab-edit-toggle').onclick = () => {
  const editing = $('vocab-edit-fields').hidden;
  displayVocabularyEditor(editing);
  if (editing) $('vocab-definition').focus();
 };
 $('vocab-form').onsubmit = async event => {
  event.preventDefault();
  const word = $('vocab-word').value, before = editorRecords.find(row => row.word === word)?.vocabulary;
  const sentences = lines($('vocab-cloze').value), explanations = $('vocab-explanations').value.split(/\r?\n/);
  const submitter = event.submitter;
  if (submitter) submitter.disabled = true;
  try {
   const record = Vocabulary.validateRecord(word, {
    senseId: before?.senseId || newListId(),
    partOfSpeech: $('vocab-pos').value || 'unknown', definition: $('vocab-definition').value,
    readingLevel: Number($('vocab-grade').value), examples: lines($('vocab-examples').value),
    acceptedSpellings: lines($('vocab-variants').value), meaningDistractors: lines($('vocab-distractors').value),
    status: submitter?.id === 'vocab-approve' ? 'approved' : 'draft',
    clozeQuestions: sentences.map((sentence, index) => ({
     id: before?.clozeQuestions.find(question => question.sentence === sentence)?.id || newListId(),
     sentence, answer: word, explanation: explanations[index]?.trim() || 'The context gives clues to the word.'
    }))
   });
   let preferred = word;
   if (record.status === 'approved' && before?.status !== 'approved') {
    const queue = filteredEditorRecords(), index = queue.findIndex(row => row.word === word);
    preferred = nextVocabularyDraft(queue, index)?.word || word;
   }
   if (await changeVocabulary(editorRecords.map(row => row.word === word ? {word, vocabulary: record} : row), preferred, vocabularyFieldValues())) {
    editorStatusText((record.status === 'approved' ? 'Approved ' : 'Saved ') + word + '.');
    if ($('vocab-form').hidden) $('vocab-close').focus();
   }
  } catch (error) { editorStatusText(error.message); }
  finally { if (submitter) submitter.disabled = false; }
 };
 $('vocab-form').addEventListener('invalid', event => {
  if ($('vocab-edit-fields').hidden) displayVocabularyEditor(true);
  const section = event.target.closest('details');
  if (section) section.open = true;
 }, true);
 $('vocab-undo').onclick = async () => {
  if (!undoVocabulary) return;
  try { await changeVocabulary(undoVocabulary, $('vocab-word').value); editorStatusText('Restored the previous version.'); }
  catch (error) { editorStatusText(error.message); }
 };
 $('vocab-bulk').onclick = async () => {
  const count = editorRecords.filter(isVocabularyDraft).length;
  if (!count || !confirm('Approve all drafts in this set (' + count + '), including drafts you haven’t opened or reviewed? This uses the saved wording.')) return;
  try {
   const next = editorRecords.map(row => isVocabularyDraft(row) ?
    {word: row.word, vocabulary: Vocabulary.validateRecord(row.word, {...row.vocabulary, status: 'approved'})} : row);
   await changeVocabulary(next, $('vocab-word').value); editorStatusText('Drafts approved.');
  } catch (error) { editorStatusText(error.message); }
 };
 $('vocab-export').onclick = () => {
  try { download('WordLab vocabulary.json', JSON.stringify(outputPack(editorList, editorRecords), null, 2), 'application/json'); }
  catch (error) { editorStatusText(error.message); }
 };
 $('pack-decline').onclick = () => $('pack-preview').close();
 $('pack-accept').onclick = async () => {
  $('pack-accept').disabled = true;
  try {
   const message = await importPack(pendingPack); $('pack-preview').close(); status(message);
  } catch (error) { $('pack-preview-status').textContent = error.message; }
  finally { $('pack-accept').disabled = false; }
 };
 $('export-json').onclick = () => exportFullBackup().catch(error => { $('backup-status').textContent = error.message; });
 $('import-json').onclick = () => $('json-file').click();
 $('json-file').onchange = async event => {
  const owner = state, token = ai.token;
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  try {
   const data = await readImport(file);
   if (state !== owner || ai.token !== token) return;
   if (data.kind === 'spellingcoach-pack') {
    $('tools-dialog').close(); previewPack(data);
   } else if (data.kind === 'spellingcoach-backup') {
    const result = await restoreFullBackup(data); $('tools-dialog').close(); status(result);
   } else {
    const lists = validBackup(data);
    if (!lists.length) throw Error('Backup contains no lists.');
    for (const list of lists) addList(list.name, list.words, list.defs);
    $('backup-status').textContent = 'Imported ' + lists.length + ' lists.';
   }
  } catch (error) { $('backup-status').textContent = error.message; status(error.message); }
 };
 $('offline-download').hidden = location.protocol === 'file:';
 initTeacher();
 initDictation();
 initSharedReview();
}

let shuffleUndo = null;
function canUndoShuffle(mode) {
 const study = mode === 'study', snapshot = study ? studyState?.shuffleUndo : shuffleUndo;
 const list = study ? studyState?.list : selectedList(), values = study ? studyState?.rows : list?.words;
 return !!snapshot && snapshot.workspace === state && snapshot.list === list && (study ? snapshot.study === studyState : list.packVersion === snapshot.version) &&
  values?.length === snapshot.after.length && values.every((value,index) => value === snapshot.after[index]);
}

async function saveWordOrder(list, words, receipt) {
 const selection = state.settings.selected[list.id];
 list.words = words;
 if (Array.isArray(selection)) state.settings.selected[list.id] = words.filter(word => selection.includes(word));
 if (receipt) list.orderReceipt = receipt; else delete list.orderReceipt;
 list.packVersion = (list.packVersion || 1)+1;
 list.audioStatus = null; list.updatedAt = now(); save(); renderSetup();
 await autosaveTeacherSet(list);
}

async function openShuffle(mode) {
 const workspace = state, study = mode === 'study', list = study ? studyState?.list : selectedList();
 const values = study ? studyState?.rows : list?.words;
 if (!list || !values || values.length < 2) return;
 try {
  if (!study && list.remoteConflict) throw Error('Reload saved sets before changing this set’s order.');
  const ordered = shuffledCopy(values);
  if (ordered.every((value,index) => value === values[index])) {
   if (study) $('study-shuffle-status').textContent = 'Shuffled. The order happened to stay the same.';
   else status('Shuffled. The order happened to stay the same.');
   return;
  }
  const snapshot = {workspace,list,before:values.slice(),after:ordered,receipt:list.orderReceipt,version:(list.packVersion || 1)+1};
  if (study) {
   snapshot.study = studyState; studyState.shuffleUndo = snapshot;
   studyState.rows = ordered; studyState.index = 0; studyState.revealed = false;
   delete state.studyReceipt; save(); renderStudy();
   $('study-shuffle-status').textContent = 'Cards shuffled.';
  } else {
   shuffleUndo = snapshot;
   await saveWordOrder(list,ordered);
   if (workspace === state && selectedList() === list) status('Word order shuffled.');
  }
 } catch (error) {
  if (workspace !== state) return;
  if (study) $('study-shuffle-status').textContent = error.message; else status(error.message);
 }
}

async function undoWordShuffle(mode) {
 if (!canUndoShuffle(mode)) return;
 const workspace = state, study = mode === 'study', snapshot = study ? studyState.shuffleUndo : shuffleUndo;
 try {
  if (study) {
   studyState.rows = snapshot.before; studyState.index = 0; studyState.revealed = false;
   delete studyState.shuffleUndo; save(); renderStudy(); $('study-shuffle').focus();
   $('study-shuffle-status').textContent = 'Previous card order restored.';
  } else {
   if (snapshot.list.remoteConflict) throw Error('Reload saved sets before changing this set’s order.');
   shuffleUndo = null;
   const saved = saveWordOrder(snapshot.list,snapshot.before,snapshot.receipt);
   $('shuffle-words').focus();
   await saved;
   if (workspace === state && selectedList() === snapshot.list) status('Previous word order restored.');
  }
 } catch (error) { if (workspace === state) status(error.message); }
}

function recordLegacySpelling(listId, word, correct) {
 const key = wordKey(word);
 if (!state.learning[listId]) state.learning[listId] = dictionary();
 const progress = state.learning[listId];
 if (!Object.prototype.hasOwnProperty.call(progress, key)) progress[key] = {};
 const wordProgress = progress[key];
 const stats = wordProgress.spelling || {attempts: 0, correct: 0, streak: 0, misses: 0, mastered: false, lastAt: 0, interval: 0, nextReview: 0};
 stats.attempts++;
 stats.correct += Number(correct);
 stats.streak = correct ? stats.streak + 1 : 0;
 stats.misses += Number(!correct);
 stats.lastAt = Date.now();
 const intervals = [1, 3, 7, 14, 30];
 if (!stats.mastered && stats.streak >= 2 || stats.mastered && (!correct || stats.nextReview <= stats.lastAt)) {
  const previous = intervals.indexOf(stats.interval);
  stats.interval = intervals[Math.max(0, Math.min(intervals.length - 1, previous + (correct ? 1 : -1)))];
  stats.nextReview = stats.lastAt + stats.interval * 86400000;
  stats.mastered = true;
 }
 wordProgress.spelling = stats;
}
