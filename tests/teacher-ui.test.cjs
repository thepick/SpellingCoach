const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(options={}) {
 const elements = new Map();
 const context = vm.createContext({GenerationSettings:require('../src/generation-settings.js'),console, URL, URLSearchParams, setTimeout, clearTimeout,
  localStorage:{setItem(){},getItem(){return null;},removeItem(){}},
  $:id => {if (!elements.has(id)) elements.set(id,{textContent:'',value:'',hidden:false,checked:false}); return elements.get(id);},
  entryPage:options.entryPage || 'teacher', location:options.location || {origin:'https://example.test'},
  document:{body:{dataset:{entry:options.entryPage || 'teacher'}}},
 });
 vm.runInContext(fs.readFileSync('src/teacher.js','utf8'), context);
 vm.runInContext('renderWorkspaceVocabulary=()=>{}', context);
 return {context,run:code => vm.runInContext(code,context),elements};
}

test('local teacher and practice pages use their local service; offline retains the published service',()=>{
 for (const hostname of ['localhost','127.0.0.1']) {
  const location={hostname,origin:'http://'+hostname+':8765'};
  assert.equal(harness({location}).run('ONLINE_CONFIG'),location.origin);
  assert.equal(harness({location,entryPage:'student'}).run('ONLINE_CONFIG'),location.origin);
  assert.equal(harness({location,entryPage:'offline'}).run('ONLINE_CONFIG'),'https://wordlab.mtomlinson.ca');
 }
});

test('teacher storage identity is stable and generation recovery is isolated', () => {
 const h = harness();
 h.run("ai.teacher={id:'teacher-a'}; ai.root='https://example.test'");
 assert.equal(h.run('teacherStorageKey()'),'spell.teacher:https%3A%2F%2Fexample.test:teacher-a');
 const first = h.run('generationStorageKey()');
 h.run("ai.teacher={id:'teacher-b'}");
 assert.notEqual(h.run('generationStorageKey()'),first);
});

test('key settings omit empty credentials and send removal only explicitly', () => {
 const h = harness();
 h.elements.set('teacher-groq-key',{value:''}); h.elements.set('teacher-openrouter-key',{value:' sk-local '});
 h.elements.set('teacher-delete-groq',{checked:false}); h.elements.set('teacher-delete-openrouter',{checked:false});
 h.elements.set('teacher-paid-text',{checked:false}); h.elements.set('teacher-alternate-audio',{checked:false});
 const body = JSON.parse(h.run('JSON.stringify(teacherKeyChanges())'));
 assert.equal(Object.hasOwn(body,'groq'),false);
 assert.equal(body.openrouter,'sk-local');
 h.elements.get('teacher-delete-groq').checked = true;
 assert.equal(h.run('teacherKeyChanges().groq'),null);
});

test('a failed API key save keeps entered keys available to retry',async()=>{
 const h=harness();
 h.run("ai.token='fixture';ai.root='https://example.test';service=async()=>{throw Error('Connection interrupted. Retry saving.');};initTeacherAccounts()");
 h.context.$('teacher-groq-key').value='fixture-groq-key';
 h.context.$('teacher-openrouter-key').value='fixture-openrouter-key';
 await h.context.$('teacher-keys-form').onsubmit({preventDefault(){}});
 assert.equal(h.context.$('teacher-groq-key').value,'fixture-groq-key');
 assert.equal(h.context.$('teacher-openrouter-key').value,'fixture-openrouter-key');
 assert.match(h.context.$('teacher-account-status').textContent,/Retry saving/);
 assert.equal(h.context.$('teacher-keys-save').disabled,false);
});

