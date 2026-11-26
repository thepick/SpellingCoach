const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function harness(fetcher = async () => new Response(new Blob(['complete recording'],{type:'audio/wav'}))) {
 const clips=[],urls=[],revoked=[],spoken=[],errors=[],elements=new Map();
 const context=vm.createContext({Blob,AbortController,
  URL:{createObjectURL:blob=>{urls.push(blob);return 'blob:clip-'+urls.length;},revokeObjectURL:url=>revoked.push(url)},
  Audio:class {
   constructor(url){this.url=url;this.paused=false;clips.push(this);}
   async play(){this.onplaying?.();}
   pause(){this.paused=true;}
  },
  fetch:fetcher,speech:false,speak:(...args)=>spoken.push(args),
  $:id=>{if(!elements.has(id))elements.set(id,{hidden:false,textContent:'',disabled:false});return elements.get(id);},
  getStore:async()=>({get:async()=>null}),Dictation:{recordingKey:()=> 'recording'},
  location:{origin:'https://fixture.test'},storageOK:true,studentPreview:false,state:{lists:[],session:null,learningSession:null},
  Learning:{practiceMastered:()=>false},setTimeout:()=>0,clearTimeout:()=>{},visibleScreen:'shared-ready',
 });
 vm.runInContext(fs.readFileSync('src/dictation-ui.js','utf8'),context);
 const run=code=>vm.runInContext(code,context);
 context.failed=()=>errors.push('failed');
 return {context,run,clips,urls,revoked,spoken,errors,elements};
}

test('published playback waits for the entire clip before creating audio and releases its blob URL',async()=>{
 const response=deferred(),body=deferred(),requests=[];
 const h=harness((path,options)=>{requests.push({path,options});return response.promise;});
 const pending=h.run("playPublishedRecording('/word.wav',false,failed)");
 assert.equal(h.clips.length,0);
 assert.equal(requests[0].path,'/word.wav');
 response.resolve({ok:true,blob:()=>body.promise});await Promise.resolve();
 assert.equal(h.clips.length,0);
 const blob=new Blob(['complete audio'],{type:'audio/wav'});body.resolve(blob);await pending;
 assert.equal(h.clips.length,1);assert.equal(h.urls[0],blob);
 assert.equal(h.clips[0].playbackRate,1);
 h.clips[0].onended();assert.deepEqual(h.revoked,['blob:clip-1']);
});

test('navigation aborts a pending download and late completion cannot play or report an error',async()=>{
 const response=deferred(),requests=[];
 const h=harness((path,options)=>{requests.push(options);return response.promise;});
 const pending=h.run("playPublishedRecording('/word.wav',false,failed)");
 assert.equal(requests[0].signal.aborted,false);h.run('stopRecording()');
 assert.equal(requests[0].signal.aborted,true);
 response.resolve({ok:true,blob:async()=>new Blob(['stale'])});await pending;
 assert.equal(h.clips.length,0);assert.equal(h.errors.length,0);
});

test('a newer Listen supersedes an older full-body read without stopping the newer recording',async()=>{
 const firstBody=deferred(),reading=deferred();let requests=0;
 const h=harness(async()=>{const request=++requests;return {ok:true,blob:()=>{if(request===1){reading.resolve();return firstBody.promise;}return Promise.resolve(new Blob(['new clip']));}};});
 const old=h.run("playPublishedRecording('/old.wav',false,failed)");await reading.promise;
 await h.run("playPublishedRecording('/new.wav',true,failed)");
 firstBody.resolve(new Blob(['old clip']));await old;
 assert.equal(h.clips.length,1);assert.equal(h.clips[0].paused,false);assert.equal(h.clips[0].playbackRate,.75);
 assert.equal(h.errors.length,0);
 await h.run("playPublishedRecording('/new.wav',false,failed)");assert.equal(requests,2);
});

