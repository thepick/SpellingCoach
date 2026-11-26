const fs = require("node:fs");
const assert = require("node:assert/strict");
const html = fs.readFileSync("index.html", "utf8");
assert.match(html, /id="learning-mode"/);
assert.match(html, /spell\.state\.v1\.backup/);
assert.match(html, /id="learning-screen"/);
assert.ok(fs.existsSync("WordLab v0.2.0.html"));
const manifest = JSON.parse(fs.readFileSync('site.webmanifest', 'utf8'));
assert.equal(manifest.name, 'WordLab');
assert.equal(manifest.short_name, 'WordLab');
assert.equal(fs.readFileSync('CNAME', 'utf8').trim(), 'wordlab.mtomlinson.ca');
assert.ok(html.includes('<title>WordLab</title>'));
assert.match(html, /id="tools-version"[^>]*>WordLab v0\.2\.0</);
assert.ok(fs.existsSync('WordLab v0.2.0.html'));
assert.match(html, /<body data-entry="teacher">/);
assert.match(html, /id="teacher-signin-screen"/);
assert.match(html, /id="ai-preview"/);
assert.match(fs.readFileSync('practice/index.html', 'utf8'), /<body data-entry="student">/);
assert.match(fs.readFileSync('WordLab v0.2.0.html', 'utf8'), /<body data-entry="offline">/);

const parentPIN = /\b(?:pin-entry|pin-overlay|pin-form|pin-check|pin-error|cancel-pin|reset-pin|parent-pin-help|local-pin-setting)\b|\b(?:state\.settings|x)\.pin\b|Parent access PIN|Forgot PIN/i;
for (const file of ['src/app.js', 'src/page.html', 'src/styles.css', 'index.html', 'practice/index.html', 'WordLab v0.2.0.html']) {
 assert.doesNotMatch(fs.readFileSync(file,'utf8'), parentPIN, file + ' contains an obsolete parent PIN control or handler');
}
