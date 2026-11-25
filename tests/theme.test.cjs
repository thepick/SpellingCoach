const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadTheme(saved, dark) {
 const html = fs.readFileSync('index.html', 'utf8');
 const script = html.match(/<script id="theme-preferences">([\s\S]*?)<\/script>/);
 assert.ok(script, 'The theme controller runs before the stylesheet');
 const data = {};
 let handleChange;
 const media = {matches: dark, addEventListener: (type, callback) => {
  assert.equal(type, 'change');
  handleChange = callback;
 }};
 const context = {document: {documentElement: {dataset: data}}, window: {matchMedia: query => {
  assert.equal(query, '(prefers-color-scheme: dark)');
  return media;
 }}, localStorage: {getItem: () => saved, setItem: (key, value) => { saved = value; }},
 location: {search: ''}, URLSearchParams};
 vm.runInNewContext(script[1] + '\nthis.theme = themePreference;', context);
 return {data, theme: context.theme, saved: () => saved, change(dark) { media.matches = dark; handleChange(); }};
}

test('system theme is the default and updates when the device changes', () => {
 const app = loadTheme(null, true);
 assert.equal(app.theme.value, 'system');
 assert.equal(app.data.theme, 'dark');
 app.change(false);
 assert.equal(app.data.theme, 'light');
});

test('manual choices survive device changes and System restores automatic matching', () => {
 const app = loadTheme('dark', false);
 assert.equal(app.data.theme, 'dark');
 app.change(true);
 app.theme.set('light');
 app.change(true);
 assert.equal(app.data.theme, 'light');
 assert.equal(app.saved(), 'light');
 app.theme.set('system');
 assert.equal(app.data.theme, 'dark');
 assert.equal(app.saved(), 'system');
});

test('both builds embed the original icon and expose all theme choices', () => {
 const favicon = fs.readFileSync('favicon.ico');
 for (const file of ['index.html', 'Spelling Coach v0.2.0.html']) {
  const html = fs.readFileSync(file, 'utf8');
  const icon = html.match(/class="brand-icon" src="data:image\/x-icon;base64,([^"]+)"/);
  assert.ok(icon, file + ' embeds the icon');
  assert.deepEqual(Buffer.from(icon[1], 'base64'), favicon);
  assert.match(html, /id="theme-select"[\s\S]*?<option value="system">System<\/option><option value="light">Light<\/option><option value="dark">Dark<\/option>/);
 }
});
