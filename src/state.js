const MAX_IMPORT = 64 * 1024 * 1024;
let storageIssue = '';
const LEGACY_BACKUP_KEY = 'spell.state.v1.backup';
const dictionary = value => Object.assign(Object.create(null), value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

function newListId() {
 const bytes = new Uint8Array(12);
 crypto.getRandomValues(bytes);
 return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function listMetadata(list) {
 const keys = ['vocabKey', 'vocabBackend', 'packId', 'packVersion', 'remoteVersion', 'remoteConflict', 'sharedOrigin', 'orderReceipt'];
 const result = {};
 for (const key of keys) if (Object.prototype.hasOwnProperty.call(list, key)) result[key] = list[key];
 const settings = GenerationSettings.validate(list.generationSettings);
 if (settings) result.generationSettings = settings;
 return result;
}

function restoreLearningFields(target, source) {
 if (source.v !== 2) return target;
 for (const key of ['learning', 'familiar']) target[key] = dictionary(source[key]);
 if (isObject(source.learningCheckpoint) && typeof source.learningCheckpoint.key === 'string' &&
     typeof source.learningCheckpoint.listId === 'string' && ['indexedDB', 'localStorage'].includes(source.learningCheckpoint.backend)) {
  target.learningCheckpoint = source.learningCheckpoint;
 }
 if (isObject(source.studyReceipt)) target.studyReceipt = source.studyReceipt;
 if (Array.isArray(source.learningHistory)) {
  target.learningHistory = source.learningHistory.filter(row => isObject(row) && typeof row.listId === 'string' && isObject(row.report)).slice(-100);
 }
 if (isObject(source.learningSession) && typeof source.learningSession.listId === 'string' &&
     Learning.sessionOK(source.learningSession.session)) target.learningSession = source.learningSession;
 return target;
}

function loadState() {
 try {
  const text = localStorage.getItem(KEY);
  if (!text) return blank();
  const original = JSON.parse(text);
  if (!original || ![0, 1, 2].includes(original.v)) throw Error('Unsupported saved state.');
  const migrated = clean(original);
  if (original.v < 2) {
   const verified = clean(JSON.parse(JSON.stringify(migrated)));
   if (JSON.stringify(verified) !== JSON.stringify(migrated)) {
    throw Error('Migration could not be verified.');
   }
   try {
    const recoveryKey = KEY.startsWith('spell.teacher:') ? KEY + '.v1.backup' : LEGACY_BACKUP_KEY;
    const originalBackup = localStorage.getItem(recoveryKey);
    if (originalBackup === null) localStorage.setItem(recoveryKey, text);
    else if (originalBackup !== text) localStorage.setItem(recoveryKey + '.' + Date.now(), text);
    localStorage.setItem(KEY, JSON.stringify(migrated));
   } catch (error) {
    storageIssue = 'The upgrade could not save a recovery copy. The original spelling data is still in this browser.';
    storageOK = false;
   }
  }
  return migrated;
 } catch (error) {
  storageIssue = 'Saved spelling data could not be read. The original data remains in browser storage.';
  storageOK = false;
  return blank();
 }
}

function orderFromReceipt(receipt, count) {
 if (!receipt || receipt.status !== 'complete' || !Array.isArray(receipt.result?.random?.data)) throw Error('Choose a completed RANDOM.ORG shuffle receipt.');
 const positions = receipt.result.random.data;
 if (positions.length !== count || new Set(positions).size !== count ||
     !positions.every(value => Number.isInteger(value) && value >= 1 && value <= count)) {
  throw Error('Choose a shuffle receipt containing each position from 1 through ' + count + '.');
 }
 return positions.map(value => value - 1);
}

async function readImport(file) {
 if (!file || file.size > MAX_IMPORT) throw Error('Choose a file smaller than 64 MB.');
 return JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
}
const LARGE_CHECKPOINT = 600000;
let checkpointChain = Promise.resolve();

function writeLocalState(value) {
 try {
  localStorage.setItem(KEY, JSON.stringify(value));
  return true;
 } catch (error) {
  storageOK = false;
  warning();
  return false;
 }
}

function checkpointActive(entry, checkpoint, text) {
 const marker = {key: checkpoint?.key || 'session:' + entry.listId + ':' + entry.session.startedAt,
  backend: checkpoint?.backend, listId: entry.listId};
 checkpointChain = checkpointChain.catch(() => {}).then(async () => {
  if (state.learningSession !== entry) return;
  const store = await getStore(marker.backend);
  await store.put(marker.key, JSON.parse(text));
  if (state.learningSession !== entry) { await store.remove(marker.key); return; }
  marker.backend = store.kind;
  state.learningCheckpoint = marker;
  if (!writeLocalState({...state, learningSession: null})) throw Error('Could not save the checkpoint reference.');
 }).catch(error => {
  warning();
  $('storage-warning').hidden = false;
  $('storage-warning').textContent = 'The latest session checkpoint could not be saved. ' + error.message;
 });
}

function saveState() {
 if (studentPreview) return true;
 const entry = state.learningSession;
 if (!entry) {
  delete state.learningCheckpoint;
  return writeLocalState(state);
 }
 const text = JSON.stringify(entry);
 if (state.learningCheckpoint || text.length > LARGE_CHECKPOINT) {
  const marker = state.learningCheckpoint;
  if (marker && !writeLocalState({...state, learningSession: null})) return false;
  checkpointActive(entry, marker, text);
  return true;
 }
 return writeLocalState(state);
}

async function recoverCheckpoint(render = true) {
 const marker = state.learningCheckpoint;
 if (!marker || state.learningSession) return;
 try {
  const data = await (await getStore(marker.backend)).get(marker.key);
  if (!data || data.listId !== marker.listId || !Learning.sessionOK(data.session)) throw Error('An unfinished session could not be read.');
  state.learningSession = data;
  listId = data.listId;
  if (render) { renderSetup(); pauseLearning(); }
 } catch (error) {
  storageOK = false;
  warning();
  $('storage-warning').textContent = error.message + ' Reload to try the saved checkpoint again.';
  if (render) show('setup-screen');
 }
}

function archiveQuestions(entry) {
 const key = 'history:' + entry.listId + ':' + entry.session.startedAt;
 getStore('indexedDB').then(store => store.put(key, {
  listId: entry.listId, sessionId: entry.session.startedAt, questions: entry.session.results
 })).catch(() => {});
}
