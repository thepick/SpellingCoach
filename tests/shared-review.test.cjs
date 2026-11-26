const assert = require('node:assert/strict');
const test = require('node:test');
const { reviewMode, matchingPractice, sharingContent } = require('../src/shared-review.js');
const SharedReview = require('../src/shared-review.js');
const fs = require('node:fs');
const vm = require('node:vm');

test('shared reviews honor the assigned mode and handle older and spelling-only packs', () => {
 const vocab = [{word:'contract',vocabulary:{definition:'An agreement.'}}];
 const spelling = [{word:'contract',vocabulary:null}];
 assert.equal(reviewMode('vocabulary', vocab), 'vocabulary');
 assert.equal(reviewMode('spelling', vocab), 'spelling');
 assert.equal(reviewMode(null, vocab), 'mixed');
 assert.equal(reviewMode('vocabulary', spelling), 'spelling');
});

test('sharing readiness distinguishes drafts, approved vocabulary, and words without definitions', () => {
 const rows = [{word:'solid', vocabulary:{status:'approved'}}, {word:'melt', vocabulary:{status:'draft'}}, {word:'gas', vocabulary:null}];
 const mixed = sharingContent(rows, 'mixed');
 assert.equal(mixed.ready, false);
 assert.deepEqual(mixed.drafts, ['melt']);
 assert.deepEqual(mixed.approved, ['solid']);
 assert.deepEqual(mixed.missing, ['gas']);
 const spelling = sharingContent(rows, 'spelling');
 assert.equal(spelling.ready, true);
 assert.equal(spelling.words[1].vocabulary, null);
 assert.equal(sharingContent([rows[2]], 'mixed').ready, false);
 assert.equal(sharingContent([rows[0], rows[2]], 'vocabulary').ready, true);
});

test('Continue practice only matches an unfinished practice for the same list', () => {
 const entry = {listId:'x',session:{type:'practice',status:'active'}};
 assert.equal(matchingPractice({learningSession:entry}, 'x'), 'learning');
 assert.equal(matchingPractice({learningSession:entry}, 'y'), null);
 assert.equal(matchingPractice({learningSession:{...entry,session:{...entry.session,status:'finished'}}}, 'x'), null);
 assert.equal(matchingPractice({learningSession:{...entry,session:{...entry.session,type:'test'}}}, 'x'), null);
 assert.equal(matchingPractice({session:{listId:'x',phase:'paused'}}, 'x'), 'spelling');
 assert.equal(matchingPractice({session:{listId:'x',phase:'paused'}}, 'x', 'mixed'), null);
 assert.equal(matchingPractice({learningSession:{...entry,session:{...entry.session,mode:'mixed'}}}, 'x', 'vocabulary'), null);
});

