const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function harness(){
 const nodes=new Map(), stored=new Map();
 const node=()=>({value:'',checked:false,hidden:false,disabled:false,dataset:{},textContent:'',open:false,
  addEventListener(){},setAttribute(){},replaceChildren(){},append(){},focus(){},querySelector(){return node();},close(){this.open=false;},showModal(){this.open=true;}});
 const context=vm.createContext({GenerationSettings:require('../src/generation-settings.js'),SharedReview:require('../src/shared-review.js'),
  URL,URLSearchParams,console,setTimeout:()=>0,clearTimeout(){},entryPage:'teacher',
  LOCAL_PREVIEW_KEY:'wordlab.local-preview',
  document:{body:{dataset:{entry:'teacher'}}},location:{origin:'https://site.test',href:'https://site.test/',hash:'',pathname:'/'},
  localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)},
  $:id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},window:{open(){}},
  Dictation:{canonicalPackId:id=>id},Vocabulary:{validatePack:pack=>pack,normalizeWords:require('../src/vocabulary.js').normalizeWords},
  now:()=>String(Date.now()),copy:async()=>false,show(){}});
 vm.runInContext(fs.readFileSync('src/teacher.js','utf8'),context);
 vm.runInContext(`state={settings:{selected:{},retypeOnMiss:true,allowVariants:false},lists:[]};
  let list={id:'local',packId:'pack',packVersion:1,name:'Week',words:['atom'],updatedAt:'same',audioStatus:{recordings:[{key:'0-s',status:'ready'}]}};state.lists=[list];
  let records=[{word:'atom',vocabulary:null}];selectedList=()=>list;loadVocabulary=async()=>records;outputPack=(list,words)=>({id:'pack',version:list.packVersion,name:list.name,words});
  refreshTeacher=()=>{};watchPracticeAudio=()=>{};autosaveTeacherSet=async()=>{};save=()=>true;newListId=()=> 'ticket';
  ai={root:'https://service.test',token:'token',role:'teacher',teacher:{id:'teacher'},config:{dictationEnabled:true}};
  canLeaveVocabularyEditor=()=>true;closeVocabularyEditor=async()=>{};renderWorkspaceVocabulary=()=>{};
  initTeacherAccounts=()=>{};initTeacherViewNavigation=()=>{};initTeacher();
  $('shared-mode').value='spelling';$('shared-hints').checked=true;$('prepare-share-screen').hidden=true;`,context);
 return {nodes,stored,context,run:code=>vm.runInContext(code,context)};
}

test('link authoring uses local defaults, then restores explicit server rules without changing them',async()=>{
 const h=harness();
 h.run(`service=async()=>({visibility:'public',pack:outputPack(list,records),practice:{mode:'spelling',allowHints:true,retypeOnMiss:false,allowVariants:true}})`);
 await h.run("showTeacherTools('share')");
 assert.equal(h.nodes.get('shared-retype').checked,false);
 assert.equal(h.nodes.get('shared-variants').checked,true);
 assert.equal(h.run('state.settings.retypeOnMiss'),true);
 assert.equal(h.run('state.settings.allowVariants'),false);
 assert.equal(h.nodes.get('ai-link-actions').hidden,false);
});

test('legacy rules stay undefined in the published snapshot until an explicit update',async()=>{
 const h=harness();
 h.run(`service=async()=>({visibility:'public',pack:outputPack(list,records),practice:{mode:'spelling',allowHints:true}})`);
 await h.run("showTeacherTools('share')");
 assert.equal(h.nodes.get('shared-retype').checked,true);
 assert.equal(h.nodes.get('shared-variants').checked,false);
 assert.equal(h.run('ai.publishedRetype'),undefined);
 assert.equal(h.run('ai.publishedVariants'),undefined);
 assert.equal(h.nodes.get('ai-link-actions').hidden,false);
 assert.equal(h.nodes.get('ai-publish').textContent,'Update student link');
});

