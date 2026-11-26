const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Settings=require('../src/generation-settings.js');

function harness(){
 const elements=new Map(), context=vm.createContext({GenerationSettings:Settings,URL,URLSearchParams,console,setTimeout,clearTimeout,entryPage:'teacher',now:()=> 'now',
  document:{body:{dataset:{entry:'teacher'}}},location:{hostname:'127.0.0.1',origin:'http://127.0.0.1'},
  $:id=>{if(!elements.has(id))elements.set(id,{value:'',checked:false,textContent:'',dataset:{},hidden:false,setAttribute(){}});return elements.get(id);}});
 vm.runInContext(fs.readFileSync('src/teacher.js','utf8'),context);
 vm.runInContext('renderWorkspaceVocabulary=()=>{}',context);
 vm.runInContext("state={lists:[]};ai={root:'http://127.0.0.1',token:'teacher-token',teacher:{id:'teacher-a'},role:'teacher',config:{}};save=()=>true;selectedList=()=>state.lists[0]||null;",context);
 return {elements,context,run:code=>vm.runInContext(code,context)};
}

test('every grade from 3 through 12 has a separate complete conservative preset',()=>{
 const presets=Settings.presets();
 assert.deepEqual(Object.keys(presets),['3','4','5','6','7','8','9','10','11','12']);
 for(let grade=3;grade<=12;grade++)assert.deepEqual(presets[grade],{readingLevel:grade,dialect:'original',practiceSentences:1,exampleSentences:1,reuseApproved:true,esl:true,distractors:true,explanations:true,context:'',sense:''});
 presets[3].practiceSentences=5;
 assert.equal(presets[4].practiceSentences,1);
 assert.equal(Settings.presets()[3].practiceSentences,1);
});

test('generation metadata validates its fields and keeps context out of reusable presets',()=>{
 assert.equal(Settings.validate({...Settings.defaults(5),practiceSentences:0}),null);
 assert.equal(Settings.validate({...Settings.defaults(5),readingLevel:13}),null);
 assert.equal(Settings.validate({...Settings.defaults(5),esl:'true'}),null);
 assert.equal(Settings.validate({...Settings.defaults(5),context:'<bad>'}),null);
 assert.equal(Settings.validate({...Settings.defaults(5),context:' Water ',sense:' flow '}).context,'Water');
 const preset=Settings.validate({...Settings.defaults(5),context:'Private chapter',sense:'Private meaning'},true);
 assert.equal(preset.context,'');assert.equal(preset.sense,'');
});

test('chosen creation preset is copied onto the set before its automatic private save',()=>{
 const h=harness(), source=fs.readFileSync('src/app.js','utf8');
 vm.runInContext(source.slice(source.indexOf('function addList('),source.indexOf('function clearListLearningData(')),h.context);
 h.run("newListId=()=> 'new-set';wordsUnique=words=>words;dictionary=value=>value||{};now=()=> 'now';state.settings={selected:{}};renderSetup=()=>{};let observed;autosaveTeacherSet=async list=>{observed=JSON.parse(JSON.stringify(list.generationSettings));};let preset=GenerationSettings.defaults(8);let created=addList('Grade 8',['atom'],{},preset);preset.readingLevel=3;");
 assert.equal(h.run('observed.readingLevel'),8);
 assert.equal(h.run('created.generationSettings.readingLevel'),8);
});

test('switching lists hydrates each set and clears context without writing the grade 5 fallback',()=>{
 const h=harness();
 h.run("let a={id:'a',generationSettings:{...GenerationSettings.defaults(8),context:'Chapter on atoms'}};let b={id:'b'};hydrateGenerationSettings(a)");
 assert.equal(h.elements.get('ai-context').value,'Chapter on atoms');
 h.run('hydrateGenerationSettings(b)');
 assert.equal(h.elements.get('ai-context').value,'');
 assert.equal(Number(h.elements.get('ai-grade').value),5);
 assert.equal(h.run('b.generationSettings'),undefined);
});

