const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Vocabulary=require('../src/vocabulary.js');
const Learning=require('../src/learning.js');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const row=()=>({word:'solid',vocabulary:{senseId:'primary',partOfSpeech:'noun',definition:'A material that keeps its shape.',
 examples:['The solid keeps its shape.'],clozeQuestions:[{id:'q1',sentence:'The _____ keeps its shape.',answer:'solid',explanation:'It keeps its shape.'}],
 meaningDistractors:['A hot gas.','A type of sound.','A bright color.'],acceptedSpellings:[],readingLevel:5,status:'draft'}});

function harness() {
 const elements=new Map(),events=[];
 const element=id=>({id,value:'',textContent:'',disabled:false,hidden:false,open:false,children:[],dataset:{},parentElement:null,listeners:{},
  append(node){if(node.parentElement)node.parentElement.children=node.parentElement.children.filter(child=>child!==node);this.children.push(node);node.parentElement=this;},
  add(node){this.append(node);},replaceChildren(){for(const child of this.children)child.parentElement=null;this.children=[];},
  addEventListener(type,callback){(this.listeners[type]??=[]).push(callback);},
  showModal(){this.open=true;events.push('modal');},close(){this.open=false;events.push('close:'+id);for(const callback of this.listeners.close||[])callback();},
  setCustomValidity(value){this.validation=value;},setAttribute(){},reportValidity(){},focus(){},reset(){},querySelector(){return element('child');},
 });
 const get=id=>{if(!elements.has(id))elements.set(id,element(id));return elements.get(id);};
 const context=vm.createContext({Vocabulary,Learning,structuredClone,Option:function(text,value){return {...element('option'),textContent:text,value};},
  $:get,document:{createElement:()=>element('created')},location:{protocol:'https:'},entryPage:'teacher',
  ai:{role:'teacher',token:'teacher-a'},state:{lists:[],learning:{},familiar:{},settings:{selected:{}}},
  save:()=>true,now:()=> 'now',newListId:()=> 'new-id',status:message=>events.push('status:'+message),
  initTeacher(){},initDictation(){},initSharedReview(){},prefillTroySentence(){},renderRecordingControls(){},
  backToSetup(){},show(){},speech:false,sharedReview:null,
  stopRecording:()=>events.push('stop'),refreshSetWorkspace:async()=>events.push('refresh'),confirm:()=>true,
 });
 vm.runInContext(fs.readFileSync('src/coach.js','utf8'),context);
 const run=code=>vm.runInContext(code,context);
 context.rows=[row()];
 run('const originalSaveVocabulary=saveVocabulary;let selected={id:"set",name:"Words",words:["solid"],packVersion:1,updatedAt:"before"};state.lists=[selected];selectedList=()=>selected;loadVocabulary=async()=>rows;saveVocabulary=async(list,records,metadata)=>{Object.assign(list,metadata);return {vocabKey:list.vocabKey,packVersion:list.packVersion,updatedAt:list.updatedAt};};initCoach();');
 get('vocab-dialog').append(get('vocab-editor-panel'));get('workspace-review').hidden=true;
 return {context,run,elements,events,get};
}

test('canceling vocabulary navigation keeps the same word, page, filters, and unsaved fields',async()=>{
 const h=harness();h.context.rows.push(...Array.from({length:30},(_,index)=>({word:'word '+index,vocabulary:null})));
 await h.run('openVocabularyEditor("",true)');
 h.context.confirm=()=>false;h.get('vocab-definition').value='Unfinished correction';
 h.get('vocab-word').value='word 0';h.get('vocab-word').onchange();
 assert.equal(h.get('vocab-word').value,'solid');
 h.get('vocab-search').value='word';h.get('vocab-search').oninput();
 assert.equal(h.get('vocab-search').value,'');
 h.get('vocab-filter').value='missing';h.get('vocab-filter').oninput();
 assert.equal(h.get('vocab-filter').value,'');
 h.get('vocab-next').onclick();
 assert.equal(h.get('vocab-page').textContent,'Page 1 of 2');
 await h.get('vocab-close').onclick();
 assert.equal(h.get('workspace-review').hidden,false);
 assert.equal(h.get('vocab-definition').value,'Unfinished correction');
 assert.equal(h.run('canLeaveVocabularyEditor()'),false);
 h.context.confirm=()=>true;
 h.get('vocab-word').value='word 0';h.get('vocab-word').onchange();
 assert.equal(h.get('vocab-word').value,'word 0');assert.equal(h.get('vocab-definition').value,'');
});