test('a media error after playback starts reports once, stops playback and releases the URL',async()=>{
 const h=harness();await h.run("playPublishedRecording('/word.wav',false,failed)");
 const audio=h.clips[0],error=audio.onerror;
 assert.equal(typeof error,'function');error();error();
 assert.equal(h.errors.length,1);assert.equal(audio.paused,true);assert.deepEqual(h.revoked,['blob:clip-1']);
 assert.equal(h.run('dictationPlayer'),null);
});

test('published download failure reports once and never starts browser speech',async()=>{
 const h=harness(async()=>({ok:false,status:404}));await h.run("playPublishedRecording('/missing.wav',false,failed)");
 assert.equal(h.errors.length,1);assert.equal(h.clips.length,0);assert.equal(h.spoken.length,0);
});

test('a media error followed by play rejection still reports only once',async()=>{
 const h=harness();
 h.context.Audio.prototype.play=function(){this.onerror();return Promise.reject(Error('Decoder failed.'));};
 await h.run("playPublishedRecording('/word.wav',false,failed)");
 assert.equal(h.errors.length,1);assert.deepEqual(h.revoked,['blob:clip-1']);
});

test('local Blob playback remains local and a failed local recording retains speech fallback',async()=>{
 let fetches=0;const h=harness(async()=>{fetches++;throw Error('local playback must not fetch');});
 h.context.recording=new Blob(['local audio'],{type:'audio/wav'});
 h.run('readRecording=async()=>recording');
 await h.run("dictate('list','solid',null,.85,failed)");
 assert.equal(fetches,0);assert.equal(h.clips.length,1);assert.equal(h.clips[0].playbackRate,.85);
 const error=h.clips[0].onerror;assert.equal(typeof error,'function');error();
 assert.equal(h.spoken.length,1);assert.equal(h.spoken[0][0],'solid');
});

function readyHarness() {
 const h=harness();vm.runInContext(fs.readFileSync('src/shared-review.js','utf8'),h.context);
 h.run("sharedReview={pack:{id:'set',name:'Words',words:[{word:'solid',vocabulary:null}]},origin:'https://fixture.test',mode:'spelling'};findPackList=()=>({id:'local'});let shown=[];show=id=>{shown.push(id);visibleScreen=id;stopRecording();}");
 return h;
}

test('a delayed ready-screen read cannot interrupt a newly started activity and its audio',async()=>{
 const h=readyHarness(),parked=deferred();h.context.readParked=()=>parked.promise;
 h.run('parkedActivity=readParked');const pending=h.run('renderSharedReady()');
 h.run("state.session={listId:'local',phase:'prompt'}");
 await h.run("playPublishedRecording('/word.wav',false,failed)");parked.resolve(null);await pending;
 assert.equal(h.clips[0].paused,false);assert.equal(h.run('shown.length'),0);
});

test('normal ready and resume rendering still selects the right button label',async()=>{
 const h=readyHarness();h.run('parkedActivity=async()=>null');await h.run('renderSharedReady()');
 assert.equal(h.elements.get('shared-start').textContent,'Start practice');
 h.run("state.session={listId:'local',phase:'paused'}");await h.run('renderSharedReady()');
 assert.equal(h.elements.get('shared-start').textContent,'Continue practice');
 assert.equal(h.run('shown.length'),2);
 assert.match(h.elements.get('shared-progress-note').textContent,/same browser and browser profile/);
 h.context.storageOK=false;await h.run('renderSharedReady()');
 assert.match(h.elements.get('shared-progress-note').textContent,/could not be saved/);
 h.context.studentPreview=true;await h.run('renderSharedReady()');
 assert.match(h.elements.get('shared-progress-note').textContent,/preview.*not saved/i);
});

