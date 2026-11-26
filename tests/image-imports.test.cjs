const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Imports=require('../src/imports.js');
const Model=require('../src/media-model.js');
const Vocabulary=require('../src/vocabulary.js');
const Learning=require('../src/learning.js');
const fflate=require('../src/vendor/fflate.js');
const image={id:'a'.repeat(64),hash:'a'.repeat(64),type:'image/png',width:120,height:80,size:200,alt:'Water rising from a dish'};
const record=word=>({id:'row-'+word,word,promptType:'definition',image,vocabulary:{senseId:'sense-'+word,partOfSpeech:'unknown',definition:'A change from liquid to vapor.',contentType:'definition',examples:[],clozeQuestions:[],meaningDistractors:[],acceptedSpellings:[],readingLevel:5,status:'approved'}});
const pack=()=>({kind:'spellingcoach-pack',v:2,id:'image-set',version:1,name:'Water',media:{display:'practice',tests:false},words:[record('evaporation')]});

test('structured imports preserve quoted commas, newlines, BOM, accents and blanks',()=>{
 const rows=Imports.table('\uFEFFterm,definition,image\r\n"café","A shop,\nwith drinks.",cafe.jpg\r\n',',');
 const guess=Imports.mapping(rows),[entry]=Imports.entries(rows,guess.map,guess.header);
 assert.equal(entry.term,'café');assert.equal(entry.definition,'A shop, with drinks.');assert.equal(entry.filename,'cafe.jpg');
 assert.throws(()=>Imports.table('term,"bad'),/Unclosed/);
});
test('headerless mapping and TSV remain explicit and do not consume an ordinary first term',()=>{
 const rows=Imports.table('meaning\tWhat something expresses.\nterm\tA name for something.');
 const m=Imports.mapping(rows);assert.equal(m.header,false);assert.equal(Imports.entries(rows,m.map,false).length,2);
 const header=Imports.mapping(Imports.table('word\tmeaning\tpicture'));assert.equal(header.header,true);assert.equal(header.map.image,2);
});
test('image matching uses paths and treats ambiguous basenames as an error',()=>{
 const files=[{name:'one/cloud.png'},{name:'two/cloud.png'}];
 assert.equal(Imports.match({term:'cloud',filename:'one/cloud.png'},files).file,files[0]);
 assert.match(Imports.match({term:'cloud',filename:'cloud.png'},files).error,/More than one/);
 assert.match(Imports.match({term:'cloud',filename:'https://x.test/cloud.png'},files).error,/Unsafe/);
 assert.equal(Imports.match({term:'cloud'},[{name:'cloud.png'}]).suggested,true);
});
test('ZIP streaming roundtrip checks CRC, sizes and rejects dangerous paths before inflation',()=>{
 const zipped=fflate.zipSync({'terms.csv':fflate.strToU8('term,definition\ncloud,A visible mass of droplets.'),'images/picture.png':new Uint8Array([1,2,3])});
 const result=new Map(Imports.inflate(zipped,fflate));assert.equal(fflate.strFromU8(result.get('terms.csv')).slice(0,4),'term');
 const unsafe=fflate.zipSync({'../picture.png':new Uint8Array([1])});assert.throws(()=>Imports.zipDirectory(unsafe),/Unsafe/);
 const nested=fflate.zipSync({'inner.zip':new Uint8Array([1])});assert.throws(()=>Imports.zipDirectory(nested),/unsupported/);
 const corrupted=fflate.zipSync({'terms.csv':[new Uint8Array([1,2,3]),{level:0}]});corrupted[39]^=1;assert.throws(()=>Imports.inflate(corrupted,fflate));
});
test('v2 metadata survives validation and v1 reader compatibility remains intact',()=>{
 const value=Vocabulary.validatePack(pack());assert.deepEqual(value,pack());
 assert.throws(()=>Vocabulary.validatePack({...pack(),v:1}),/unexpected|version 2/);
 assert.throws(()=>Vocabulary.validatePack({...pack(),words:Array.from({length:201},(_,i)=>record('term'+i))}),/200/);
 assert.throws(()=>Model.validate({...image,type:'image/svg+xml'}),/Invalid/);
 assert.throws(()=>Model.validate({...image,width:1601}),/Invalid/);
});
test('image-only pack updates preserve vocabulary progress classification',()=>{
 const previous=pack(),next=pack();next.version=2;next.words[0].image={...image,alt:'A bowl of water'};
 const plan=Vocabulary.planPackUpdate(previous,next);assert.deepEqual(plan.unchangedWords,['evaporation']);assert.deepEqual(plan.changedWords,[]);
});
test('definition-only imported packs complete exactly the three existing stages',()=>{
 const rows=[record('evaporation'),{...record('condensation'),vocabulary:{...record('condensation').vocabulary,definition:'A change from vapor to liquid.'}}];
 const s=Learning.createSession(rows,{mode:'mixed',sequentialPractice:true}),types=[];
 while(Learning.current(s)){types.push(Learning.current(s).type);Learning.submit(s,Learning.current(s).answer);Learning.advance(s);assert(Learning.sessionOK(JSON.parse(JSON.stringify(s))));}
 assert.deepEqual(types,['dictation','dictation','word-bank','word-bank','definition-recall','definition-recall']);assert(Learning.practiceMastered(s));
 assert.deepEqual(Learning.practiceAudioPrompts(rows[0],0).map(r=>r.skill),['spelling','vocabulary']);
 const enriched={...rows[0],vocabulary:{...rows[0].vocabulary,clozeQuestions:[{id:'q1',sentence:'Water changes through _____.',answer:'evaporation',explanation:''}]}};
 assert.equal(Learning.practiceAudioPrompts(enriched,0)[1].text,rows[0].vocabulary.definition);
});
test('display rules separate study, practice and tests',()=>{
 assert(Model.show({display:'study',tests:true},'study'));assert(!Model.show({display:'study',tests:true},'practice'));
 assert(!Model.show({display:'practice',tests:false},'test'));assert(Model.show({display:'practice',tests:true},'test'));
 assert(!Model.show({display:'hidden',tests:true},'study'));
});
test('loadVocabulary and outputPack retain images, IDs, prompt preference and settings',async()=>{
 const value=pack(),list={id:'local',packId:value.id,packVersion:1,name:value.name,words:['evaporation'],defs:{},vocabKey:'local',media:value.media};
 const context=vm.createContext({Vocabulary,Dictation:{canonicalPackId:x=>x},studentPreview:false,KEY:'spell.teacher:a',structuredClone});
 vm.runInContext(fs.readFileSync('src/coach.js','utf8'),context);context.list=list;context.rows=value.words;
 vm.runInContext('getStore=async()=>({get:async()=>rows});',context);
 assert.deepEqual(JSON.parse(JSON.stringify(await vm.runInContext('loadVocabulary(list).then(rows=>outputPack(list,rows))',context))),value);
});
test('the built guide includes the complete CSV/image instructions and usable download controls',()=>{
 const html=fs.readFileSync('src/page.html','utf8');
 for(const text of ['CSV format and adding images','image_alt','images/evaporation.png','Download CSV template','Download example ZIP with images','Use filenames rather than web links'])assert(html.includes(text));
 assert(html.includes('id="learning-definition-card"'));assert(html.includes('id="study-definition-card"'));
});
test('question renderer hides pictures during spelling and follows snapshotted image rules',()=>{
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{children:[],hidden:false,replaceChildren(){this.children=[];},append(x){this.children.push(x);},classList:{toggle(){}}});return nodes.get(id);};
 const context=vm.createContext({MediaModel:Model,$:get,state:{lists:[{id:'local'}]},KEY:'student'});
 vm.runInContext(fs.readFileSync('src/media.js','utf8'),context);
 vm.runInContext('pictureButton=(image,list,context)=>({id:image.id,context});',context);context.entry={listId:'local',session:{type:'practice',media:{display:'practice',tests:false},records:[record('evaporation')]}};
 context.question={type:'dictation',recordIndex:0};vm.runInContext('renderQuestionImage(entry,question)',context);assert.equal(get('learning-picture').hidden,true);
 context.question.type='definition-recall';vm.runInContext('renderQuestionImage(entry,question)',context);assert.equal(get('learning-picture').children[0].id,image.id);
 context.entry.session.type='test';vm.runInContext('renderQuestionImage(entry,question)',context);assert.equal(get('learning-picture').hidden,true);
 context.entry.session.media.tests=true;vm.runInContext('renderQuestionImage(entry,question)',context);assert.equal(get('learning-picture').hidden,false);
 assert.equal(vm.runInContext("imageAnswerLeak('An evaporation diagram','evaporation')",context),true);
 assert.equal(vm.runInContext("imageAnswerLeak('A glass of water','gas')",context),false);
});
