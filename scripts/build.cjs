const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const sources = ['media-model','vocabulary','imports','media', 'learning', 'generation-settings', 'state', 'dictation', 'coach', 'dictation-ui', 'teacher', 'shared-review'];
const zipWorkerSource = read('src/vendor/fflate.js')+'\n'+read('src/imports.js')+'\nonmessage = function(e){try{postMessage({files:TermImports.inflate(e.data,fflate)});}catch(error){postMessage({error:error.message});}}';
const modules = 'const ZIP_WORKER_SOURCE = '+JSON.stringify(zipWorkerSource)+';\n'+'const fflate = (()=>{const self={};'+read('src/vendor/fflate.js')+';return self.fflate;})();\n'+read('src/vendor/qrcode.js') + '\n' + sources.map(file => read('src/' + file + '.js')).join('\n');
const sample = JSON.stringify(JSON.parse(read('examples/weekly-vocabulary-sample.json'))).replace(/</g, '\\u003c');
const code = read('src/app.js')
  .replace('// BUILD:MODULES', () => 'const SAMPLE_PACK = ' + sample + ';\n' + modules)
  .replace('// BUILD:STARTUP', 'initCoach();initMediaUI();');
let page = read('src/page.html').replace('<!-- BUILD:STYLE -->', () => read('src/styles.css'))
  .replace('<!-- BUILD:SCRIPT -->', () => code)
  .replace('@@BRAND_ICON@@', () => fs.readFileSync(path.join(root, 'favicon.ico')).toString('base64'));
const buildId = createHash('sha256').update(page).digest('hex').slice(0,12);
page = page.replace('@@BUILD_ID@@',buildId);
const entry = (html, kind) => html.replace('<body>', `<body data-entry="${kind}">`);
const student = page.replace(/(<link rel="(?:icon|apple-touch-icon|manifest)"[^\n]*?href=")/g, '$1../');
const offline = page.replace(/^<link rel="(?:icon|apple-touch-icon|manifest)"[^\n]*\n/gm, '');
const outputs = { 'index.html': entry(page, 'teacher'), 'practice/index.html': entry(student, 'student'),
 'WordLab v0.2.0.html': entry(offline, 'offline') };
outputs['release.json'] = JSON.stringify({buildId,assets:Object.fromEntries(Object.entries(outputs).map(([file,content])=>
 [file,createHash('sha256').update(content).digest('hex')]))},null,2)+'\n';
for (const [file, contents] of Object.entries(outputs)) {
  const target = path.join(root, file);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || read(file) !== contents) throw Error(file + ' needs to be rebuilt');
  } else {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, contents);
  }
}
if (process.argv.includes('--stage')) {
  const stage = path.join(root, 'worker', '.wrangler', 'site');
  const assets = [...Object.keys(outputs), 'site.webmanifest', 'favicon.ico',
    ...fs.readdirSync(root).filter(file => /^(?:favicon-|apple-touch-icon|android-chrome-).*\.png$/.test(file))];
  for (const file of assets) {
    const target = path.join(stage, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(root, file), target);
  }
  const stagedAudio = path.join(stage, 'demo-audio');
  fs.rmSync(stagedAudio, {recursive: true, force: true});
  fs.cpSync(path.join(root, 'demo-audio'), stagedAudio, {recursive: true});
}
