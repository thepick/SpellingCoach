const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Learning = require('../src/learning.js');
const Vocabulary = require('../src/vocabulary.js');

function harness(draws = [0,0]) {
 const elements = new Map();
 function element() {
  const children = new Map(), attrs = {};
  return {hidden:false,disabled:false,value:'',textContent:'',style:{},dataset:{},attributes:attrs,
   reset(){},showModal(){this.open=true;},setAttribute(k,v){attrs[k]=String(v);},setCustomValidity(){},replaceChildren(){},append(){},focus(){},
   classList:{toggle(){}},querySelector(selector){if(!children.has(selector))children.set(selector,element());return children.get(selector);}};
 }
 const context = vm.createContext({Learning,Vocabulary,Uint32Array,console,
  crypto:{getRandomValues(array){assert(draws.length,'Unexpected extra random draw');array[0]=draws.shift();return array;}},
  $:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},
  document:{createElement:element}, setTimeout:()=>0,clearTimeout(){},studentPreview:false,
  show(){},save(){},now:()=> 'new-time',speech:true,sharedReview:null,sharedAudioPath:()=>null,
  state:{lists:[],settings:{selected:{},autoAdvanceMs:0,feedbackMs:0},learning:{}},ai:{role:'teacher',token:'token'},
  renderCorrection(){},renderTiles(){},feedback(){},status(message){context.message=message;},
  autosaveTeacherSet:async()=>{context.saves++;},saves:0,finished:false});
 vm.runInContext(fs.readFileSync('src/state.js','utf8'),context);
 vm.runInContext(fs.readFileSync('src/coach.js','utf8'),context);
 vm.runInContext("let activeList={id:'a',words:['one','two','three'],defs:{one:'First'},packVersion:4,updatedAt:'before'};state.lists=[activeList];state.settings.selected.a=['one','three'];state.progress={a:{words:{one:{mastered:true}}}};selectedList=()=>activeList;renderSetup=()=>{};",context);
 return {context,elements,run:code=>vm.runInContext(code,context)};
}

test('device shuffle preserves values, rejects biased draws, and accepts an unchanged order',()=>{
 const h=harness([4294967295,0,0]);
 assert.equal(h.run("JSON.stringify(shuffledCopy(['a','b','c']))"),'["b","c","a"]');
 const identity=harness([2,1]);
 assert.equal(identity.run("JSON.stringify(shuffledCopy(['a','b','c']))"),'["a","b","c"]');
 assert.equal(identity.run("JSON.stringify(shuffledCopy([]))"),'[]');
});

test('one-click shuffle and undo preserve selected membership, progress and vocabulary while advancing versions',async()=>{
 const h=harness();
 await h.run("openShuffle('list')");
 assert.equal(h.run('JSON.stringify(activeList.words)'),'["two","three","one"]');
 assert.equal(h.run('JSON.stringify(state.settings.selected.a)'),'["three","one"]');
 assert.equal(h.run('state.progress.a.words.one.mastered'),true);
 assert.equal(h.run('activeList.defs.one'),'First');
 assert.equal(h.run('activeList.packVersion'),5);
 assert.equal(h.run("canUndoShuffle('list')"),true);
 await h.run("undoWordShuffle('list')");
 assert.equal(h.run('JSON.stringify(activeList.words)'),'["one","two","three"]');
 assert.equal(h.run('JSON.stringify(state.settings.selected.a)'),'["one","three"]');
 assert.equal(h.run('activeList.packVersion'),6);
 assert.equal(h.context.saves,2);
 assert.equal(h.run("canUndoShuffle('list')"),false);
});

test('shuffle does not revise an unchanged permutation and undo cannot cross edits or workspaces',async()=>{
 const same=harness([2,1]);await same.run("openShuffle('list')");
 assert.equal(same.run('activeList.packVersion'),4);assert.equal(same.context.saves,0);
 const h=harness();await h.run("openShuffle('list')");
 h.run("activeList.words=['edited'];activeList.packVersion++");
 await h.run("undoWordShuffle('list')");assert.equal(h.run('activeList.words[0]'),'edited');
 const other=harness();await other.run("openShuffle('list')");
 other.run('state={...state}');assert.equal(other.run("canUndoShuffle('list')"),false);
});

