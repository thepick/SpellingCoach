const vocabularyStores = new Map();
let vocabCache = {key: '', records: null};
let pendingPack = null;
let undoVocabulary = null;
const wordKey = Vocabulary.wordKey;
const recordKey = list => list.vocabKey || 'list:' + list.id;
function getStore(backend) {
 if (!vocabularyStores.has(backend)) {
  vocabularyStores.set(backend, Vocabulary.openStore(globalThis, backend).catch(error => {
   vocabularyStores.delete(backend);
   throw error;
  }));
 }
 return vocabularyStores.get(backend);
}
const titleForType = {
 dictation: 'Listen, then spell',
 'missing-word': 'Fill in the blank',
 'definition-recall': 'Name the word',
 'sentence-choice': 'Choose the missing word',
 'meaning-choice': 'Choose the meaning',
 'word-bank': 'Use the word bank'
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
 const study = options.mode === 'study', test = !study && options.type === 'test';
 const available = records.filter(row => row.vocabulary && (!test || row.vocabulary.status === 'approved')).length;
 $('open-vocabulary').disabled = !list;
 $('open-report').disabled = !list;
 $('sample-pack').hidden = state.lists.some(row => row.packId === SAMPLE_PACK.id);
 $('type-setting').hidden = study;
 $('difficulty-setting').hidden = study || test || options.mode === 'spelling';
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
 if (options.mode === 'study') {
  beginStudy(list, records);
  return;
 }
 if (options.mode === 'spelling' && options.type === 'practice') {
  start(records.map(row => row.word), list);
  return;
 }
 const preview = Learning.createSession(records, options, learningProgress(list));
 if (options.type === 'test' && preview.questions.some(question => question.type === 'dictation') && !speech) {
  status('Audio is unavailable. A spelling test requires speech synthesis.');
  return;
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
 const session = Learning.createSession(records, options, dueLists ? dueLists.progress : learningProgress(list));
 if (!session.questions.length) { status('There are no questions for this selection.'); return; }
 state.learningSession = {listId: list.id, listName: list.name, session, dueLists: dueLists?.owners || null};
 save();
 renderLearning(true);
}

let audioReady = false;
let audioQuestion = null;
let lastHint = null;
const learningEntry = () => state.learningSession;

function playQuestion(initial, slow) {
 const entry = learningEntry();
 const session = entry?.session;
 const question = session && Learning.current(session);
 if (!question || !initial && !session.settings.audioReplay || session.feedback) return;
 const message = Learning.audio(question, {choices: true});
 if (!message) return;
 const failed = () => {
  if (audioQuestion !== question) return;
  $('learning-audio-error').textContent = question.type === 'dictation' ?
   'Audio is unavailable. Pause or end this session to keep your place.' : 'Audio is unavailable. You can read the question and continue.';
  $('learning-audio-error').hidden = false;
 };
 speak(message, slow ? state.settings.rate * .65 : state.settings.rate, failed, () => {
  if (audioQuestion !== question) return;
  audioReady = true;
  $('learning-audio-error').hidden = true;
  $('learning-submit').disabled = false;
  $('learning-skip').disabled = false;
 });
}

function renderLearning(play) {
 const entry = learningEntry();
 if (!entry) return;
 const session = entry.session, question = Learning.current(session);
 if (!question) { finishLearningReport(); return; }
 const test = session.type === 'test', result = session.feedback, correction = result?.correctionRequired;
 if (question !== audioQuestion) { audioQuestion = question; audioReady = false; lastHint = Learning.lastHint(session); }
 show('learning-screen');
 $('learning-label').textContent = entry.listName + ' · ' + (test ? 'Test' : 'Practice');
 $('learning-title').textContent = titleForType[question.type];
 $('learning-count').textContent = 'Question ' + (session.index + 1) + (test ? ' of ' + session.questions.length : '');
 $('learning-prompt').textContent = question.type === 'dictation' ? 'Listen to the word, then type it.' : question.prompt;
 $('learning-audio-actions').hidden = !session.settings.audioReplay || !!result;
 $('learning-audio').disabled = !speech;
 $('learning-slow').disabled = !speech;
 $('learning-audio-error').hidden = speech;
 if (!speech) $('learning-audio-error').textContent = 'Audio is unavailable.';
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
  label.append(input, document.createTextNode(choice));
  $('learning-choices').append(label);
 }
 $('learning-typed').hidden = choices.length > 0 && !correction;
 $('learning-input').value = '';
 $('learning-submit').textContent = correction ? 'Check correction' : test ? 'Submit answer' : 'Check answer';
 $('learning-input').setCustomValidity('');
 $('learning-submit').disabled = test && question.type === 'dictation' && !audioReady;
 $('learning-skip').disabled = $('learning-submit').disabled;
 $('learning-skip').hidden = !!result;
 $('learning-hint').hidden = test || !!result || session.revealed;
 $('learning-hint-text').hidden = !lastHint || !!result;
 $('learning-hint-text').textContent = lastHint?.text || '';
 const box = $('learning-feedback');
 box.hidden = !result;
 box.className = 'feedback' + (result ? result.correct ? ' good' : ' bad' : '');
 if (result) {
  const message = {'other-word': 'That is a different word.', 'word-form': 'Check the word form.', 'likely-spelling': 'Check the spelling.'};
  box.textContent = (result.correct ? (result.assisted ? 'Correct with help.' : 'Correct.') :
   (message[result.kind] || 'Incorrect.') + ' Answer: ' + result.answer + '.') +
   (result.explanation ? ' ' + result.explanation : '') + (correction ? ' Type the answer to continue.' : '');
 }
 $('learning-next').hidden = !result || !!correction;
 $('learning-end').hidden = test;
 $('learning-pause').textContent = test ? 'Save and pause' : 'Pause';
 $('learning-end').textContent = 'End practice';
 if (play) {
  $('learning-title').focus();
  if (question.type === 'dictation') playQuestion(true, false);
 }
}