test('Escape and Close protect unsaved vocabulary in the modal',async()=>{
 const h=harness();await h.run('openVocabularyEditor()');
 const dialog=h.get('vocab-dialog');let canceled=false;
 h.context.confirm=()=>false;h.get('vocab-explanations').value='Unfinished feedback';
 for(const handler of dialog.listeners.cancel || []) handler({preventDefault(){canceled=true;}});
 assert.equal(canceled,true);
 h.get('vocab-close').onclick();assert.equal(dialog.open,true);
 assert.equal(h.get('vocab-explanations').value,'Unfinished feedback');
 h.context.confirm=()=>true;
 h.get('vocab-close').onclick();assert.equal(dialog.open,false);
});

test('word navigation crosses pages and Save and approve advances to the next draft',async()=>{
 const h=harness();
 h.context.rows.push(...Array.from({length:29},(_,index)=>({word:'word '+index,vocabulary:null})),
  {word:'liquid',vocabulary:{...row().vocabulary,examples:[],clozeQuestions:[]}});
 await h.run('openVocabularyEditor("",true)');
 h.get('vocab-word').value='word 28';h.get('vocab-word').onchange();
 h.get('vocab-word-next').onclick?.();
 assert.equal(h.get('vocab-word').value,'liquid');assert.equal(h.get('vocab-page').textContent,'Page 2 of 2');
 h.get('vocab-word-prev').onclick();assert.equal(h.get('vocab-word').value,'word 28');
 h.get('vocab-filter').value='draft';h.get('vocab-filter').oninput();
 assert.equal(h.get('vocab-word').value,'solid');
 await h.get('vocab-form').onsubmit({preventDefault(){},submitter:{id:'vocab-approve'}});
 assert.equal(h.run('editorRecords[0].vocabulary.status'),'approved');
 assert.equal(h.get('vocab-word').value,'liquid');assert.equal(h.get('vocab-form').hidden,false);
 await h.get('vocab-form').onsubmit({preventDefault(){},submitter:{id:'vocab-approve'}});
 assert.equal(h.get('vocab-form').hidden,true);assert.equal(h.get('vocab-review-content').hidden,true);
 assert.equal(h.get('vocab-edit-toggle').hidden,true);
});

test('bulk approval discloses that drafts outside the filter and unopened drafts are included',async()=>{
 const h=harness();
 h.context.rows.push({word:'liquid',vocabulary:{...row().vocabulary,examples:[],clozeQuestions:[]}});
 await h.run('openVocabularyEditor("draft",true)');
 h.get('vocab-search').value='solid';h.get('vocab-search').oninput();
 let message;h.context.confirm=text=>{message=text;return false;};
 await h.get('vocab-bulk').onclick();
 assert.match(message,/all.*drafts/i);assert.match(message,/haven.t opened or reviewed/i);
 assert.equal(h.run('editorRecords[1].vocabulary.status'),'draft');
 h.context.confirm=()=>true;await h.get('vocab-bulk').onclick();
 assert.equal(h.run('editorRecords[1].vocabulary.status'),'approved');
});

test('a save completing after more typing keeps the newer edit instead of advancing',async()=>{
 const h=harness(),saved=deferred();
 h.context.rows.push({word:'liquid',vocabulary:{...row().vocabulary,examples:[],clozeQuestions:[]}});
 await h.run('openVocabularyEditor("draft",true)');
 h.context.saved=saved.promise;h.run('saveVocabulary=async()=>{await saved;return vocabularyRevision(selected)}');
 const pending=h.get('vocab-form').onsubmit({preventDefault(){},submitter:{id:'vocab-approve'}});
 h.get('vocab-definition').value='A new correction while saving';saved.resolve();await pending;
 assert.equal(h.get('vocab-word').value,'solid');
 assert.equal(h.get('vocab-definition').value,'A new correction while saving');
 h.context.confirm=()=>false;assert.equal(h.run('canLeaveVocabularyEditor()'),false);
});

