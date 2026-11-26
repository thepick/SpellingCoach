const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Learning = require('../src/learning.js');
const records = JSON.parse(fs.readFileSync('examples/weekly-vocabulary-sample.json','utf8')).words.slice(0,3);
const options = {mode:'mixed', sequentialPractice:true, retypeOnMiss:false};
function answer(s, text = Learning.current(s).answer) {
 Learning.submit(s,text); Learning.advance(s);
 assert(Learning.sessionOK(JSON.parse(JSON.stringify(s))));
}

test('a correct mixed session completes each set-wide stage once and records mastery',()=>{
 const s=Learning.createSession(records,options), types=[];
 while(Learning.current(s)) {
  types.push(Learning.current(s).type);answer(s);
 }
 assert.deepEqual(types,['dictation','dictation','dictation','word-bank','word-bank','word-bank','missing-word','missing-word','missing-word']);
 assert.equal(s.results.length,9);assert(Learning.practiceMastered(s));
 assert.equal(Learning.practiceWordProgress(s).progress,1);
 for(const skill of ['spelling','vocabulary']) assert.equal(Learning.mastery(s.progress,records)[skill].percent,100);
});

test('misses and hints retry only the unfinished stage without restarting spelling',()=>{
 const s=Learning.createSession(records,options);
 answer(s,'wrong');
 while(Learning.current(s).type==='dictation') answer(s);
 assert.equal(s.results.filter(r=>r.question.type==='dictation').length,4);
 Learning.hint(s);answer(s);
 assert.equal(s.tasks.find(t=>t.skill==='vocabulary').bankPassed,false);
 while(Learning.current(s).type==='word-bank') answer(s);
 answer(s,'wrong');
 while(Learning.current(s)) answer(s);
 assert.equal(s.results.filter(r=>r.question.type==='dictation').length,4);
 assert.equal(s.results.filter(r=>r.question.type==='word-bank').length,4);
 assert.equal(s.results.filter(r=>r.question.type==='missing-word').length,4);
 assert(Learning.practiceMastered(s));
});

test('resuming an older repeat session keeps its successful spelling and skips the duplicate',()=>{
 let s=Learning.createSession(records.slice(0,1),{mode:'mixed',phasedVocabulary:true});
 answer(s);assert.equal(s.results[0].question.type,'dictation');
 s=JSON.parse(JSON.stringify(s));Learning.upgradePractice(s);
 assert.equal(Learning.current(s).type,'word-bank');
 assert(Learning.sessionOK(s));
 while(Learning.current(s))answer(s);
 assert.equal(s.results.filter(r=>r.question.type==='dictation').length,1);
 assert(Learning.practiceMastered(s));
});

test('tests keep their fixed question counts and do not use practice stages',()=>{
 const approved=records.map(row=>({...row,vocabulary:{...row.vocabulary,status:'approved'}}));
 const s=Learning.createSession(approved,{...options,type:'test',perWord:3});
 assert.equal(s.questions.length,12);assert.equal(Learning.practiceStage(s),null);
});

function cards() {
 const nodes=new Map(), calls=[];
 function element(tag='div') {return {tag,children:[],dataset:{},hidden:false,open:false,disabled:false,textContent:'',parentElement:null,
  append(...items){for(const item of items){if(item.parentElement)item.parentElement.children=item.parentElement.children.filter(x=>x!==item);this.children.push(item);item.parentElement=this;}},
  replaceChildren(){this.children=[];},setAttribute(name,value){this[name]=value;},focus(){calls.push('focus');},
  querySelector(){return get('body');}};}
 const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
 const row=records[0], list={id:'local',packId:'pack',updatedAt:'one',audioStatus:{recordings:Learning.practiceAudioPrompts(row,0).map(p=>({...p,status:'ready'}))}};
 const context=vm.createContext({definitionCard:(row,text)=>text,imageEditControls:()=>element(),Learning,GenerationSettings:require('../src/generation-settings.js'),URL,Blob,Uint8Array,console,$:get,
  document:{body:{dataset:{entry:'teacher'}},createElement:element,createTextNode:text=>({...element('text'),textContent:text})},
  location:{origin:'https://site.test'},entryPage:'teacher',dictationRequest:0,
  stopRecording(){context.dictationRequest++;},selectedList:()=>list,
  recordedService:async(path)=>{calls.push(path);return new Uint8Array([1]);},playRecording:async()=>calls.push('play'),
  state:{},editorInline:false,openVocabularyEditor:async(...args)=>{calls.push(args);context.editorInline=true;return true;},
  displayVocabularyEditor:()=>calls.push('edit'),workspaceSavePending:()=>false,
 });
 vm.runInContext(fs.readFileSync('src/teacher.js','utf8'),context);
 context.list=list;context.rows=[row];
 vm.runInContext("service=recordedService;ai.token='teacher';ai.role='teacher';sharing={list,records:rows};teacherStatus=()=>{};renderWorkspaceVocabulary()",context);
 return {context,get,calls,list,run:code=>vm.runInContext(code,context)};
}

test('generated rows show sentences, play prepared audio, and edit the requested word in place',async()=>{
 const h=cards(),card=h.get('workspace-generated-list').children[0],body=card.children[1];
 assert.equal(card.open,true);assert.equal(body.children[0].textContent,records[0].vocabulary.definition);
 const clip=body.children.find(x=>x.className==='generated-clip');
 assert.equal(clip.children[1].textContent,'Listen');await clip.children[1].onclick();
 assert(h.calls.some(x=>typeof x==='string'&&x.startsWith('/teacher/sets/pack/audio/')));assert(h.calls.includes('play'));
 await body.children.at(-1).onclick();
 assert.deepEqual(h.calls.find(Array.isArray),['',true,records[0].word]);
 assert.equal(body.children.at(-1),h.get('workspace-review'));assert(h.calls.includes('edit'));
});

test('audio refresh preserves collapsed rows and never rebuilds an active editor',()=>{
 const h=cards(),host=h.get('workspace-generated-list'),card=host.children[0];card.open=false;
 h.list.audioStatus.recordings[0].status='pending';h.run('renderWorkspaceVocabulary()');
 assert.equal(host.children[0].open,false);assert.equal(host.children[0].children[1].children[2].children[1].disabled,true);
 const stable=host.children[0];h.context.editorInline=true;h.list.updatedAt='two';h.run('renderWorkspaceVocabulary()');
 assert.equal(host.children[0],stable);
});