test('public study routing requires the full-example manifest entry', () => {
 const context = vm.createContext({URL, location:{origin:'https://student.test'},
  sharedReview:{pack:{id:'set',version:3,words:[{word:'solid'}]},origin:'https://service.test',audio:new Set(['e0'])},
  findPackList:()=>({id:'local'}), Dictation:{publishedClip:()=>null},
  Learning:{practiceAudioPrompts:()=>[{key:'e0',skill:'study',text:'A solid holds its shape.'},{key:'v0',skill:'vocabulary',text:'A blank holds its shape.'}]}});
 vm.runInContext(fs.readFileSync('src/dictation-ui.js','utf8'),context);
 assert.equal(vm.runInContext("sharedAudioPath('local','solid','study','A solid holds its shape.')",context),'https://service.test/api/packs/set/audio/3/e0');
 assert.equal(vm.runInContext("sharedAudioPath('local','solid','missing-word','A solid holds its shape.')",context),null);
});

function savingHarness() {
 const h = harness();
 h.run(`state={lists:[]}; let savedCount=0; let calls=[];
  renderPrivateAudio=()=>{}; watchPrivateAudio=()=>{};
  save=()=>{savedCount++;}; status=()=>{};
  loadVocabulary=async list=>list.rows;
  outputPack=(list,rows)=>({id:list.id,version:list.packVersion || 1,words:rows});
  ai.token='token-a'; ai.root='https://example.test'; ai.role='teacher';
  let list={id:'set-a',packVersion:1,updatedAt:'first',rows:[{word:'solid',vocabulary:null}]}; state.lists.push(list);`);
 return h;
}

test('private autosaves serialize revisions and keep the final recording status',async()=>{
 const h=savingHarness();
 h.run(`let release; let expectations=[];
  service=async(path,options)=>{
   expectations.push(options.body.expectedVersion);
   calls.push(options.body.pack);
   if(calls.length===1) await new Promise(resolve=>release=resolve);
   return {pack:options.body.pack,audioStatus:{ready:0,total:1,pending:true,version:options.body.pack.version}};
  };
  let firstSave=autosaveTeacherSet(list);`);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.run('calls.length'),1);
 h.run("list.packVersion=2; list.updatedAt='second'; list.rows=[{word:'liquid',vocabulary:null}]; let secondSave=autosaveTeacherSet(list); release();");
 await h.run('Promise.all([firstSave,secondSave])');
 assert.deepEqual(JSON.parse(h.run('JSON.stringify(calls.map(pack=>pack.version))')),[1,2]);
 assert.equal(h.run('list.audioStatus.version'),2);
 assert.equal(h.run('teacherSaves.size'),0);
 assert.deepEqual(JSON.parse(h.run('JSON.stringify(expectations)')),[0,1]);
});

test('an old account response cannot save or expose recording status after switching',async()=>{
 const h=savingHarness();
 h.run(`let release;
  service=async(path,options)=>{await new Promise(resolve=>release=resolve);return {pack:options.body.pack,audioStatus:{ready:1,total:1}};};
  let pendingSave=autosaveTeacherSet(list);`);
 await new Promise(resolve=>setImmediate(resolve));
 h.run("ai.token='token-b'; state={lists:[]}; release();");
 await h.run('pendingSave');
 assert.equal(h.run('savedCount'),0);
 assert.equal(h.run('list.audioStatus'),undefined);
});

test('revision conflicts surface an explicit export and reload recovery',async()=>{
 const h=savingHarness();
 h.run("service=async()=>{const error=Error('Conflict');error.status=409;throw error;}");
 await assert.rejects(h.run('autosaveTeacherSet(list)'),/Export your local changes, then reload/);
 assert.match(h.elements.get('teacher-private-audio-status').textContent,/another tab or browser/);
 h.run("service=async()=>{throw Error('Must not send another request')}");
 await assert.rejects(h.run('autosaveTeacherSet(list)'),/version conflict/);
});

