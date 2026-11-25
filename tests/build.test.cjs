const fs = require("node:fs");
const assert = require("node:assert/strict");
const html = fs.readFileSync("index.html", "utf8");
assert.match(html, /id="learning-mode"/);
assert.match(html, /spell\.state\.v1\.backup/);
assert.match(html, /id="learning-screen"/);
assert.ok(fs.existsSync("Spelling Coach v0.2.0.html"));