test('Show all cards restores an empty unfamiliar queue without changing familiarity or mastery',()=>{
 const h=harness();
 h.run('rows[0].vocabulary.status="approved";state.familiar.set=["solid"];beginStudy(selected,rows)');
 assert.equal(h.get('study-show-all').hidden,true);
 h.get('study-unfamiliar').checked=true;h.get('study-unfamiliar').onchange();
 assert.equal(h.get('study-show-all').hidden,false);
 h.get('study-show-all').onclick?.();
 assert.equal(h.get('study-unfamiliar').checked,false);assert.equal(h.get('study-show-all').hidden,true);
 assert.equal(h.get('study-front').textContent,'solid');
 assert.equal(h.run('state.familiar.set[0]'),'solid');assert.equal(h.run('state.learning.set'),undefined);
});

test('existing vocabulary opens as a readable preview and toggling editing keeps typed wording',async()=>{
 const h=harness();h.context.rows.push({word:'liquid',vocabulary:null});
 await h.run('openVocabularyEditor("",true)');
 assert.equal(h.get('vocab-review-content').hidden,false);assert.equal(h.get('vocab-edit-fields').hidden,true);
 assert.equal(h.get('vocab-review-definition').textContent,row().vocabulary.definition);
 assert.equal(h.get('vocab-review-examples').children[0].textContent,'The solid keeps its shape.');
 assert.equal(h.get('vocab-review-cloze').children[0].textContent,'The _____ keeps its shape.');
 assert.equal(h.get('vocab-save-draft').hidden,true);
 h.get('vocab-edit-toggle').onclick();
 assert.equal(h.get('vocab-review-content').hidden,true);assert.equal(h.get('vocab-save-draft').hidden,false);
 h.get('vocab-definition').value='A clearer definition';
 h.get('vocab-edit-toggle').onclick();
 assert.equal(h.get('vocab-review-definition').textContent,'A clearer definition');
 h.get('vocab-edit-toggle').onclick();
 assert.equal(h.get('vocab-definition').value,'A clearer definition');
 h.get('vocab-word').value='liquid';h.get('vocab-word').onchange();
 assert.equal(h.get('vocab-edit-toggle').hidden,true);assert.equal(h.get('vocab-edit-fields').hidden,false);
});

test('inline review moves the same editor and Finish restores it before refreshing the workspace',async()=>{
 const h=harness(),panel=h.get('vocab-editor-panel'),form=h.get('vocab-form'),handler=form.onsubmit;
 await h.run('openVocabularyEditor("draft",true)');
 assert.equal(panel.parentElement,h.get('workspace-review'));assert.equal(h.get('workspace-review').hidden,false);
 assert.equal(h.get('vocab-dialog').open,false);assert.equal(h.get('vocab-close').textContent,'Finish reviewing');
 assert.equal(form.onsubmit,handler);
 await h.get('vocab-close').onclick();
 assert.equal(panel.parentElement,h.get('vocab-dialog'));assert.equal(h.get('workspace-review').hidden,true);
 assert.equal(h.events.filter(event=>event==='refresh').length,1);
 await h.run('openVocabularyEditor()');
 assert.equal(panel.parentElement,h.get('vocab-dialog'));assert.equal(h.get('vocab-dialog').open,true);
 assert.equal(form.onsubmit,handler);
});

test('Save and approve plus Undo use the existing inline validation and refresh only after successful saves',async()=>{
 const h=harness();await h.run('openVocabularyEditor("",true)');
 h.get('vocab-definition').value='';
 await h.get('vocab-form').onsubmit({preventDefault(){},submitter:{id:'vocab-approve'}});
 assert.equal(h.events.filter(event=>event==='refresh').length,0);
 h.get('vocab-definition').value=row().vocabulary.definition;
 await h.get('vocab-form').onsubmit({preventDefault(){},submitter:{id:'vocab-approve'}});
 assert.equal(h.run('editorRecords[0].vocabulary.status'),'approved');
 assert.equal(h.events.filter(event=>event==='refresh').length,1);
 await h.get('vocab-undo').onclick();
 assert.equal(h.run('editorRecords[0].vocabulary.status'),'draft');
 assert.equal(h.events.filter(event=>event==='refresh').length,2);
});