test('a delayed audio-readiness poll cannot show the ready screen over active practice',async()=>{
 const h=readyHarness(),response=deferred();let poll;
 h.context.setTimeout=callback=>{poll=callback;return 1;};h.context.service=()=>response.promise;
 h.run('sharedReview.audioStatus={pending:true}');await h.run('renderSharedReady()');
 const pending=poll();h.run("state.session={listId:'local',phase:'prompt'}");
 await h.run("playPublishedRecording('/word.wav',false,failed)");
 response.resolve({audio:['0-s'],audioStatus:{pending:false}});await pending;
 assert.equal(h.clips[0].paused,false);assert.equal(h.run('shown.length'),1);
});

test('resuming the same already-active learning entry on the same screen invalidates a delayed ready render',async()=>{
 const h=readyHarness(),parked=deferred();h.context.readParked=()=>parked.promise;
 h.run("visibleScreen='learning-screen';sharedReview.mode='mixed';state.learningSession={listId:'local',session:{mode:'mixed',type:'test',status:'active'}};parkedActivity=readParked;Learning.resume=session=>session;Learning.upgradePractice=()=>{};save=()=>{};renderLearning=()=>show('learning-screen')");
 const resume=fs.readFileSync('src/app.js','utf8').match(/^function resumeActivity\(\).*$/m)[0];vm.runInContext(resume,h.context);
 const pending=h.run('renderSharedReady()');h.run('resumeActivity()');
 await h.run("playPublishedRecording('/word.wav',false,failed)");parked.resolve(null);await pending;
 assert.equal(h.run('visibleScreen'),'learning-screen');assert.equal(h.clips[0].paused,false);
});