test('a late preferences GET from another account is discarded',async()=>{
 const h=harness();
 h.run("let release;service=async()=>{await new Promise(resolve=>release=resolve);return {presets:{'5':{...GenerationSettings.defaults(5),practiceSentences:4}}}};let pending=loadTeacherPreferences();ai.token='new-token';ai.teacher={id:'teacher-b'};state={lists:[]};release()");
 await h.run('pending');
 assert.equal(h.run('teacherPresets[5].practiceSentences'),1);
});

test('saving a grade updates only its preset, leaves sets alone, and preserves the newly selected editor',async()=>{
 const h=harness();
 h.run("state.lists=[{id:'a',generationSettings:GenerationSettings.defaults(6)}];$('preset-grade').value='6';writeGenerationForm('preset',{...GenerationSettings.defaults(6),practiceSentences:3});let release;service=async(path,options)=>{await new Promise(resolve=>release=resolve);return {presets:{...GenerationSettings.presets(),'6':options.body.settings}}};let pending=saveTeacherPreset();$('preset-grade').value='9';presetEditVersion++;writeGenerationForm('preset',GenerationSettings.defaults(9));release()");
 await h.run('pending');
 assert.equal(h.run('teacherPresets[6].practiceSentences'),3);
 assert.equal(h.run('state.lists[0].generationSettings.practiceSentences'),1);
 assert.equal(Number(h.elements.get('preset-readingLevel').value),9);
});

test('per-set edits preserve context, advance the CAS revision, and never mutate a grade preset',()=>{
 const h=harness();
 h.run("now=()=> 'edited';let list={id:'a',packVersion:2,generationSettings:{...GenerationSettings.defaults(7),context:'Our chapter',sense:'matter'}};state.lists=[list];hydrateGenerationSettings(list);$('ai-sentences').value='3';persistSetGenerationSettings(false)");
 assert.equal(h.run('list.packVersion'),3);
 assert.equal(h.run('list.generationSettings.practiceSentences'),3);
 assert.equal(h.run('list.generationSettings.context'),'Our chapter');
 assert.equal(h.run('list.generationSettings.sense'),'matter');
 assert.equal(h.run('teacherPresets[7].practiceSentences'),1);
 assert.equal(h.run('aiSettings().practiceSentences'),3);
});

test('private save and restore carry generation settings outside the immutable public pack',async()=>{
 const h=harness();
 h.run("let detail;let sent;let list={id:'set',packVersion:1,updatedAt:'first',generationSettings:{...GenerationSettings.defaults(10),context:'A chapter'}};state.lists=[list];loadVocabulary=async()=>[{word:'atom',vocabulary:null}];outputPack=list=>({id:list.id,version:list.packVersion,words:[{word:'atom'}]});service=async(path,options)=>{sent=options.body;detail={pack:sent.pack,generationSettings:sent.generationSettings,audioStatus:{ready:1,total:1}};return detail};renderPrivateAudio=()=>{};watchPrivateAudio=()=>{};status=()=>{};");
 await h.run('autosaveTeacherSet(list)');
 assert.equal(h.run('sent.generationSettings.readingLevel'),10);
 assert.equal(h.run('sent.pack.generationSettings'),undefined);
 h.run("state={lists:[]};service=async()=>({sets:[detail]});Vocabulary={validatePack:pack=>pack};findPackList=id=>state.lists.find(list=>list.id===id);importPack=async pack=>state.lists.push({id:pack.id,packVersion:pack.version});renderSetup=()=>{}");
 await h.run('restoreTeacherSets()');
 assert.equal(h.run('state.lists[0].generationSettings.context'),'A chapter');
 assert.equal(h.run('state.lists[0].generationSettings.readingLevel'),10);
});

test('local state and backups retain only valid generation settings',()=>{
 const h=harness();vm.runInContext(fs.readFileSync('src/state.js','utf8'),h.context);
 h.run("let good=listMetadata({generationSettings:{...GenerationSettings.defaults(11),context:'Lab'}});let invalid=listMetadata({generationSettings:{readingLevel:99}})");
 assert.equal(h.run('good.generationSettings.readingLevel'),11);
 assert.equal(h.run('invalid.generationSettings'),undefined);
});

