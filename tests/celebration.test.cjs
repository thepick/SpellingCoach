const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness(reduced = false) {
 const frames = new Map(), listeners = new Map(), launches = [];
 let clock = 0, nextFrame = 0, removed = 0, saves = 0;
 const canvas = {style:{},setAttribute(){},remove(){removed++;},getContext(){return {
  setTransform(){},clearRect(){},save(){},restore(){},translate(x,y){launches.push([x,y]);},rotate(){},fillRect(){}};}};
 const motion = {matches:reduced};
 const context = vm.createContext({console,Math,Vocabulary:require('../src/vocabulary.js'),save(){saves++;},
  matchMedia:()=>motion,innerWidth:1000,innerHeight:800,devicePixelRatio:2,
  performance:{now:()=>clock},requestAnimationFrame:fn=>{frames.set(++nextFrame,fn);return nextFrame;},
  cancelAnimationFrame:id=>frames.delete(id),
  document:{hidden:false,createElement:()=>canvas,body:{append(){}},
   addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)},
  window:{addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)}});
 vm.runInContext(fs.readFileSync('src/coach.js','utf8'),context);
 return {context,motion,listeners,launches,canvas,run:code=>vm.runInContext(code,context),
  tick(ms){clock+=ms;const queued=[...frames.values()];frames.clear();queued.forEach(fn=>fn(clock));},
  get frames(){return frames.size;},get removed(){return removed;},get saves(){return saves;}};
}

test('mastery celebration launches from both sides and expires without leaving canvas or listeners',()=>{
 const h=harness();h.run('let session={};celebrateMastery(session)');h.tick(16);
 assert.equal(h.launches.length,72);
 assert(h.launches.slice(0,36).every(([x])=>x>800));
 assert(h.launches.slice(36).every(([x])=>x<200));
 assert.equal(h.canvas.width,2000);assert.equal(h.canvas.height,1600);
 for(let i=0;i<240;i++)h.tick(16);
 assert.equal(h.frames,0);assert.equal(h.removed,1);assert.equal(h.listeners.size,0);
 assert.equal(h.saves,1);
 h.run('celebrateMastery(session)');assert.equal(h.frames,0);assert.equal(h.saves,1);
});

test('reduced motion, navigation, hidden pages and a motion preference change suppress or cancel confetti',()=>{
 const quiet=harness(true);quiet.run('let session={};celebrateMastery(session)');
 assert.equal(quiet.frames,0);assert.equal(quiet.run('session.celebrationShown'),true);
 for(const type of ['visibilitychange','pagehide','resize']) {
  const h=harness();h.run('celebrateMastery({})');
  if(type==='visibilitychange')h.context.document.hidden=true;
  h.listeners.get(type)();assert.equal(h.frames,0);assert.equal(h.removed,1);
 }
 const h=harness();h.run('celebrateMastery({})');h.motion.matches=true;h.tick(16);
 assert.equal(h.frames,0);assert.equal(h.removed,1);
 const nav=harness();nav.run('celebrateMastery({});stopMasteryCelebration();stopMasteryCelebration()');
 assert.equal(nav.removed,1);assert.equal(nav.listeners.size,0);
});
