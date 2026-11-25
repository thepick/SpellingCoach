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
 assert.equal(meter.querySelector('.mastery-count').textContent,'1 of 3 words mastered');
 assert.equal(meter.querySelector('.mastery-percent').textContent,'33%');
 assert.equal(meter.querySelector('.progressfill').style.width,'33.33333333333333%');
 assert.equal(meter.querySelector('[role="progressbar"]').attributes['aria-valuenow'],'1');
 assert.equal(meter.querySelector('[role="progressbar"]').attributes['aria-valuemax'],'3');
 h.run("renderMasteryProgress('learning-mastery',199,200)");
 assert.equal(meter.querySelector('.mastery-percent').textContent,'99%');
 h.run("renderMasteryProgress('learning-mastery',1,1)");
 assert.equal(meter.querySelector('.mastery-count').textContent,'1 of 1 word mastered');
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
   assert.equal(meter.querySelector('[role="progressbar"]').attributes['aria-valuenow'],String(mastered));
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