function submitLearning(value) {
 const item = learningEntry();
 if (!item || $('learning-submit').disabled) return;
 const session = item.session;
 if (session.feedback?.correctionRequired) {
  if (!Learning.correct(session, value)) { $('learning-input').setCustomValidity('Type the answer shown above.'); $('learning-input').reportValidity(); return; }
 } else {
  if (!Learning.submit(session, value)) return;
 }
 save();
 renderLearning(session.type === 'test');
 if (!session.feedback?.correctionRequired && !$('learning-next').hidden) $('learning-next').focus();
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
 showReport(report, entry);
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
 $('report-title').textContent = report ? (report.type === 'test' ? report.status === 'unfinished' ? 'Unfinished test' : 'Test results' : 'Practice results') : 'Learning progress';
 $('report-exit').textContent = report?.status === 'unfinished' ? 'Leave unfinished test' : 'Return to setup';
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
  if (mode === 'spelling') start(selected.map(row => row.word), list);
  else beginLearning(list, selected, {...coachOptions(), mode, type: 'practice', difficulty: 'adaptive'});
 };
 show('report-screen');
 $('report-title').focus();
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
 $('study-title').focus();
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
 show('study-screen');
 $('study-count').textContent = card ? 'Card ' + (study.index + 1) + ' of ' + cards.length : 'No unfamiliar cards in this selection.';
 $('study-front').textContent = card?.front || '';
 $('study-back').hidden = !study.revealed || !card;
 $('study-back').replaceChildren();
 if (card && study.revealed) {
  for (const line of [card.back, card.partOfSpeech, ...card.examples].filter(Boolean)) {
   const p = document.createElement('p'); p.textContent = line; $('study-back').append(p);
  }
 }
 $('study-reveal').textContent = study.revealed ? 'Hide answer' : 'Reveal answer';
 $('study-listen').disabled = !card || !speech;
 $('study-reveal').disabled = !card;
 $('study-familiar').disabled = !card || reverse && !study.revealed;
 $('study-familiar').textContent = card && state.familiar[study.list.id]?.includes(wordKey(card.word)) ? 'Mark as unfamiliar' : 'Mark as familiar';
 $('study-prev').disabled = study.index < 1;
 $('study-next').disabled = study.index + 1 >= cards.length;
 $('study-shuffle').disabled = study.rows.length < 2;
}

