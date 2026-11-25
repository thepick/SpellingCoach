let dictationPlayer = null;
let dictationRequest = 0;

function stopRecording() {
 dictationRequest++;
 if (dictationPlayer) {
  dictationPlayer.audio.pause();
  URL.revokeObjectURL(dictationPlayer.url);
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
 const url = URL.createObjectURL(recording);
 const audio = new Audio(url);
 dictationPlayer = {audio, url};
 audio.playbackRate = rate;
 if (onStart) audio.onplaying = () => { if (request === dictationRequest) onStart(); };
 audio.onended = () => { if (request === dictationRequest) stopRecording(); };
 await audio.play();
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

function initDictation() {
 $('vocab-dialog').addEventListener('close', stopRecording);
 $('recording-file').onchange = async event => {
  const input = event.target, target = editorRecordingTarget(), file = input.files[0];
  input.value = '';
  if (!file || !target) return;
  try {
   if (file.size > Dictation.MAX_WAV_BYTES) throw Error('Choose a WAV file up to 1 MB.');
   const bytes = await file.arrayBuffer();
   Dictation.validateRecording(bytes);
   const key = Dictation.recordingKey(target.listId, target.word, target.vocabulary);
   await (await getStore('indexedDB')).put(key, new Blob([bytes], {type:'audio/wav'}));
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