test('automatic draft application preserves approved words and avoids identical revision bumps',async()=>{
 const h=savingHarness();
 h.run(`wordKey=word=>word; Vocabulary={validateRecord:(word,value)=>value}; refreshTeacher=()=>{};
  list.rows=[{word:'solid',vocabulary:{status:'approved',definition:'Keep this.'}},{word:'liquid',vocabulary:null}];
  ai.listId=list.id;ai.job={words:[{word:'solid',vocabulary:{status:'draft',definition:'Ignore this.'}},{word:'liquid',vocabulary:{status:'draft',definition:'New definition.'}}]};
  saveVocabulary=async(target,rows,metadata)=>{target.rows=rows;Object.assign(target,metadata);savedCount++;};`);
 await h.run('applyTeacherDrafts()');
 assert.equal(h.run('list.rows[0].vocabulary.definition'),'Keep this.');
 assert.equal(h.run('list.rows[1].vocabulary.status'),'draft');
 assert.equal(h.run('list.packVersion'),2);
 h.run('ai.reviewDrafts=0');
 await h.run('applyTeacherDrafts()');
 assert.equal(h.run('savedCount'),1);
});

test('store handles retain their captured teacher namespace across account changes',async()=>{
 const context=vm.createContext({Vocabulary:{wordKey:word=>word,openStore:async()=>({kind:'indexedDB',get:async key=>key})},
  studentPreview:false,KEY:'spell.teacher:a',structuredClone});
 vm.runInContext(fs.readFileSync('src/coach.js','utf8'),context);
 const old=await vm.runInContext("getStore('indexedDB')",context);
 context.KEY='spell.teacher:b';
 const current=await vm.runInContext("getStore('indexedDB')",context);
 assert.equal(await old.get('list:x'),'spell.teacher:a:list:x');
 assert.equal(await current.get('list:x'),'spell.teacher:b:list:x');
});

test('spelling can share after word audio is ready while vocabulary waits for its clips',()=>{
 const h=harness();
 h.context.SharedReview={sharingContent:()=>({ready:true,words:[{word:'solid'}],approved:['solid'],drafts:[],missing:[]})};
 h.run(`ai.teacher={id:'teacher-a',isAdmin:false}; ai.token='token'; ai.config={dictationEnabled:true};
  sharing={list:{id:'local',words:['solid'],audioStatus:{recordings:[{key:'0-s',status:'ready'},{key:'0-e0',status:'pending'}]}},records:[{word:'solid'}]};`);
 h.elements.set('shared-mode',{value:'spelling'});
 h.run('renderSharing()');
 assert.equal(h.elements.get('ai-publish').disabled,false);
 h.elements.get('shared-mode').value='mixed';
 h.run('renderSharing()');
 assert.equal(h.elements.get('ai-publish').disabled,true);
 assert.match(h.elements.get('ai-publish-readiness').textContent,/Waiting for recordings/);
 h.run("sharing.list.audioStatus.recordings[1].status='ready';renderSharing()");
 assert.equal(h.elements.get('ai-publish').disabled,false);
});

test('creating or selecting the first teacher set enables its direct vocabulary action',()=>{
 const h=harness();
 h.run("ai.role='teacher';ai.config={generationEnabled:true};renderPrivateAudio=()=>{};watchPrivateAudio=()=>{};updateTeacherSelection(null,null)");
 assert.equal(h.elements.get('teacher-open-drafting').disabled,true);
 h.run("updateTeacherSelection({id:'first',words:['solid']},null)");
 assert.equal(h.elements.get('teacher-open-drafting').disabled,false);
 h.run("updateTeacherSelection(null,null)");
 assert.equal(h.elements.get('teacher-open-drafting').disabled,true);
 h.run("ai.config.generationEnabled=false;updateTeacherSelection({id:'first',words:['solid']},null)");
 assert.equal(h.elements.get('teacher-open-drafting').disabled,true);
});