test('publish and local student preview use the same explicit per-link rules',async()=>{
 const h=harness();
 h.run("sharing={list,records};$('shared-retype').checked=false;$('shared-variants').checked=true;renderSharing();let body;service=async(path,options)=>{body=options.body;return {pack:body.pack,audioStatus:{ready:1,total:1}}}");
 h.nodes.get('ai-preview').onclick();
 const preview=JSON.parse(h.stored.get('wordlab.local-preview'));
 await h.nodes.get('ai-publish').onclick();
 const body=JSON.parse(h.run('JSON.stringify(body)'));
 assert.equal(body.retypeOnMiss,false);assert.equal(body.allowVariants,true);
 assert.deepEqual(preview.practice,{mode:body.mode,allowHints:body.allowHints,retypeOnMiss:body.retypeOnMiss,allowVariants:body.allowVariants});
 assert.equal(h.run('ai.publishedRetype'),false);assert.equal(h.run('ai.publishedVariants'),true);
 h.nodes.get('shared-retype').checked=true;h.nodes.get('shared-retype').onchange();
 assert.equal(h.nodes.get('ai-link-actions').hidden,false);
});

test('a rule change during existing-link lookup cannot overwrite the author controls',async()=>{
 const h=harness();
 h.run("let release;service=async()=>{await new Promise(resolve=>release=resolve);return {visibility:'public',pack:outputPack(list,records),practice:{mode:'spelling',allowHints:true,retypeOnMiss:false,allowVariants:true}}};let pending=showTeacherTools('share')");
 await new Promise(resolve=>setImmediate(resolve));
 h.nodes.get('shared-retype').checked=false;h.nodes.get('shared-variants').checked=false;
 h.run('release()');await h.run('pending');
 assert.equal(h.nodes.get('shared-variants').checked,false);
 assert.equal(h.nodes.get('ai-link-actions').hidden,false);
 assert.equal(h.run('ai.publishedVariants'),true);
});

test('a rule change while saving prevents a publish request for stale author choices',async()=>{
 const h=harness();
 h.run("sharing={list,records};$('shared-retype').checked=true;$('shared-variants').checked=false;let release;let calls=0;autosaveTeacherSet=async()=>{await new Promise(resolve=>release=resolve)};service=async()=>{calls++;throw Error('Unexpected publish')}");
 const pending=h.nodes.get('ai-publish').onclick();
 await new Promise(resolve=>setImmediate(resolve));
 h.nodes.get('shared-variants').checked=true;h.run('release()');await pending;
 assert.equal(h.run('calls'),0);
 assert.match(h.nodes.get('ai-publish-status').textContent,/rules changed/i);
});

test('a rule change after a publish request starts never exposes its stale link as current',async()=>{
 const h=harness();
 h.run("sharing={list,records};$('shared-retype').checked=true;$('shared-variants').checked=false;let release;let body;service=async(path,options)=>{body=options.body;await new Promise(resolve=>release=resolve);return {pack:body.pack,audioStatus:{ready:1,total:1}}}");
 const pending=h.nodes.get('ai-publish').onclick();
 await new Promise(resolve=>setImmediate(resolve));
 h.nodes.get('shared-retype').checked=false;h.run('release()');await pending;
 assert.equal(h.run('body.retypeOnMiss'),true);
 assert.equal(h.nodes.get('ai-link-actions').hidden,true);
 assert.match(h.nodes.get('ai-publish-status').textContent,/rules changed/i);
});

test('new link defaults are captured when opening the link view, and spelling keeps the variants snapshot',async()=>{
 const h=harness();
 h.run("service=async()=>null");
 await h.run("showTeacherTools('prepare')");
 h.run("state.settings.retypeOnMiss=false;state.settings.allowVariants=true");
 await h.run("showTeacherTools('share')");
 assert.equal(h.nodes.get('shared-retype').checked,false);
 assert.equal(h.nodes.get('shared-variants').checked,true);
 assert.equal(h.nodes.get('shared-variants').disabled,true);
 h.run('publishing=true;renderSharing()');
 assert.equal(h.nodes.get('shared-retype').disabled,true);
 assert.equal(h.nodes.get('shared-variants').checked,true);
});

test('existing rules survive private content edits and reload without changing local teacher defaults',async()=>{
 const h=harness();
 h.run("list.packVersion=2;list.updatedAt='edited';let body;service=async(path,options)=>{if(options?.method==='POST'){body=options.body;return {pack:body.pack,audioStatus:{ready:1,total:1}};}return {visibility:'public',pack:{...outputPack(list,records),version:1},practice:{mode:'spelling',allowHints:true,retypeOnMiss:false,allowVariants:true}}}");
 await h.run("showTeacherTools('share')");
 assert.equal(h.nodes.get('shared-retype').checked,false);
 assert.equal(h.nodes.get('shared-variants').checked,true);
 assert.equal(h.run('state.settings.retypeOnMiss'),true);
 assert.equal(h.nodes.get('ai-link-actions').hidden,false);
 assert.equal(h.run('ai.publishedUpdatedAt'),null);
 await h.nodes.get('ai-publish').onclick();
 assert.equal(h.run('body.retypeOnMiss'),false);
 assert.equal(h.run('body.allowVariants'),true);
});