test('a late preset PUT cannot update the next account cache or editor',async()=>{
 const h=harness();
 h.run("$('preset-grade').value='6';writeGenerationForm('preset',{...GenerationSettings.defaults(6),practiceSentences:5});let release;service=async(path,options)=>{await new Promise(resolve=>release=resolve);return {presets:{'6':options.body.settings}}};let pending=saveTeacherPreset();ai.token='other';ai.teacher={id:'teacher-b'};state={lists:[]};teacherPresets=GenerationSettings.presets();writeGenerationForm('preset',GenerationSettings.defaults(8));release()");
 await h.run('pending');
 assert.equal(h.run('teacherPresets[6].practiceSentences'),1);
 assert.equal(Number(h.elements.get('preset-readingLevel').value),8);
});

test('dialog views show only controls for the named task',()=>{
 const h=harness();
 h.run("state.lists=[{id:'set',name:'Week 1'}];ai.teacher.isAdmin=true;ai.config.generationEnabled=true");
 const shown={setup:['teacher-account'],presets:['teacher-grade-defaults'],prepare:['teacher-job','teacher-private-audio'],share:['teacher-admin','teacher-private-audio'],administration:['teacher-operations']};
 const ids=['teacher-account','teacher-grade-defaults','teacher-job','teacher-private-audio','teacher-admin','teacher-operations'];
 for(const [view,visible] of Object.entries(shown)){
  h.run("renderTeacherView('"+view+"')");
  for(const id of ids)assert.equal(h.elements.get(id).hidden,!visible.includes(id),view+': '+id);
 }
 assert.match(h.elements.get('teacher-title').textContent,/Administration/);
 const html=fs.readFileSync('src/page.html','utf8');
 assert.match(html,/Create student link/);assert.match(html,/required for Paul audio/);
 assert.doesNotMatch(html,/teacher-alternate-audio|Troy|Publish set/);
});

test('offline signed-in teachers can reach prepare and student links without teacher landing actions',async()=>{
 const h=harness();
 h.run("entryPage='offline';state.lists=[{id:'set',name:'Offline words'}];ai.teacher.isAdmin=true;showTeacherTools=async view=>renderTeacherView(view);initTeacherViewNavigation();renderTeacherView('setup')");
 assert.equal(h.elements.get('teacher-view-nav').hidden,false);
 assert.equal(h.elements.get('teacher-nav-prepare').disabled,false);
 await h.elements.get('teacher-nav-prepare').onclick();
 assert.equal(h.elements.get('teacher-job').hidden,false);
 await h.elements.get('teacher-nav-share').onclick();
 assert.equal(h.elements.get('teacher-admin').hidden,false);
 h.run("ai.role='class';ai.teacher=undefined;renderTeacherView('tools')");
 assert.equal(h.elements.get('teacher-view-nav').hidden,true);
 assert.equal(h.elements.get('teacher-operations').hidden,true);
});

test('contextual vocabulary stays out of optional shared reuse without blocking student links',()=>{
 const h=harness();
 h.run("ai.teacher.isAdmin=true;state.lists=[{id:'set',generationSettings:GenerationSettings.defaults(5)}]");
 assert.equal(h.run('sharedDraftCacheSettings(true).readingLevel'),5);
 h.run("state.lists[0].generationSettings.context='Chapter example'");
 assert.equal(h.run('sharedDraftCacheSettings(true)'),undefined);
 h.run("state.lists[0].generationSettings.context='';state.lists[0].generationSettings.sense='A particular meaning'");
 assert.equal(h.run('sharedDraftCacheSettings(true)'),undefined);
 h.run("state.lists[0].generationSettings.sense='';ai.teacher.isAdmin=false");
 assert.equal(h.run('sharedDraftCacheSettings(true)'),undefined);
});

