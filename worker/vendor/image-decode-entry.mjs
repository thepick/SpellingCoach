// Bundled dependencies: jpeg-js 0.4.4 and fflate 0.8.2. See adjacent licenses.
import jpeg from 'jpeg-js';
import {Unzlib} from 'fflate';
function crc(bytes){let c=-1;for(const b of bytes){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^-1)>>>0;}
function png(bytes) {
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(bytes.length<45 || ![137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b) || v.getUint32(12)!==0x49484452)throw Error('PNG header');
 const width=v.getUint32(16),height=v.getUint32(20),depth=bytes[24],color=bytes[25];
 if(!width || !height || width>1600 || height>1600 || depth!==8 || ![2,6].includes(color) || bytes[26] || bytes[27] || bytes[28])throw Error('Re-encode this PNG before uploading.');
 const stride=width*(color===6?4:3)+1,expected=height*stride;let actual=0,ended=false,seenData=false,at=8;
 const inflate=new Unzlib((chunk,final)=>{if(actual+chunk.length>expected)throw Error('PNG expanded size');for(let i=0;i<chunk.length;i++)if((actual+i)%stride===0 && chunk[i]>4)throw Error('PNG filter');actual+=chunk.length;if(final && actual!==expected)throw Error('PNG truncated data');});
 while(at+12<=bytes.length) {
  const size=v.getUint32(at),kind=v.getUint32(at+4),end=at+8+size;
  if(end+4>bytes.length || crc(bytes.subarray(at+4,end))!==v.getUint32(end))throw Error('PNG chunk');
  if(kind===0x6163544c)throw Error('Animated PNG');
  if(kind===0x49444154){seenData=true;for(let i=at+8;i<end;i+=8192)inflate.push(bytes.subarray(i,Math.min(i+8192,end)),false);}
  if(kind===0x49454e44){if(size || !seenData)throw Error('PNG end');inflate.push(new Uint8Array(),true);ended=true;at=end+4;break;}
  at=end+4;
 }
 if(!ended || at!==bytes.length || actual!==expected)throw Error('PNG incomplete');return {width,height};
}
export function decodeImage(bytes,type) {
 if(type==='image/png')return png(bytes);
 if(type!=='image/jpeg' || bytes[0]!==255 || bytes[1]!==216 || bytes[bytes.length-2]!==255 || bytes[bytes.length-1]!==217)throw Error('JPEG header');
 const image=jpeg.decode(bytes,{useTArray:true,formatAsRGBA:false,tolerantDecoding:false,maxResolutionInMP:3,maxMemoryUsageInMB:64});
 if(!image.width || !image.height || image.width>1600 || image.height>1600)throw Error('JPEG dimensions');return {width:image.width,height:image.height};
}