test('untouched controls cannot publish local defaults before the initial link lookup finishes',async()=>{
 const h=harness();
 h.run("let release;let posts=0;service=async(path,options)=>{if(options?.method==='POST'){posts++;throw Error('Must wait for GET');}await new Promise(resolve=>release=resolve);return {visibility:'public',pack:outputPack(list,records),practice:{mode:'spelling',allowHints:true,retypeOnMiss:false,allowVariants:true}}};let pending=showTeacherTools('share')");
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.nodes.get('ai-publish').disabled,true);
 await h.nodes.get('ai-publish').onclick();
 assert.equal(h.run('posts'),0);
 h.run('release()');await h.run('pending');
 assert.equal(h.nodes.get('shared-retype').checked,false);
 assert.equal(h.nodes.get('ai-link-actions').hidden,false);
});

test('404 allows a new link while transient lookup errors require reopening to retry',async()=>{
 const h=harness();
 h.run("let status=503;service=async()=>{const error=Error('Lookup failed');error.status=status;throw error}");
 await h.run("showTeacherTools('share')");
 assert.equal(h.nodes.get('ai-publish').disabled,true);
 assert.match(h.nodes.get('ai-publish-readiness').textContent,/Retry loading the link/);
 h.run('status=404');await h.run("showTeacherTools('share')");
 assert.equal(h.nodes.get('ai-publish').disabled,false);
 assert.equal(h.run('sharing.linkLookup'),'missing');
});

test('all assignment controls and preview wait for lookup, stay blocked on error, then reopen after 404',async()=>{
 const h=harness();
 h.run("let release;service=async()=>{await new Promise(resolve=>release=resolve);const error=Error('Unavailable');error.status=503;throw error};let pending=showTeacherTools('share')");
 await new Promise(resolve=>setImmediate(resolve));
 for(const id of ['shared-mode','shared-hints','shared-retype','shared-variants','ai-preview'])assert.equal(h.nodes.get(id).disabled,true,'loading '+id);
 h.run('release()');await h.run('pending');
 for(const id of ['shared-mode','shared-hints','shared-retype','shared-variants','ai-preview'])assert.equal(h.nodes.get(id).disabled,true,'error '+id);
 h.run("service=async()=>{const error=Error('New link');error.status=404;throw error}");
 await h.run("showTeacherTools('share')");
 assert.equal(h.nodes.get('shared-mode').disabled,false);
 assert.equal(h.nodes.get('shared-retype').disabled,false);
 assert.equal(h.nodes.get('shared-hints').disabled,true);
 assert.equal(h.nodes.get('shared-variants').disabled,true);
 assert.equal(h.nodes.get('ai-preview').disabled,false);
 h.nodes.get('shared-mode').value='mixed';h.nodes.get('shared-mode').onchange();
 for(const id of ['shared-mode','shared-hints','shared-retype','shared-variants'])assert.equal(h.nodes.get(id).disabled,false,'loaded mixed '+id);
});

test('touching and restoring the same checkbox value during lookup preserves the chosen draft rules',async()=>{
 const h=harness();
 h.run("let release;service=async()=>{await new Promise(resolve=>release=resolve);return {visibility:'public',pack:outputPack(list,records),practice:{mode:'spelling',allowHints:true,retypeOnMiss:false,allowVariants:true}}};let pending=showTeacherTools('share')");
 await new Promise(resolve=>setImmediate(resolve));
 h.nodes.get('shared-retype').checked=false;h.nodes.get('shared-retype').onchange();
 h.nodes.get('shared-retype').checked=true;h.nodes.get('shared-retype').onchange();
 h.run('release()');await h.run('pending');
 assert.equal(h.nodes.get('shared-retype').checked,true);
 assert.equal(h.nodes.get('ai-link-actions').hidden,false);
});

test('correction retyping is hidden for vocabulary-only links without changing its selected policy',()=>{
 const h=harness();
 h.run("sharing={list,records};$('shared-mode').value='vocabulary';$('shared-retype').checked=true;renderSharing()");
 assert.equal(h.nodes.get('shared-retype-row').hidden,true);
 assert.equal(h.nodes.get('shared-retype').checked,true);
});

