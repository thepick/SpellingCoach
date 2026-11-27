const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const page=fs.readFileSync('src/page.html','utf8');

test('the normal workspace keeps word editing and practice rules in named disclosures',()=>{
 assert(/<details id="workspace-words-editor"/.test(page));
 assert(/<details id="shared-practice-options"/.test(page));
 assert(/<details id="vocab-more-actions"/.test(page));
 assert(!/<form id="teacher-keys-form"[\s\S]*?id="teacher-reload-sets"[\s\S]*?<\/form>/.test(page));
 assert(/id="tools-recovery"/.test(page));
});

test('student example sentences remain part of ordinary vocabulary review',()=>{
 assert(page.indexOf('id="vocab-examples"')<page.indexOf('id="vocab-advanced"'));
 assert(/id="vocab-review-content"/.test(page));
 assert(/id="vocab-word-next"/.test(page));
});

test('the combined generation action stays visible above the vocabulary disclosure',()=>{
 assert(page.indexOf('id="workspace-generation-slot"')<page.indexOf('id="workspace-vocabulary"'));
 assert.equal((page.match(/id="ai-generate"/g)||[]).length,1);
 assert.match(page,/id="ai-generate">Generate sentences and audio<\/button>/);
});