test('a GET started during a pending preset PUT cannot overwrite its committed result',async()=>{
 const h=harness();
 h.run("$('preset-grade').value='6';writeGenerationForm('preset',{...GenerationSettings.defaults(6),practiceSentences:4});let releasePut,releaseGet;service=async(path,options)=>{if(options.method==='PUT'){await new Promise(resolve=>releasePut=resolve);return {presets:{'6':options.body.settings}};}await new Promise(resolve=>releaseGet=resolve);return {presets:GenerationSettings.presets()};};let put=saveTeacherPreset();let get=loadTeacherPreferences();releasePut()");
 await h.run('put');h.run('releaseGet()');await h.run('get');
 assert.equal(h.run('teacherPresets[6].practiceSentences'),4);
 assert.equal(h.run('preferencesIdentity'),null);
});

test('an old account save cannot release the next account pending save lock',async()=>{
 const h=harness();
 h.run("$('preset-grade').value='6';writeGenerationForm('preset',GenerationSettings.defaults(6));let releases=[];service=async(path,options)=>{await new Promise(resolve=>releases.push(resolve));return {presets:{'6':options.body.settings}}};let first=saveTeacherPreset();ai.token='teacher-b';ai.teacher={id:'teacher-b'};state={lists:[]};pendingPresetSave=null;let second=saveTeacherPreset();releases[0]()");
 await h.run('first');
 assert.equal(h.run('pendingPresetSave.id'),'teacher-b');
 assert.equal(h.elements.get('preset-save').disabled,true);
 h.run('releases[1]()');await h.run('second');
 assert.equal(h.run('pendingPresetSave'),null);
 assert.equal(h.elements.get('preset-save').disabled,false);
});

test('invalid per-set controls block paid generation instead of silently using old settings',()=>{
 const h=harness();
 h.run("let list={id:'set',packVersion:1,generationSettings:GenerationSettings.defaults(5)};state.lists=[list];hydrateGenerationSettings(list);$('ai-sentences').value='6';persistSetGenerationSettings(false)");
 assert.equal(h.run('list.generationSettings.practiceSentences'),1);
 assert.throws(()=>h.run('aiSettings()'),/Practice sentences must be a whole number from 1 through 5/);
 h.run("$('ai-sentences').value='1';$('ai-context').value='temperature < 0';persistSetGenerationSettings(false)");
 assert.throws(()=>h.run('aiSettings()'),/plain text without angle brackets/);
 h.run("$('ai-context').value='Our chapter';persistSetGenerationSettings(false)");
 assert.equal(h.run('aiSettings().context'),'Our chapter');
 assert.equal(h.elements.get('teacher-settings-status').textContent,'');
});

test('a new owner student link requires recordings, while contextual cache reuse remains optional',()=>{
 const h=harness();
 h.context.SharedReview={sharingContent:()=>({ready:true,words:[{word:'atom',vocabulary:{status:'approved'}}],approved:['atom'],drafts:[],missing:[]})};
 h.run("ai.teacher.isAdmin=true;ai.config={dictationEnabled:false};state.lists=[{id:'set',words:['atom'],generationSettings:GenerationSettings.defaults(5)}];sharing={list:state.lists[0],records:[{word:'atom'}]};$('shared-mode').value='spelling';renderSharing()");
 assert.equal(h.elements.get('ai-publish').disabled,true);
 assert.match(h.elements.get('ai-publish-readiness').textContent,/Connect OpenRouter/);
 h.run("ai.config.dictationEnabled=true;state.lists[0].audioStatus={recordings:[{key:'0-s',status:'ready'}]};state.lists[0].generationSettings.sense='a particular meaning';$('ai-publish-cache').checked=true;renderSharing()");
 assert.equal(h.elements.get('ai-publish-cache').disabled,true);
 assert.equal(h.elements.get('ai-publish-cache').checked,false);
 assert.equal(h.elements.get('ai-publish').disabled,false);
 assert.match(h.elements.get('ai-publish-cache-help').textContent,/still create/);
});