test('an obsolete lookup response cannot hydrate policies after the publishing generation changes',async()=>{
 const h=harness();
 h.run("let release;service=async()=>{await new Promise(resolve=>release=resolve);return {visibility:'public',pack:outputPack(list,records),practice:{mode:'spelling',allowHints:true,retypeOnMiss:false,allowVariants:true}}};let pending=showTeacherTools('share')");
 await new Promise(resolve=>setImmediate(resolve));
 h.run('ai.linkGeneration=1;release()');await h.run('pending');
 assert.equal(h.nodes.get('shared-retype').checked,true);
 assert.equal(h.run('ai.published'),undefined);
 assert.equal(h.nodes.get('ai-publish').disabled,true);
});


test('current links use one Copy action, while private edits retain the published link and preview the draft',async()=>{
 const h=harness();h.run("let posts=0,copies=0;copy=async()=>{copies++;return true};service=async()=>({visibility:'public',pack:outputPack(list,records),practice:{mode:'spelling',allowHints:true,retypeOnMiss:true,allowVariants:false},audioStatus:{ready:1,total:1}})");
 await h.run("showTeacherTools('share')");
 assert.equal(h.nodes.get('ai-publish').textContent,'Copy student link');
 await h.nodes.get('ai-publish').onclick();assert.equal(h.run('copies'),1);
 h.run("list.name='Private revision';list.updatedAt='changed';renderSharing()");
 assert.equal(h.nodes.get('ai-publish').textContent,'Update student link');
 assert.equal(h.nodes.get('ai-link-actions').hidden,false);
 assert.equal(h.nodes.get('workspace-unshared').hidden,false);
 assert.match(h.nodes.get('ai-student-link').value,/#pack=pack/);
 h.nodes.get('ai-preview').onclick();
 assert.equal(JSON.parse(h.stored.get('wordlab.local-preview')).pack.name,'Private revision');
});

test('workspace words validate before autosave and block generation, publication, and preview until saved',async()=>{
 const h=harness();
 h.run("let saves=0;renderSetup=()=>{};autosaveTeacherSet=async()=>{saves++};sharing={list,records};workspaceEdit={list,owner:state,token:ai.token,revision:0,pending:false,error:''};$('workspace-name').value='Week';$('workspace-words').value='atom';$('prepare-share-screen').hidden=false;ai.config.generationEnabled=true");
 h.nodes.get('workspace-words').value='';h.nodes.get('workspace-words').oninput();
 assert.equal(h.nodes.get('ai-publish').disabled,true);assert.equal(h.nodes.get('ai-generate').disabled,true);
 assert.equal(await h.run('flushWorkspaceWords()'),false);
 assert.equal(h.run('JSON.stringify(list.words)'), '["atom"]');assert.equal(h.run('saves'),0);
 h.nodes.get('workspace-words').value='atom\n\nsolid\natom\n';h.nodes.get('workspace-words').oninput();
 assert.equal(await h.run('flushWorkspaceWords()'),true);
 assert.equal(h.run('JSON.stringify(list.words)'), '["atom","solid"]');assert.equal(h.run('saves'),1);
 assert.equal(h.run('list.packVersion'),2);assert.equal(h.run('workspaceEdit.pending'),false);
});

test('an old words-save response cannot clear a newer edit or cross accounts',async()=>{
 const h=harness();h.run("renderSetup=()=>{};let release;autosaveTeacherSet=async()=>{await new Promise(resolve=>release=resolve)};sharing={list,records};workspaceEdit={list,owner:state,token:ai.token,revision:1,pending:true,error:''};$('workspace-name').value='Week';$('workspace-words').value='solid';let pending=flushWorkspaceWords()");
 await new Promise(resolve=>setImmediate(resolve));
 h.nodes.get('workspace-words').value='solid\ngas';h.nodes.get('workspace-words').oninput();
 h.run('release()');await h.run('pending');
 assert.equal(h.run('workspaceEdit.pending'),true);assert.equal(h.nodes.get('workspace-words').value,'solid\ngas');
 h.run("autosaveTeacherSet=async()=>{await new Promise(resolve=>release=resolve)};pending=flushWorkspaceWords()");
 await new Promise(resolve=>setImmediate(resolve));
 h.run("ai.token='another-account';release()");await h.run('pending');
 assert.equal(h.nodes.get('workspace-words').value,'solid\ngas');
 assert.doesNotMatch(h.nodes.get('workspace-word-status').textContent,/Saved automatically/);
});

test('a copy failure leaves a ready visible link and Copy action without republishing',async()=>{
 const h=harness();h.run("sharing={list,records};let posts=0;copy=async()=>{throw Error('Clipboard denied')};service=async(path,options)=>{posts++;return {pack:options.body.pack,audioStatus:{ready:1,total:1}}}");
 await h.nodes.get('ai-publish').onclick();
 assert.equal(h.run('posts'),1);assert.equal(h.nodes.get('ai-link-actions').hidden,false);
 assert.equal(h.nodes.get('ai-publish').textContent,'Copy student link');
 assert.match(h.nodes.get('ai-publish-status').textContent,/Student link ready/);
 assert.match(h.nodes.get('ai-student-link').value,/#pack=pack/);
});


test('returning to the same set reloads words changed from the set list',async()=>{
 const h=harness();h.run("renderSetup=()=>{};show=id=>{$('prepare-share-screen').hidden=id!=='prepare-share-screen'};service=async()=>{const error=Error('No link');error.status=404;throw error}");
 await h.run("showTeacherTools('workspace')");
 await h.nodes.get('workspace-back').onclick();
 h.run("list.words=['newer'];list.updatedAt='newer-revision';list.packVersion++");
 await h.run("showTeacherTools('workspace')");
 assert.equal(h.nodes.get('workspace-words').value,'newer');
});

test('generation locks before loading and snapshots the selected set settings',async()=>{
 const h=harness();h.run("let releases=[],posts=0,sent;ai.config.generationEnabled=true;let generationSettings={readingLevel:4};aiSettings=()=>({...generationSettings});loadVocabulary=async()=>{await new Promise(resolve=>releases.push(resolve));return records};runJob=async()=>{};applyJob=job=>{ai.job=job};service=async(path,options)=>{posts++;sent=options.body.settings;return {id:'job',status:'complete',words:[]}};let first=$('ai-generate').onclick();let second=$('ai-generate').onclick()");
 await new Promise(resolve=>setImmediate(resolve));
 h.run("generationSettings.readingLevel=8;releases.forEach(resolve=>resolve())");
 await h.run('Promise.all([first,second])');assert.equal(h.run('posts'),1);assert.equal(h.run('sent.readingLevel'),4);
});

test('switching sets during the generation read cancels before dispatch',async()=>{
 const h=harness();h.run("let release,posts=0;aiSettings=()=>({readingLevel:4});loadVocabulary=async()=>{await new Promise(resolve=>release=resolve);return records};service=async()=>{posts++;return {}};let pending=$('ai-generate').onclick()");
 await new Promise(resolve=>setImmediate(resolve));
 h.run("selectedList=()=>({id:'other'});release()");await h.run('pending');assert.equal(h.run('posts'),0);
});


test('reopening recovers completed missing drafts without making another generation request',async()=>{
 const h=harness();h.run("wordKey=word=>word;Vocabulary.validateRecord=(word,value)=>value;ai.listId=list.id;ai.job={status:'complete',words:[{word:'atom',vocabulary:{status:'draft',definition:'Recovered draft'}}]};let generations=0;service=async path=>{if(path==='/generate')generations++;const error=Error('No public link');error.status=404;throw error};saveVocabulary=async(target,rows,metadata)=>{records=rows;Object.assign(target,metadata)}");
 await h.run("showTeacherTools('workspace')");
 assert.equal(h.run('records[0].vocabulary.definition'),'Recovered draft');assert.equal(h.run('generations'),0);
 h.run("$('prepare-share-screen').hidden=false;ai.config.generationEnabled=true;renderSetWorkspace()");
 assert.equal(h.nodes.get('ai-generate').hidden,false);
 assert.equal(h.nodes.get('workspace-edit-vocabulary').textContent,'Review vocabulary');
});

test('one click fills imported definitions at the set grade and prepares all audio without publishing',async()=>{
 const h=harness();
 h.context.generated={senseId:'primary',partOfSpeech:'noun',definition:'A tiny piece of matter.',
  examples:['An atom is too small to see.'],clozeQuestions:[{id:'q1',sentence:'An _____ is a tiny part of matter.',answer:'atom',explanation:'It is a small part of matter.'}],
  meaningDistractors:['A large cloud.','A loud sound.','A kind of food.'],acceptedSpellings:[],readingLevel:4,status:'draft'};
 h.context.RealVocabulary=require('../src/vocabulary.js');
 h.run(`Vocabulary=RealVocabulary;wordKey=Vocabulary.wordKey;let calls=[];let saves=0;
  list.generationSettings=GenerationSettings.defaults(4);hydrateGenerationSettings(list);
  records=[{word:'atom',promptType:'definition',image:{id:'keep-image'},vocabulary:{...generated,definition:'A tiny part of matter.',examples:[],clozeQuestions:[],meaningDistractors:[],contentType:'definition',status:'approved'}}];
  autosaveTeacherSet=async()=>{saves++;list.audioStatus={ready:1,total:3,pending:false};};
  saveVocabulary=async(target,rows,metadata)=>{records=rows;sharing.records=rows;Object.assign(target,metadata)};
  renderPrivateAudio=()=>{};watchPrivateAudio=()=>{};renderSetWorkspace=()=>{};
  ai.config.generationEnabled=true;sharing={list,records};
  service=async(path,options)=>{calls.push({path,body:options.body});if(path==='/generate')return {id:'job',status:'complete',words:[{word:'atom',vocabulary:generated}],definitions:options.body.definitions};if(path.endsWith('/retry'))return {audioStatus:{ready:1,total:3,pending:true}};throw Error('Unexpected endpoint '+path);};
  applyJob=job=>{ai.job=job};runJob=async()=>applyTeacherDrafts();`);
 await h.nodes.get('ai-generate').onclick();
 assert.deepEqual(JSON.parse(h.run('JSON.stringify(calls.map(call=>call.path))')),['/generate','/teacher/sets/pack/retry']);
 assert.equal(h.run('calls[0].body.settings.readingLevel'),4);
 assert.equal(h.run('calls[0].body.definitions[0].definition'),'A tiny part of matter.');
 assert.equal(h.run('records[0].vocabulary.definition'),'A tiny part of matter.');
 assert.equal(h.run('records[0].vocabulary.clozeQuestions.length'),1);
 assert.equal(h.run('records[0].vocabulary.examples.length'),1);
 assert.equal(h.run('records[0].vocabulary.contentType'),undefined);
 assert.equal(h.run('records[0].vocabulary.status'),'draft');
 assert.equal(h.run('records[0].promptType'),'sentence');
 assert(require('../src/learning.js').practiceAudioPrompts(JSON.parse(h.run('JSON.stringify(records[0])')),0).some(prompt=>prompt.skill==='vocabulary' && /blank/.test(prompt.text)));
 assert.equal(h.run('records[0].image.id'),'keep-image');
 assert.equal(h.run('list.audioStatus.pending'),true);
 assert.equal(h.run('saves'),2);
});

test('the same main button retries audio for completed vocabulary without generating replacement sentences',async()=>{
 const h=harness();
 h.run(`let retries=0,saves=0;records=[{word:'atom',vocabulary:{examples:['Keep this example.'],clozeQuestions:[{sentence:'Keep this _____.'}]}}];
  aiSettings=()=>({readingLevel:4});autosaveTeacherSet=async()=>{saves++;};
  list.audioStatus={ready:1,total:3,pending:false};renderPrivateAudio=()=>{};watchPrivateAudio=()=>{};renderSetWorkspace=()=>{};
  service=async path=>{assertRetryPath=path;retries++;return {audioStatus:{ready:1,total:3,pending:true}}};`);
 await h.nodes.get('ai-generate').onclick();
 assert.equal(h.run('retries'),1);assert.equal(h.run('saves'),1);
 assert.equal(h.run('assertRetryPath'),'/teacher/sets/pack/retry');
 assert.equal(h.run('records[0].vocabulary.examples[0]'),'Keep this example.');
});

test('a supplied definition edited while generation runs keeps its existing content',async()=>{
 const h=harness();
 h.run(`wordKey=word=>word;Vocabulary.validateRecord=(word,value)=>value;let saves=0;
  records=[{word:'atom',vocabulary:{definition:'A newer teacher meaning.',examples:[],clozeQuestions:[]}}];
  ai.listId=list.id;ai.job={words:[{word:'atom',vocabulary:{definition:'Old meaning.'}}],definitions:[{word:'atom',definition:'Old meaning.'}]};
  saveVocabulary=async()=>{saves++;};`);
 await h.run('applyTeacherDrafts()');
 assert.equal(h.run('saves'),0);assert.equal(h.run('records[0].vocabulary.definition'),'A newer teacher meaning.');
});
