import MediaModel from '../src/media-model.js';
import {ApiError, requireInput, shape, shortId} from './validation.mjs';
import {decodeImage} from './vendor/image-decode.mjs';

const DAY=86400000;
const fail=(status,code,message)=>{throw new ApiError(status,code,message);};
const missing=()=>fail(404,'not_found','This image is unavailable.');
const json=value=>Response.json(value);
async function bytesOf(request,limit) {
 if(!request.body || Number(request.headers.get('Content-Length'))>limit)fail(413,'image_size','The image or request is too large.');
 const reader=request.body.getReader(),parts=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();fail(413,'image_size','The image or request is too large.');}parts.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
async function metadataBody(request,limit=250000) {
 if(!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || ''))fail(415,'image_input','Image metadata must use JSON.');
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytesOf(request,limit)));}
 catch(e){if(e instanceof ApiError)throw e;fail(400,'image_input','Provide valid image metadata.');}
}
function metadata(value) {try{return MediaModel.validate(value);}catch(e){fail(400,'image_metadata',e.message);}}
export async function verifyImage(bytes, expected) {
 requireInput(bytes.length===expected.size && bytes.length<=MediaModel.limits.image,'The image size does not match its metadata.');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 requireInput(digest===expected.hash,'The image checksum does not match. Upload it again.');
 let image;
 try {image=decodeImage(bytes,expected.type);}
 catch(e){fail(400,'image_decode','This image could not be decoded. Upload a different JPEG or PNG.');}
 requireInput(image.width===expected.width && image.height===expected.height && image.width<=1600 && image.height<=1600,'The image dimensions do not match.');
}