function startBuiltPage(entry='teacher',initialState=null) {
 const file=entry==='student'?'practice/index.html':entry==='offline'?'WordLab v0.2.0.html':'index.html';
 const html=fs.readFileSync(file,'utf8'), elements=new Map();
 const storage=new Map();
 if(initialState)storage.set('spell.state',JSON.stringify(initialState));
 const node=()=>({value:'',hidden:true,checked:false,dataset:{},style:{},children:[],
  addEventListener(){},removeEventListener(){},setAttribute(){},removeAttribute(){},setCustomValidity(){},
  append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},add(child){this.children.push(child);},
  closest(){return node();},querySelector(){return node();},querySelectorAll(){return [];},
  close(){this.open=false;},showModal(){this.open=true;},focus(){this.focused=true;},reset(){},click(){return this.onclick?.();},
 });
 for(const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1],node());
 const loginOptions=html.match(/<select id="teacher-login-kind">([\s\S]*?)<\/select>/)[1];
 elements.get('teacher-login-kind').value=(loginOptions.match(/<option value="([^"]+)"[^>]*selected[^>]*>/)||loginOptions.match(/<option value="([^"]+)"/))[1];
 const document={body:{dataset:{entry}},documentElement:{dataset:{}},getElementById:id=>elements.get(id)||null,
  querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},createElement:()=>node()};
 const context=vm.createContext({document,URL,URLSearchParams,console,structuredClone,AbortSignal,
  location:{hostname:'127.0.0.1',origin:'http://127.0.0.1:8765',href:'http://127.0.0.1:8765/',search:'',hash:'',pathname:'/'},
  localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
  window:{matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener(){}},
  Option:function(text,value){return {text,value};},setTimeout:()=>0,clearTimeout(){},
  fetch:()=>{throw Error('Startup must not request an external service.');},
 });
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1],context);
 return {context,elements,storage};
}

test('actual built teacher script starts with real module ordering and a local sign-in form',async()=>{
 const page=startBuiltPage();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(page.elements.get('teacher-signin-screen').hidden,false);
 assert.equal(page.elements.get('teacher-url').value,'http://127.0.0.1:8765');
 assert.equal(page.elements.get('teacher-login-kind').value,'owner');
 assert.equal(page.elements.get('teacher-username-field').hidden,true);
 assert.equal(page.elements.get('teacher-secret').focused,true);
 assert.equal(page.elements.get('teacher-secret').value,'');
});

test('Tools gives API keys their own section after backups and hides it from students',async()=>{
 const html=fs.readFileSync('index.html','utf8');
 const sections=[...html.slice(html.indexOf('<dialog id="tools-dialog"'),html.indexOf('<section id="tools-teaching-options"')).matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)].map(match=>match[0]);
 assert.equal(sections.length,2);
 assert.match(sections[0],/id="export-json"/);
 assert.match(sections[1],/id="tools-api-keys"/);
 assert.match(sections[1],/id="open-teacher"[^>]*>API keys<\/button>/);
 for(const entry of ['teacher','offline','student']) {
  const page=startBuiltPage(entry);
  await new Promise(resolve=>setImmediate(resolve));
  page.context.document.querySelectorAll=selector=>selector==='dialog[open]'?['tools-dialog','teacher-dialog'].map(id=>page.elements.get(id)).filter(dialog=>dialog.open):[];
  if(entry!=='teacher') {
   page.elements.get('open-tools').click();
   assert.equal(page.elements.get('tools-api-keys').hidden,entry==='student');
   if(entry==='student')continue;
   await page.elements.get('open-teacher').click();
   assert.equal(page.elements.get('tools-dialog').open,false);
   assert.equal(page.elements.get('teacher-dialog').open,true);
   assert.equal(page.elements.get('teacher-connect').hidden,false);
   assert.equal(page.elements.get('teacher-account').hidden,true);
  }
  const profile={teacher:{id:'teacher-a',name:'Teacher',username:'teacher',isAdmin:false},config:{},keys:{groq:false,openrouter:false},settings:{allowPaidText:false}};
  page.context.fetch=async url=>({ok:true,headers:{get:()=> 'application/json'},
   json:async()=>url.endsWith('/admin/access')?{...profile,token:'fixture-token'}:url.endsWith('/teacher/profile')?profile:{sets:[]}});
  page.elements.get('teacher-url').value='http://127.0.0.1:8765';
  page.elements.get('teacher-login-kind').value='owner';
  page.elements.get('teacher-secret').value='fixture-password';
  await page.elements.get('teacher-connect').onsubmit({preventDefault(){},submitter:{id:'teacher-login'}});
  assert.equal(!!page.elements.get('teacher-dialog').open,false);
  page.elements.get('open-tools').click();
  assert.equal(page.elements.get('tools-api-keys').hidden,false);
  await page.elements.get('open-teacher').click();
  assert.equal(page.elements.get('teacher-title').textContent,'API keys');
  assert.equal(page.elements.get('teacher-account').hidden,false);
  assert.equal(page.elements.get('tools-dialog').open,false);
  assert.equal(page.elements.get('teacher-dialog').open,true);
  page.elements.get('teacher-close').click();
  await page.elements.get('teacher-open-connections').click();
  assert.equal(page.elements.get('teacher-title').textContent,'API keys');
  assert.equal(page.elements.get('teacher-account').hidden,false);
 }
});

