const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const sources = ['vocabulary', 'learning', 'state', 'dictation', 'coach', 'dictation-ui', 'teacher'];
const modules = read('src/vendor/qrcode.js') + '\n' + sources.map(file => read('src/' + file + '.js')).join('\n');
const sample = JSON.stringify(JSON.parse(read('examples/weekly-vocabulary-sample.json'))).replace(/</g, '\\u003c');
const code = read('src/app.js')
  .replace('// BUILD:MODULES', () => 'const SAMPLE_PACK = ' + sample + ';\n' + modules)
  .replace('// BUILD:STARTUP', 'initCoach();');
const page = read('src/page.html').replace('<!-- BUILD:STYLE -->', () => read('src/styles.css'))
  .replace('<!-- BUILD:SCRIPT -->', () => code)
  .replace('@@BRAND_ICON@@', () => fs.readFileSync(path.join(root, 'favicon.ico')).toString('base64'));
const offline = page.replace(/^<link rel="(?:icon|apple-touch-icon|manifest)"[^\n]*\n/gm, '');
const outputs = { 'index.html': page, 'WordLab v0.2.0.html': offline };
for (const [file, contents] of Object.entries(outputs)) {
  const target = path.join(root, file);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || read(file) !== contents) throw Error(file + ' needs to be rebuilt');
  } else fs.writeFileSync(target, contents);
}