function outputPack(list, records) {
 return Vocabulary.validatePack({kind: 'spellingcoach-pack', v: 1,
  id: list.packId || list.id, version: list.packVersion || 1, name: list.name, words: records});
}

async function saveVocabulary(list, records, metadata) {
 const store = await getStore();
 const before = list.vocabKey, beforeBackend = list.vocabBackend;
 const next = 'list:' + list.id + ':' + newListId();
 await store.put(next, records);
 const snapshot = {...list};
 Object.assign(list, metadata, {vocabKey: next, vocabBackend: store.kind, updatedAt: now()});
 if (!save()) {
  for (const key of Object.keys(list)) delete list[key];
  Object.assign(list, snapshot);
  await store.remove(next).catch(() => {});
  throw Error('Browser storage could not save your changes.');
 }
 if (before) getStore(beforeBackend).then(oldStore => oldStore.remove(before)).catch(() => {});
 renderSetup();
}

function previewPack(pack) {
 pendingPack = Vocabulary.validatePack(pack);
 $('pack-preview-text').textContent = pendingPack.name + ' · ' + pendingPack.words.length + ' words · Version ' + pendingPack.version +
  ' · ' + pendingPack.words.filter(row => row.vocabulary?.status === 'approved').length + ' approved definitions';
 $('pack-preview-status').textContent = '';
 $('pack-preview').showModal();
}