test('teacher sign-in remains selectable and invitation links always use the teacher flow',()=>{
 const h=harness({location:{origin:'https://example.test',hash:''}});
 h.run("ai={token:'',config:{}};$('teacher-login-kind').value='teacher';refreshTeacherLogin()");
 assert.equal(h.elements.get('teacher-username-field').hidden,false);
 assert.equal(h.elements.get('teacher-username').required,true);
 assert.equal(h.elements.get('teacher-username').disabled,false);
 h.run("$('teacher-username').value='a!';$('teacher-login-kind').value='owner';refreshTeacherLogin()");
 assert.equal(h.elements.get('teacher-username').disabled,true);
 h.run("location.hash='#invite=fixture';refreshTeacherLogin()");
 assert.equal(h.elements.get('teacher-login-kind').value,'teacher');
 assert.equal(h.elements.get('teacher-login-kind').disabled,true);
 assert.equal(h.elements.get('teacher-name-field').hidden,false);
 assert.equal(h.elements.get('teacher-secret').autocomplete,'new-password');
});

test('deleting a saved teacher set waits for its pending save and the server deletion',async()=>{
 const h=savingHarness();
 h.run("let releaseSave;let waiting=new Promise(resolve=>releaseSave=resolve);teacherSaves.set(list.id,waiting);service=async(path,options)=>calls.push({path,method:options.method});let deletion=deleteTeacherSet(list)");
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.run('calls.length'),0);
 h.run('releaseSave()'); await h.run('deletion');
 assert.deepEqual(JSON.parse(h.run('JSON.stringify(calls)')),[{path:'/teacher/sets/set-a',method:'DELETE'}]);
 h.run("service=async()=>{throw Error('Cannot delete now')}");
 await assert.rejects(h.run('deleteTeacherSet(list)'),/Cannot delete now/);
});

test('completed recovered jobs apply missing drafts and preserve newer edited drafts',async()=>{
 const h=savingHarness();
 h.run(`wordKey=word=>word;Vocabulary={validateRecord:(word,value)=>value};refreshTeacher=()=>{};applyJob=job=>ai.job=job;
  list.rows=[{word:'solid',vocabulary:{status:'draft',definition:'My newer edit.'}},{word:'liquid',vocabulary:null}];
  service=async()=>({id:'completed',status:'complete',words:[{word:'solid',vocabulary:{status:'draft',definition:'Older AI result.'}},{word:'liquid',vocabulary:{status:'draft',definition:'Recovered result.'}}]});
  saveVocabulary=async(target,rows,metadata)=>{target.rows=rows;Object.assign(target,metadata);savedCount++;};`);
 await h.run("restoreTeacherGeneration({root:ai.root,role:'teacher',id:'completed',listId:list.id})");
 assert.equal(h.run('list.rows[0].vocabulary.definition'),'My newer edit.');
 assert.equal(h.run('list.rows[1].vocabulary.definition'),'Recovered result.');
 assert.equal(h.run('savedCount'),1);
});

