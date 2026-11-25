let dictationPlayer = null;
let dictationRequest = 0;
let dictationDownload = null;
let publishedRecordingCache = null;

function stopRecording() {
 dictationRequest++;
 if (dictationDownload) { dictationDownload.abort(); dictationDownload = null; }
 if (dictationPlayer) {
  dictationPlayer.audio.onplaying = null;
  dictationPlayer.audio.onended = null;
  dictationPlayer.audio.onerror = null;
  dictationPlayer.audio.pause();
  if (dictationPlayer.url.startsWith('blob:')) URL.revokeObjectURL(dictationPlayer.url);
  dictationPlayer = null;
 }
}

function readRecording(listId, word, vocabulary) {
 return getStore('indexedDB').then(store => store.get(Dictation.recordingKey(listId, word, vocabulary)))
  .catch(() => null);
}

async function playRecording(recording, rate, request, onStart, onError) {
 if (request !== dictationRequest) return;
 if (speech) speechSynthesis.cancel();
 const url = typeof recording === 'string' ? recording : URL.createObjectURL(recording);
 const audio = new Audio(url);
 dictationPlayer = {audio, url};
 audio.playbackRate = rate;
 if (onStart) audio.onplaying = () => { if (request === dictationRequest) onStart(); };
 audio.onended = () => { if (request === dictationRequest) stopRecording(); };
 audio.onerror = () => {
  if (request !== dictationRequest) return;
  const error = audio.error;
  stopRecording();
  if (onError) onError(error);
 };
 await audio.play();
}

function sharedAudioPath(listId, word, type, spoken) {
 const review = sharedReview;
 if (!review || findPackList(review.pack.id, review.origin)?.id !== listId) return null;
 const bundled = review.origin === location.origin && Dictation.publishedClip(review.pack, word, type, spoken);
 if (bundled) return bundled;
 if (!review.audio?.size) return null;
 const index = review.pack.words.findIndex(row => row.word === word);
 if (index < 0) return null;
 const skill = type === 'dictation' ? 'spelling' : type === 'study' ? 'study' : 'vocabulary';
 const prompt = Learning.practiceAudioPrompts(review.pack.words[index], index)
  .find(item => item.skill === skill && item.text === spoken && review.audio.has(item.key));
 return prompt ? review.origin + '/api/packs/' + encodeURIComponent(review.pack.id) + '/audio/' + review.pack.version + '/' + prompt.key : null;
}

async function playPublishedRecording(path, slow, onError, onStart) {
 stopRecording();
 const request = dictationRequest;
 const workspace = state;
 let recording = publishedRecordingCache?.path === path && publishedRecordingCache.workspace === workspace ? publishedRecordingCache.recording : null;
 const evict = () => {
  if (publishedRecordingCache?.path === path && publishedRecordingCache.workspace === workspace && publishedRecordingCache.recording === recording) publishedRecordingCache = null;
 };
 const failed = error => {
  if (error?.code === 3 || error?.code === 4) evict();
  onError();
 };
 const download = recording ? null : new AbortController();
 if (download) dictationDownload = download;
 const deadline = download ? setTimeout(() => download.abort(), 45000) : null;
 try {
  if (!recording) {
   const response = await fetch(path, {signal:download.signal});
   if (request !== dictationRequest || state !== workspace) return;
   if (!response.ok) throw Error('The recording could not download.');
   recording = await response.blob();
   if (request !== dictationRequest || state !== workspace) return;
   if (!recording.size) throw Error('The recording is empty.');
   publishedRecordingCache = {path,workspace,recording};
  }
  await playRecording(recording, slow ? .75 : 1, request, onStart, failed);
 } catch (error) {
  if (request !== dictationRequest || state !== workspace) return;
  if (error?.name === 'NotSupportedError') evict();
  stopRecording();
  onError();
 } finally {
  if (deadline !== null) clearTimeout(deadline);
  if (dictationDownload === download) dictationDownload = null;
 }
}

async function dictate(listId, word, vocabulary, rate, onError, onStart) {
 stopRecording();
 const request = dictationRequest;
 const recording = await readRecording(listId, word, vocabulary);
 if (request !== dictationRequest) return;
 if (recording) {
  try { await playRecording(recording, rate, request, onStart, () => speak(word, rate, onError, onStart)); return; }
  catch (error) {
   if (request !== dictationRequest) return;
   stopRecording();
  }
 }
 speak(word, rate, onError, onStart);
}

async function playStudyRecordings(card, example) {
 const spoken = example || card.word, study = studyState;
 const reverseHidden = $('study-reverse').checked && !study.revealed && !example;
 const clip = !reverseHidden && sharedAudioPath(study.list.id,card.word,example ? 'study' : 'dictation',spoken);
 const failed = () => {
  if (studyState !== study) return;
  let message = $('study-audio-status');
  if (!message) { message = document.createElement('p'); message.id = 'study-audio-status'; message.setAttribute('role','status'); $('study-back').after(message); }
  message.textContent = 'The prepared recording is unavailable. Ask your teacher to prepare it, or read the example.';
 };
 if ($('study-audio-status')) $('study-audio-status').textContent = '';
 if (clip) await playPublishedRecording(clip,false,failed);
 else if (sharedReview?.preparedAudio) failed();
 else speak(example || (study.revealed ? card.audio : card.frontAudio),undefined,failed);
}