async function importPack(pack) {
 let list = state.lists.find(row => row.packId === pack.id);
 const fresh = !list;
 const before = list && structuredClone({progress: state.progress[list.id], learning: state.learning[list.id],
  familiar: state.familiar[list.id], selection: state.settings.selected[list.id]});
 const previousListId = listId;
 const words = pack.words.map(row => row.word);
 if (fresh) {
  list = {id: newListId(), name: pack.name, words, defs: dictionary(), updatedAt: now()};
 } else {
  const current = outputPack(list, await loadVocabulary(list));
  const plan = Vocabulary.planPackUpdate(current, pack);
  if (plan.action === 'older' || plan.action === 'unchanged') {
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
  await saveVocabulary(list, pack.words, {name: pack.name, words, packId: pack.id, packVersion: pack.version});
 } catch (error) {
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
 const packs = [];
 for (const list of state.lists) if (list.vocabKey) packs.push({listId: list.id, records: await loadVocabulary(list)});
 const archived = await getStore('indexedDB').then(async store => {
  const entries = await Promise.all(state.learningHistory.filter(row => row.report.status === 'finished')
   .map(row => store.get('history:' + row.listId + ':' + row.id)));
  return entries.filter(Boolean);
 }).catch(() => []);
 const snapshot = {...state};
 delete snapshot.learningCheckpoint;
 const contents = JSON.stringify({kind: 'spellingcoach-backup', v: 1, state: snapshot, packs, questionHistory: archived,
  theme: themePreference.value});
 if (new Blob([contents]).size > MAX_IMPORT) throw Error('The backup is too large. Export individual vocabulary packs first.');
 download('WordLab full backup.json', contents, 'application/json');
}

async function restoreFullBackup(backup) {
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
 const old = state, stagedKeys = [];
 try {
  for (const list of restored.lists) if (staged.has(list.id)) {
   list.vocabKey = 'list:' + list.id + ':' + newListId();
   list.vocabBackend = store.kind;
   stagedKeys.push(list.vocabKey);
   await store.put(list.vocabKey, staged.get(list.id));
  }
  state = restored;
  if (!save()) throw Error('Browser storage could not restore the backup.');
 } catch (error) {
  state = old;
  if (store) for (const key of stagedKeys) await store.remove(key).catch(() => {});
  throw error;
 }
 if (Array.isArray(backup.questionHistory)) {
  await getStore('indexedDB').then(async historyStore => {
   for (const entry of backup.questionHistory.slice(-100)) {
    if (restored.lists.some(list => list.id === entry?.listId) && Number.isSafeInteger(entry.sessionId) &&
        Array.isArray(entry.questions) && entry.questions.length <= 3200) {
     await historyStore.put('history:' + entry.listId + ':' + entry.sessionId, entry);
    }
   }
  }).catch(() => {});
 }
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
const editorPageSize = 30;
const fields = {
 definition: 'vocab-definition', examples: 'vocab-examples', meaningDistractors: 'vocab-distractors',
 acceptedSpellings: 'vocab-variants', partOfSpeech: 'vocab-pos', readingLevel: 'vocab-grade'
};
const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const editorStatusText = message => { $('vocab-status').textContent = message; };

function renderVocabularyEditor(preferred) {
 const search = wordKey($('vocab-search').value), filter = $('vocab-filter').value;
 const chosen = preferred || $('vocab-word').value;
 const filtered = editorRecords.filter(row => wordKey(row.word).includes(search) &&
  (!filter || (filter === 'draft' ? row.vocabulary && row.vocabulary.status !== 'approved' :
   (row.vocabulary?.status || 'missing') === filter)));
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
 $('vocab-prev').disabled = !editorPage;
 $('vocab-next').disabled = editorPage >= lastPage;
 const select = $('vocab-word');
 select.replaceChildren();
 for (const row of page) {
  const status = row.vocabulary?.status === 'approved' ? 'Approved' : row.vocabulary ? 'Review' : 'Missing';
  select.add(new Option(row.word + ' · ' + status + (row.vocabulary ? ' · ' + row.vocabulary.clozeQuestions.length + ' sentences' : ''), row.word));
 }
 select.value = page.some(row => row.word === chosen) ? chosen : page[0]?.word || '';
 $('vocab-undo').disabled = !undoVocabulary;
 $('vocab-bulk').disabled = !editorRecords.some(row => row.vocabulary && row.vocabulary.status !== 'approved');
 renderEditFields();
}

function renderEditFields() {
 const row = editorRecords.find(item => item.word === $('vocab-word').value);
 $('vocab-form').hidden = !row;
 if (!row) return;
 const v = row.vocabulary;
 for (const [key, id] of Object.entries(fields)) {
  const value = v?.[key];
  $(id).value = Array.isArray(value) ? value.join('\n') : value || (key === 'readingLevel' ? '5' : '');
 }
 $('vocab-cloze').value = (v?.clozeQuestions || []).map(question => question.sentence).join('\n');
 $('vocab-explanations').value = (v?.clozeQuestions || []).map(question => question.explanation).join('\n');
 $('vocab-regenerate').disabled = !v || ai.role !== 'teacher';
}

async function changeVocabulary(next, preferred) {
 const list = editorList, before = editorRecords;
 const oldLearning = structuredClone(state.learning[list.id] || {});
 const oldFamiliar = (state.familiar[list.id] || []).slice();
 const oldRows = new Map(before.map(row => [wordKey(row.word), row.vocabulary]));
 for (const row of next) {
  const key = wordKey(row.word), previous = oldRows.get(key);
  if (previous && (previous.senseId !== row.vocabulary?.senseId || previous.definition !== row.vocabulary.definition ||
      previous.partOfSpeech !== row.vocabulary.partOfSpeech)) {
   if (state.learning[list.id]?.[key]) delete state.learning[list.id][key].vocabulary;
   if (state.familiar[list.id]) state.familiar[list.id] = state.familiar[list.id].filter(word => word !== key);
  }
 }
 try {
  await saveVocabulary(list, next, {packVersion: (list.packVersion || 0) + 1});
 } catch (error) {
  state.learning[list.id] = oldLearning;
  state.familiar[list.id] = oldFamiliar;
  throw error;
 }
 editorRecords = next;
 undoVocabulary = before;
 renderVocabularyEditor(preferred);
}

async function openVocabularyEditor() {
 const list = selectedList();
 if (!list) return;
 try {
  editorRecords = await loadVocabulary(list);
  if (selectedList() !== list) return;
  editorList = list; editorPage = 0; undoVocabulary = null;
  $('vocab-search').value = ''; $('vocab-filter').value = '';
  editorStatusText('');
  renderVocabularyEditor();
  $('vocab-dialog').showModal();
 } catch (error) { status(error.message); }
}

function initCoach() {
 for (const id of ['learning-mode', 'learning-difficulty', 'learning-type', 'test-per-word', 'test-choices', 'test-audio-replay']) {
  $(id).addEventListener('change', updateCoachSetup);
 }
 $('sample-pack').onclick = () => previewPack(SAMPLE_PACK);
 $('open-vocabulary').onclick = openVocabularyEditor;
 $('open-report').onclick = () => showReport();
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
  lastHint = Learning.hint(entry.session); save();
  $('learning-hint-text').textContent = lastHint?.text || '';
  $('learning-hint-text').hidden = !lastHint;
  if (entry.session.revealed) { $('learning-hint').hidden = true; $('learning-input').focus(); }
 };
 $('learning-next').onclick = () => {
  const entry = learningEntry(); if (!entry) return;
  Learning.advance(entry.session); save(); renderLearning(true);
 };
 $('study-exit').onclick = backToSetup;
 for (const id of ['study-reverse', 'study-unfamiliar']) $(id).onchange = () => {
  studyState.index = 0; studyState.revealed = false; renderStudy();
 };
 $('study-listen').onclick = () => {
  const card = studyCards()[studyState.index];
  if (card) speak(studyState.revealed ? card.audio : card.frontAudio);
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
 };
 $('study-shuffle').onclick = () => openShuffle('study');
 $('shuffle-close').onclick = () => $('shuffle-dialog').close();
 $('shuffle-form').onsubmit = async event => {
  event.preventDefault();
  const list = selectedList(), mode = $('shuffle-dialog').dataset.mode;
  if (!list) return;
  const values = mode === 'study' ? studyState.rows : list.words;
  try {
   const receipt = await readImport($('shuffle-file').files[0]);
   const positions = orderFromReceipt(receipt, values.length);
   const ordered = positions.map(position => values[position]);
   if (mode === 'study') {
    state.studyReceipt = {receipt, words: values.map(row => row.word), listId: list.id};
    studyState.rows = ordered; studyState.index = 0; studyState.revealed = false; save(); renderStudy();
   } else {
    list.orderReceipt = {receipt, words: values.slice()};
    list.words = ordered; list.updatedAt = now(); save(); renderSetup(); status('Saved the new word order.');
   }
   $('shuffle-dialog').close();
  } catch (error) { $('shuffle-error').textContent = error.message; }
 };
 $('vocab-close').onclick = () => $('vocab-dialog').close();
 for (const id of ['vocab-search', 'vocab-filter']) $(id).oninput = () => { editorPage = 0; renderVocabularyEditor(); };
 $('vocab-prev').onclick = () => { editorPage--; renderVocabularyEditor(); };
 $('vocab-next').onclick = () => { editorPage++; renderVocabularyEditor(); };
 $('vocab-word').onchange = () => { editorStatusText(''); renderEditFields(); };
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
   await changeVocabulary(editorRecords.map(row => row.word === word ? {word, vocabulary: record} : row), word);
   editorStatusText('Saved ' + word + '.');
  } catch (error) { editorStatusText(error.message); }
  finally { if (submitter) submitter.disabled = false; }
 };
 $('vocab-undo').onclick = async () => {
  if (!undoVocabulary) return;
  try { await changeVocabulary(undoVocabulary, $('vocab-word').value); editorStatusText('Restored the previous version.'); }
  catch (error) { editorStatusText(error.message); }
 };
 $('vocab-bulk').onclick = async () => {
  if (!confirm('Approve all drafts in this list that you have reviewed?')) return;
  try {
   const next = editorRecords.map(row => row.vocabulary && row.vocabulary.status !== 'approved' ?
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
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  try {
   const data = await readImport(file);
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
}

function openShuffle(mode) {
 const values = mode === 'study' ? studyState.rows : selectedList()?.words || [];
 if (values.length < 2) return;
 $('shuffle-help').textContent = 'Import a random permutation containing the positions 1 through ' + values.length + '. The app maps numbers to words locally.';
 $('shuffle-error').textContent = '';
 $('shuffle-form').reset();
 $('shuffle-dialog').dataset.mode = mode;
 $('shuffle-dialog').showModal();
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
