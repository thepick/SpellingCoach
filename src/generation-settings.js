const GenerationSettings = (() => {
 function defaults(grade=5) {
  return {readingLevel:grade,dialect:'original',practiceSentences:1,exampleSentences:1,
   reuseApproved:true,esl:true,distractors:true,explanations:true,context:'',sense:''};
 }
 function validate(value,preset=false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const integer=(key,min,max)=>Number.isInteger(value[key]) && value[key]>=min && value[key]<=max;
  if (!integer('readingLevel',1,12) || !integer('practiceSentences',1,5) || !integer('exampleSentences',1,2) ||
      !['original','american','british','canadian'].includes(value.dialect)) return null;
  for (const key of ['reuseApproved','esl','distractors','explanations']) if (typeof value[key] !== 'boolean') return null;
  for (const [key,max] of [['context',1000],['sense',160]]) if (typeof value[key] !== 'string' || [...value[key]].length>max || /[<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value[key])) return null;
  const clean={};
  for (const key of Object.keys(defaults())) clean[key]=value[key];
  clean.context=preset?'':clean.context.trim(); clean.sense=preset?'':clean.sense.trim();
  return clean;
 }
 function presets() { return Object.fromEntries(Array.from({length:10},(_,index)=>{const grade=index+3;return [grade,defaults(grade)];})); }
 return {defaults,validate,presets};
})();
if (typeof module === 'object' && module.exports) module.exports=GenerationSettings;