test('a late editor load cannot mount or populate fields after owner, token, or selected list changes',async()=>{
 for(const change of ['state={...state,lists:state.lists}','ai.token="teacher-b"','selected={...selected};state.lists=[selected]','selected.updatedAt="changed"','selected.vocabKey="generated";selected.packVersion++']) {
  const h=harness(),loaded=deferred();h.context.loaded=loaded.promise;h.run('loadVocabulary=()=>loaded');
  const pending=h.run('openVocabularyEditor("draft",true)');h.run(change);loaded.resolve([row()]);await pending;
  assert.equal(h.run('editorList'),null);assert.equal(h.run('editorRecords.length'),0);
  assert.equal(h.get('vocab-editor-panel').parentElement,h.get('vocab-dialog'));assert.equal(h.get('vocab-dialog').open,false);
 }
});

test('a stale save cannot replace editor fields or refresh another signed-in workspace',async()=>{
 const h=harness(),saved=deferred();await h.run('openVocabularyEditor("",true)');
 h.context.saved=saved.promise;h.run('saveVocabulary=()=>saved');
 const pending=h.run('changeVocabulary([{...editorRecords[0],vocabulary:{...editorRecords[0].vocabulary,status:"approved"}}],"solid")');
 h.run('ai.token="teacher-b"');saved.resolve();await pending;
 assert.equal(h.run('editorRecords[0].vocabulary.status'),'draft');assert.equal(h.events.filter(event=>event==='refresh').length,0);
});

test('the create-set form closes first then opens the signed-in teacher workspace, while offline stays local',async()=>{
 for(const entry of ['teacher','offline','signed-out','changed-token','changed-state']) {
  const h=harness();h.context.entryPage=entry;
  if(!['teacher','offline'].includes(entry))h.context.entryPage='teacher';
  if(entry==='signed-out')h.context.ai.token='';
  Object.assign(h.context,{listDraft:{id:null,defs:{}},draftWords:()=>['solid'],draftDefinitions:()=>({}),presetForGrade:()=>({readingLevel:5}),
   editorStatus:()=>{},addList:()=>{h.events.push('created');if(entry==='changed-token')h.context.ai.token='teacher-b';if(entry==='changed-state')h.context.state={...h.context.state};},showTeacherTools:async view=>h.events.push('workspace:'+view)});
  const app=fs.readFileSync('src/app.js','utf8');
  vm.runInContext(app.slice(app.indexOf("$('create-list-form').onsubmit"),app.indexOf("$('split-list').onclick")),h.context);
  h.get('create-list-name').value='New set';h.get('create-list-grade').value='5';h.get('create-list-dialog').open=true;
  await h.get('create-list-form').onsubmit({preventDefault(){}});
  assert.equal(h.get('create-list-dialog').open,false);
  assert.equal(h.events.includes('workspace:workspace'),entry==='teacher');
  if(entry==='teacher')assert(h.events.indexOf('close:create-list-dialog')<h.events.indexOf('workspace:workspace'));
 }
});

test('the standalone editor restores an inline panel and the workspace close helper is otherwise a no-op',async()=>{
 const h=harness();await h.run('openVocabularyEditor("",true)');await h.run('openVocabularyEditor()');
 assert.equal(h.get('vocab-editor-panel').parentElement,h.get('vocab-dialog'));assert.equal(h.get('workspace-review').hidden,true);
 const before=h.events.length;assert.equal(await h.run('closeVocabularyEditor()'),false);assert.equal(h.events.length,before);
 assert.equal(h.get('vocab-dialog').open,true);h.get('vocab-close').onclick();assert.equal(h.get('vocab-dialog').open,false);
});