test('owner migration recovers the active checkpoint before saving the new namespace',async()=>{
 const h=savingHarness();
 h.run(`KEY='spell.teacher:operator';ai.teacher={id:'operator',isAdmin:true};
  let checkpoint={listId:'legacy',session:{status:'active'}};
  let migrated={lists:[],learningCheckpoint:{key:'session:legacy',backend:'indexedDB'},learningSession:null};
  localStorage.getItem=key=>key==='spell.state'?'{}':null;loadState=()=>({lists:[]});clean=()=>migrated;
  Vocabulary={openStore:async()=>({get:async()=>checkpoint})};Learning={sessionOK:()=>true};
  getStore=async()=>({put:async()=>{}});save=()=>{if(!state.learningSession)throw Error('checkpoint lost');};`);
 await h.run('loadTeacherWorkspace()');
 assert.equal(h.run('state.learningSession.listId'),'legacy');
});

test('actual built owner login opens a signed-in workspace without module ordering errors',async()=>{
 const page=startBuiltPage(), calls=[];
 const profile={teacher:{id:'operator',name:'Owner',username:'owner',isAdmin:true},config:{},keys:{groq:false,openrouter:false},settings:{allowPaidText:false,allowAlternateAudio:false}};
 page.context.fetch=async(url,options)=>{
  calls.push(url);
  const result=url.endsWith('/admin/access')?{...profile,token:'fixture-token'}:url.endsWith('/teacher/profile')?profile:{sets:[]};
  return {ok:true,headers:{get:()=> 'application/json'},json:async()=>result};
 };
 page.elements.get('teacher-login-kind').value='owner';
 page.elements.get('teacher-secret').value='fixture-password';
 await page.elements.get('teacher-connect').onsubmit({preventDefault(){},submitter:{id:'teacher-login'}});
 assert.equal(page.elements.get('teacher-workspace-actions').hidden,false);
 assert.equal(page.elements.get('teacher-open-invitations').hidden,false);
 assert.equal(page.elements.get('teacher-operations').hidden,true);
 assert.deepEqual(calls.map(url=>new URL(url).pathname),['/api/admin/access','/api/teacher/profile','/api/teacher/sets','/api/teacher/preferences']);
 assert.ok(calls.every(url=>url.startsWith('http://127.0.0.1:8765/')));
 page.elements.get('teacher-workspace-logout').click();
 assert.equal(page.elements.get('teacher-login').disabled,false);
 assert.equal(page.elements.get('teacher-signin-screen').hidden,false);
 assert.equal(page.elements.get('teacher-login-kind').value,'owner');
});

test('reopening grade defaults keeps its pending save locked and rejects a duplicate PUT',async()=>{
 const page=startBuiltPage(), Settings=require('../src/generation-settings.js');
 const profile={teacher:{id:'operator',name:'Owner',username:'owner',isAdmin:true},config:{},keys:{},settings:{allowPaidText:false}};
 let release, puts=0;
 page.context.fetch=async(url,options)=>{
  let result;
  if(options.method==='PUT') {
   puts++;const body=JSON.parse(options.body);await new Promise(resolve=>release=resolve);
   result={presets:{...Settings.presets(),[body.grade]:body.settings}};
  } else result=url.endsWith('/admin/access')?{...profile,token:'fixture-token'}:url.endsWith('/teacher/profile')?profile:url.endsWith('/teacher/preferences')?{presets:Settings.presets()}:{sets:[]};
  return {ok:true,headers:{get:()=> 'application/json'},json:async()=>result};
 };
 page.elements.get('teacher-login-kind').value='owner';page.elements.get('teacher-secret').value='fixture-password';
 await page.elements.get('teacher-connect').onsubmit({preventDefault(){},submitter:{id:'teacher-login'}});
 await page.elements.get('teacher-open-presets').onclick();
 page.elements.get('preset-grade').value='5';page.elements.get('preset-practiceSentences').value='3';page.elements.get('preset-form').oninput();
 const pending=page.elements.get('preset-form').onsubmit({preventDefault(){}});
 assert.equal(page.elements.get('preset-save').disabled,true);
 page.elements.get('teacher-close').onclick();await page.elements.get('teacher-open-presets').onclick();
 assert.equal(page.elements.get('preset-save').disabled,true);
 page.elements.get('preset-practiceSentences').value='4';page.elements.get('preset-form').oninput();
 await page.elements.get('preset-form').onsubmit({preventDefault(){}});
 assert.equal(puts,1);
 release();await pending;
 assert.equal(page.elements.get('preset-save').disabled,false);
 await page.elements.get('teacher-open-presets').onclick();
 assert.equal(Number(page.elements.get('preset-practiceSentences').value),3);
});