test('flashcard shuffle and undo stay in the active study selection and never reorder the saved list',async()=>{
 const h=harness();
 h.run("renderStudy=()=>{};studyState={list:activeList,rows:[{word:'one'},{word:'two'},{word:'three'}],index:2,revealed:true};");
 await h.run("openShuffle('study')");
 assert.equal(h.run('JSON.stringify(studyState.rows.map(row=>row.word))'),'["two","three","one"]');
 assert.equal(h.run('JSON.stringify(activeList.words)'),'["one","two","three"]');
 assert.equal(h.run('studyState.revealed'),false);assert.equal(h.context.saves,0);
 await h.run("undoWordShuffle('study')");
 assert.equal(h.run('JSON.stringify(studyState.rows.map(row=>row.word))'),'["one","two","three"]');
 assert.equal(h.run("canUndoShuffle('study')"),false);
});

test('mastery meter shows full mastered words, useful text and exact accessible values',()=>{
 const h=harness();h.run("renderMasteryProgress('learning-mastery',1,3)");
 const meter=h.elements.get('learning-mastery');
 assert.equal(meter.querySelector('.mastery-count').textContent,'1 of 3 words fully mastered');
 assert.equal(meter.querySelector('.mastery-percent').textContent,'33%');
 assert.equal(meter.querySelector('.progressfill').style.width,'33.33333333333333%');
 assert.equal(meter.querySelector('[role="progressbar"]').attributes['aria-valuenow'],'33');
 assert.equal(meter.querySelector('[role="progressbar"]').attributes['aria-valuemax'],'100');
 h.run("renderMasteryProgress('learning-mastery',199,200)");
 assert.equal(meter.querySelector('.mastery-percent').textContent,'99%');
 h.run("renderMasteryProgress('learning-mastery',1,1)");
 assert.equal(meter.querySelector('.mastery-count').textContent,'1 of 1 word fully mastered');
 assert.equal(meter.querySelector('.mastery-percent').textContent,'100%');
});

test('vocabulary and mixed practice meters follow session mastery, including resumed sessions; assessments hide them',()=>{
 for(const mode of ['vocabulary','mixed']) {
  const h=harness();h.context.records=JSON.parse(fs.readFileSync('examples/weekly-vocabulary-sample.json','utf8')).words.slice(0,2);
  h.run("state.learningSession={listId:'a',listName:'Example',session:Learning.createSession(records,{mode:'"+mode+"',phasedVocabulary:true})};renderLearning(false)");
  const meter=h.elements.get('learning-mastery');assert.equal(meter.hidden,false);
  assert.match(meter.querySelector('.mastery-count').textContent,/^0 of 2/);
  for(let turn=0;turn<30;turn++) {
   h.run("Learning.submit(state.learningSession.session,Learning.current(state.learningSession.session).answer);renderLearning(false)");
   const mastered=h.run('Learning.practiceWordProgress(state.learningSession.session).mastered');
   assert.equal(meter.querySelector('[role="progressbar"]').attributes['aria-valuenow'],String(h.run('Math.min(99,Math.round(100*Learning.practiceWordProgress(state.learningSession.session).progress))')));
   if(mastered>0)break;
   h.run('Learning.advance(state.learningSession.session)');
  }
  assert.notEqual(meter.querySelector('[role="progressbar"]').attributes['aria-valuenow'],'0');
  h.run('state.learningSession.session=JSON.parse(JSON.stringify(state.learningSession.session));renderLearning(false)');
  assert.notEqual(meter.querySelector('[role="progressbar"]').attributes['aria-valuenow'],'0');
  h.run("records.forEach(row=>row.vocabulary.status='approved');state.learningSession.session=Learning.createSession(records,{mode:'"+mode+"',type:'test'});renderLearning(false)");
  assert.equal(meter.hidden,true);
 }
});


test('partial progress is distinct from mastered count and reserves 100 percent for completion',()=>{
 const h=harness();h.run("renderMasteryProgress('learning-mastery',0,12,.5)");
 const meter=h.elements.get('learning-mastery'),bar=meter.querySelector('[role="progressbar"]');
 assert.equal(meter.querySelector('.mastery-percent').textContent,'50%');
 assert.equal(meter.querySelector('.mastery-count').textContent,'0 of 12 words fully mastered');
 assert.equal(bar.attributes['aria-valuenow'],'50');
 assert.match(bar.attributes['aria-valuetext'],/50% progress toward mastery/);
 h.run("renderMasteryProgress('learning-mastery',11,12,1)");
 assert.equal(meter.querySelector('.mastery-percent').textContent,'99%');
 h.run("renderMasteryProgress('learning-mastery',12,12,0)");
 assert.equal(meter.querySelector('.mastery-percent').textContent,'100%');
});