test('a newer editor request wins over a late load and finishing an old owner cannot refresh the new one',async()=>{
 const h=harness(),loaded=deferred();h.context.loaded=loaded.promise;
 h.run('loadVocabulary=()=>loaded');const old=h.run('openVocabularyEditor("draft",true)');
 h.run('loadVocabulary=async()=>rows');await h.run('openVocabularyEditor("missing",true)');loaded.resolve([row()]);await old;
 assert.equal(h.get('vocab-filter').value,'missing');
 h.run('state={...state};ai.token="teacher-b"');await h.get('vocab-close').onclick();
 assert.equal(h.events.filter(event=>event==='refresh').length,0);assert.equal(h.get('workspace-review').hidden,true);
});

test('finishing, closing, or reopening review during a save does not cancel a pending approval',async()=>{
 for(const action of ['finish','back','reopen','close','escape']) {
  const h=harness(),started=deferred(),release=deferred(),stored=new Map();
  const inline=!['close','escape'].includes(action);
  await h.run(`openVocabularyEditor("",${inline})`);
  h.context.getStore=async()=>({kind:'indexedDB',async put(key,records){stored.set(key,records);started.resolve();await release.promise;},
   async remove(key){stored.delete(key);}});
  h.run('saveVocabulary=originalSaveVocabulary;restoringTeacherSets=true;renderSetup=()=>{}');
  const pending=h.get('vocab-form').onsubmit({preventDefault(){},submitter:{id:'vocab-approve'}});
  await started.promise;
  let canceled=false;
  if(action==='back')await h.run('closeVocabularyEditor(true)');
  else if(action==='reopen')await h.run('openVocabularyEditor("draft",true)');
  else if(action==='escape')for(const handler of h.get('vocab-dialog').listeners.cancel)handler({preventDefault(){canceled=true;}});
  else await h.get('vocab-close').onclick();
  const remainedOpen=inline?!h.get('workspace-review').hidden:h.get('vocab-dialog').open;
  release.resolve();await pending;
  assert.equal(stored.get(h.run('selected.vocabKey'))?.[0].vocabulary.status,'approved',action);
  assert.equal(remainedOpen,true,action);
  if(action==='escape')assert.equal(canceled,true);
  await h.get('vocab-close').onclick();
  assert.equal(inline?h.get('workspace-review').hidden:!h.get('vocab-dialog').open,true,action);
 }
});

test('leaving before an inline load finishes prevents its panel from mounting afterward',async()=>{
 const h=harness(),loaded=deferred();h.context.loaded=loaded.promise;h.run('loadVocabulary=()=>loaded');
 const pending=h.run('openVocabularyEditor("",true)');await h.run('closeVocabularyEditor()');loaded.resolve([row()]);await pending;
 assert.equal(h.run('editorList'),null);assert.equal(h.get('workspace-review').hidden,true);
 assert.equal(h.get('vocab-editor-panel').parentElement,h.get('vocab-dialog'));
});

test('Approve, Undo, and bulk approval reject a stale editor without erasing a generated draft or typed fields',async()=>{
 for(const action of ['approve','undo','bulk']) {
  const h=harness();h.context.rows.push({word:'liquid',vocabulary:null});
  h.run('selected.words.push("liquid");selected.vocabKey="original";let writes=0,persisted=rows;saveVocabulary=async(list,records,metadata)=>{writes++;persisted=records;Object.assign(list,metadata,{vocabKey:"save-"+writes});return {vocabKey:list.vocabKey,packVersion:list.packVersion,updatedAt:list.updatedAt};}');
  await h.run('openVocabularyEditor("",true)');
  if(action==='undo')await h.get('vocab-form').onsubmit({preventDefault(){},submitter:{id:'vocab-approve'}});
  h.context.generated={word:'liquid',vocabulary:{...row().vocabulary,definition:'A material that takes the shape of its container.',
   examples:['The liquid fills the cup.'],clozeQuestions:[{id:'q1',sentence:'The _____ fills the cup.',answer:'liquid',explanation:'It can flow.'}]}};
  h.run('persisted=[editorRecords[0],generated];rows=persisted;selected.vocabKey="generated";selected.packVersion++;selected.updatedAt="generation"');
  h.get('vocab-definition').value='Unsaved teacher text';const before=h.run('writes');
  if(action==='approve')await h.get('vocab-form').onsubmit({preventDefault(){},submitter:{id:'vocab-approve'}});
  else await h.get(action==='undo'?'vocab-undo':'vocab-bulk').onclick();
  assert.equal(h.run('writes'),before);assert.equal(h.run('persisted[1].vocabulary.status'),'draft');
  assert.equal(h.get('vocab-definition').value,'Unsaved teacher text');assert.match(h.get('vocab-status').textContent,/Vocabulary changed.*Close and reopen vocabulary review/i);
  await h.run('closeVocabularyEditor()');await h.run('openVocabularyEditor("",true)');
  assert.equal(h.run('editorRecords[1].vocabulary.status'),'draft');
 }
});