function editorRecordingTarget() {
 const word = $('vocab-word').value;
 const row = editorRecords.find(item => item.word === word);
 return row && editorList ? {listId: editorList.id, word, vocabulary: row.vocabulary, workspace:state, token:ai.token} : null;
}

async function renderRecordingControls() {
 const target = editorRecordingTarget();
 $('recording-preview').disabled = true;
 $('recording-remove').disabled = true;
 if (!target) return;
 const clip = await readRecording(target.listId, target.word, target.vocabulary);
 if (editorList?.id !== target.listId || $('vocab-word').value !== target.word) return;
 $('recording-preview').disabled = !clip;
 $('recording-remove').disabled = !clip;
}

function updateTroyControls() {
 const teacher = ai.role === 'teacher';
 const manual = teacher && !!ai.teacher?.isAdmin;
 $('troy-sign-in').hidden = teacher;
 $('generate-troy').disabled = !manual || !ai.config.dictationEnabled || generatingTroy ||
  !$('troy-sentence').value.trim();
 $('troy-help').textContent = teacher && !manual ? 'Recordings prepare automatically when you save this set. Check Prepared recordings in your online vocabulary tools.' : teacher && !ai.config.dictationEnabled
  ? 'Audio generation is unavailable. You can attach a WAV file.'
  : 'Use the exact spelling word in a sentence that shows its meaning.';
}

function prefillTroySentence(row) {
 $('troy-sentence').value = row.vocabulary?.examples.find(sentence => sentence.length <= 200 &&
  Dictation.containsTarget(sentence, row.word)) || '';
 updateTroyControls();
}

let generatingTroy = false;
async function saveRecording(target, bytes) {
 if (target.workspace !== state || target.token !== ai.token) throw Error('The workspace changed. Recording was not saved.');
 Dictation.validateRecording(bytes);
 const key = Dictation.recordingKey(target.listId, target.word, target.vocabulary);
 const store = await getStore('indexedDB');
 if (target.workspace !== state || target.token !== ai.token) throw Error('The workspace changed. Recording was not saved.');
 await store.put(key, new Blob([bytes], {type:'audio/wav'}));
}

function initDictation() {
 $('vocab-dialog').addEventListener('close', stopRecording);
 $('troy-sentence').oninput = updateTroyControls;
 $('troy-sign-in').onclick = () => {
  $('vocab-dialog').close();
  $('open-teacher').click();
 };
 $('generate-troy').onclick = async () => {
  const target = editorRecordingTarget(), sentence = $('troy-sentence').value.trim();
  if (!target || generatingTroy || ai.role !== 'teacher' || !ai.config.dictationEnabled) return;
  generatingTroy = true;
  updateTroyControls();
  editorStatusText('Generating audio for “' + target.word + '”…');
  try {
   const bytes = await service('/admin/dictation', {method:'POST', audio:true, body:{word:target.word, sentence}});
   await saveRecording(target, bytes);
   editorStatusText('Audio attached to “' + target.word + '”. Listen to check the pronunciation.');
  } catch (error) { editorStatusText(error.message); }
  finally { generatingTroy = false; updateTroyControls(); renderRecordingControls(); }
 };
 $('recording-file').onchange = async event => {
  const input = event.target, target = editorRecordingTarget(), file = input.files[0];
  input.value = '';
  if (!file || !target) return;
  try {
   if (file.size > Dictation.MAX_WAV_BYTES) throw Error('Choose a WAV file up to 1 MB.');
   const bytes = await file.arrayBuffer();
   Dictation.validateRecording(bytes);
   await saveRecording(target, bytes);
   editorStatusText('Saved a dictation recording for “' + target.word + '”.');
  } catch (error) { editorStatusText(error.message); }
  renderRecordingControls();
 };
 $('recording-preview').onclick = async () => {
  const target = editorRecordingTarget();
  if (!target) return;
  stopRecording();
  const request = dictationRequest;
  try {
   const clip = await readRecording(target.listId, target.word, target.vocabulary);
   if (!clip) throw Error('Recording unavailable.');
   await playRecording(clip, 1, request, undefined, () => editorStatusText('The recording could not play.'));
  } catch (error) {
   if (request === dictationRequest) { stopRecording(); editorStatusText('The recording could not play.'); }
  }
 };
 $('recording-remove').onclick = async () => {
  const target = editorRecordingTarget();
  if (!target) return;
  stopRecording();
  try {
   await (await getStore('indexedDB')).remove(Dictation.recordingKey(target.listId, target.word, target.vocabulary));
   editorStatusText('Recording removed.');
  } catch (error) { editorStatusText(error.message); }
  renderRecordingControls();
 };
}