test('legacy spelling shows half credit for each first answer and preserves it on restore',()=>{
 const h=harness(),app=fs.readFileSync('src/app.js','utf8');
 vm.runInContext(app.slice(app.indexOf('function setSpellingAnswerEnabled('),app.indexOf('\nfunction advance(')),h.context);
 h.run("state.session={listName:'Test',round:1,phase:'prompt',current:'one',words:Array.from({length:12},(_,i)=>String(i)),perWord:Object.fromEntries(Array.from({length:12},(_,i)=>[String(i),{streak:1,mastered:false}])),defs:{},log:[]};renderPractice(false)");
 const meter=h.elements.get('spelling-mastery');
 assert.equal(meter.querySelector('.mastery-percent').textContent,'50%');
 assert.equal(meter.querySelector('.mastery-count').textContent,'0 of 12 words fully mastered');
 h.run("state.session=JSON.parse(JSON.stringify(state.session));state.session.perWord['0'].streak=0;renderPractice(false)");
 assert.equal(meter.querySelector('.mastery-percent').textContent,'46%');
 h.run("Object.values(state.session.perWord).forEach(p=>{p.streak=2;p.mastered=true});renderPractice(false)");
 assert.equal(meter.querySelector('.mastery-percent').textContent,'100%');
});

test('legacy completion celebrates only the final mastery transition, not summary reopening',()=>{
 const h=harness(),app=fs.readFileSync('src/app.js','utf8');
 vm.runInContext(app.slice(app.indexOf('function advance(){'),app.indexOf('\nfunction showSummary(')),h.context);
 h.run("let blasts=0;celebrateMastery=()=>blasts++;finish=()=>{};next=()=>{};renderPractice=()=>{};state.session={phase:'feedback',words:['one'],perWord:{one:{mastered:false}}};advance()");
 assert.equal(h.run('blasts'),0);
 h.run("state.session.perWord.one.mastered=true;advance();advance()");
 assert.equal(h.run('blasts'),1);
});

test('learning completion celebrates vocabulary and mixed mastery once, never unfinished practice or tests',()=>{
 for(const mode of ['vocabulary','mixed']) {
  const h=harness();h.context.records=JSON.parse(fs.readFileSync('examples/weekly-vocabulary-sample.json','utf8')).words.slice(0,1);
  h.run("let blasts=0;celebrateMastery=()=>blasts++;renderLearning=()=>{if(!Learning.current(state.learningSession.session))finishLearningReport()};showPracticeComplete=()=>{};showReport=()=>{};archiveQuestions=()=>{};state.learningHistory=[];state.learningSession={listId:'a',session:Learning.createSession(records,{mode:'"+mode+"',phasedVocabulary:true})};Learning.finish(state.learningSession.session);finishLearningReport()");
  assert.equal(h.run('blasts'),0);
  h.run("state.learningSession={listId:'a',session:Learning.createSession(records,{mode:'"+mode+"',phasedVocabulary:true})};while(Learning.current(state.learningSession.session)){Learning.submit(state.learningSession.session,Learning.current(state.learningSession.session).answer);advanceLearning()}finishLearningReport();finishLearningReport()");
  assert.equal(h.run('blasts'),1);
  h.run("state.learningSession.recorded=false;finishLearningReport()");
  assert.equal(h.run('blasts'),1);
  h.run("records.forEach(row=>row.vocabulary.status='approved');state.learningSession={listId:'a',session:Learning.createSession(records,{mode:'"+mode+"',type:'test'})};while(Learning.current(state.learningSession.session))Learning.submit(state.learningSession.session,Learning.current(state.learningSession.session).answer);finishLearningReport()");
  assert.equal(h.run('blasts'),1);
 }
});