test('a stalled published download times out once and clears its deadline',async()=>{
 let expire,cleared=0;
 const h=harness((path,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Aborted.')))));
 h.context.setTimeout=(callback,delay)=>{assert.equal(delay,45000);expire=callback;return 7;};
 h.context.clearTimeout=id=>{assert.equal(id,7);cleared++;};
 const pending=h.run("playPublishedRecording('/stalled.wav',false,failed)");
 assert.equal(typeof expire,'function');expire();await pending;
 assert.equal(h.errors.length,1);assert.equal(h.clips.length,0);assert.equal(cleared,1);
});

test('normal readiness polling survives its own initial screen transition',async()=>{
 const h=readyHarness();let poll;
 h.context.setTimeout=callback=>{poll=callback;return 1;};
 h.context.service=async()=>({audio:['0-s'],audioStatus:{pending:false}});
 h.run("visibleScreen='resume-screen';sharedReview.audioStatus={pending:true};parkedActivity=async()=>null");
 await h.run('renderSharedReady()');await poll();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.run('visibleScreen'),'shared-ready');assert.equal(h.elements.get('shared-start').hidden,false);
 assert.equal(h.elements.get('shared-start').textContent,'Start practice');assert.equal(h.run('shown.length'),2);
});

test('a completed clip replays within the user gesture after asynchronous autoplay is denied',async()=>{
 let downloads=0;const gestures=[];
 const h=harness(async()=>{downloads++;return new Response(new Blob(['complete clip']));});
 h.context.Audio.prototype.play=function(){gestures.push(h.context.gesture === true);return h.context.gesture ? Promise.resolve() : Promise.reject(Error('NotAllowedError'));};
 h.context.gesture=true;const first=h.run("playPublishedRecording('/word.wav',false,failed)");h.context.gesture=false;await first;
 assert.equal(h.errors.length,1);
 h.context.gesture=true;const replay=h.run("playPublishedRecording('/word.wav',false,failed)");h.context.gesture=false;await replay;
 assert.deepEqual(gestures,[false,true]);assert.equal(downloads,1);assert.equal(h.errors.length,1);
 h.context.state={lists:[],session:null,learningSession:null};
 h.context.gesture=true;const otherWorkspace=h.run("playPublishedRecording('/word.wav',false,failed)");h.context.gesture=false;await otherWorkspace;
 assert.equal(downloads,2);assert.deepEqual(gestures,[false,true,false]);
});

test('shared study stays hidden while a pack loads or its audio is pending',async()=>{
 const h=readyHarness(),response=deferred();
 Object.assign(h.context,{URLSearchParams,studentPreview:false,entryPage:'student',ONLINE_CONFIG:'https://fixture.test',
  ai:{root:'https://fixture.test',token:''},serviceOrigin:value=>value,service:()=>response.promise});
 h.context.Dictation.canonicalPackId=id=>id;h.context.location.hash='#pack=set';
 h.run("$('shared-study').hidden=false");const loading=h.run('openSharedReview()');
 assert.equal(h.elements.get('shared-study').hidden,true);response.reject(Error('Fixture load cancelled.'));await loading;
 h.run("sharedReview={pack:{id:'set',name:'Words',words:[]},mode:'mixed',audioStatus:{pending:true}};$('shared-study').hidden=false");
 await h.run('renderSharedReady()');assert.equal(h.elements.get('shared-study').hidden,true);
});

test('starting study without changing a saved activity invalidates a delayed ready-screen read',async()=>{
 const h=readyHarness(),parked=deferred();h.context.readParked=()=>parked.promise;
 const coach=fs.readFileSync('src/coach.js','utf8');
 const begin=coach.slice(coach.indexOf('function beginStudy('),coach.indexOf('function studyCards('));
 vm.runInContext('let studyState;renderStudy=()=>show("study-screen");'+begin,h.context);
 h.run('parkedActivity=readParked');const pending=h.run('renderSharedReady()');
 h.run("beginStudy({id:'local'},[])");parked.resolve(null);await pending;
 assert.equal(h.run('visibleScreen'),'study-screen');assert.equal(h.run('shown.length'),1);
});

test('a failed incomplete body is not cached and explicit replay downloads again',async()=>{
 let downloads=0;const h=harness(async()=>({ok:true,blob:()=>++downloads===1 ? Promise.reject(Error('Body interrupted.')) : Promise.resolve(new Blob(['complete clip']))}));
 await h.run("playPublishedRecording('/word.wav',false,failed)");assert.equal(h.errors.length,1);assert.equal(h.clips.length,0);
 await h.run("playPublishedRecording('/word.wav',false,failed)");assert.equal(downloads,2);assert.equal(h.clips.length,1);
});

test('decode and unsupported-source media errors evict a completed bad clip so replay can recover',async()=>{
 for(const code of [3,4]) {
  let downloads=0;const h=harness(async()=>{downloads++;return new Response(new Blob([downloads===1 ? 'bad bytes' : 'recovered audio']));});
  await h.run("playPublishedRecording('/word.wav',false,failed)");
  h.clips[0].error={code};h.clips[0].onerror();
  await h.run("playPublishedRecording('/word.wav',false,failed)");
  assert.equal(downloads,2);assert.equal(h.errors.length,1);assert.equal(h.clips[1].paused,false);
 }
});

test('NotSupportedError evicts a cached clip while gesture denial remains recoverable without refetch',async()=>{
 let downloads=0,plays=0;const h=harness(async()=>{downloads++;return new Response(new Blob(['complete clip']));});
 h.context.Audio.prototype.play=function(){return ++plays===1 ? Promise.reject(Object.assign(Error('Unsupported.'),{name:'NotSupportedError'})) : Promise.resolve();};
 await h.run("playPublishedRecording('/word.wav',false,failed)");await h.run("playPublishedRecording('/word.wav',false,failed)");
 assert.equal(downloads,2);assert.equal(h.errors.length,1);assert.equal(plays,2);
});

test('a stale older media error cannot evict the newer completed clip',async()=>{
 let downloads=0;const h=harness(async()=>{downloads++;return new Response(new Blob(['complete clip']));});
 await h.run("playPublishedRecording('/old.wav',false,failed)");const oldError=h.clips[0].onerror;
 await h.run("playPublishedRecording('/new.wav',false,failed)");
 h.clips[0].error={code:3};oldError();
 await h.run("playPublishedRecording('/new.wav',false,failed)");
 assert.equal(downloads,2);assert.equal(h.errors.length,0);
});
