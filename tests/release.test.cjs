const test=require('node:test');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');

test('release manifest identifies all current entry pages and their exact generated contents',()=>{
 const release=JSON.parse(fs.readFileSync('release.json','utf8'));
 assert.match(release.buildId,/^[a-f0-9]{12}$/);
 assert.deepEqual(Object.keys(release.assets),['index.html','practice/index.html','WordLab v0.2.0.html']);
 for(const [file,hash] of Object.entries(release.assets)) {
  const html=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
  assert.equal(createHash('sha256').update(html).digest('hex'),hash,file);
  assert(html.includes('Build '+release.buildId));
  assert(!/id="(?:pin-entry|pin-overlay|pin-check)"/.test(html));
 }
});
