import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {VocabularyService} from './service.mjs';
import Imports from '../src/imports.js';
import {verifyImage} from './media.mjs';

function png() {
 const chunk=(type,data)=>{const bytes=Buffer.concat([Buffer.from(type),data]),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(Imports.crc32(bytes));return Buffer.concat([size,bytes,crc]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(2,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,20,80,150,255,50,100,200,255]))),chunk('IEND',Buffer.alloc(0))]);
}
const bytes=png(),hash=createHash('sha256').update(bytes).digest('hex'),image={id:hash,hash,type:'image/png',width:2,height:1,size:bytes.length,alt:'A blue illustration'};
const secret='media-tests-owner-secret-with-entropy',origin='https://wordlab.mtomlinson.ca';
function fixture(extra={}) {
 const db=new DatabaseSync(':memory:'),objects=new Map();let now=Date.now();
 const bucket={put:async(key,data)=>{objects.set(key,new Uint8Array(data));},get:async key=>{const data=objects.get(key);return data?{body:new Blob([data]).stream(),size:data.length}:null;},delete:async key=>objects.delete(key)};
 const env={ADMIN_AUTH_SECRET:secret,SESSION_SIGNING_SECRET:'media-tests-session-secret-with-entropy',ALLOWED_ORIGINS:origin,WORDLAB_IMAGES:bucket,...extra};
 const storage={async setAlarm(){},sql:{exec(sql,...args){const stmt=db.prepare(sql),rows=stmt.columns().length?stmt.all(...args):[];if(!stmt.columns().length)stmt.run(...args);return{toArray:()=>rows};}},transactionSync(work){db.exec('BEGIN');try{const value=work();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const service=new VocabularyService(storage,env,{now:()=>now});
 const call=async(method,path,body,token=secret)=>{const raw=body instanceof Uint8Array;const headers={Origin:origin};if(token)headers.Authorization='Bearer '+token;if(body!==undefined)headers['Content-Type']=raw?'image/png':'application/json';const response=await service.fetch(new Request('https://wordlab.test/api'+path,{method,headers,body:body===undefined?undefined:raw?body:JSON.stringify(body)}));return{status:response.status,body:response.headers.get('Content-Type')?.startsWith('image/')?new Uint8Array(await response.arrayBuffer()):await response.json(),headers:response.headers};};
 const upload=async(token=secret)=>{const session=await call('POST','/teacher/image-imports',{images:[image]},token);assert.equal(session.status,200);const result=await call('PUT','/teacher/image-imports/'+session.body.id+'/assets/'+hash,bytes,token);assert.equal(result.status,200);return session;};
 const pack=()=>({kind:'spellingcoach-pack',v:2,id:'pictures',version:1,name:'Water',media:{display:'practice',tests:false},words:[{id:'row-one',word:'evaporation',image,promptType:'definition',vocabulary:{contentType:'definition',senseId:'literal',partOfSpeech:'unknown',definition:'A change from liquid to vapor.',examples:[],clozeQuestions:[],meaningDistractors:[],acceptedSpellings:[],readingLevel:5,status:'approved'}}]});
 return{db,env,service,objects,call,upload,pack,advance:ms=>{now+=ms;}};
}
test('server decodes complete bounded images and rejects checksum, dimensions and corrupt pixels',async()=>{
 await verifyImage(bytes,image);await assert.rejects(verifyImage(bytes,{...image,width:3}),/dimensions/);
 const broken=Uint8Array.from(bytes);broken[50]^=1;const digest=createHash('sha256').update(broken).digest('hex');
 await assert.rejects(verifyImage(broken,{...image,id:digest,hash:digest}),/decoded/);
 await assert.rejects(verifyImage(broken,image),/checksum/);
});
test('image reservation/upload is idempotent, private and never cached publicly',async()=>{
 const f=fixture();await f.upload();
 const again=await f.call('POST','/teacher/image-imports',{images:[image]});assert.deepEqual(again.body.missing,[]);assert.equal(f.objects.size,1);
 const read=await f.call('GET','/teacher/images/'+hash);assert.equal(read.status,200);assert.deepEqual(read.body,new Uint8Array(bytes));assert.equal(read.headers.get('Cache-Control'),'no-store');
 assert.equal((await f.call('GET','/teacher/images/'+hash,undefined,'')).status,401);
});
test('teacher isolation covers image reads, session uploads and set attachment',async()=>{
 const f=fixture();await f.upload();
 const invitation=await f.call('POST','/admin/invitations',{label:'Teacher two'});
 const login=await f.call('POST','/teacher/accept',{invite:invitation.body.invite,username:'teacher-two',name:'Teacher Two',password:'a sufficiently long password'},'');assert.equal(login.status,200);
 const token=login.body.token;assert.equal((await f.call('GET','/teacher/images/'+hash,undefined,token)).status,404);
 assert.equal((await f.call('POST','/teacher/sets',{pack:f.pack(),expectedVersion:0},token)).status,400);
 await f.upload(token);assert.equal(f.objects.size,2);
});
test('publishing requires uploaded owned images and preserves the private/published boundary',async()=>{
 const f=fixture(),pack=f.pack();assert.equal((await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'vocabulary'})).status,400);
 await f.upload();assert.equal((await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'vocabulary'})).status,200);
 const path='/packs/pictures/images/1/'+hash;assert.equal((await f.call('GET',path,undefined,'')).status,200);
 assert.equal((await f.call('GET','/packs/pictures/images/2/'+hash,undefined,'')).status,404);
 f.service.sql.exec('DELETE FROM teacher_sets');await f.service.media.cleanup();assert.equal((await f.call('GET',path,undefined,'')).status,200);
});
test('class-restricted pictures inherit pack authorization',async()=>{
 const f=fixture();await f.upload();const cls=await f.call('POST','/admin/classes',{classId:'ip5-9',name:'IP5/9',dailyWords:200,expiresAt:Date.now()+3600000});
 const token=(await f.call('POST','/access',{code:cls.body.code},'')).body.token;
 assert.equal((await f.call('POST','/admin/publish',{pack:f.pack(),visibility:'class',classId:'ip5-9',mode:'vocabulary'})).status,200);
 assert.equal((await f.call('GET','/packs/pictures/images/1/'+hash,undefined,'')).status,404);
 assert.equal((await f.call('GET','/packs/pictures/images/1/'+hash,undefined,token)).status,200);
});
test('quotas, invalid metadata and disabled image imports fail before writing objects',async()=>{
 const f=fixture({IMAGE_OWNER_QUOTA_MB:'0'});assert.equal((await f.call('POST','/teacher/image-imports',{images:[image]})).status,413);assert.equal(f.objects.size,0);
 const g=fixture();assert.equal((await g.call('POST','/teacher/image-imports',{images:[{...image,type:'image/svg+xml'}]})).status,400);
 g.env.IMAGE_IMPORTS_ENABLED='false';assert.equal((await g.call('POST','/teacher/image-imports',{images:[image]})).status,503);
});
test('cleanup retains referenced assets and protects active imports, then removes abandoned images',async()=>{
 const f=fixture(),session=await f.upload();f.advance(8*86400000);
 const active=await f.call('POST','/teacher/image-imports',{images:[image]});await f.service.media.cleanup();assert.equal(f.objects.size,1);
 await f.call('DELETE','/teacher/image-imports/'+active.body.id);await f.service.media.cleanup();assert.equal(f.objects.size,0);
});
test('image-only private edits reuse every prepared recording and preserve published images',async()=>{
 const f=fixture();await f.upload();const pack=f.pack();
 const first=await f.call('POST','/teacher/sets',{pack,expectedVersion:0});assert.equal(first.status,200);
 const record=f.service.accounts.readSet('operator',pack.id);
 for(const clip of record.recordings){Object.assign(clip,{status:'ready',provider:'openrouter',voice:'en_paul_neutral',cacheKey:JSON.stringify([clip.skill,clip.text,'openrouter','mistralai/voxtral-mini-tts-2603','en_paul_neutral'])});f.service.sql.exec('INSERT INTO teacher_audio VALUES (?, ?, ?)', 'operator',clip.cacheKey,new Uint8Array([1,2,3]));}
 f.service.accounts.writeSet('operator',record);
 assert.equal((await f.call('POST','/admin/publish',{pack,visibility:'public',mode:'vocabulary'})).status,200);
 const updated=structuredClone(pack);updated.version=2;updated.words[0].image.alt='A water illustration';
 const second=await f.call('POST','/teacher/sets',{pack:updated,expectedVersion:1});assert.equal(second.status,200);
 assert(second.body.audioStatus.recordings.every(r=>r.status==='ready'));assert.equal(second.body.audioStatus.total,2);
 const published=await f.call('GET','/packs/pictures',undefined,'');assert.equal(published.body.pack.version,1);assert.equal(published.body.pack.words[0].image.alt,image.alt);
 assert.equal((await f.call('GET','/packs/pictures/images/1/'+hash,undefined,'')).status,200);
});