test('overlapping editor writes are rejected before a second save begins',async()=>{
 const h=harness(),saved=deferred();await h.run('openVocabularyEditor("",true)');h.context.saved=saved.promise;
 h.run('let writes=0;saveVocabulary=async(list,records,metadata)=>{writes++;await saved;Object.assign(list,metadata);return {vocabKey:list.vocabKey,packVersion:list.packVersion,updatedAt:list.updatedAt};}');
 const first=h.run('changeVocabulary(editorRecords,"solid")');
 const second=h.run('changeVocabulary(editorRecords,"solid")').then(()=>null,error=>error);
 await new Promise(resolve=>setImmediate(resolve));const writes=h.run('writes');saved.resolve();await first;const error=await second;
 assert.equal(writes,1);assert.match(error?.message || '',/save.*already|already.*sav/i);
});

test('saveVocabulary discards an unused record when another write commits during its storage await',async()=>{
 const h=harness(),putEntered=deferred(),release=deferred(),stored=new Map(),removed=[];let puts=0,ids=0;
 const store={kind:'indexedDB',async put(key,records){stored.set(key,records);if(++puts===1){putEntered.resolve();await release.promise;}},async remove(key){removed.push(key);stored.delete(key);}};
 h.context.getStore=async()=>store;h.context.newListId=()=> 'id-'+(++ids);
 h.run('saveVocabulary=originalSaveVocabulary;restoringTeacherSets=true;renderSetup=()=>{}');
 const first=h.run('saveVocabulary(selected,rows,{packVersion:2})').then(()=>null,error=>error);await putEntered.promise;
 h.context.newRows=[row(),{word:'liquid',vocabulary:{...row().vocabulary,status:'draft'}}];
 await h.run('saveVocabulary(selected,newRows,{packVersion:2})');const currentKey=h.run('selected.vocabKey');
 release.resolve();const error=await first;
 assert.match(error?.message || '',/Vocabulary changed/i);assert.equal(h.run('selected.vocabKey'),currentKey);
 assert.equal(stored.get(currentKey).length,2);assert(removed.includes('list:set:id-1'));assert(!stored.has('list:set:id-1'));
});

test('a revision change while an editor save awaits completion does not replace the typed fields',async()=>{
 const h=harness(),saved=deferred();await h.run('openVocabularyEditor("",true)');h.context.saved=saved.promise;
 h.run('saveVocabulary=async(list,records,metadata)=>{Object.assign(list,metadata,{vocabKey:"editor-save"});const revision={vocabKey:list.vocabKey,packVersion:list.packVersion,updatedAt:list.updatedAt};await saved;return revision;}');
 const pending=h.run('changeVocabulary([{...editorRecords[0],vocabulary:{...editorRecords[0].vocabulary,status:"approved"}}],"solid")').then(()=>null,error=>error);
 h.run('selected.vocabKey="new-generation";selected.packVersion++');h.get('vocab-definition').value='Unsaved teacher text';saved.resolve();const error=await pending;
 assert.match(error?.message || '',/Vocabulary changed/i);assert.equal(h.get('vocab-definition').value,'Unsaved teacher text');
});

