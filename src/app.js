(function(){
'use strict';
// BUILD:MODULES
const SELFTEST = new URLSearchParams(location.search).has('selftest');
const VERSION='0.2.0',KEY='spell.state',D={roundSize:7,retypeOnMiss:true,autoAdvanceMs:600,feedbackMs:1800,voiceURI:'',rate:.85,pin:'',allowVariants:false};
const $=id=>document.getElementById(id),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),now=()=>new Date().toISOString();
const norm=s=>String(s??'').trim().replace(/\s+/g,' ').replace(/[’‘]/g,"'");
function equal(a,b){a=norm(a);b=norm(b);return /[A-Z]/.test(b)?a===b:a.toLowerCase()===b.toLowerCase();}
function wordsUnique(a){const seen=new Set(),out=[];for(const x of a){const w=String(x??'').trim(),k=norm(w).toLowerCase();if(w&&!seen.has(k)){seen.add(k);out.push(w);}}return out;}
function parseCSV(text){
 text=String(text??'').replace(/^\uFEFF/,'');const rows=[];let row=[],field='',quoted=false,closed=false;
 for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];
  if(quoted){if(c==='"'&&n==='"'){field+='"';i++;}else if(c==='"'){quoted=false;closed=true;}else if(c==='\n'||c==='\r')throw Error('Quoted line breaks are not supported.');else field+=c;}
  else if(c==='"'){if(field||closed)throw Error('Unexpected quote in CSV.');quoted=true;}
  else if(c===','){row.push(field);field='';closed=false;}
  else if(c==='\r'||c==='\n'){if(c==='\r'&&n==='\n')i++;row.push(field);if(row.some(x=>x.trim()))rows.push(row);row=[];field='';closed=false;}
  else{if(closed&&c.trim())throw Error('Unexpected text after a quoted field.');field+=c;}
 }
 if(quoted)throw Error('Unclosed quoted field.');row.push(field);if(row.some(x=>x.trim()))rows.push(row);
 return rows.flat().map(word=>({word:word.trim(),definition:''})).filter(r=>r.word);
}
function csv(v){v=String(v??'');return /[",\r\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;}
function diff(a,b){
 a=Array.from(String(a));b=Array.from(String(b));const n=a.length,m=b.length,d=Array.from({length:n+1},()=>Array(m+1).fill(0));
 for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)d[i][j]=a[i]===b[j]?d[i+1][j+1]+1:Math.max(d[i+1][j],d[i][j+1]);
 const x=[],y=[];let i=0,j=0;while(i<n||j<m){if(i<n&&j<m&&a[i]===b[j]){x.push({c:a[i],k:''});y.push({c:b[j],k:''});i++;j++;}else if(i<n&&(j===m||d[i+1][j]>=d[i][j+1])){x.push({c:a[i++],k:'wrong'});y.push({c:'·',k:''});}else{x.push({c:'·',k:''});y.push({c:b[j++],k:'right'});}}return{x,y};
}
function blank(){return {v:2,lists:[],settings:{...D,selected:dictionary()},progress:dictionary(),history:dictionary(),learning:dictionary(),learningHistory:[],familiar:dictionary(),learningSession:null,session:null};}
function clamp(v,a,b,f){v=Number(v);return Number.isFinite(v)?Math.max(a,Math.min(b,Math.round(v))):f;}
function listOK(l){return !!l&&typeof l.id==='string'&&!!l.id.trim()&&typeof l.name==='string'&&Array.isArray(l.words)&&l.words.every(w=>typeof w==='string')&&(!l.defs||(typeof l.defs==='object'&&!Array.isArray(l.defs)&&Object.values(l.defs).every(v=>typeof v==='string')));}
function sessionOK(s){if(!s||s.v!==1||typeof s.listId!=='string'||!Array.isArray(s.words)||!s.words.length||new Set(s.words).size!==s.words.length||!Array.isArray(s.queue)||!s.perWord||!Array.isArray(s.log)||!Number.isInteger(s.round)||s.round<1||!['prompt','feedback','retype','paused','done'].includes(s.phase))return false;const set=new Set(s.words);return s.words.every(w=>typeof w==='string'&&s.perWord[w]&&typeof s.perWord[w]==='object')&&s.queue.every(w=>set.has(w))&&(s.phase==='done'?!s.current||set.has(s.current):set.has(s.current));}
function clean(raw){
 const s=blank();if(!raw||typeof raw!=='object')return s;
 s.lists=Array.isArray(raw.lists)?raw.lists.filter(listOK).map(l=>({id:l.id,name:l.name,words:wordsUnique(l.words),defs:dictionary(l.defs),updatedAt:l.updatedAt||now(),...listMetadata(l)})):[];
 if(![0,1,2].includes(raw.v))return s;
 const x=raw.settings||{};s.settings={roundSize:clamp(x.roundSize,1,20,7),retypeOnMiss:x.retypeOnMiss!==false,autoAdvanceMs:clamp(x.autoAdvanceMs,0,5000,600),feedbackMs:clamp(x.feedbackMs,300,10000,1800),voiceURI:typeof x.voiceURI==='string'?x.voiceURI:'',rate:Math.max(.5,Math.min(1.2,Number(x.rate)||.85)),pin:/^\d{4}$/.test(x.pin||'')?x.pin:'',allowVariants:x.allowVariants===true,selected:dictionary(x.selected)};
 if(raw.progress&&typeof raw.progress==='object')for(const[k,v]of Object.entries(raw.progress))if(v&&v.words&&typeof v.words==='object')s.progress[k]={words:dictionary(v.words)};
 if(raw.history&&typeof raw.history==='object')for(const[k,v]of Object.entries(raw.history))if(v&&Array.isArray(v.sessions))s.history[k]={sessions:v.sessions.slice(-10)};
 if(sessionOK(raw.session)){s.session=raw.session;s.session.defs=dictionary(raw.session.defs);s.session.perWord=dictionary(raw.session.perWord);}
 return restoreLearningFields(s,raw);
}
let storageOK=true,state=SELFTEST?blank():loadState(),listId=(state.session||state.learningSession||state.learningCheckpoint||{}).listId||(state.lists[0]||{}).id||'',voices=[],speech=!!(window.speechSynthesis&&window.SpeechSynthesisUtterance),timer=0;
function save(){return SELFTEST || storageOK && saveState();}
function warning(){$('storage-warning').hidden=storageOK;if(storageIssue)$('storage-warning').textContent=storageIssue;}
function status(t){$('setup-status').textContent=t;}
function show(id){document.querySelectorAll('.screen').forEach(x=>x.hidden=true);$(id).hidden=false;}
function selectedList(){return state.lists.find(x=>x.id===listId)||null;}
function selectedGroup(words,selection){
 const chosen=new Set(selection);
 for(let i=0;i<Math.ceil(words.length/20);i++){
  const group=words.slice(i*20,(i+1)*20);
  if(chosen.size===group.length&&group.every(w=>chosen.has(w)))return i;
 }
 return -1;
}
function selectedWords(){const l=selectedList();if(!l)return[];return Array.isArray(state.settings.selected[l.id])?state.settings.selected[l.id].filter(w=>l.words.includes(w)):[...l.words];}
function addList(name,ws,defs){const l={id:newListId(),name:name||'New list',words:wordsUnique(ws),defs:dictionary(defs),updatedAt:now()};state.lists.push(l);state.settings.selected[l.id]=[...l.words];listId=l.id;save();renderSetup();return l;}
function clearListLearningData(target,id){delete target.progress[id];delete target.history[id];if(target.learning)delete target.learning[id];if(target.familiar)delete target.familiar[id];if(target.learningHistory)target.learningHistory=target.learningHistory.filter(x=>x.listId!==id);}
function comparator(s,a,b){const x=s.perWord[a],y=s.perWord[b];return(y.misses-x.misses)||((x.lastSeen||-Infinity)-(y.lastSeen||-Infinity))||(s.words.indexOf(a)-s.words.indexOf(b));}
function buildRound(s){const left=s.words.filter(w=>!s.perWord[w].mastered).sort((a,b)=>comparator(s,a,b));s.roundMembers=left.slice(0,state.settings.roundSize);s.queue=[...s.roundMembers];}
function takeNext(s){const previous=s.current;if(s.queue[0]===previous){const other=s.queue.findIndex(w=>w!==previous);if(other>0)[s.queue[0],s.queue[other]]=[s.queue[other],s.queue[0]];else{const alternative=s.words.find(w=>w!==previous&&!s.perWord[w].mastered);if(alternative)s.queue.unshift(alternative);}}s.current=s.queue.shift();s.currentType=s.perWord[s.current].initialDone?'review':'initial';s.phase='prompt';}
function next(s){
 if(s.queue.length){takeNext(s);return true;}
 if(s.words.every(w=>s.perWord[w].mastered)){s.current='';s.phase='done';return false;}
 s.round++;buildRound(s);if(!s.queue.length){s.current='';s.phase='done';return false;}takeNext(s);return true;
}
function start(ws,list){
 if(!ws.length||!list)return;const defs=dictionary();for(const w of ws)defs[w]=(list.defs&&list.defs[w])||'';
 const perWord=dictionary();for(const w of ws){const old=state.progress[list.id]?.words?.[w]||{};perWord[w]={streak:0,misses:Number(old.misses)||0,lastSeen:Number(old.lastSeen)||null,initialDone:false,initialCorrect:false,missed:false,mastered:false,retypeMisses:0};}
 state.session={v:1,listId:list.id,listName:list.name,words:[...ws],defs,startedAt:now(),round:1,roundMembers:[],queue:[],current:'',currentType:'initial',phase:'prompt',perWord,log:[],missed:[],firstCorrect:0,initialCount:0,retypeMisses:0};
 buildRound(state.session);next(state.session);save();renderPractice(true);
}
function submit(s,text){
 if(!s||s.phase!=='prompt')return null;const w=s.current,p=s.perWord[w],type=s.currentType,ok=equal(text,w),progress=state.progress[s.listId]||(state.progress[s.listId]={words:dictionary()}),cp=progress.words[w]||(progress.words[w]={initialAttempts:0,initialCorrect:0,misses:0,retypeMisses:0,lastSeen:null});
 s.log.push({type,word:w,typed:String(text),ok,at:now()});if(type==='initial'){p.initialDone=true;s.initialCount++;cp.initialAttempts++;if(ok){s.firstCorrect++;p.initialCorrect=true;cp.initialCorrect++;}}
 cp.lastSeen=Date.now();recordLegacySpelling(s.listId,w,ok);
 if(ok){p.streak++;if(p.streak>=2)p.mastered=true;s.phase='feedback';}
 else{p.streak=0;p.misses++;p.missed=true;cp.misses++;if(!s.missed.includes(w))s.missed.push(w);s.queue.push(w);s.feedbackDiff=diff(text,w);s.phase=state.settings.retypeOnMiss?'retype':'feedback';}
 save();return{ok,type,typed:String(text),word:w,diff:diff(text,w)};
}
function retype(s,text){
 const w=s.current,ok=equal(text,w),p=s.perWord[w];s.log.push({type:'retype',word:w,typed:String(text),ok,at:now()});
 if(!ok){p.retypeMisses++;s.retypeMisses++;s.feedbackDiff=diff(text,w);const cp=state.progress[s.listId]?.words?.[w];if(cp)cp.retypeMisses++;save();return{ok:false,diff:diff(text,w)};}
 delete s.feedbackDiff;next(s);save();return{ok:true};
}
function summary(s){const missed=s.words.filter(w=>s.perWord[w].missed).sort((a,b)=>comparator(s,a,b));return{at:now(),total:s.words.length,mastered:s.words.filter(w=>s.perWord[w].mastered).length,attempts:s.initialCount,correct:s.firstCorrect,accuracy:s.initialCount?Math.round(s.firstCorrect/s.initialCount*100):0,retypes:s.retypeMisses,missed};}
let finished=false;
function finish(render=true){const s=state.session;if(!s)return;if(s.summary){if(render)showSummary(s.summary);return;}finished=true;const r=summary(s),h=state.history[s.listId]||(state.history[s.listId]={sessions:[]});h.sessions.push(r);h.sessions=h.sessions.slice(-10);s.summary=r;s.phase='done';save();if(render)showSummary(r);}
function end(){clearTimeout(timer);finish(true);}
function textDiff(d){return'<div>'+d.x.map(x=>'<span class="'+x.k+'">'+esc(x.c)+'</span>').join('')+'</div><div>'+d.y.map(x=>'<span class="'+x.k+'">'+esc(x.c)+'</span>').join('')+'</div>';}
function renderSetup(){
 const sel=$('list-select');sel.innerHTML='';
 if(!state.lists.length){sel.add(new Option('No saved lists',''));listId='';}else{state.lists.forEach(l=>sel.add(new Option(l.name,l.id)));if(!state.lists.some(l=>l.id===listId))listId=state.lists[0].id;sel.value=listId;}
 const l=selectedList();$('setup-intro').textContent=state.lists.length?'Choose a word list and select the words you want to practice.':'Create a list to get started. Give it a name and add one word or phrase per line.';$('list-actions-help').hidden=!!l;
 ['edit-list','delete-list','reset-progress','shuffle-words','select-all','select-none','select-next-group'].forEach(id=>$(id).disabled=!l);
 const host=$('word-chips');host.innerHTML='';
 if(l){const chosen=new Set(selectedWords());l.words.forEach(w=>{const label=document.createElement('label');label.className='chip';const cb=document.createElement('input');cb.type='checkbox';cb.checked=chosen.has(w);cb.setAttribute('aria-label','Include '+w);cb.onchange=()=>{const a=selectedWords();state.settings.selected[l.id]=l.words.filter(x=>x===w?cb.checked:a.includes(x));save();countSelected();};const span=document.createElement('span');span.textContent=w;label.append(cb,span);host.append(label);});}
 else host.innerHTML='<span class="hint">Create or import a list to begin.</span>';
 countSelected();loadSettings();queueVocabulary();
}
function countSelected(){
 const l=selectedList(),selection=selectedWords(),n=selection.length;
 $('selection-count').textContent=n+' selected';$('start-session').disabled=!n;
 const group=l?selectedGroup(l.words,selection):-1,total=l?Math.ceil(l.words.length/20):0;
 const button=$('select-next-group');
 button.disabled=!total;
 button.textContent=group<0?'Select first 20':group===total-1?'Back to first 20':'Next 20';
 $('group-status').textContent=group<0?(total?'Select groups of up to 20 words for each practice session.':''):'Group '+(group+1)+' of '+total+' · Words '+(group*20+1)+'–'+Math.min((group+1)*20,l.words.length);
 updateCoachSetup();
}
function loadSettings(){const x=state.settings;$('round-size').value=x.roundSize;$('retype-toggle').checked=x.retypeOnMiss;$('auto-advance').value=x.autoAdvanceMs;$('feedback-delay').value=x.feedbackMs;$('speech-rate').value=x.rate;$('rate-label').textContent=Number(x.rate).toFixed(2);$('pin-entry').value=x.pin;$('allow-variants').checked=x.allowVariants;refreshVoices();$('voice-select').value=x.voiceURI;}
function speak(value,rate,onError,onStart){if(!speech){if(onError)onError();return;}try{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(String(value)),v=voices.find(x=>x.voiceURI===state.settings.voiceURI)||voices.find(x=>/^en-US/i.test(x.lang))||voices.find(x=>/^en/i.test(x.lang));if(v)u.voice=v;if(onStart)u.onstart=onStart;if(onError)u.onerror=e=>{if(!['canceled','interrupted'].includes(e.error))onError();};u.rate=rate||state.settings.rate;speechSynthesis.speak(u);}catch(e){if(onError){onError();return;}speech=false;$('replay-button').hidden=true;$('slow-replay').hidden=true;$('visual-word').className='visual-prompt';$('visual-word').textContent='Prompt: '+value;}}
function refreshVoices(){if(!speech)return;voices=speechSynthesis.getVoices().filter(v=>/^en(?:-|_)/i.test(v.lang));const sel=$('voice-select'),old=state.settings.voiceURI;sel.innerHTML='<option value="">System default</option>';voices.forEach(v=>sel.add(new Option(v.name+' ('+v.lang+')',v.voiceURI)));sel.value=old;}
function renderTiles(s){const host=$('tiles');host.innerHTML='';s.words.forEach(w=>{const p=s.perWord[w],el=document.createElement('span');el.className='tile'+(p.mastered?' mastered':p.streak===1?' familiar':'');el.setAttribute('aria-label',p.mastered?'Mastered':p.streak===1?'One correct':'Not mastered');el.title=p.mastered?'Mastered':p.streak===1?'One correct':'Not mastered';host.append(el);});}
function feedback(msg,kind,d){const box=$('feedback');box.className='feedback'+(kind?' '+kind:'');box.innerHTML='';if(msg){const t=document.createElement('div');t.textContent=msg;box.append(t);}if(d){const x=document.createElement('div');x.className='diff';x.innerHTML=textDiff(d);box.append(x);}}
function renderPractice(play){
 const s=state.session;if(!s)return;finished=false;show('practice-screen');$('list-name-practice').textContent=s.listName;$('round-text').textContent='Round '+s.round;
 const done=s.words.filter(w=>s.perWord[w].mastered).length;$('progress-text').textContent=done+' / '+s.words.length+' mastered';$('progress-fill').style.width=(100*done/s.words.length)+'%';$('mastery-progress').setAttribute('aria-valuemax',s.words.length);$('mastery-progress').setAttribute('aria-valuenow',done);renderTiles(s);
 $('definition').textContent=s.defs[s.current]||'';$('visual-word').className=speech?'sr':'visual-prompt';$('visual-word').textContent=speech?'':'Prompt: '+s.current;$('replay-button').hidden=!speech;$('slow-replay').hidden=!speech;$('answer-input').value='';$('answer-input').disabled=!['prompt','retype'].includes(s.phase);$('dont-know').hidden=s.phase==='retype';$('submit-answer').textContent=s.phase==='retype'?'Type it correctly':'Check spelling';$('submit-answer').disabled=!['prompt','retype'].includes(s.phase);
 if(s.phase==='retype')feedback('Type the word correctly to continue.','bad',s.feedbackDiff||diff('',s.current));else if(s.phase==='feedback'){const last=s.log[s.log.length-1];if(last&&last.ok)feedback(s.perWord[s.current]?.mastered?'Mastered: two correct answers in a row.':'Correct. One more correct answer will master this word.','good');else if(last)feedback('Compare your answer with the correct spelling.','bad',diff(last.typed,s.current));}else feedback('','');
 if(play&&s.phase==='prompt')speak(s.current,state.settings.rate);if(['prompt','retype'].includes(s.phase))setTimeout(()=>$('answer-input').focus(),35);
 if(s.phase==='feedback'){clearTimeout(timer);const last=s.log[s.log.length-1],delay=last&&last.ok?state.settings.autoAdvanceMs:state.settings.feedbackMs;timer=setTimeout(advance,delay);}
}
function advance(){const s=state.session;if(!s||s.phase!=='feedback')return;if(s.words.every(w=>s.perWord[w].mastered)){s.current='';s.phase='done';finish(true);return;}next(s);save();renderPractice(true);}
function showSummary(r){const s=state.session;if(!s)return;clearTimeout(timer);show('summary-screen');$('summary-list').textContent=s.listName;$('summary-title').textContent=r.mastered===r.total?'Practice complete':'Practice ended';$('summary-stats').innerHTML='<div class="stat"><span class="hint">Words mastered</span><strong>'+Number(r.mastered)+' / '+Number(r.total)+'</strong><small class="hint">Two correct answers in a row.</small></div><div class="stat"><span class="hint">First-attempt accuracy</span><strong>'+(r.attempts?Number(r.accuracy)+'%':'Not assessed')+'</strong><small class="hint">Correct first answers ÷ first answers submitted.</small></div><div class="stat"><span class="hint">Incorrect retype attempts</span><strong>'+Number(r.retypes)+'</strong><small class="hint">Incorrect answers during the correction step.</small></div>';
 const list=$('missed-list');list.innerHTML='';r.missed.forEach(w=>{const li=document.createElement('li');li.textContent=w+(s.defs[w]?' — '+s.defs[w]:'');list.append(li);});$('missed-empty').hidden=!!r.missed.length;$('practice-missed').disabled=!r.missed.length;$('copy-missed').disabled=!r.missed.length;
 const hist=(state.history[s.listId]?.sessions||[]).slice().reverse(),h=$('history-list');h.innerHTML='';hist.forEach(x=>{const li=document.createElement('li');li.textContent=new Date(x.at).toLocaleDateString()+' · '+x.accuracy+'% · '+x.mastered+'/'+x.total+' mastered'+(Array.isArray(x.missed)&&x.missed.length?' · '+x.missed[0]:'');h.append(li);});
}
function copy(text){if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text).then(()=>true,()=>fallbackCopy(text));return Promise.resolve(fallbackCopy(text));}
function fallbackCopy(text){const t=document.createElement('textarea');t.value=text;t.style.position='fixed';t.style.opacity='0';(document.querySelector('dialog[open]')||document.body).append(t);t.select();let ok=false;try{ok=document.execCommand('copy');}catch(e){}t.remove();return ok;}
function download(file,text,type){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=file;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function practiceMissed(){const s=state.session;if(!s)return;const r=s.summary||summary(s);if(!Array.isArray(r.missed)||!r.missed.length)return;const l={id:s.listId,name:s.listName,words:s.words,defs:s.defs};state.session=null;save();start(r.missed,l);}
function finishToSetup(){const checkpoint=state.learningCheckpoint;if(state.session&&!state.session.summary)finish(false);state.session=null;state.learningSession=null;save();if(checkpoint)getStore(checkpoint.backend).then(store=>store.remove(checkpoint.key)).catch(()=>{});renderSetup();show('setup-screen');}
function backToSetup(){if(state.settings.pin){$('pin-check').value='';$('pin-error').textContent='';$('pin-overlay').hidden=false;$('pin-check').focus();}else finishToSetup();}
function validBackup(x){if(!x||x.v!==1||!Array.isArray(x.lists)||!x.lists.every(listOK))throw Error('Choose a WordLab backup with a valid lists array.');return x.lists.map(l=>({id:l.id,name:l.name,words:wordsUnique(l.words),defs:dictionary(l.defs),updatedAt:now()}));}
function runTests(){
 const out=[],assert=(v,m)=>{if(!v)throw Error(m||'assertion failed');},test=(n,f)=>{try{f();out.push([n,true,'']);}catch(e){out.push([n,false,e.message]);}};
 const oldSession=state.session,oldRound=state.settings.roundSize,oldMode=state.settings.retypeOnMiss,oldProgress=state.progress.selftest;
 test('normalization handles spaces and curly apostrophes',()=>assert(norm(' can’t   go ')==="can't go"));
 test('case-insensitive words and exact proper nouns',()=>{assert(equal('Disconnect','disconnect'));assert(!equal('america','America'));});
 test('CSV handles BOM, CRLF, and quoted commas',()=>{const a=parseCSV('\uFEFFcat\r\n"hello, world"\r\n');assert(a.length===2&&a[1].word==='hello, world');});
 test('CSV accepts a plain word list without headers or definitions',()=>{const a=parseCSV('﻿because\r\ndifferent\r\n\r\nimportant\r\n');assert(a.length===3&&a[0].word==='because'&&a.every(x=>x.definition===''));});
 test('CSV preserves a first word that looks like a header',()=>assert(parseCSV('word\nmeaning')[0].word==='word'));
 test('CSV treats every cell as a word',()=>{const a=parseCSV('cat,dog,bird\nfish,');assert(a.map(x=>x.word).join('|')==='cat|dog|bird|fish'&&a.every(x=>x.definition===''));});
 test('CSV rejects quoted newlines and malformed quotes',()=>{let a=false,b=false;try{parseCSV('word,"two\nlines"')}catch(e){a=true}try{parseCSV('word,"unclosed')}catch(e){b=true}assert(a&&b);});
 test('dedupe retains first spelling and order',()=>assert(wordsUnique([' Cat ','cat','Dog']).join('|')==='Cat|Dog'));
 test('CSV export escapes quotes and commas',()=>assert(csv('a,"b"')==='"a,""b"""'));
 test('JSON backup validates its version and list shape',()=>{assert(validBackup({v:1,lists:[{id:'x',name:'X',words:['a']}]}).length===1);let bad=false;try{validBackup({v:0,lists:[]})}catch(e){bad=true}assert(bad);});
 test('round ordering uses misses, then oldest lastSeen',()=>{const s={words:['a','b','c'],perWord:{a:{misses:3,lastSeen:5,mastered:false},b:{misses:1,lastSeen:1,mastered:false},c:{misses:1,lastSeen:null,mastered:false}},queue:[]};state.settings.roundSize=2;buildRound(s);assert(s.roundMembers.join('|')==='a|c');});
 test('wrong review requeues and correct reviews leave initial accuracy unchanged',()=>{state.progress.selftest={words:dictionary()};state.settings.roundSize=2;state.settings.retypeOnMiss=false;const s={v:1,listId:'selftest',listName:'test',words:['cat','dog'],defs:{},round:1,roundMembers:['cat','dog'],queue:['dog'],current:'cat',currentType:'review',phase:'prompt',perWord:{cat:{streak:1,misses:0,lastSeen:null,initialDone:true,initialCorrect:true,missed:false,mastered:false},dog:{streak:0,misses:0,lastSeen:null,initialDone:false,initialCorrect:false,missed:false,mastered:false}},log:[],missed:[],firstCorrect:1,initialCount:1,retypeMisses:0};submit(s,'wrong');assert(s.queue.join('|')==='dog|cat'&&s.initialCount===1&&s.firstCorrect===1);s.phase='prompt';s.current='cat';s.currentType='review';submit(s,'cat');assert(s.initialCount===1&&s.firstCorrect===1&&s.perWord.cat.streak===1&&!s.perWord.cat.mastered);s.phase='prompt';s.current='cat';s.currentType='review';submit(s,'cat');assert(s.perWord.cat.mastered&&summary(s).missed.includes('cat'));});
 test('incorrect retype is counted outside accuracy',()=>{const s={listId:'selftest',current:'cat',phase:'retype',perWord:{cat:{retypeMisses:0}},log:[],retypeMisses:0};assert(!retype(s,'cut').ok&&s.retypeMisses===1);});
  test('a different unmastered word is prompted before a requeued word',()=>{const s={words:['cat','dog'],queue:['cat'],current:'cat',round:1,perWord:{cat:{initialDone:true,mastered:false},dog:{initialDone:false,mastered:false}},phase:'feedback'};assert(next(s)&&s.current==='dog'&&s.queue[0]==='cat');});
  test('a word repeats when it is the only unmastered word',()=>{const s={words:['cat','dog'],queue:['cat'],current:'cat',round:1,perWord:{cat:{initialDone:true,mastered:false},dog:{initialDone:true,mastered:true}},phase:'feedback'};assert(next(s)&&s.current==='cat');});
 test('two correct answers master; a miss resets streak',()=>{let streak=1;streak++;assert(streak===2);streak=0;assert(streak===0);});
 test('character diff marks substitutions',()=>{const d=diff('cat','cut');assert(d.x.some(x=>x.k==='wrong')&&d.y.some(x=>x.k==='right'));});
  test('reset clears only the selected list learning data',()=>{const x={lists:[{id:'a',words:['cat']},{id:'b',words:['dog']}],settings:{selected:{a:['cat'],b:['dog']}},progress:{a:{words:{cat:{misses:2}}},b:{words:{dog:{misses:1}}}},history:{a:{sessions:[1]},b:{sessions:[2]}}};clearListLearningData(x,'a');assert(!x.progress.a&&!x.history.a&&x.progress.b&&x.history.b&&x.lists.length===2&&x.settings.selected.a[0]==='cat');});
  test('old stored version keeps lists and retains progress',()=>{const s=clean({v:0,lists:[{id:'x',name:'X',words:['a']}],progress:{bad:{words:{}}}});assert(s.lists.length===1&&Object.keys(s.progress).length===1);});
 test('legacy list backups preserve words predating new authoring limits',()=>{
  const words=Array.from({length:201},(_,index)=>'word_'+index);
  assert(validBackup({v:1,lists:[{id:'legacy',name:'Legacy',words}]})[0].words.length===201);
 });
 test('migration carries settings, progress and an unfinished spelling session',()=>{
  const raw={v:1,lists:[{id:'a',name:'Legacy',words:['dog'],defs:{dog:'A pet.'}}],settings:{pin:'1234',selected:{a:['dog']}},
   progress:{a:{words:{dog:{misses:4}}}},history:{a:{sessions:[{attempts:1}]}},
   session:{v:1,listId:'a',words:['dog'],defs:{dog:'A pet.'},queue:[],current:'dog',perWord:{dog:{}},log:[],round:1,phase:'prompt'}};
  const migrated=clean(raw), again=clean(JSON.parse(JSON.stringify(migrated)));
  assert(again.v===2&&again.settings.pin==='1234'&&again.settings.selected.a[0]==='dog'&&again.progress.a.words.dog.misses===4&&
   again.history.a.sessions[0].attempts===1&&again.session.current==='dog'&&again.lists[0].defs.dog==='A pet.');
 });
 test('RANDOM.ORG receipts must map each position exactly once',()=>{
  const receipt={status:'complete',result:{random:{data:[3,1,2]}}};
  assert(orderFromReceipt(receipt,3).join(',')==='2,0,1');
  receipt.result.random.data=[1,1,3];
  let failed=false;try{orderFromReceipt(receipt,3);}catch(error){failed=true;}
  assert(failed);
 });
 test('page title matches app version',()=>assert(document.title==='WordLab v'+VERSION));
 state.session=oldSession;state.settings.roundSize=oldRound;state.settings.retypeOnMiss=oldMode;if(oldProgress===undefined)delete state.progress.selftest;else state.progress.selftest=oldProgress;
 const pass=out.filter(x=>x[1]).length;document.body.innerHTML='<main style="font:16px system-ui;max-width:800px;margin:36px auto;padding:20px"><h1>WordLab self-test</h1><p>'+pass+'/'+out.length+' checks passed.</p><ul>'+out.map(x=>'<li>'+(x[1]?'✓ ':'✗ ')+esc(x[0])+(x[2]?' — '+esc(x[2]):'')+'</li>').join('')+'</ul></main>';document.body.dataset.selftest=pass===out.length?'passed':'failed';
}
if(SELFTEST){runTests();return;}

function renderTheme(){$('theme-select').value=themePreference.value;}
$('theme-select').onchange=event=>themePreference.set(event.target.value);
renderTheme();

function settingsChanged(){state.settings.roundSize=clamp($('round-size').value,1,20,7);state.settings.retypeOnMiss=$('retype-toggle').checked;state.settings.autoAdvanceMs=clamp($('auto-advance').value,0,5000,600);state.settings.feedbackMs=clamp($('feedback-delay').value,300,10000,1800);state.settings.voiceURI=$('voice-select').value;state.settings.rate=Math.max(.5,Math.min(1.2,Number($('speech-rate').value)||.85));state.settings.pin=/^\d{4}$/.test($('pin-entry').value)?$('pin-entry').value:'';state.settings.allowVariants=$('allow-variants').checked;save();}
$('list-select').onchange=()=>{listId=$('list-select').value;renderSetup();status('');};
let listDraft=null,importRequest=0;
function draftWords(){return wordsUnique($('create-list-words').value.split(/\r?\n/));}
function draftDefinitions(ws){const defs=dictionary();ws.forEach(w=>{if(listDraft.defs[w])defs[w]=listDraft.defs[w];});return defs;}
function editorStatus(message){$('list-editor-status').textContent=message;}
function openListEditor(l){
 listDraft={id:l?.id||null,defs:{...(l?.defs||{})}};
 $('create-list-form').reset();$('create-list-name').setCustomValidity('');$('create-list-words').setCustomValidity('');
 $('create-list-title').textContent=l?'Edit word list':'Create a word list';
 $('create-list-intro').textContent=l?'Update the name or words, then save your changes.':'Give your list a name, then add or import the words to practice.';
 $('create-list-name').value=l?.name||'';$('create-list-words').value=l?l.words.join('\n'):'';
 $('save-list-draft').textContent=l?'Save changes':'Create this list';$('save-list-draft').disabled=false;
 $('split-list').hidden=true;
 $('split-list').textContent=l?'Split into new lists':'Split into lists';
 editorStatus('');$('create-list-dialog').showModal();$('create-list-name').focus();
}
$('new-list').onclick=()=>openListEditor(null);
$('edit-list').onclick=()=>{const l=selectedList();if(l)openListEditor(l);};
$('create-list-dialog').addEventListener('close',()=>{listDraft=null;importRequest++;});
$('cancel-create-list').onclick=()=>$('create-list-dialog').close();
$('create-list-name').oninput=()=>$('create-list-name').setCustomValidity('');
$('create-list-words').oninput=()=>{
 $('create-list-words').setCustomValidity('');
 $('split-list').hidden=draftWords().length<=Vocabulary.MAX_WORDS;
};
$('create-list-form').onsubmit=e=>{
 e.preventDefault();if(!listDraft||$('save-list-draft').disabled)return;
 const name=$('create-list-name').value.trim();
 let ws;try{ws=Vocabulary.normalizeWords(draftWords());}catch(error){editorStatus(error.message+' Split the list into smaller lists if needed.');return;}
 $('create-list-name').setCustomValidity(name?'':'Enter a name for this word list.');
 if(!name){$('create-list-name').reportValidity();return;}
 if(!ws.length){$('create-list-words').setCustomValidity('Enter at least one spelling word.');$('create-list-words').reportValidity();return;}
 const defs=draftDefinitions(ws),l=state.lists.find(x=>x.id===listDraft.id);
 if(l){
  const oldWords=l.words,chosen=new Set(selectedWords());
  l.name=name;l.words=ws;l.defs=defs;l.updatedAt=now();
  state.settings.selected[l.id]=ws.filter(w=>chosen.has(w)||!oldWords.includes(w));
  save();renderSetup();
 }else addList(name,ws,defs);
 $('create-list-dialog').close();
 status((l?'Saved “':'Created “')+name+'” with '+ws.length+' words. Choose words to practice or begin your session.');
};
$('split-list').onclick=()=>{
 if(!listDraft)return;
 const name=$('create-list-name').value.trim();
 if(!name){$('create-list-name').reportValidity();return;}
 const ws=draftWords(), groups=[];
 try {
  for(let index=0;index<ws.length;index+=Vocabulary.MAX_WORDS){
   groups.push(Vocabulary.normalizeWords(ws.slice(index,index+Vocabulary.MAX_WORDS)));
  }
  if(groups.length<2)return;
  groups.forEach((words,index)=>addList(name+' ('+(index+1)+')',words,draftDefinitions(words)));
  save();renderSetup();$('create-list-dialog').close();status('Split the words into '+groups.length+' lists.');
 }catch(error){editorStatus(error.message);}
};
$('delete-list').onclick=()=>{const l=selectedList();if(l&&confirm('Delete “'+l.name+'” and its words?')){state.lists=state.lists.filter(x=>x.id!==l.id);delete state.settings.selected[l.id];clearListLearningData(state,l.id);removeVocabulary(l);listId=state.lists[0]?.id||'';save();renderSetup();status('List deleted.');}};
$('reset-progress').onclick=()=>{const l=selectedList();if(!l)return;const message='Reset learning progress for “'+l.name+'”? This clears its review statistics and past practice summaries. The word list, definitions, selection, and settings will stay.';if(!confirm(message))return;clearListLearningData(state,l.id);save();status('Learning progress and practice summaries reset for “'+l.name+'”.');};

$('select-all').onclick=()=>{const l=selectedList();if(l){state.settings.selected[l.id]=[...l.words];save();renderSetup();}};
$('select-none').onclick=()=>{const l=selectedList();if(l){state.settings.selected[l.id]=[];save();renderSetup();}};
$('select-next-group').onclick=()=>{
 const l=selectedList();if(!l||!l.words.length)return;
 const group=(selectedGroup(l.words,selectedWords())+1)%Math.ceil(l.words.length/20);
 state.settings.selected[l.id]=l.words.slice(group*20,(group+1)*20);
 save();renderSetup();
};
$('shuffle-words').onclick=()=>openShuffle('list');
$('import-csv').onclick=()=>$('csv-file').click();
$('csv-file').onchange=async e=>{
 const f=e.target.files[0];e.target.value='';if(!f||!listDraft)return;
 const draft=listDraft,request=++importRequest;$('save-list-draft').disabled=true;editorStatus('Reading CSV…');
 try{
  if(f.size>100000)throw Error('The CSV file is too large.');
  const rows=parseCSV(await f.text());
  if(listDraft!==draft||request!==importRequest)return;
  if(!rows.length)throw Error('No words found.');
  const combined=wordsUnique([...draftWords(),...rows.map(x=>x.word)]);
  const oversized=combined.length>Vocabulary.MAX_WORDS;
  const ws=oversized?combined:Vocabulary.normalizeWords(combined);
  $('split-list').hidden=!oversized;
  rows.forEach(x=>{const w=ws.find(w=>norm(w).toLowerCase()===norm(x.word).toLowerCase());if(w&&x.definition&&!draft.defs[w])draft.defs[w]=x.definition;});
  $('create-list-words').value=ws.join('\n');$('create-list-words').setCustomValidity('');
  if(!$('create-list-name').value.trim()){
   let name=f.name.replace(/\.[^.]+$/,'')||'Imported list',base=name,i=2;
   while(state.lists.some(l=>l.name.toLowerCase()===name.toLowerCase()))name=base+' ('+(i++)+')';
   $('create-list-name').value=name;$('create-list-name').setCustomValidity('');
  }
  editorStatus(oversized?'CSV loaded with '+ws.length+' words. Split into lists to keep every word.':'CSV loaded. Review '+ws.length+' words, then '+(draft.id?'save your changes.':'create this list.'));
 }catch(err){if(listDraft===draft&&request===importRequest)editorStatus('CSV import failed: '+err.message);}
 finally{if(listDraft===draft&&request===importRequest)$('save-list-draft').disabled=false;}
};
$('copy-list').onclick=()=>{
 if(!listDraft)return;const draft=listDraft,ws=draftWords();
 copy(ws.map(csv).join('\r\n')).then(ok=>{if(listDraft===draft)editorStatus(ok?'Draft copied as CSV.':'Copy failed.');});
};
$('preview-voice').onclick=()=>speak('The quick brown fox jumps over the lazy dog.',state.settings.rate);
$('open-tools').onclick=()=>{$('tools-dialog').showModal();};
$('close-tools').onclick=()=>$('tools-dialog').close();
$('done-tools').onclick=()=>$('tools-dialog').close();
['round-size','retype-toggle','auto-advance','feedback-delay','voice-select','pin-entry','allow-variants'].forEach(id=>$(id).addEventListener('change',()=>{state.settings.roundSize=clamp($('round-size').value,1,20,7);state.settings.retypeOnMiss=$('retype-toggle').checked;state.settings.autoAdvanceMs=clamp($('auto-advance').value,0,5000,600);state.settings.feedbackMs=clamp($('feedback-delay').value,300,10000,1800);state.settings.voiceURI=$('voice-select').value;state.settings.rate=Math.max(.5,Math.min(1.2,Number($('speech-rate').value)||.85));state.settings.pin=/^\d{4}$/.test($('pin-entry').value)?$('pin-entry').value:'';state.settings.allowVariants=$('allow-variants').checked;save();}));
$('speech-rate').oninput=()=>{$('rate-label').textContent=Number($('speech-rate').value).toFixed(2);state.settings.rate=Number($('speech-rate').value);save();};
$('start-session').onclick=beginCoach;
$('answer-form').onsubmit=e=>{e.preventDefault();const s=state.session;if(!s)return;const wasRetype=s.phase==='retype',r=wasRetype?retype(s,$('answer-input').value):submit(s,$('answer-input').value);if(!r)return;$('answer-input').value='';if(wasRetype&&!r.ok){renderPractice(false);$('answer-input').focus();}else renderPractice(s.phase==='prompt'&&r.ok);};
$('dont-know').onclick=()=>{$('answer-input').value='';$('answer-form').requestSubmit();};
$('replay-button').onclick=()=>state.session&&speak(state.session.current,state.settings.rate);
$('slow-replay').onclick=()=>state.session&&speak(state.session.current,state.settings.rate*.6);
$('pause-button').onclick=()=>{const s=state.session;if(!s)return;clearTimeout(timer);s.resumePhase=s.phase;s.phase='paused';save();$('pause-overlay').hidden=false;$('resume-practice').focus();};
$('resume-practice').onclick=()=>{const s=state.session;if(!s)return;$('pause-overlay').hidden=true;s.phase=s.resumePhase||'prompt';delete s.resumePhase;save();renderPractice(s.phase==='prompt');};
$('end-session').onclick=()=>{$('pause-overlay').hidden=true;end();};
$('back-setup').onclick=()=>{$('pause-overlay').hidden=true;backToSetup();};
$('resume-button').onclick=()=>{const s=state.session;if(state.learningSession){Learning.resume(state.learningSession.session);state.learningSession.recorded=false;save();renderLearning(true);return;}if(!s)return;if(s.phase==='done'&&s.summary){showSummary(s.summary);return;}s.phase=s.phase==='paused'?(s.resumePhase||'prompt'):s.phase;delete s.resumePhase;save();renderPractice(s.phase==='prompt');};
$('end-saved-button').onclick=()=>{if(!state.learningSession){end();return;}Learning.finish(state.learningSession.session);finishLearningReport();};
$('pin-form').onsubmit=e=>{e.preventDefault();if($('pin-check').value!==state.settings.pin){$('pin-error').textContent='That PIN did not match.';return;}$('pin-overlay').hidden=true;finishToSetup();};
$('cancel-pin').onclick=()=>{$('pin-overlay').hidden=true;if(state.learningSession)renderLearning(false);else if(state.session?.summary)showSummary(state.session.summary);else if(state.session)$('pause-overlay').hidden=false;};
$('reset-pin').onclick=()=>{if(confirm('Clear the saved PIN? Lists and progress will stay.')){state.settings.pin='';save();$('pin-overlay').hidden=true;if(state.learningSession)renderLearning(false);else if(state.session&&!state.session.summary)$('pause-overlay').hidden=false;else finishToSetup();}};
$('summary-setup').onclick=backToSetup;
$('practice-missed').onclick=practiceMissed;
$('copy-missed').onclick=()=>{const s=state.session;if(!s)return;const r=s.summary||summary(s);copy(r.missed.map(w=>csv(w)+','+csv(s.defs[w]||'')).join('\r\n')).then(ok=>{$('copy-missed').textContent=ok?'Copied':'Copy failed';setTimeout(()=>$('copy-missed').textContent='Copy missed words',1300);});};
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'){if(!$('pin-overlay').hidden){$('pin-overlay').hidden=true;if(state.session&&!state.session.summary)$('pause-overlay').hidden=false;return;}if(!$('pause-overlay').hidden)return;if(!$('practice-screen').hidden){e.preventDefault();$('pause-button').click();}else if(!$('learning-screen').hidden){e.preventDefault();pauseLearning();}return;}
 if(e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName||''))return;
 if(!$('practice-screen').hidden&&e.key.toLowerCase()==='r')speak(state.session?.current,state.settings.rate);
 if(!$('practice-screen').hidden&&e.key.toLowerCase()==='s')speak(state.session?.current,state.settings.rate*.6);
});
if(speech){speechSynthesis.addEventListener('voiceschanged',refreshVoices);setTimeout(refreshVoices,400);setTimeout(refreshVoices,1200);}
state.settings.roundSize=clamp(state.settings.roundSize,1,20,7);state.settings.retypeOnMiss=state.settings.retypeOnMiss!==false;
// BUILD:STARTUP
renderSetup();warning();if(state.learningSession)pauseLearning();else if(state.learningCheckpoint)recoverCheckpoint();else show(state.session?'resume-screen':'setup-screen');
})();