test('reopened and parked spelling, vocabulary, and mixed sets resume serialized partial mastery',async()=>{
 for(const mode of ['spelling','vocabulary','mixed'])for(const parked of [false,true]) {
  const h=policyHarness({retypeOnMiss:true,allowVariants:false},mode);
  h.run('dictationRequest=0');
  if(mode==='spelling') {
   await h.run('startSharedReview()');h.run("submit(state.session,'color')");
   assert.equal(h.run('state.session.perWord.color.streak'),1);
  } else {
   h.context.resumeRecord=JSON.parse(fs.readFileSync('examples/weekly-vocabulary-sample.json','utf8')).words[0];
   h.run("let s=Learning.createSession([resumeRecord],{mode:'"+mode+"',phasedVocabulary:true,masteryPractice:true});Learning.submit(s,Learning.current(s).answer);Learning.advance(s);state.learningSession={listId:'local',session:s}");
  }
  h.run('state=JSON.parse(JSON.stringify(state));let storedActivity={session:state.session,learningSession:state.learningSession}');
  const progress=mode==='spelling'?h.run('state.session.perWord.color.streak'):h.run('Learning.practiceWordProgress(state.learningSession.session).progress');
  if(parked)h.run('state.session=null;state.learningSession=null;parkedActivity=async()=>storedActivity');
  const app=fs.readFileSync('src/app.js','utf8');vm.runInContext(app.match(/^function resumeActivity\(.*$/m)[0],h.context);
  await h.run('renderSharedReady()');assert.equal(h.elements.get('shared-start').textContent,'Continue practice',mode+' parked='+parked);
  await h.run('startSharedReview()');
  assert.equal(mode==='spelling'?h.run('state.session.perWord.color.streak'):h.run('Learning.practiceWordProgress(state.learningSession.session).progress'),progress);
  if(mode!=='spelling')assert.equal(h.run('Learning.sessionOK(state.learningSession.session)'),true);
 }
});

function policyHarness(practice,mode='mixed') {
 const elements=new Map(),list={id:'local',name:'Words',words:['color'],defs:{}},rows=[{word:'color',vocabulary:{definition:'A shade.',acceptedSpellings:['colour']}}];
 const context=vm.createContext({Learning:require('../src/learning.js'),Dictation:{demoPackId:'demo'},
  state:{lists:[list],settings:{retypeOnMiss:true,allowVariants:true},progress:{},history:{},learningHistory:[],session:null,learningSession:null},
  $:id=>{if(!elements.has(id))elements.set(id,{disabled:false,textContent:'',children:[],replaceChildren(){this.children=[];},append(...nodes){this.children.push(...nodes);}});return elements.get(id);},
  save:()=>true,checkpointChain:Promise.resolve(),storageOK:false,studentPreview:false,
  coachOptions:()=>({retypeOnMiss:true,allowVariants:true}),loadVocabulary:async()=>rows,selectedList:()=>list,
  importPack:async()=>{},renderPractice:()=>{},now:()=> 'now',dictionary:()=>Object.create(null),
  buildRound:s=>{s.queue=s.words.slice();},next:s=>{s.current=s.queue.shift();s.currentType='initial';s.phase='prompt';},
  equal:(a,b)=>a.toLowerCase()===b.toLowerCase(),diff:()=>({}),recordLegacySpelling:()=>{},
  vocabCache:{records:rows},learningProgress:()=>({}),makeStat:()=>({}),show:()=>{},
 });
 vm.runInContext(fs.readFileSync('src/shared-review.js','utf8'),context);
 const app=fs.readFileSync('src/app.js','utf8');
 vm.runInContext(app.match(/^function sessionOK\(.*$/m)[0],context);
 vm.runInContext(app.slice(app.indexOf('async function start('),app.indexOf('function retype(')),context);
 const run=code=>vm.runInContext(code,context);
 context.assignment={pack:{id:'pack',version:1,words:rows},origin:'https://fixture.test',mode,allowHints:false,practice};
 run('sharedReview=assignment;findPackList=()=>({id:"local"});parkedActivity=async()=>null;let created,resumed;beginLearning=(list,records,options)=>{created=options;state.learningSession={listId:list.id,session:Learning.createSession(records,options)}};resumeActivity=()=>{resumed=state.learningSession?.session.settings || state.session};');
 return {context,run,elements};
}

test('practice policy includes explicit false values and ignores absent or malformed legacy fields',()=>{
 assert.deepEqual(SharedReview.practiceRules({retypeOnMiss:false,allowVariants:true,mode:'mixed'}),{retypeOnMiss:false,allowVariants:true});
 assert.deepEqual(SharedReview.practiceRules(),{});
 assert.deepEqual(SharedReview.practiceRules({retypeOnMiss:'false',allowVariants:null}),{});
});

test('new modern shared practice overrides conflicting device options and older assignments preserve them',async()=>{
 const h=policyHarness({retypeOnMiss:false,allowVariants:false});await h.run('startSharedReview()');
 assert.equal(h.run('created.retypeOnMiss'),false);assert.equal(h.run('created.allowVariants'),false);assert.equal(h.run('created.allowHints'),false);
 assert.equal(h.run('Learning.sessionOK(JSON.parse(JSON.stringify(state.learningSession.session)))'),true);
 assert.equal(h.run('state.settings.retypeOnMiss'),true);assert.equal(h.run('state.settings.allowVariants'),true);
 const old=policyHarness(undefined);await old.run('startSharedReview()');
 assert.equal(old.run('created.retypeOnMiss'),true);assert.equal(old.run('created.allowVariants'),true);
});

test('active and parked modern shared sessions receive current teacher policy before resuming',async()=>{
 for(const parked of [false,true]) {
  const h=policyHarness({retypeOnMiss:false,allowVariants:false});
  h.run('let activity={learningSession:{listId:"local",session:{type:"practice",mode:"mixed",status:"active",settings:{retypeOnMiss:true,allowVariants:true}}}};');
  h.run(parked ? 'parkedActivity=async()=>activity' : 'state.learningSession=activity.learningSession');
  await h.run('startSharedReview()');
  assert.equal(h.run('resumed.retypeOnMiss'),false);assert.equal(h.run('resumed.allowVariants'),false);assert.equal(h.run('resumed.allowHints'),false);
  assert.equal(h.run('JSON.parse(JSON.stringify(state.learningSession)).session.settings.allowVariants'),false);
 }
});

test('new spelling practice snapshots correction policy across serialization without enabling variant grading',async()=>{
 const h=policyHarness({retypeOnMiss:false,allowVariants:true},'spelling');await h.run('startSharedReview()');
 assert.equal(h.run('state.session.retypeOnMiss'),false);
 h.run('state.session=JSON.parse(JSON.stringify(state.session))');
 assert.equal(h.run('sessionOK(state.session)'),true);
 assert.equal(h.run('submit(state.session,"colour").ok'),false);assert.equal(h.run('state.session.phase'),'feedback');
 const enabled=policyHarness({retypeOnMiss:true},'spelling');enabled.run('state.settings.retypeOnMiss=false');await enabled.run('startSharedReview()');
 enabled.run('submit(state.session,"wrong")');assert.equal(enabled.run('state.session.phase'),'retype');
});

test('loading a public assignment retains its explicit practice rules for starting and resuming',async()=>{
 const h=policyHarness(undefined);
 const practice={mode:'mixed',allowHints:false,retypeOnMiss:false,allowVariants:true};
 Object.assign(h.context,{URLSearchParams,location:{hash:'#pack=pack',origin:'https://fixture.test'},studentPreview:false,
  entryPage:'student',ONLINE_CONFIG:'https://fixture.test',ai:{root:'https://fixture.test',token:''},
  serviceOrigin:value=>value,show(){},Vocabulary:{validatePack:pack=>pack},
  service:async()=>({pack:h.context.assignment.pack,practice,visibility:'public',audio:[]})});
 h.context.Dictation.canonicalPackId=id=>id;h.run('renderSharedReady=async()=>{}');await h.run('openSharedReview()');
 assert.equal(h.run('sharedReview.practice'),practice);assert.equal(h.run('SharedReview.practiceRules(sharedReview.practice).retypeOnMiss'),false);
});

test('active and parked spelling practice use teacher correction rules while older sessions retain device fallback',async()=>{
 for(const parked of [false,true]) {
  const h=policyHarness({retypeOnMiss:false},'spelling');
  h.run('let activity={session:{listId:"local",phase:"paused",retypeOnMiss:true}}');
  h.run(parked ? 'parkedActivity=async()=>activity' : 'state.session=activity.session');await h.run('startSharedReview()');
  assert.equal(h.run('resumed.retypeOnMiss'),false);
 }
 const old=policyHarness(undefined,'spelling');await old.run('startSharedReview()');
 assert.equal(old.run('Object.hasOwn(state.session,"retypeOnMiss")'),false);
 old.run('state.settings.retypeOnMiss=false;submit(state.session,"wrong")');assert.equal(old.run('state.session.phase'),'feedback');
});

test('the normal spelling summary missed button preserves the serialized assignment correction policy',async()=>{
 for(const enabled of [false,true,undefined]) {
  const h=policyHarness({retypeOnMiss:enabled},'spelling');h.run(`state.settings.retypeOnMiss=${!enabled}`);await h.run('startSharedReview()');
  h.run('state.session.summary={missed:["color"]};state.session=JSON.parse(JSON.stringify(state.session))');
  if(enabled === undefined)h.run('sharedReview=null;state.settings.retypeOnMiss=false');
  const app=fs.readFileSync('src/app.js','utf8');
  vm.runInContext(app.match(/^function practiceMissed\(.*$/m)[0]+'\n'+app.match(/^\$\('practice-missed'\)\.onclick=.*$/m)[0],h.context);
  h.elements.get('practice-missed').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.run('state.session.retypeOnMiss'),enabled);h.run('submit(state.session,"wrong")');
  assert.equal(h.run('state.session.phase'),enabled?'retype':'feedback');
 }
});

test('the normal modern report missed button preserves shared assignment rules without changing local follow-ups',async()=>{
 for(const shared of [false,true]) {
  const h=policyHarness({retypeOnMiss:false,allowVariants:false});await h.run('startSharedReview()');
  h.run('state.learningSession=JSON.parse(JSON.stringify(state.learningSession));state.learningSession.session.status="finished";missedFor=()=>["color"]');
  if(!shared)h.run('sharedReview=null');
  const coach=fs.readFileSync('src/coach.js','utf8');vm.runInContext(coach.slice(coach.indexOf('function showReport('),coach.indexOf('async function beginDueReview(')),h.context);
  h.run('showReport(null,state.learningSession)');h.elements.get('review-missed').onclick();
  assert.equal(h.run('created.retypeOnMiss'),!shared);assert.equal(h.run('created.allowVariants'),!shared);
  assert.equal(h.run('created.allowHints'),shared?false:undefined);
 }
});