export class ImageService {
 constructor(service) {
  this.s=service;
  service.sql.exec('CREATE TABLE IF NOT EXISTS image_assets (owner TEXT NOT NULL, id TEXT NOT NULL, metadata TEXT NOT NULL, object_key TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(owner,id))');
  service.sql.exec('CREATE TABLE IF NOT EXISTS image_imports (owner TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(owner,id))');
 }
 enabled(){return !!this.s.env.WORDLAB_IMAGES && this.s.env.IMAGE_IMPORTS_ENABLED!=='false';}
 asset(owner,id){return this.s.one('SELECT * FROM image_assets WHERE owner = ? AND id = ?',owner,id);}
 unchanged(identity){if(!this.s.accounts.unchanged(identity))fail(409,'account_changed','Your account changed. Sign in again before uploading images.');}
 refs(pack){return (pack?.words || []).filter(r=>r.image).map(r=>r.image);}
 assertAssets(pack,owner) {
  let total=0;
  for(const image of this.refs(pack)) {
   metadata(image);const record=this.asset(owner,image.id),actual=record && JSON.parse(record.metadata);
   requireInput(record?.state==='ready' && ['hash','type','width','height','size'].every(k=>actual[k]===image[k]),'An image is missing or still uploading. Retry its upload before saving or sharing.');
   total+=image.size;
  }
  requireInput(total<=MediaModel.limits.set,'A set can contain up to 50 MB of images.');
 }
 start(identity,input) {
  requireInput(shape(input,['images']) && Array.isArray(input.images) && input.images.length<=200,'Choose up to 200 images.');
  const images=input.images.map(metadata),unique=new Map(images.map(image=>[image.id,image]));
  const s=this.s,owner=identity.teacherId,id=crypto.randomUUID();
  if(!this.enabled() && [...unique.keys()].some(key=>this.asset(owner,key)?.state!=='ready'))fail(503,'images_unavailable','Image uploads are unavailable. Your definitions can still be saved without images.');
  return s.atomic(()=>{
   this.unchanged(identity);
   const bytes=s.rows('SELECT metadata FROM image_assets WHERE owner = ?',owner).reduce((n,r)=>n+JSON.parse(r.metadata).size,0);
   const added=[...unique.values()].filter(image=>!this.asset(owner,image.id)).reduce((n,image)=>n+image.size,0);
   const quota=Number(s.env.IMAGE_OWNER_QUOTA_MB || 250)*1024*1024;
   if(bytes+added>quota)fail(413,'image_quota','Your image storage is full. Contact the site owner or use smaller images.');
   for(const image of unique.values()) {
    const existing=this.asset(owner,image.id);
    if(existing?.state==='deleting')fail(409,'image_retry','This image is being cleaned up. Retry shortly.');
    if(existing) {const value=JSON.parse(existing.metadata);requireInput(['hash','size','width','height','type'].every(k=>value[k]===image[k]),'Conflicting image metadata.');}
    else s.sql.exec('INSERT INTO image_assets VALUES (?, ?, ?, ?, ?, ?)',owner,image.id,JSON.stringify(image),'teachers/'+encodeURIComponent(owner)+'/'+image.id,'reserved',s.now());
   }
   s.sql.exec('INSERT INTO image_imports VALUES (?, ?, ?, ?)',owner,id,JSON.stringify([...unique.keys()]),s.now());
   return {id,missing:[...unique.keys()].filter(key=>this.asset(owner,key).state!=='ready'),usedBytes:bytes+added,quotaBytes:quota};
  });
 }
 async route(request) {
  const path=new URL(request.url).pathname,method=request.method;
  const teacher=path.match(/^\/api\/teacher\/(?:image-imports(?:\/([a-zA-Z0-9-]+)(?:\/assets\/([a-f0-9]{64})|\/(commit))?)?|images\/([a-f0-9]{64}))$/);
  const published=path.match(/^\/api\/packs\/([a-zA-Z0-9._:-]{1,96})\/images\/(\d{1,16})\/([a-f0-9]{64})$/);
  if(!teacher && !published)return null;
  const s=this.s;
  if(published && method==='GET') {
   const [,id,version,asset]=published,info=await s.pack(id,request);
   if(info.pack.version!==Number(version) || !this.refs(info.pack).some(image=>image.id===asset))missing();
   const value=s.one('SELECT value FROM packs WHERE id = ?',id),owner=JSON.parse(value.value).owner || 'operator';
   return this.response(owner,asset);
  }
  if(!teacher)missing();
  const identity=await s.principal(request);if(identity.role!=='teacher')fail(403,'forbidden','Teacher access is required.');
  this.unchanged(identity);const owner=identity.teacherId,[,id,asset,commit,preview]=teacher;
  if(preview && method==='GET')return this.response(owner,preview);
  if(!id && method==='POST'){const result=this.start(identity,await metadataBody(request));await s.scheduleAudio();return json(result);}
  const record=id && s.one('SELECT value, created FROM image_imports WHERE owner = ? AND id = ?',owner,id);
  if(!record || record.created<s.now()-DAY)missing();
  if(asset && method==='PUT') {
   if(!this.enabled())fail(503,'images_unavailable','Image uploads are unavailable.');
   if(!JSON.parse(record.value).includes(asset))missing();
   const saved=this.asset(owner,asset);if(!saved || saved.state==='deleting')missing();
   const expected=JSON.parse(saved.metadata);
   const bytes=await bytesOf(request,MediaModel.limits.image);
   if(request.headers.get('Content-Type')!==expected.type)fail(400,'image_type','The image type does not match.');
   await verifyImage(bytes,expected);this.unchanged(identity);
   if(saved.state!=='ready')await s.env.WORDLAB_IMAGES.put(saved.object_key,bytes,{httpMetadata:{contentType:expected.type}});
   this.unchanged(identity);
   s.sql.exec("UPDATE image_assets SET state = 'ready' WHERE owner = ? AND id = ? AND state <> 'deleting'",owner,asset);
   return json({id:asset,ready:true});
  }
  if(commit && method==='POST') {
   const result=await s.accounts.saveSet(identity,await metadataBody(request,1500000));
   s.sql.exec('DELETE FROM image_imports WHERE owner = ? AND id = ?',owner,id);return json(result);
  }
  if(!asset && !commit && method==='DELETE') {s.sql.exec('DELETE FROM image_imports WHERE owner = ? AND id = ?',owner,id);return json({cancelled:true});}
  missing();
 }
 async response(owner,id) {
  const record=this.asset(owner,id);if(!record || record.state!=='ready' || !this.s.env.WORDLAB_IMAGES)missing();
  const image=await this.s.env.WORDLAB_IMAGES.get(record.object_key);if(!image)missing();
  return new Response(image.body,{headers:{'Content-Type':JSON.parse(record.metadata).type,'Content-Length':String(image.size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }
 async cleanup() {
  const s=this.s;if(!s.env.WORDLAB_IMAGES)return;
  s.sql.exec('DELETE FROM image_imports WHERE created < ?',s.now()-DAY);
  const cursor=s.saved('imageCleanupCursor') || {owner:'',id:''};
  let candidates=s.rows('SELECT * FROM image_assets WHERE created < ? AND (owner > ? OR (owner = ? AND id > ?)) ORDER BY owner,id LIMIT 20',s.now()-7*DAY,cursor.owner,cursor.owner,cursor.id);
  if(!candidates.length)candidates=s.rows('SELECT * FROM image_assets WHERE created < ? ORDER BY owner,id LIMIT 20',s.now()-7*DAY);
  for(const asset of candidates) {
   const removed=s.atomic(()=>{
    const protectedByImport=s.rows('SELECT value FROM image_imports WHERE owner = ?',asset.owner).some(r=>JSON.parse(r.value).includes(asset.id));
    const referenced=['teacher_sets','packs'].some(table=>s.rows('SELECT value FROM '+table+(table==='teacher_sets'?' WHERE owner = ?':''),...(table==='teacher_sets'?[asset.owner]:[]))
     .some(r=>{const value=JSON.parse(r.value);return (table==='teacher_sets' || (value.owner || 'operator')===asset.owner) && this.refs(value.pack).some(image=>image.id===asset.id);}));
    if(protectedByImport || referenced)return false;
    s.sql.exec("UPDATE image_assets SET state = 'deleting' WHERE owner = ? AND id = ?",asset.owner,asset.id);return true;
   });
   if(removed){await s.env.WORDLAB_IMAGES.delete(asset.object_key);s.sql.exec("DELETE FROM image_assets WHERE owner = ? AND id = ? AND state = 'deleting'",asset.owner,asset.id);}
   s.save('imageCleanupCursor',{owner:asset.owner,id:asset.id});
  }
 }
}
