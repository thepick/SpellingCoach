const assert = require('node:assert/strict');
const test = require('node:test');
const { reviewMode, matchingPractice, sharingContent } = require('../src/shared-review.js');

test('shared reviews honor the assigned mode and handle older and spelling-only packs', () => {
 const vocab = [{word:'contract',vocabulary:{definition:'An agreement.'}}];
 const spelling = [{word:'contract',vocabulary:null}];
 assert.equal(reviewMode('vocabulary', vocab), 'vocabulary');
 assert.equal(reviewMode('spelling', vocab), 'spelling');
 assert.equal(reviewMode(null, vocab), 'mixed');
 assert.equal(reviewMode('vocabulary', spelling), 'spelling');
});

test('sharing readiness distinguishes drafts, approved vocabulary, and words without definitions', () => {
 const rows = [{word:'solid', vocabulary:{status:'approved'}}, {word:'melt', vocabulary:{status:'draft'}}, {word:'gas', vocabulary:null}];
 const mixed = sharingContent(rows, 'mixed');
 assert.equal(mixed.ready, false);
 assert.deepEqual(mixed.drafts, ['melt']);
 assert.deepEqual(mixed.approved, ['solid']);
 assert.deepEqual(mixed.missing, ['gas']);
 const spelling = sharingContent(rows, 'spelling');
 assert.equal(spelling.ready, true);
 assert.equal(spelling.words[1].vocabulary, null);
 assert.equal(sharingContent([rows[2]], 'mixed').ready, false);
 assert.equal(sharingContent([rows[0], rows[2]], 'vocabulary').ready, true);
});

test('Continue practice only matches an unfinished practice for the same list', () => {
 const entry = {listId:'x',session:{type:'practice',status:'active'}};
 assert.equal(matchingPractice({learningSession:entry}, 'x'), 'learning');
 assert.equal(matchingPractice({learningSession:entry}, 'y'), null);
 assert.equal(matchingPractice({learningSession:{...entry,session:{...entry.session,status:'finished'}}}, 'x'), null);
 assert.equal(matchingPractice({learningSession:{...entry,session:{...entry.session,type:'test'}}}, 'x'), null);
 assert.equal(matchingPractice({session:{listId:'x',phase:'paused'}}, 'x'), 'spelling');
 assert.equal(matchingPractice({session:{listId:'x',phase:'paused'}}, 'x', 'mixed'), null);
 assert.equal(matchingPractice({learningSession:{...entry,session:{...entry.session,mode:'mixed'}}}, 'x', 'vocabulary'), null);
});
