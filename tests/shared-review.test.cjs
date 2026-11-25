const assert = require('node:assert/strict');
const test = require('node:test');
const { reviewMode, matchingPractice } = require('../src/shared-review.js');

test('shared reviews honor the assigned mode and handle older and spelling-only packs', () => {
 const vocab = [{word:'contract',vocabulary:{definition:'An agreement.'}}];
 const spelling = [{word:'contract',vocabulary:null}];
 assert.equal(reviewMode('vocabulary', vocab), 'vocabulary');
 assert.equal(reviewMode('spelling', vocab), 'spelling');
 assert.equal(reviewMode(null, vocab), 'mixed');
 assert.equal(reviewMode('vocabulary', spelling), 'spelling');
});

test('Continue practice only matches an unfinished practice for the same list', () => {
 const entry = {listId:'x',session:{type:'practice',status:'active'}};
 assert.equal(matchingPractice({learningSession:entry}, 'x'), 'learning');
 assert.equal(matchingPractice({learningSession:entry}, 'y'), null);
 assert.equal(matchingPractice({learningSession:{...entry,session:{...entry.session,status:'finished'}}}, 'x'), null);
 assert.equal(matchingPractice({learningSession:{...entry,session:{...entry.session,type:'test'}}}, 'x'), null);
 assert.equal(matchingPractice({session:{listId:'x',phase:'paused'}}, 'x'), 'spelling');
});