test('a stale audio poll cannot restore recordings from an older edited manifest',async()=>{
 const h=harness();
 h.run(`let list={id:'set',updatedAt:'first',packVersion:1};ai.token='token-a';let poll;let release;selectedList=()=>list;setTimeout=callback=>{poll=callback;return 1;};
  list.audioStatus={pending:true};service=async()=>{await new Promise(resolve=>release=resolve);return {pack:{version:1},audioStatus:{ready:1,total:1}};};
  watchPrivateAudio();let pendingPoll=poll();list.updatedAt='edited';list.packVersion=2;list.audioStatus=null;release();`);
 await h.run('pendingPoll');
 assert.equal(h.run('list.audioStatus'),null);
});

test('an unrevealed reverse study card never plays the answer recording',async()=>{
 const elements=new Map([['study-reverse',{checked:true}],['study-audio-status',{textContent:''}]]);
 const context=vm.createContext({URL,studyState:{list:{id:'x'},revealed:false},sharedReview:{preparedAudio:true},
  $:id=>elements.get(id),speech:false,played:0,spoken:[],
  speak:text=>context.spoken.push(text)});
 vm.runInContext(fs.readFileSync('src/dictation-ui.js','utf8'),context);
 vm.runInContext('sharedAudioPath=()=>"answer.wav";playPublishedRecording=async()=>{played++}',context);
 await vm.runInContext('playStudyRecordings({word:"solid",audio:"solid",frontAudio:"A material that holds its shape."})',context);
 assert.equal(context.played,0);
 assert.match(elements.get('study-audio-status').textContent,/unavailable/);
 context.sharedReview={preparedAudio:false};
 await vm.runInContext('playStudyRecordings({word:"solid",audio:"solid",frontAudio:"A material that holds its shape."})',context);
 assert.deepEqual(context.spoken,['A material that holds its shape.']);
});

test('implicit restore preserves conflicted local edits and continues restoring other sets',async()=>{
 const h=savingHarness();
 h.run(`list.packVersion=2;list.remoteVersion=1;list.remoteConflict=true;list.rows=[{word:'my local edit'}];
  let imported=[];Vocabulary={validatePack:pack=>pack};findPackList=id=>state.lists.find(item=>item.id===id);
  service=async()=>({sets:[{pack:{id:list.id,version:3,words:[{word:'server copy'}]}},{pack:{id:'other',version:1,words:[]}}]});
  importPack=async pack=>{imported.push(pack.id);state.lists.push({id:pack.id,packVersion:pack.version});};
  renderSetup=()=>{};selectedList=()=>list;`);
 await h.run('restoreTeacherSets()');
 assert.equal(h.run('list.rows[0].word'),'my local edit');
 assert.equal(h.run('list.remoteConflict'),true);
 assert.deepEqual(JSON.parse(h.run('JSON.stringify(imported)')),['other']);
 assert.equal(h.run("state.lists.find(item=>item.id==='other').remoteVersion"),1);
});

