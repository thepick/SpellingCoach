// Shared by the browser and Worker. Image bytes never belong in vocabulary JSON.
const MediaModel = (() => {
 const MB = 1024 * 1024;
 const limits = {original:10*MB, pixels:20000000, image:MB, edge:1600, set:50*MB, owner:250*MB, zip:50*MB, expanded:100*MB, entries:500};
 const fields = ['id','hash','type','width','height','size','alt','source','credit','license'];
 function validate(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).some(k=>!fields.includes(k)) ||
      !/^[a-f0-9]{64}$/.test(image.id) || image.hash !== image.id ||
      !['image/jpeg','image/png'].includes(image.type) ||
      !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width<1 || image.height<1 ||
      image.width>limits.edge || image.height>limits.edge || !Number.isInteger(image.size) || image.size<1 || image.size>limits.image) {
   throw Error('Invalid image metadata. Upload a JPEG, PNG, or WebP image again.');
  }
  for (const key of ['alt','source','credit','license']) if (image[key] !== undefined &&
      (typeof image[key] !== 'string' || image[key].length> (key==='source'?1000:300) || /[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(image[key]))) throw Error('Image descriptions and credits must be plain text.');
  return Object.fromEntries(fields.filter(k=>image[k]!==undefined).map(k=>[k,image[k]]));
 }
 function settings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!['display','tests'].includes(k)) ||
      !['practice','study','hidden'].includes(value.display) || typeof value.tests !== 'boolean') throw Error('Choose valid image display settings.');
  return {display:value.display,tests:value.tests};
 }
 function show(settings, context) {
  const value = settings || {display:'practice',tests:false};
  return context==='study' ? value.display!=='hidden' : context==='test' ? value.tests && value.display==='practice' : value.display==='practice';
 }
 return {limits,validate,settings,show};
})();
if (typeof module === 'object' && module.exports) module.exports = MediaModel;