test('saveVocabulary rejects a stale revision after opening storage without writing an unused record',async()=>{
 const h=harness(),opened=deferred();let puts=0;
 h.context.getStore=()=>opened.promise;
 h.run('saveVocabulary=originalSaveVocabulary;restoringTeacherSets=true;renderSetup=()=>{}');
 const pending=h.run('saveVocabulary(selected,rows,{packVersion:2})').then(()=>null,error=>error);
 h.run('selected.vocabKey="generated";selected.packVersion=3');
 opened.resolve({kind:'indexedDB',async put(){puts++;},async remove(){}});const error=await pending;
 assert.match(error?.message || '',/Vocabulary changed/i);assert.equal(puts,0);assert.equal(h.run('selected.packVersion'),3);
});

test('a losing definition edit never erases learned or familiar data persisted by a winning generation save',async()=>{
 const h=harness(),entered=deferred(),release=deferred(),stored=new Map(),snapshots=[];let puts=0,ids=0;
 const store={kind:'indexedDB',async put(key,records){stored.set(key,structuredClone(records));if(++puts===1){entered.resolve();await release.promise;}},async remove(key){stored.delete(key);}};
 h.run('selected.vocabKey="original";state.learning.set={solid:{vocabulary:{streak:2,mastered:true},spelling:{streak:1}}};state.familiar.set=["solid"]');
 await h.run('openVocabularyEditor("",true)');h.context.getStore=async()=>store;h.context.newListId=()=> 'id-'+(++ids);
 h.context.save=()=>{snapshots.push(structuredClone(h.context.state));return true;};
 h.run('saveVocabulary=originalSaveVocabulary;restoringTeacherSets=true;renderSetup=()=>{}');
 const pending=h.run('changeVocabulary([{...editorRecords[0],vocabulary:{...editorRecords[0].vocabulary,definition:"A new reviewed definition."}}],"solid")').then(()=>null,error=>error);
 await entered.promise;
 h.context.newRows=[row(),{word:'liquid',vocabulary:{...row().vocabulary,status:'draft'}}];
 await h.run('saveVocabulary(selected,newRows,{packVersion:2})');release.resolve();const error=await pending;
 assert.match(error?.message || '',/Vocabulary changed/i);
 assert.equal(h.run('state.learning.set.solid.vocabulary.mastered'),true);assert.equal(h.run('state.familiar.set.includes("solid")'),true);
 assert.equal(snapshots.at(-1).learning.set.solid.vocabulary.mastered,true);assert.deepEqual(snapshots.at(-1).familiar.set,['solid']);
 assert.equal(stored.get(h.run('selected.vocabKey'))[0].vocabulary.definition,row().vocabulary.definition);
});

test('learning invalidations commit with a winning definition save and roll back when local persistence fails',async()=>{
 const h=harness(),stored=new Map();let ids=0,checked=false;
 h.run('selected.vocabKey="original";state.learning.set={solid:{vocabulary:{mastered:true},spelling:{streak:1}}};state.familiar.set=["solid"]');
 await h.run('openVocabularyEditor("",true)');
 h.context.getStore=async()=>({kind:'indexedDB',async put(key,records){stored.set(key,records);},async remove(key){stored.delete(key);}});
 h.context.newListId=()=> 'id-'+(++ids);
 h.context.save=()=>{checked=true;assert.equal(h.run('state.learning.set.solid.vocabulary'),undefined);assert.equal(h.run('state.familiar.set.length'),0);return false;};
 h.run('saveVocabulary=originalSaveVocabulary;restoringTeacherSets=true;renderSetup=()=>{}');
 const edit='changeVocabulary([{...editorRecords[0],vocabulary:{...editorRecords[0].vocabulary,definition:"A new reviewed definition."}}],"solid")';
 await assert.rejects(h.run(edit),/Browser storage/i);assert.equal(checked,true);
 assert.equal(h.run('selected.vocabKey'),'original');assert.equal(h.run('state.learning.set.solid.vocabulary.mastered'),true);assert.equal(h.run('state.familiar.set.includes("solid")'),true);assert.equal(stored.size,0);
 h.context.save=()=>true;await h.run(edit);
 assert.equal(h.run('state.learning.set.solid.vocabulary'),undefined);assert.equal(h.run('state.learning.set.solid.spelling.streak'),1);assert.equal(h.run('state.familiar.set.length'),0);
});