test('same-version divergent restores mark the conflict and continue instead of dropping later sets',async()=>{
 const h=savingHarness();
 h.run(`list.remoteVersion=1;let imported=[];Vocabulary={validatePack:pack=>pack};findPackList=id=>state.lists.find(item=>item.id===id);
  service=async()=>({sets:[{pack:{id:list.id,version:1}},{pack:{id:'other',version:1}}]});
  importPack=async pack=>{if(pack.id===list.id)throw Error('This pack version conflicts');imported.push(pack.id);state.lists.push({id:pack.id,packVersion:pack.version});};
  renderSetup=()=>{};selectedList=()=>list;`);
 await h.run('restoreTeacherSets()');
 assert.equal(h.run('list.remoteConflict'),true);
 assert.deepEqual(JSON.parse(h.run('JSON.stringify(imported)')),['other']);
});


test('standalone teacher and class sign-ins retain a main-page sign-out control',async()=>{
 for(const role of ['teacher','class']) {
  const page=startBuiltPage('offline');
  const profile={teacher:{id:'operator',name:'Owner',username:'owner',isAdmin:true},config:{},keys:{},settings:{}};
  page.context.fetch=async url=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>url.endsWith('/admin/access')?{...profile,token:'fixture-token'}:url.endsWith('/access')?{token:'fixture-class-token',config:{}}:url.endsWith('/teacher/profile')?profile:{sets:[]}});
  page.elements.get('teacher-url').value='https://wordlab.mtomlinson.ca';
  page.elements.get('teacher-login-kind').value='owner';
  page.elements.get('teacher-secret').value='fixture-password';
  await page.elements.get('teacher-connect').onsubmit({preventDefault(){},submitter:{id:role==='class'?'class-login':'teacher-login'}});
  assert.equal(page.elements.get('teacher-workspace-logout').hidden,false,role);
  page.elements.get('teacher-workspace-logout').click();
  assert.equal(page.elements.get('teacher-workspace-logout').hidden,true,role);
  assert.equal(page.elements.get('teacher-login').disabled,false,role);
 }
 const css=fs.readFileSync('src/styles.css','utf8');
 assert.match(css,/#teacher-dialog #teacher-logout\s*\{ display: none;/);
});


test('automatic generation fills only missing rows and preserves newer teacher-written drafts',async()=>{
 const h=savingHarness();
 h.run("wordKey=word=>word;Vocabulary={validateRecord:(word,value)=>value};refreshTeacher=()=>{};list.rows=[{word:'solid',vocabulary:{status:'draft',definition:'Teacher wrote this.'}},{word:'liquid',vocabulary:null}];ai.listId=list.id;ai.job={words:[{word:'solid',vocabulary:{status:'draft',definition:'Generated overwrite.'}},{word:'liquid',vocabulary:{status:'draft',definition:'New generated word.'}}]};saveVocabulary=async(target,rows,metadata)=>{target.rows=rows;Object.assign(target,metadata);savedCount++}");
 await h.run('applyTeacherDrafts()');
 assert.equal(h.run('list.rows[0].vocabulary.definition'),'Teacher wrote this.');
 assert.equal(h.run('list.rows[1].vocabulary.definition'),'New generated word.');
});

test('the actual built app remembers the vocabulary audio toggle across reload and backup validation',()=>{
 const page=startBuiltPage('offline',{v:2,lists:[],settings:{vocabularyAutoplay:false}});
 page.elements.get('study-autoplay').click();
 assert.equal(page.elements.get('study-autoplay').textContent,'Auto audio: on');
 assert.equal(page.elements.get('learning-autoplay').textContent,'Auto audio: on');
 page.elements.get('learning-autoplay').click();
 const saved=JSON.parse(page.storage.get('spell.state'));
 assert.equal(saved.settings.vocabularyAutoplay,false);
 const reopened=startBuiltPage('offline',saved);reopened.elements.get('study-autoplay').click();
 assert.equal(reopened.elements.get('study-autoplay').textContent,'Auto audio: on');
});
