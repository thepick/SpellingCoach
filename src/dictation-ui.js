let dictationPlayer = null;
let dictationRequest = 0;

function stopRecording() {
 dictationRequest++;
 if (dictationPlayer) {
  dictationPlayer.audio.pause();
  if (dictationPlayer.url.startsWith('blob:')) URL.revokeObjectURL(dictationPlayer.url);
  dictationPlayer = null;
 }
}

function readRecording(listId, word, vocabulary) {
 return getStore('indexedDB').then(store => store.get(Dictation.recordingKey(listId, word, vocabulary)))
  .catch(() => null);
}

async function playRecording(recording, rate, request, onStart) {
 if (request !== dictationRequest) return;
 if (speech) speechSynthesis.cancel();
 const url = typeof recording === 'string' ? recording : URL.createObjectURL(recording);
 const audio = new Audio(url);
 dictationPlayer = {audio, url};
 audio.playbackRate = rate;
 if (onStart) audio.onplaying = () => { if (request === dictationRequest) onStart(); };
 audio.onended = () => { if (request === dictationRequest) stopRecording(); };
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
 const skill = type === 'dictation' ? 'spelling' : 'vocabulary';
 const prompt = Learning.practiceAudioPrompts(review.pack.words[index], index)
  .find(item => item.skill === skill && item.text === spoken && review.audio.has(item.key));
 return prompt ? review.origin + '/api/packs/' + encodeURIComponent(review.pack.id) + '/audio/' + review.pack.version + '/' + prompt.key : null;
}

async function playPublishedRecording(path, slow, fallback, onStart) {
 stopRecording();
 const request = dictationRequest;
 try {
  await playRecording(path, slow ? .75 : 1, request, onStart);
 } catch {
  if (request !== dictationRequest) return;
  stopRecording();
  fallback();
 }
}

async function dictate(listId, word, vocabulary, rate, onError, onStart) {
 stopRecording();
 const request = dictationRequest;
 const recording = await readRecording(listId, word, vocabulary);
 if (request !== dictationRequest) return;
 if (recording) {
  try { await playRecording(recording, rate, request, onStart); return; }
  catch (error) {
   if (request !== dictationRequest) return;
   stopRecording();
  }
 }
 speak(word, rate, onError, onStart);
}

function editorRecordingTarget() {
 const word = $('vocab-word').value;
 const row = editorRecords.find(item => item.word === word);
 return row && editorList ? {listId: editorList.id, word, vocabulary: row.vocabulary} : null;
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
 $('troy-sign-in').hidden = teacher;
 $('generate-troy').disabled = !teacher || !ai.config.dictationEnabled || generatingTroy ||
  !$('troy-sentence').value.trim();
 $('troy-help').textContent = teacher && !ai.config.dictationEnabled
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
 Dictation.validateRecording(bytes);
 const key = Dictation.recordingKey(target.listId, target.word, target.vocabulary);
 await (await getStore('indexedDB')).put(key, new Blob([bytes], {type:'audio/wav'}));
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
   await playRecording(clip, 1, request);
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
