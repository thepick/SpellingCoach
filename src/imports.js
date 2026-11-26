const TermImports = (() => {
 const norm = value => String(value || '').normalize('NFC').trim();
 const termKey = value => norm(value).replace(/\s+/g,' ').toLowerCase();
 const aliases = {term:['term','word','terms','words'],definition:['definition','meaning','definitions'],image:['image','picture','filename','image_filename'],alt:['image_alt','alt','description'],pos:['part_of_speech','pos'],source:['image_source','source'],credit:['image_credit','credit'],license:['image_license','license']};
 function table(text, delimiter) {
  text=String(text).replace(/^\uFEFF/,'');
  if (text.length>4*1024*1024) throw Error('The terms file must be 4 MB or smaller.');
  delimiter=delimiter || (text.split(/\r?\n/,1)[0].includes('\t')?'\t':',');
  let rows=[], row=[], value='', quoted=false, closed=false;
  for(let i=0;i<text.length;i++) {
   const c=text[i];
   if(quoted) {if(c==='"' && text[i+1]==='"'){value+='"';i++;}else if(c==='"'){quoted=false;closed=true;}else value+=c;}
   else if(c==='"'){if(value||closed)throw Error('Unexpected quote near row '+(rows.length+1)+'.');quoted=true;}
   else if(c===delimiter){row.push(value);value='';closed=false;}
   else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(x=>x.trim()))rows.push(row);row=[];value='';closed=false;}
   else {if(closed && c.trim())throw Error('Unexpected text after a quoted cell.');value+=c;}
  }
  if(quoted)throw Error('Unclosed quote in the terms file.');
  row.push(value);if(row.some(x=>x.trim()))rows.push(row);
  if(!rows.length)throw Error('The terms file is empty.');
  if(rows.length>1001 || rows.some(r=>r.length>30))throw Error('The import has too many rows or columns.');
  return rows;
 }
 function mapping(rows) {
  const first=rows[0].map(x=>termKey(x).replace(/\s+/g,'_')), map={};
  for(const [key,values]of Object.entries(aliases))map[key]=first.findIndex(x=>values.includes(x));
  const header=map.term>=0 && map.definition>=0;
  if(!header)Object.assign(map,{term:0,definition:rows[0].length>1?1:-1,image:rows[0].length>2?2:-1,alt:-1,pos:-1,source:-1,credit:-1,license:-1});
  return {header,map};
 }
 function entries(rows,map,header) {
  return rows.slice(header?1:0).map((cells,index)=>{
   const get=key=>norm(cells[map[key]]).replace(/\s+/g,' ');
   return {row:index+(header?2:1),term:get('term'),definition:get('definition'),filename:get('image'),alt:get('alt'),pos:get('pos'),source:get('source'),credit:get('credit'),license:get('license'),include:true};
  });
 }
 function path(value) {
  const name=norm(value).replace(/\\/g,'/');
  if(!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(x=>x==='..'||x==='.'||!x) || /[\x00-\x1f]/.test(name))throw Error('Unsafe image or ZIP filename.');
  return name;
 }
 function match(entry,files) {
  if(entry.filename) {
   let requested;try{requested=path(entry.filename);}catch(e){return {error:e.message};}
   const exact=files.filter(f=>f.name===requested);
   if(exact.length===1)return {file:exact[0]};
   const base=files.filter(f=>f.name.split('/').pop()===requested);
   if(base.length===1)return {file:base[0]};
   return {error:base.length>1?'More than one image has this filename. Choose one.':'Image file not found: '+requested};
  }
  const candidates=files.filter(f=>termKey(f.name.split('/').pop().replace(/\.[^.]+$/,''))===termKey(entry.term));
  return candidates.length===1?{file:candidates[0],suggested:true}:candidates.length>1?{error:'Several images match this term. Choose one.'}:{};
 }
 // Check the central directory before any decompression. Actual output is bounded again below.
 function zipDirectory(bytes) {
  if(bytes.length>50*1024*1024)throw Error('ZIP files must be 50 MB or smaller.');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(v.getUint32(i,true)===0x06054b50 && i+22+v.getUint16(i+20,true)===bytes.length){end=i;break;}
  if(end<0 || v.getUint16(end+4,true) || v.getUint16(end+6,true))throw Error('Choose a complete, single ZIP archive.');
  const count=v.getUint16(end+10,true),size=v.getUint32(end+12,true),start=v.getUint32(end+16,true);
  if(count>500 || count===65535 || start+size!==end || v.getUint16(end+8,true)!==count)throw Error('Unsupported or oversized ZIP directory.');
  const entries=new Map();let at=start,total=0;
  for(let i=0;i<count;i++) {
   if(at+46>end || v.getUint32(at,true)!==0x02014b50)throw Error('Invalid ZIP directory.');
   const flags=v.getUint16(at+8,true),method=v.getUint16(at+10,true),expanded=v.getUint32(at+24,true),length=v.getUint16(at+28,true),extra=v.getUint16(at+30,true),comment=v.getUint16(at+32,true);
   const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(at+46,at+46+length));
   const directory=name.endsWith('/');const normalized=path(directory?name.slice(0,-1):name);
   const type=(v.getUint32(at+38,true)>>>16)&0xf000;
   if(flags&1 || ![0,8].includes(method) || type===0xa000 || entries.has(normalized) || /\.(zip|7z|rar)$/i.test(name) || expanded>10*1024*1024)throw Error('ZIP contains an unsupported, duplicate, or oversized file.');
   total+=expanded;if(total>100*1024*1024)throw Error('ZIP expands beyond 100 MB.');
   if(!directory)entries.set(normalized,{size:expanded,crc:v.getUint32(at+16,true)});
   at+=46+length+extra+comment;
  }
  if(at!==end)throw Error('Invalid ZIP directory size.');
  return entries;
 }
 function crc32(bytes) {let c=-1;for(const b of bytes){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^-1)>>>0;}
 function inflate(bytes, codec) {
  const directory=zipDirectory(bytes), output=new Map();let total=0, failure;
  const unzip=new codec.Unzip(file=>{
   if(file.name.endsWith('/'))return;
   const name=path(file.name), expected=directory.get(name);
   if(!expected || output.has(name))throw Error('ZIP files do not match its directory.');
   const parts=[];let size=0;
   file.ondata=(error,data,final)=>{
    if(error)throw error;size+=data.length;total+=data.length;
    if(size>expected.size || total>100*1024*1024){file.terminate();throw Error('ZIP expanded beyond its declared size.');}
    parts.push(data);
    if(final){const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
     if(size!==expected.size || crc32(bytes)!==expected.crc)throw Error('ZIP contains a damaged file: '+name);output.set(name,bytes);}
   };file.start();
  });
  unzip.register(codec.UnzipInflate);
  try{for(let i=0;i<bytes.length;i+=8192)unzip.push(bytes.subarray(i,i+8192),i+8192>=bytes.length);}catch(e){failure=e;}
  if(failure)throw failure;if(output.size!==directory.size)throw Error('ZIP is incomplete.');return [...output];
 }
 function unpack(bytes) {
  zipDirectory(bytes);
  if(typeof Worker==='undefined' || typeof ZIP_WORKER_SOURCE==='undefined')return Promise.resolve(inflate(bytes,fflate));
  return new Promise((resolve,reject)=>{
   const url=URL.createObjectURL(new Blob([ZIP_WORKER_SOURCE],{type:'text/javascript'})),worker=new Worker(url);
   const done=()=>{worker.terminate();URL.revokeObjectURL(url);clearTimeout(timer);};
   const timer=setTimeout(()=>{done();reject(Error('ZIP import took too long. Try a smaller package.'));},60000);
   worker.onerror=()=>{done();reject(Error('The ZIP could not be opened.'));};
   worker.onmessage=e=>{done();if(e.data.error)reject(Error(e.data.error));else resolve(e.data.files);};worker.postMessage(bytes,[bytes.buffer]);
  });
 }
 return {table,mapping,entries,path,match,zipDirectory,inflate,unpack,crc32};
})();
if (typeof module === 'object' && module.exports) module.exports = TermImports;