test('vocabulary questions autoplay masked prompts; mute spans cards without changing dictation or tests',()=>{
 const h=harness();h.context.records=JSON.parse(fs.readFileSync('examples/weekly-vocabulary-sample.json','utf8')).words.slice(0,2);
 h.run("let clips=[],stops=0,cancels=0;stopRecording=()=>stops++;speechSynthesis={cancel:()=>cancels++};playQuestion=()=>clips.push(Learning.audio(Learning.current(state.learningSession.session)));state.learningSession={listId:'a',listName:'Words',session:Learning.createSession(records,{mode:'vocabulary',phasedVocabulary:true})};renderLearning(true)");
 assert.equal(h.run('clips.length'),1);assert.match(h.run('clips[0]'),/blank/);
 assert.equal(h.run('clips[0].includes(records[0].word)'),false);
 h.run('renderLearning(false);toggleVocabularyAutoplay()');
 assert.equal(h.run('stops'),1);assert.equal(h.run('cancels'),1);
 assert.equal(h.elements.get('learning-autoplay').attributes['aria-pressed'],'false');
 h.run('Learning.submit(state.learningSession.session,Learning.current(state.learningSession.session).answer);Learning.advance(state.learningSession.session);renderLearning(true)');
 assert.equal(h.run('clips.length'),1);
 h.run('playQuestion(false,false)');assert.equal(h.run('clips.length'),2);
 h.run('toggleVocabularyAutoplay()');assert.equal(h.run('clips.length'),2);
 h.run('renderLearning(true)');assert.equal(h.run('clips.length'),3);
 h.run("state.settings.vocabularyAutoplay=false;state.learningSession.session=Learning.createSession(records,{mode:'mixed',phasedVocabulary:true});renderLearning(true)");
 assert.equal(h.run('clips.length'),4);assert.equal(h.elements.get('learning-autoplay').hidden,true);
 h.run("records.forEach(row=>row.vocabulary.status='approved');state.settings.vocabularyAutoplay=true;state.learningSession.session=Learning.createSession(records,{mode:'vocabulary',type:'test'});renderLearning(true)");
 assert.equal(h.run('clips.length'),4);assert.equal(h.elements.get('learning-autoplay').hidden,true);
});

test('study autoplay waits for reveal, never leaks reverse cards, and shares the mute preference',()=>{
 const h=harness();h.context.records=JSON.parse(fs.readFileSync('examples/weekly-vocabulary-sample.json','utf8')).words.slice(0,2);
 h.run("let clips=[];Option=function(text,value){return {text,value}};playStudyRecordings=(card,line)=>clips.push(line);studyState={list:activeList,rows:records,index:0,revealed:false};state.familiar={};$('study-reverse').checked=true;renderStudy()");
 assert.equal(h.run('clips.length'),0);
 h.run('studyState.revealed=true;renderStudy();renderStudy()');assert.equal(h.run('clips.length'),1);
 assert.equal(h.run('clips[0]'),h.run('records[0].vocabulary.examples[0]'));
 h.run('state.settings.vocabularyAutoplay=false;studyState.index=1;studyState.revealed=false;renderStudy();studyState.revealed=true;renderStudy()');
 assert.equal(h.run('clips.length'),1);assert.equal(h.elements.get('study-autoplay').attributes['aria-pressed'],'false');
 h.run('state.settings.vocabularyAutoplay=true;studyState.revealed=false;renderStudy();studyState.revealed=true;renderStudy()');
 assert.equal(h.run('clips.length'),2);
});

test('actual device speech stops when a revealed example is hidden or a practice answer is submitted',()=>{
 const h=harness(),app=fs.readFileSync('src/app.js','utf8');
 h.context.records=JSON.parse(fs.readFileSync('examples/weekly-vocabulary-sample.json','utf8')).words.slice(0,2);
 h.context.document.querySelectorAll=()=>[];
 h.run("let activeSpeech='';let voices=[];SpeechSynthesisUtterance=function(text){this.text=text};speechSynthesis={cancel(){activeSpeech=''},speak(utterance){activeSpeech=utterance.text;utterance.onstart?.()}};state.settings.rate=.85;state.familiar={}");
 vm.runInContext(fs.readFileSync('src/dictation-ui.js','utf8'),h.context);
 vm.runInContext(app.match(/^function show\(.*$/m)[0],h.context);
 vm.runInContext(app.match(/^function speak\(.*$/m)[0],h.context);
 h.run("studyState={list:activeList,rows:records,index:0,revealed:true};$('study-reverse').checked=true;renderStudy()");
 assert.equal(h.run('activeSpeech'),h.run('records[0].vocabulary.examples[0]'));
 h.run('studyState.revealed=false;renderStudy()');assert.equal(h.run('activeSpeech'),'');
 h.run("state.learningSession={listId:'a',listName:'Words',session:Learning.createSession(records,{mode:'vocabulary',phasedVocabulary:true})};renderLearning(true)");
 assert.match(h.run('activeSpeech'),/blank/);
 h.run('Learning.submit(state.learningSession.session,Learning.current(state.learningSession.session).answer);renderLearning(false)');
 assert.equal(h.run('activeSpeech'),'');
});
