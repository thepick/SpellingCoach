const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Dictation = require('../src/dictation.js');
const GenerationSettings = require('../src/generation-settings.js');

const app = fs.readFileSync('src/app.js', 'utf8').replace('// BUILD:MODULES', () =>
 ['state', 'dictation-ui'].map(name => fs.readFileSync('src/' + name + '.js', 'utf8')).join('\n'));
const submitEvent = {preventDefault(){}};

function openApp({entry = 'offline', settings = {}, version = 2, recording, history = [{attempts:4}]} = {}) {
 const original = {
  v:version, lists:[{id:'list',name:'List',words:['quartz'],defs:{quartz:'A mineral.'}}], settings,
  progress:{list:{words:{quartz:{misses:3}}}}, history:{list:{sessions:history}},
  session:{v:1,listId:'list',listName:'List',words:['quartz'],defs:{quartz:'A mineral.'},round:1,
   queue:[],current:'quartz',currentType:'review',phase:'paused',resumePhase:'prompt',
   perWord:{quartz:{streak:1,mastered:false}},log:[],initialCount:0,firstCorrect:0,retypeMisses:0},
 };
 const key = entry === 'teacher' ? 'spell.teacher.signed-out' : 'spell.state';
 const storage = new Map([[key, JSON.stringify(original)]]), elements = new Map(), clips = [];
 const node = () => ({hidden:true, disabled:false, textContent:'', children:[],
  set innerHTML(value){this.children=[];}, add(child){this.children.push(child);},
  append(...children){this.children.push(...children);}, setAttribute(){}, removeAttribute(){},
  querySelector(){return node();}, focus(){}, addEventListener(){}, showModal(){this.open=true;},
 });
 const get = id => {if (!elements.has(id)) elements.set(id, node()); return elements.get(id);};
 const ai = {role:'', token:''};
 const context = vm.createContext({Dictation, GenerationSettings, ai, URL, URLSearchParams, location:{search:''}, window:{},
  document:{body:{dataset:{entry}}, getElementById:get, createElement:node, addEventListener(){},
   querySelectorAll:() => [...elements].filter(([id]) => id.endsWith('-screen')).map(([,element]) => element)},
  localStorage:{getItem:key => storage.get(key) ?? null, setItem:(key,value) => storage.set(key,value)},
  Option:function(text,value){return {text,value};}, setTimeout:()=>0, clearTimeout(){},
  Audio:class {constructor(url){clips.push(this);this.url=url;} play(){this.onplaying?.();return Promise.resolve();} pause(){}},
  sharedReview:null, themePreference:{value:'system'}, canUndoShuffle:()=>false,
  beginCoach(){}, queueVocabulary(){}, updateCoachSetup(){}, renderMasteryProgress(){},
  stopMasteryCelebration(){}, openSharedReview(){}, recordLegacySpelling(){},
  getStore:async()=>({get:name => name === Dictation.recordingKey('list','quartz') ? recording : null}),
 });
 vm.runInContext(app.replace('// BUILD:STARTUP', "Object.assign(globalThis,{showLanding:()=>show('setup-screen')});"), context);
 return {ai, clips, get, original, storage, saved:()=>JSON.parse(storage.get(key))};
}

test('a legacy PIN never blocks return to setup and migration preserves local practice data', () => {
 const app = openApp({version:1,settings:{pin:'1234',selected:{list:['quartz']}}});
 assert.equal(app.saved().session.current,'quartz');
 app.get('setup-screen').hidden=true;
 app.get('back-setup').onclick();
 assert.equal(app.get('setup-screen').hidden,false);
 const saved = app.saved();
 assert.equal(saved.session,null);
 assert.equal(Object.hasOwn(saved.settings,'pin'),false);
 assert.deepEqual(saved.settings.selected.list,['quartz']);
 assert.equal(saved.lists[0].defs.quartz,'A mineral.');
 assert.equal(saved.progress.list.words.quartz.misses,3);
 assert.equal(saved.history.list.sessions[0].attempts,4);
 assert.deepEqual(JSON.parse(app.storage.get('spell.state.v1.backup')),app.original);
});

test('Tools hides local practice controls on teacher and student pages', () => {
 for (const entry of ['teacher','student','offline']) {
  const app = openApp({entry});
  app.get('tools-audio').open=true;
  app.get('open-tools').onclick();
  assert.equal(app.get('tools-teaching-options').hidden,entry !== 'offline',entry);
  assert.equal(app.get('tools-advanced').hidden,entry !== 'offline',entry);
  assert.equal(app.get('local-audio-settings').hidden,entry === 'teacher',entry);
  assert.equal(app.get('tools-audio').open,false,entry);
  assert.equal(app.get('tools-grade-defaults').hidden,true,entry);
  assert.equal(app.get('tools-recovery').hidden,true,entry);
  Object.assign(app.ai,{role:'teacher',token:'fixture-token'});
  app.get('open-tools').onclick();
  assert.equal(app.get('tools-grade-defaults').hidden,entry === 'student',entry);
  assert.equal(app.get('tools-recovery').hidden,entry === 'student',entry);
 }
});

test('an unavailable spelling recording neither reveals an answer nor allows a scored attempt', async () => {
 const app = openApp();
 app.get('resume-practice').onclick();
 assert.equal(app.get('answer-input').disabled,true);
 await new Promise(resolve => setImmediate(resolve));
 assert.match(app.get('feedback').children[0]?.textContent ?? '', /audio is unavailable/i);
 assert.doesNotMatch(app.get('feedback').children[0].textContent, /quartz/i);
 assert.doesNotMatch(app.get('visual-word').textContent, /quartz/i);
 assert.equal(app.get('submit-answer').disabled,true);
 assert.equal(app.get('dont-know').disabled,true);
 app.get('answer-input').value='quartz';
 app.get('answer-form').onsubmit(submitEvent);
 assert.equal(app.saved().session.log.length,0);
 assert.equal(app.saved().session.perWord.quartz.mastered,false);
});

test('a recorded spelling prompt can replay and unlock answering without device speech', async () => {
 const app = openApp({recording:'local-quartz.wav'});
 app.get('resume-practice').onclick();
 assert.equal(app.get('submit-answer').disabled,true);
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(app.get('submit-answer').disabled,false);
 app.get('slow-replay').onclick();
 await new Promise(resolve => setImmediate(resolve));
 assert.deepEqual(app.clips.map(clip => clip.url),['local-quartz.wav','local-quartz.wav']);
 assert.ok(app.clips[1].playbackRate < app.clips[0].playbackRate);
});

test('recent spelling history distinguishes unattempted sessions from scored and legacy sessions', () => {
 const app = openApp({history:[
  {at:'2026-11-24',accuracy:75,mastered:0,total:1},
  {at:'2026-11-25',attempts:1,accuracy:0,mastered:0,total:1},
 ]});
 app.get('end-session').onclick();
 const rows = app.get('history-list').children.map(row => row.textContent.split(' · ')[1]);
 assert.deepEqual(rows,['Not assessed','0%','75%']);
});
