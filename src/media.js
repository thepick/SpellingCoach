// Media is kept in IndexedDB, partitioned by the active account. No image bytes in localStorage.
const mediaURLs=new Set();
const mediaPictures=new Map();
const mediaPictureLoads=new WeakMap(),mediaPictureNodes=new Set();
let mediaDatabase,mediaEpoch=0,termImport=null,imageViewerOrigin=null,imageViewerURL=null,mediaPreviewScope=null,mediaPictureObserver=null;
function mediaScope(){return typeof studentPreview!=='undefined' && studentPreview && mediaPreviewScope ? mediaPreviewScope : KEY.startsWith('spell.teacher:')?KEY:'student';}
function mediaDB(){
 if(!mediaDatabase)mediaDatabase=new Promise((resolve,reject)=>{
  if(typeof indexedDB==='undefined'){reject(Error('Images require browser storage. Enable IndexedDB and retry.'));return;}
  const request=indexedDB.open('WordLab images',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('images');
  request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
  request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('Close other WordLab tabs and retry image storage.'));
 }).catch(e=>{mediaDatabase=null;throw e;});
 return mediaDatabase;
}
async function mediaRecord(action,id,value,scope=mediaScope()) {
 const db=await mediaDB();return new Promise((resolve,reject)=>{
  const tx=db.transaction('images',action==='get'?'readonly':'readwrite'),store=tx.objectStore('images'),key=JSON.stringify([scope,id]);
  const request=action==='get'?store.get(key):action==='put'?store.put(value,key):store.delete(key);
  tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error || Error('Image storage is full or unavailable.'));
 });
}
function mediaObjectURL(blob){const url=URL.createObjectURL(blob);mediaURLs.add(url);return url;}
function releaseMediaURL(url){if(url && mediaURLs.delete(url))URL.revokeObjectURL(url);}
function resetMediaUI(){
 mediaEpoch++;termImport=null;mediaPreviewScope=null;
 for(const url of mediaURLs)URL.revokeObjectURL(url);mediaURLs.clear();mediaPictures.clear();mediaPictureNodes.clear();mediaPictureObserver?.disconnect();mediaPictureObserver=null;
 if($('terms-import-panel'))$('terms-import-panel').hidden=true;
 if($('image-viewer')?.open)$('image-viewer').close();
}
async function digestBlob(blob){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');}
async function processTermImage(file,metadata={}) {
 if(!file || file.size>MediaModel.limits.original || !file.size)throw Error('Choose an image of 10 MB or smaller.');
 const bytes=new Uint8Array(await file.arrayBuffer());
 const png=bytes[0]===137 && bytes[1]===80, jpeg=bytes[0]===255 && bytes[1]===216, webp=String.fromCharCode(...bytes.slice(8,12))==='WEBP';
 if(!png && !jpeg && !webp)throw Error('Choose a JPEG, PNG, or WebP image. SVG and animated images are not supported.');
 if((png && new TextDecoder('latin1').decode(bytes).includes('acTL')) || (webp && new TextDecoder('latin1').decode(bytes).includes('ANIM')))throw Error('Choose a still image rather than an animation.');
 const bitmap=await createImageBitmap(new Blob([bytes],{type:png?'image/png':jpeg?'image/jpeg':'image/webp'}));
 try {
  if(bitmap.width*bitmap.height>MediaModel.limits.pixels)throw Error('Choose an image of 20 megapixels or smaller.');
  let scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),blob,canvas=document.createElement('canvas');
  for(let attempt=0;attempt<6;attempt++) {
   canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
   const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
   blob=await new Promise(resolve=>canvas.toBlob(resolve,png?'image/png':'image/jpeg',.85));
   if(blob && blob.size<=MediaModel.limits.image)break;scale*=.75;
  }
  if(!blob || blob.size>MediaModel.limits.image)throw Error('This diagram is too large. Use a smaller image.');
  const id=await digestBlob(blob),image=MediaModel.validate({id,hash:id,type:blob.type,width:canvas.width,height:canvas.height,size:blob.size,alt:'',...metadata});
  return {image,blob};
 }finally{bitmap.close();}
}
async function imageBlob(image,list,scope=mediaScope()) {
 const cached=await mediaRecord('get',image.id,undefined,scope);if(cached?.blob)return cached.blob;
 let path,root,token='';
 if(list?.sharedOrigin){root=list.sharedOrigin;path='/packs/'+encodeURIComponent(list.packId)+'/images/'+list.packVersion+'/'+image.id;token=ai.role==='class'?ai.token:'';}
 else if(ai.role==='teacher' && ai.token){root=ai.root;token=ai.token;path='/teacher/images/'+image.id;}
 else throw Error('This image is not saved on this device. Connect to WordLab or import the complete ZIP.');
 const response=await fetch(root+'/api'+path,{headers:token?{Authorization:'Bearer '+token}:{},credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error('The image could not be loaded. Check your connection and retry.');
 const blob=await response.blob();
 if(blob.size!==image.size || await digestBlob(blob)!==image.hash)throw Error('The downloaded image did not match this vocabulary set.');
 await mediaRecord('put',image.id,{blob},scope);return blob;
}
function imageAnswerLeak(text,word){if(!word)return false;const escaped=word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return new RegExp('(^|[^\\p{L}\\p{N}])'+escaped+'($|[^\\p{L}\\p{N}])','iu').test(text || '');}
function pictureButton(image,list,context='practice',word='') {
 for(const node of mediaPictureNodes)if(!node.isConnected){mediaPictureObserver?.unobserve(node);mediaPictureNodes.delete(node);}
 for(const [node,url]of mediaPictures)if(!node.isConnected){releaseMediaURL(url);mediaPictures.delete(node);}
 const button=document.createElement('button'),img=document.createElement('img'),retry=document.createElement('span');
 button.type='button';button.className='definition-picture';button.setAttribute('aria-label','Enlarge image');
 img.alt=context!=='teacher' && context!=='study' && imageAnswerLeak(image.alt,word)?'Vocabulary illustration':image.alt || 'Vocabulary illustration';img.width=image.width;img.height=image.height;img.loading='lazy';
 retry.className='hint';retry.textContent='Loading image...';button.append(img,retry);
 const epoch=mediaEpoch,scope=mediaScope();let url,blob;
 const load=async()=>{retry.textContent='Loading image...';try{blob=await imageBlob(image,list,scope);if(epoch!==mediaEpoch || !button.isConnected)return;releaseMediaURL(url);url=mediaObjectURL(blob);mediaPictures.set(button,url);img.src=url;retry.hidden=true;}catch(e){if(epoch!==mediaEpoch)return;retry.textContent='Image unavailable. Tap to retry.';}};
 button.onclick=()=>{if(!blob){load();return;}imageViewerOrigin=button;releaseMediaURL(imageViewerURL);imageViewerURL=mediaObjectURL(blob);$('image-viewer-image').src=imageViewerURL;$('image-viewer-image').alt=img.alt;$('image-viewer-credit').textContent=context==='teacher' || context==='study'?[image.credit,image.license,image.source].filter(Boolean).join(' - '):[image.credit,image.license].filter(text=>text && !imageAnswerLeak(text,word)).join(' - ');$('image-viewer').showModal();};
 // Loading starts once the card has been attached, including progressively rendered previews.
 mediaPictureNodes.add(button);
 if(typeof IntersectionObserver!=='undefined'){
  if(!mediaPictureObserver)mediaPictureObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){mediaPictureObserver.unobserve(entry.target);mediaPictureLoads.get(entry.target)?.();}},{rootMargin:'200px'});
  mediaPictureLoads.set(button,load);requestAnimationFrame(()=>{if(button.isConnected)mediaPictureObserver?.observe(button);});
 }else requestAnimationFrame(load);
 return button;
}
function definitionCard(row,text,{list,context='practice'}={}) {
 const card=document.createElement('div');card.className='definition-card';
 if(row.image && (context==='teacher' || MediaModel.show(list?.media,context)))card.append(pictureButton(row.image,list,context,row.word || row.term));
 else card.classList.add('without-picture');
 const body=document.createElement('div');body.className='definition-copy';body.append(text);card.append(body);return card;
}
function renderQuestionImage(entry,question) {
 const host=$('learning-picture');host.replaceChildren();
 const row=entry.session.records[question.recordIndex],context=entry.session.type==='test'?'test':'practice';
 const show=question.type!=='dictation' && row?.image && MediaModel.show(entry.session.media,context);
 host.hidden=!show;$('learning-definition-card').classList.toggle('without-picture',!show);
 if(show){const list=state.lists.find(l=>l.id===entry.listId);host.append(pictureButton(row.image,{...list,...entry.session.mediaOrigin},context,row.word));}
}
function renderStudyImage(study,card,reverse) {
 const host=$('study-picture');host.replaceChildren();
 const row=card && study.rows.find(r=>r.word===card.word);
 const show=!!row?.image && MediaModel.show(study.list.media,'study') && (reverse || study.revealed);
 host.hidden=!show;
 if(show)host.append(pictureButton(row.image,study.list,'study',row.word));
 $('study-definition-card').classList.toggle('without-picture',!show);
}
function renderEditorImage(row,list){const host=$('vocab-review-picture');host.replaceChildren();host.hidden=!row?.image;$('vocab-review-card').classList.toggle('without-picture',!row?.image);if(row?.image)host.append(pictureButton(row.image,list,'teacher',row.word));}
async function ensureTeacherImages(pack,{root,token,owner}) {
 const images=[...new Map(pack.words.filter(r=>r.image).map(r=>[r.image.id,r.image])).values()];if(!images.length)return;
 const scope=mediaScope(),epoch=mediaEpoch,active=()=>state===owner && ai.token===token && epoch===mediaEpoch;
 const config=await service('/config',{root,token});
 if(!config.packFormats?.includes(2))throw Error('The service does not support image uploads yet. Your images and wording are saved on this device.');
 const session=await service('/teacher/image-imports',{root,token,method:'POST',body:{images}});
 if(active() && $('images-storage-usage'))$('images-storage-usage').textContent=(session.usedBytes/1048576).toFixed(1)+' MB of '+(session.quotaBytes/1048576).toFixed(0)+' MB image storage used.';
 try {
  for(const id of session.missing) {
   if(!active())throw Error('The account changed. Image upload stopped.');
   const image=images.find(r=>r.id===id),local=await mediaRecord('get',id,undefined,scope);
   if(!local?.blob)throw Error('An image is not available locally. Reload its saved set or import the complete ZIP.');
   let error;
   for(let attempt=0;attempt<3;attempt++){
    try {
     const response=await fetch(root+'/api/teacher/image-imports/'+session.id+'/assets/'+id,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':image.type},body:local.blob,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(45000)});
     if(!response.ok){const body=await response.json();throw Error(body.error?.message || 'Image upload failed.');}error=null;break;
    }catch(e){error=e;if(!active())break;}
   }
   if(error)throw error;
  }
 }finally{if(active())service('/teacher/image-imports/'+session.id,{root,token,method:'DELETE'}).catch(()=>{});}
}
function imageEditControls(row,list) {
 const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');summary.textContent='Image and prompt settings';details.append(summary,body);body.className='stack';
 const file=document.createElement('input');file.type='file';file.accept='image/png,image/jpeg,image/webp';file.setAttribute('aria-label','Choose image for '+row.word);
 const alt=document.createElement('input'),source=document.createElement('input'),credit=document.createElement('input'),license=document.createElement('input'),prompt=document.createElement('select');
 const field=(label,input,value)=>{const wrap=document.createElement('label');wrap.textContent=label;input.value=value || '';wrap.append(input);body.append(wrap);};
 body.append(file);field('Image description',alt,row.image?.alt);field('Image source',source,row.image?.source);field('Image credit',credit,row.image?.credit);field('Image license',license,row.image?.license);
 for(const [value,label]of [['sentence','Sentence when available'],['definition','Definition']]){const option=document.createElement('option');option.value=value;option.textContent=label;prompt.append(option);}field('Vocabulary prompt',prompt,row.promptType || 'sentence');
 const saveButton=document.createElement('button'),remove=document.createElement('button'),message=document.createElement('p');saveButton.type=remove.type='button';saveButton.className=remove.className='ghost small';saveButton.textContent='Save image settings';remove.textContent='Remove image';remove.hidden=!row.image;message.className='status';message.setAttribute('role','status');body.append(saveButton,remove,message);
 const owner=state,token=ai.token,revision=vocabularyRevision(list),scope=mediaScope();
 const save=async(image)=>{
  if(state!==owner || ai.token!==token || !sameVocabularyRevision(list,revision))throw Error('This set changed. Reopen its image settings.');
  if(editorInline && !canLeaveVocabularyEditor())throw Error('Save or close the wording editor first.');
  const rows=await loadVocabulary(list);if(state!==owner || ai.token!==token || !sameVocabularyRevision(list,revision))throw Error(VOCABULARY_CHANGED);
  const next=rows.map(r=>r.word!==row.word?r:{...r,image:image || undefined,promptType:prompt.value});
  await saveVocabulary(list,next,{media:list.media || {display:'practice',tests:false},packVersion:(list.packVersion || 1)+1});await refreshSetWorkspace();
 };
 const run=async action=>{saveButton.disabled=remove.disabled=file.disabled=true;message.textContent='Saving...';try{await action();message.textContent='Saved privately. Update the student link to share changes.';}catch(e){message.textContent=e.message;}finally{saveButton.disabled=remove.disabled=file.disabled=false;}};
 file.onchange=()=>run(async()=>{const chosen=file.files[0];if(!chosen)return;const value=await processTermImage(chosen,{alt:alt.value,source:source.value,credit:credit.value,license:license.value});if(state!==owner || ai.token!==token)throw Error('Account changed.');await mediaRecord('put',value.image.id,{blob:value.blob},scope);await save(value.image);});
 body.addEventListener('paste',event=>{const pasted=Array.from(event.clipboardData?.files || []).find(f=>f.type.startsWith('image/'));if(!pasted)return;event.preventDefault();run(async()=>{const value=await processTermImage(pasted,{alt:alt.value,source:source.value,credit:credit.value,license:license.value});await mediaRecord('put',value.image.id,{blob:value.blob},scope);await save(value.image);});});
 saveButton.onclick=()=>run(()=>save(row.image?MediaModel.validate({...row.image,alt:alt.value,source:source.value,credit:credit.value,license:license.value}):null));
 remove.onclick=()=>run(()=>save(null));
 const warning=document.createElement('p');warning.className='hint';warning.textContent='Choose a file or paste a copied image while editing here. Review labels in the picture and its description; they should not reveal the answer during practice.';body.append(warning);return details;
}

function openTermImport() {
 if(!canLeaveVocabularyEditor())return;
 const panel=$('terms-import-panel');
 const home=entryPage==='teacher' && !$('prepare-share-screen').hidden?$('prepare-share-screen'):$('setup-screen');home.append(panel);panel.hidden=false;
 if($('create-list-dialog').open)$('create-list-dialog').close();
 if($('tools-dialog').open)$('tools-dialog').close();
 const target=$('terms-target');target.replaceChildren();
 for(const [value,label]of [['new','Create a new set'],...state.lists.map(l=>[l.id,'Add to: '+l.name])]){const option=document.createElement('option');option.value=value;option.textContent=label;target.append(option);}
 termImport={owner:state,token:ai.token,scope:mediaScope(),rows:[],files:[],table:null};$('terms-name').value='Imported vocabulary';$('terms-preview').replaceChildren();$('terms-import-status').textContent='';$('terms-save').disabled=true;
 panel.scrollIntoView({block:'start',behavior:'smooth'});$('terms-import-title').focus();
}
function importActive(draft){return termImport===draft && draft.owner===state && draft.token===ai.token;}
function configureTermMapping(rows) {
 const guess=TermImports.mapping(rows);$('terms-header').checked=guess.header;
 for(const key of Object.keys(guess.map)){
  const select=$('terms-column-'+key);select.replaceChildren();
  const none=document.createElement('option');none.value='-1';none.textContent='Not included';select.append(none);
  for(let i=0;i<Math.max(...rows.map(r=>r.length));i++){const option=document.createElement('option');option.value=String(i);option.textContent='Column '+(i+1)+': '+rows[0][i]?.slice(0,45);select.append(option);}select.value=String(guess.map[key]);
 }
 $('terms-mapping').hidden=false;
}
function mapTermRows(){
 const draft=termImport;if(!draft?.table)return;
 const map=Object.fromEntries(['term','definition','image','alt','pos','source','credit','license'].map(key=>[key,Number($('terms-column-'+key).value)]));
 if(map.term<0 || map.definition<0 || map.term===map.definition)throw Error('Choose different columns for terms and definitions.');
 draft.rows=TermImports.entries(draft.table,map,$('terms-header').checked);renderImportRows();
}
function importRowProblem(row,rows) {
 if(!row.include)return '';
 try{Vocabulary.normalizeWords([row.term]);if(!row.definition)throw Error('Add a definition.');if(row.definition.length>300)throw Error('Definitions must be 300 characters or shorter.');
  Vocabulary.validateRecord(row.term,{senseId:'import',partOfSpeech:row.pos || 'unknown',definition:row.definition,examples:[],clozeQuestions:[],meaningDistractors:[],acceptedSpellings:[],readingLevel:5,status:'draft',contentType:'definition'});
 }catch(e){return e.message;}
 if(rows.some(r=>r!==row && r.include && wordKey(r.term)===wordKey(row.term)))return 'Duplicate term. Edit or exclude one row.';
 if(row.processing)return 'Processing image...';if(row.imageError)return row.imageError;return '';
}
function updateImportCounts() {
 const draft=termImport;if(!draft)return;
 const rows=draft.rows.filter(r=>r.include),invalid=rows.filter(r=>importRowProblem(r,draft.rows)),missing=rows.filter(r=>!r.image);
 const old=draft.existing || [],keys=new Set(old.map(r=>wordKey(r.word))),existing=rows.filter(r=>keys.has(wordKey(r.term))).length;
 const replacing=$('terms-merge').value==='replace';
 $('terms-counts').textContent=rows.length+' terms selected; '+(rows.length-existing)+' new; '+existing+(replacing?' to replace':' existing terms preserved')+'; '+missing.length+' without images; '+invalid.length+' need attention.';
 $('terms-save').disabled=!rows.length || rows.length>200 || !!invalid.length;
}
async function matchImportImages() {
 const draft=termImport;if(!draft)return;
 for(const row of draft.rows) {
  if(!importActive(draft))return;if(row.manualImage)continue;
  const match=TermImports.match(row,draft.files);row.imageError=match.error || '';
  if(match.file && row.matchedFile!==match.file){row.processing=true;updateImportCounts();try{const media=await processTermImage(match.file.file,{alt:row.alt,source:row.source,credit:row.credit,license:row.license});if(!importActive(draft))return;row.image=media.image;await mediaRecord('put',media.image.id,{blob:media.blob},draft.scope);row.matchedFile=match.file;}catch(e){row.imageError=e.message;}finally{row.processing=false;}}
 }
 if(importActive(draft))renderImportRows();
}
function renderImportRows() {
 const draft=termImport;if(!draft)return;const host=$('terms-preview'),filter=$('terms-filter').value;host.replaceChildren();
 for(const row of draft.rows){
  const problem=importRowProblem(row,draft.rows);
  if(filter==='missing' && row.image || filter==='errors' && !problem)continue;
  const article=document.createElement('article');article.className='term-import-row stack';
  const include=document.createElement('input');include.type='checkbox';include.checked=row.include;
  const title=document.createElement('label');title.className='checkline';title.append(include,document.createTextNode('Row '+row.row));article.append(title);
  const term=document.createElement('input'),definition=document.createElement('textarea');term.value=row.term;term.setAttribute('aria-label','Term in row '+row.row);definition.value=row.definition;definition.rows=2;definition.setAttribute('aria-label','Definition in row '+row.row);article.append(term);
  article.append(definitionCard(row,definition,{context:'teacher'}));
  const image=document.createElement('select');image.setAttribute('aria-label','Image file for '+(row.term || 'row '+row.row));
  for(const [value,label]of [['','No image'],...draft.files.map((f,i)=>[String(i),f.name])]){const option=document.createElement('option');option.value=value;option.textContent=label;image.append(option);}
  image.value=row.matchedFile?String(draft.files.indexOf(row.matchedFile)):'';article.append(image);
  const add=document.createElement('input');add.type='file';add.accept='image/png,image/jpeg,image/webp';add.setAttribute('aria-label','Upload image for '+(row.term || 'this row'));article.append(add);
  const alt=document.createElement('input');alt.value=row.image?.alt || row.alt || '';alt.placeholder='Image description (do not include the answer)';alt.setAttribute('aria-label','Image description for row '+row.row);article.append(alt);
  const message=document.createElement('p');message.className=problem?'status error':'hint';message.textContent=problem || (row.image?'Image ready. Review any labels in the picture.':'Optional: add an image.');article.append(message);
  const refresh=()=>{row.term=term.value;row.definition=definition.value;row.include=include.checked;row.alt=alt.value;if(row.image)row.image={...row.image,alt:alt.value};message.textContent=importRowProblem(row,draft.rows) || (row.image?'Image ready.':'Optional: add an image.');updateImportCounts();};
  term.oninput=definition.oninput=alt.oninput=refresh;include.onchange=()=>{refresh();renderImportRows();};
  const pick=async file=>{row.manualImage=true;row.imageError='';row.processing=true;updateImportCounts();message.textContent='Processing image...';try{const value=await processTermImage(file,{alt:row.alt,source:row.source,credit:row.credit,license:row.license});if(!importActive(draft))return;await mediaRecord('put',value.image.id,{blob:value.blob},draft.scope);row.image=value.image;}catch(e){row.imageError=e.message;}finally{row.processing=false;if(importActive(draft))renderImportRows();}};
  image.onchange=()=>{if(image.value===''){row.image=null;row.manualImage=true;row.imageError='';row.matchedFile=null;renderImportRows();}else{row.matchedFile=draft.files[Number(image.value)];pick(row.matchedFile.file);}};
  add.onchange=()=>{if(add.files[0])pick(add.files[0]);};host.append(article);
 }
 updateImportCounts();
}
async function saveTermImport() {
 const draft=termImport;if(!draft)return;const rows=draft.rows.filter(r=>r.include),target=$('terms-target').value,mode=$('terms-merge').value,name=$('terms-name').value.trim();
 if(!rows.length || rows.length>200 || rows.some(r=>importRowProblem(r,draft.rows)))throw Error('Resolve the selected rows before saving.');
 if(!name || name.length>80)throw Error('Enter a set name of up to 80 characters.');
 let list=target==='new'?null:state.lists.find(l=>l.id===target);if(target!=='new' && !list)throw Error('The target set is unavailable.');
 if(list && draft.targetRevision && !sameVocabularyRevision(list,draft.targetRevision))throw Error('The target set changed. Select it again to refresh the change preview.');
 const revision=list && vocabularyRevision(list),old=list?await loadVocabulary(list):[],lookup=new Map(old.map(r=>[wordKey(r.word),r]));
 if(!importActive(draft) || list && !sameVocabularyRevision(list,revision))throw Error('This workspace changed. Preview the import again.');
 let added=0,changed=0,unchanged=0;
 for(const row of rows){const key=wordKey(row.term),before=lookup.get(key);
  if(before && mode!=='replace'){unchanged++;continue;}
  const definition=row.definition.trim().replace(/\s+/g,' '),same=before?.vocabulary?.definition===definition;
  const vocabulary=Vocabulary.validateRecord(row.term,{senseId:before?.vocabulary?.senseId || newListId(),partOfSpeech:row.pos || before?.vocabulary?.partOfSpeech || 'unknown',definition,examples:same?before.vocabulary.examples:[],clozeQuestions:same?before.vocabulary.clozeQuestions:[],meaningDistractors:same?before.vocabulary.meaningDistractors:[],acceptedSpellings:same?before.vocabulary.acceptedSpellings:[],readingLevel:before?.vocabulary?.readingLevel || 5,status:'draft',contentType:'definition'});
  lookup.set(key,{id:before?.id || newListId(),word:before?.word || row.term.trim(),vocabulary,promptType:'definition',...(row.image?{image:MediaModel.validate(row.image)}:{})});before?changed++:added++;
 }
 if(lookup.size>200)throw Error('The combined set would exceed 200 terms. Choose a new set or exclude rows.');
 const selected=[...lookup.values()];
 if(!list){list={id:newListId(),name,words:[],defs:dictionary(),updatedAt:now()};state.lists.push(list);state.settings.selected[list.id]=[];}
 const fresh=!revision,oldListId=listId;listId=list.id;
 try{await saveVocabulary(list,selected,{name:fresh?name:list.name,words:selected.map(r=>r.word),media:list.media || {display:'practice',tests:false},packVersion:(list.packVersion || 0)+1},()=>{
   const before=draft.owner.learning[list.id],next=before && structuredClone(before),familiar=draft.owner.familiar[list.id],changed=new Set();
   for(const row of selected){const previous=old.find(r=>wordKey(r.word)===wordKey(row.word));if(previous?.vocabulary?.definition!==row.vocabulary?.definition){changed.add(wordKey(row.word));if(next?.[wordKey(row.word)])delete next[wordKey(row.word)].vocabulary;}}
   if(next)draft.owner.learning[list.id]=next;if(familiar)draft.owner.familiar[list.id]=familiar.filter(key=>!changed.has(key));return ()=>{if(before)draft.owner.learning[list.id]=before;if(familiar)draft.owner.familiar[list.id]=familiar;};
  });}
 catch(e){if(!list.vocabKey && fresh && state===draft.owner){state.lists=state.lists.filter(l=>l!==list);delete state.settings.selected[list.id];listId=oldListId;}else if(importActive(draft)){const option=document.createElement('option');option.value=list.id;option.textContent='Retry saved set: '+list.name;$('terms-target').append(option);$('terms-target').value=list.id;state.settings.selected[list.id]=list.words.slice();save();}throw e;}
 if(!importActive(draft))return;
 state.settings.selected[list.id]=list.words.slice();save();$('terms-import-panel').hidden=true;termImport=null;renderSetup();status('Imported '+added+' new terms; '+changed+' replaced; '+unchanged+' preserved. Review and approve vocabulary before publishing.');
 if(ai.role==='teacher')$('teacher-open-publishing').click();
}
async function zipBlob(files){return new Promise((resolve,reject)=>fflate.zip(files,{level:1},(error,bytes)=>error?reject(error):resolve(new Blob([bytes],{type:'application/zip'}))));}
function downloadBlob(name,blob){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function archiveImages(packs) {
 const files={},assets={};let total=0;const scope=mediaScope(),epoch=mediaEpoch;
 for(const {pack,list}of packs)for(const row of pack.words)if(row.image && !assets[row.image.id]){
  const image=row.image,blob=await imageBlob(image,list,scope);if(epoch!==mediaEpoch)throw Error('Account changed. Export cancelled.');
  total+=blob.size;if(total>MediaModel.limits.expanded)throw Error('Export individual sets to keep image packages below 100 MB.');
  const path='images/'+image.id+(image.type==='image/png'?'.png':'.jpg');files[path]=new Uint8Array(await blob.arrayBuffer());assets[image.id]=path;
 }return {files,assets};
}
async function exportSetImages() {
 const list=selectedList();if(!list)throw Error('Select a set first.');const pack=outputPack(list,await loadVocabulary(list)),{files,assets}=await archiveImages([{pack,list}]);
 files['vocabulary.json']=fflate.strToU8(JSON.stringify(pack,null,2));files['manifest.json']=fflate.strToU8(JSON.stringify({kind:'wordlab-images',v:1,assets}));
 files['terms.csv']=fflate.strToU8('term,definition,image,image_alt\r\n'+pack.words.map(r=>[r.word,r.vocabulary?.definition || '',r.image?assets[r.image.id]:'',r.image?.alt || ''].map(csv).join(',')).join('\r\n'));
 downloadBlob('WordLab vocabulary with images.zip',await zipBlob(files));
}
async function exportBackupImages(backup) {
 if(!backup.packs.some(p=>p.records.some(r=>r.image)))return false;
 const packs=backup.packs.map(p=>{const list=backup.state.lists.find(l=>l.id===p.listId);return {list,pack:outputPack(list,p.records)};});
 const {files,assets}=await archiveImages(packs);files['backup.json']=fflate.strToU8(JSON.stringify(backup));files['manifest.json']=fflate.strToU8(JSON.stringify({kind:'wordlab-images',v:1,assets}));
 downloadBlob('WordLab full backup with images.zip',await zipBlob(files));return true;
}
async function readMediaArchive(file,backup=false) {
 const epoch=mediaEpoch,scope=mediaScope(),unpacked=await TermImports.unpack(new Uint8Array(await file.arrayBuffer())),files=new Map(unpacked);
 const parse=name=>{const bytes=files.get(name);if(!bytes || bytes.length>4*1024*1024)throw Error('Package metadata is missing or too large.');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));};
 if(!files.has('manifest.json'))return {files};
 const manifest=parse('manifest.json');if(manifest.kind!=='wordlab-images' || manifest.v!==1 || !manifest.assets || Object.keys(manifest.assets).length>2000)throw Error('Unsupported image package manifest.');
 const value=files.has('backup.json')?parse('backup.json'):Vocabulary.validatePack(parse('vocabulary.json'));
 const rows=value.kind==='spellingcoach-backup'?value.packs.flatMap(p=>p.records):value.words;
 if(!Array.isArray(rows))throw Error('Invalid package vocabulary.');
 for(const row of rows)if(row.image){const image=MediaModel.validate(row.image),bytes=files.get(TermImports.path(manifest.assets[image.id]));if(!bytes)throw Error('Package is missing an image.');
  const blob=new Blob([bytes],{type:image.type});if(blob.size!==image.size || await digestBlob(blob)!==image.hash)throw Error('Package image checksum mismatch.');
  const bitmap=await createImageBitmap(blob);try{if(bitmap.width!==image.width || bitmap.height!==image.height)throw Error('Package image dimensions mismatch.');}finally{bitmap.close();}
  if(epoch!==mediaEpoch)throw Error('Account changed. Import cancelled.');await mediaRecord('put',image.id,{blob},scope);
 }
 if(backup)return value;return {pack:value,files};
}
async function loadTermsFile(file) {
 const draft=termImport;if(!draft)return;
 if(file.size>MediaModel.limits.zip)throw Error('Choose a file of 50 MB or smaller.');
 const signature=new Uint8Array(await file.slice(0,4).arrayBuffer());
 if(/\.zip$/i.test(file.name) || signature[0]===80 && signature[1]===75 && signature[2]===3 && signature[3]===4){
  const data=await readMediaArchive(file);if(!importActive(draft))return;
  if(data.pack){if(data.pack.kind!=='spellingcoach-pack')throw Error('Use Tools to restore a full backup.');draft.rows=data.pack.words.map((r,i)=>({row:i+1,term:r.word,definition:r.vocabulary?.definition || '',image:r.image,pos:r.vocabulary?.partOfSpeech || 'unknown',include:true,manualImage:true}));$('terms-name').value=data.pack.name;$('terms-mapping').hidden=true;renderImportRows();return;}
  const terms=[...data.files.keys()].filter(name=>/\.(csv|tsv)$/i.test(name));if(terms.length!==1)throw Error('Include exactly one CSV or TSV terms file in the ZIP.');
  draft.files=[...data.files].filter(([name])=>/\.(jpg|jpeg|png|webp)$/i.test(name)).map(([name,bytes])=>({name,file:new File([bytes],name)}));
  draft.table=TermImports.table(new TextDecoder('utf-8',{fatal:true}).decode(data.files.get(terms[0])),/\.tsv$/i.test(terms[0])?'\t':',');
 }else{if(file.size>4*1024*1024)throw Error('CSV and TSV files must be 4 MB or smaller.');draft.table=TermImports.table(await file.text(),/\.tsv$/i.test(file.name)?'\t':',');}
 if(!importActive(draft))return;configureTermMapping(draft.table);mapTermRows();await matchImportImages();
}
async function downloadImportExample(zip) {
 const text='term,definition,image,image_alt\r\nevaporation,The change from liquid water into water vapor.,evaporation.png,Water rising from a dish\r\ncondensation,The change from water vapor into liquid water.,condensation.png,Droplets on a cold glass\r\n';
 if(!zip){download('WordLab terms template.csv',text,'text/csv');return;}
 const files={'terms.csv':fflate.strToU8(text)};
 for(const name of ['evaporation','condensation']){const canvas=document.createElement('canvas');canvas.width=240;canvas.height=180;const ctx=canvas.getContext('2d');ctx.fillStyle='#eff6ff';ctx.fillRect(0,0,240,180);ctx.strokeStyle='#1759a6';ctx.lineWidth=6;
  if(name==='evaporation'){ctx.fillStyle='#57b9eb';ctx.fillRect(25,130,190,25);for(const x of [65,120,175]){ctx.beginPath();ctx.moveTo(x,105);ctx.lineTo(x,45);ctx.moveTo(x-10,55);ctx.lineTo(x,45);ctx.lineTo(x+10,55);ctx.stroke();}}
  else {ctx.strokeRect(60,25,120,130);ctx.fillStyle='#57b9eb';for(const [x,y]of [[80,55],[130,85],[165,65],[95,120],[150,135]]){ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.fill();}}
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));files[name+'.png']=new Uint8Array(await blob.arrayBuffer());
 }downloadBlob('WordLab example with images.zip',await zipBlob(files));
}
async function downloadOfflineImages() {
 const review=typeof sharedReview!=='undefined' && sharedReview;
 const list=review ? findPackList(review.pack.id,review.origin) : selectedList(),rows=review ? review.pack.words : list?await loadVocabulary(list):null;
 if(!rows)throw Error('Open or select a set first.');let n=0;const target=$('shared-images-offline-status') && review?$('shared-images-offline-status'):$('images-offline-status');
 for(const row of rows)if(row.image){await imageBlob(row.image,list || {packId:review.pack.id,packVersion:review.pack.version,sharedOrigin:review.origin});target.textContent='Saved '+(++n)+' images...';}
 target.textContent=n+' images saved on this device. Keep the set here, or export a complete ZIP for the offline app.';
}
function initMediaUI() {
 const report=async action=>{try{await action();}catch(e){$('terms-import-status').textContent=e.message;status(e.message);}};
 for(const id of ['import-terms','workspace-import-terms','create-import-terms'])$(id).onclick=openTermImport;
 $('terms-close').onclick=()=>{if(termImport?.rows.length && !confirm('Discard this import preview? Your saved sets will stay as they are.'))return;termImport=null;$('terms-import-panel').hidden=true;};
 $('terms-source').onchange=e=>{const file=e.target.files[0];e.target.value='';if(file)report(()=>loadTermsFile(file));};
 $('terms-paste-parse').onclick=()=>report(async()=>{if(!termImport)return;termImport.table=TermImports.table($('terms-paste').value);configureTermMapping(termImport.table);mapTermRows();await matchImportImages();});
 $('terms-map-apply').onclick=()=>report(async()=>{mapTermRows();await matchImportImages();});
 $('terms-images').onchange=e=>report(async()=>{const draft=termImport;if(!draft)return;draft.files=Array.from(e.target.files).map(file=>({name:file.webkitRelativePath || file.name,file}));if(draft.files.length>500)throw Error('Choose up to 500 files.');await matchImportImages();});
 $('terms-filter').onchange=renderImportRows;
 $('terms-target').onchange=()=>report(async()=>{const draft=termImport,list=state.lists.find(l=>l.id===$('terms-target').value);if(!draft)return;draft.targetRevision=list?vocabularyRevision(list):null;draft.existing=list?await loadVocabulary(list):[];if(importActive(draft))updateImportCounts();});
 $('terms-merge').onchange=updateImportCounts;
 $('terms-save').onclick=()=>report(async()=>{$('terms-save').disabled=true;try{await saveTermImport();}finally{updateImportCounts();}});
 for(const id of ['terms-template','terms-template-guide'])$(id).onclick=()=>report(()=>downloadImportExample(false));
 $('terms-example-zip').onclick=()=>report(()=>downloadImportExample(true));
 for(const id of ['export-images','workspace-export-images'])$(id).onclick=()=>report(exportSetImages);
 $('images-offline').onclick=()=>report(downloadOfflineImages);
 $('shared-images-offline').onclick=()=>downloadOfflineImages().catch(e=>{$('shared-images-offline-status').textContent=e.message;});
 $('image-viewer-close').onclick=()=>$('image-viewer').close();$('image-viewer').addEventListener('close',()=>{$('image-viewer-image').removeAttribute('src');releaseMediaURL(imageViewerURL);imageViewerURL=null;imageViewerOrigin?.focus();});
 for(const id of ['images-display','images-tests'])$(id).onchange=()=>report(async()=>{const list=selectedList();if(!list)return;const rows=await loadVocabulary(list);await saveVocabulary(list,rows,{media:{display:$('images-display').value,tests:$('images-tests').checked},packVersion:(list.packVersion || 1)+1});await refreshSetWorkspace();});
}
