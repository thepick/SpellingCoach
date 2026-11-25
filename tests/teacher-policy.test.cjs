const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function harness(){
 const nodes=new Map(), stored=new Map();
 const node=()=>({value:'',checked:false,hidden:false,disabled:false,dataset:{},textContent:'',open:false,
  addEventListener(){},setAttribute(){},replaceChildren(){},querySelector(){return node();},close(){this.open=false;},showModal(){this.open=true;}});
 const context=vm.createContext({GenerationSettings:require('../src/generation-settings.js'),SharedReview:require('../src/shared-review.js'),
  URL,URLSearchParams,console,setTimeout:()=>0,clearTimeout(){},entryPage:'teacher',
  LOCAL_PREVIEW_KEY:'wordlab.local-preview',
  document:{body:{dataset:{entry:'teacher'}}},location:{origin:'https://site.test',href:'https://site.test/',hash:'',pathname:'/'},
  localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)},
  $:id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},window:{open(){}},
  Dictation:{canonicalPackId:id=>id},Vocabulary:{validatePack:pack=>pack}});
 vm.runInContext(fs.readFileSync('src/teacher.js','utf8'),context);
 vm.runInContext(`state={settings:{retypeOnMiss:true,allowVariants:false},lists:[]};
  let list={id:'local',packId:'pack',packVersion:1,name:'Week',words:['atom'],updatedAt:'same',audioStatus:{recordings:[{key:'0-s',status:'ready'}]}};state.lists=[list];
  let records=[{word:'atom',vocabulary:null}];selectedList=()=>list;loadVocabulary=async()=>records;outputPack=(list,words)=>({id:'pack',version:list.packVersion,name:list.name,words});
  refreshTeacher=()=>{};watchPracticeAudio=()=>{};autosaveTeacherSet=async()=>{};save=()=>true;newListId=()=> 'ticket';
  ai={root:'https://service.test',token:'token',role:'teacher',teacher:{id:'teacher'},config:{dictationEnabled:true}};
  initTeacherAccounts=()=>{};initTeacherViewNavigation=()=>{};initTeacher();
  $('shared-mode').value='spelling';$('shared-hints').checked=true;`,context);
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
 assert.equal(h.nodes.get('ai-link-actions').hidden,true);
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
 assert.equal(h.nodes.get('ai-link-actions').hidden,true);
});

test('a rule change during existing-link lookup cannot overwrite the author controls',async()=>{
 const h=harness();
 h.run("let release;service=async()=>{await new Promise(resolve=>release=resolve);return {visibility:'public',pack:outputPack(list,records),practice:{mode:'spelling',allowHints:true,retypeOnMiss:false,allowVariants:true}}};let pending=showTeacherTools('share')");
 await new Promise(resolve=>setImmediate(resolve));
 h.nodes.get('shared-retype').checked=false;h.nodes.get('shared-variants').checked=false;
 h.run('release()');await h.run('pending');
 assert.equal(h.nodes.get('shared-variants').checked,false);
 assert.equal(h.nodes.get('ai-link-actions').hidden,true);
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
 assert.equal(h.nodes.get('ai-link-actions').hidden,true);
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
 assert.match(h.nodes.get('ai-publish-readiness').textContent,/Reopen Student link to retry/);
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
 assert.equal(h.nodes.get('ai-link-actions').hidden,true);
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
