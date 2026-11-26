const fs=require('node:fs');
const {createHash}=require('node:crypto');
const assert=require('node:assert/strict');
const expected=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../release.json'),'utf8'));

(async()=>{
 const root='https://wordlab.mtomlinson.ca/';
 const manifest=await fetch(root+'release.json?build='+expected.buildId,{cache:'no-store',signal:AbortSignal.timeout(30000)});
 assert(manifest.ok,'Live release manifest is unavailable');
 assert.equal((await manifest.json()).buildId,expected.buildId,'Live site is running a different build');
 for(const [file,hash] of Object.entries(expected.assets)) {
  const response=await fetch(root+encodeURI(file)+'?build='+expected.buildId,{cache:'no-store',signal:AbortSignal.timeout(30000)});
  assert(response.ok,'Could not load '+file);
  const actual=createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  assert.equal(actual,hash,'Live asset differs from tested build: '+file);
 }
 const health=await fetch(root+'api/health',{cache:'no-store',signal:AbortSignal.timeout(30000)});
 assert(health.ok,'Live API health check failed');
 const healthBody=await health.json();
 assert.equal(healthBody.ok,true,'Live API reported unhealthy status');
 assert.equal(healthBody.apiVersion,1,'Live API version is incompatible');
 console.log('Live teacher, student and offline pages match build '+expected.buildId+'. API health passed.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
