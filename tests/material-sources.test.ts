import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {importTextSource,importVttSource,importOcrSource,validateMaterialSource,MaterialSourceError} from '../src/materials/sources.js';
import type {SourceOptions} from '../src/materials/types.js';

const options:SourceOptions={id:'source-1',label:'合成采购材料',role:'procurement'};
const hash=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const invalid=(error:unknown)=>error instanceof MaterialSourceError&&error.code!=='UNIMPLEMENTED';
const cue=(start='00:01.000',end='00:02.000',text='名称：显示器')=>`${start} --> ${end}\n${text}`;
const vtt=(...cues:string[])=>`WEBVTT\n\n${cues.join('\n\n')}`;
const ocr=()=>({schema:'office-document-analysis-v1',provider:{name:'synthetic',version:'1',kind:'fixture'},original:{sha256:'a'.repeat(64),pages:2},spans:[{id:'p2-box',page:2,bbox:[0.1,0.2,0.3,0.4],text:'数量：3台'}]});

test('text preserves original content and hashes the raw UTF-8 input',async()=>{
  const text='  名称：显示器\r\n数量：3台  ';
  const source=await importTextSource(text,options);
  assert.equal(source.spans.map(span=>span.text).join(''),text);
  assert.equal(source.contentHash,hash(text));assert.equal(source.kind,'text');
  assert.equal(source.fixture,false);assert.equal(source.originalVerified,false);
});
test('text splits evidence into bounded stable spans without truncating',async()=>{
  const text=('文'.repeat(499)+'\n').repeat(8);const source=await importTextSource(text,options);
  assert.equal(source.spans.length,8);assert.equal(source.spans.map(span=>span.text).join(''),text);
  assert.equal(new Set(source.spans.map(span=>span.id)).size,8);
  assert.deepEqual((await importTextSource(text,options)).spans,source.spans);
});
test('text rejects empty and oversized input',async()=>{
  for(const text of ['', '  \n', '文'.repeat(4001)])await assert.rejects(importTextSource(text,options),invalid);
});
test('text splitting preserves whitespace sections without rejecting valid material',async()=>{
  const text='A'.repeat(499)+'\n'+' '.repeat(499)+'\n'+'B'.repeat(500);
  const source=await importTextSource(text,options);
  assert.equal(source.spans.map(span=>span.text).join(''),text);
});
test('text splitting never splits a Unicode surrogate pair across evidence spans',async()=>{
  const text='字'.repeat(498)+'😀\r\n'+'字'.repeat(20);const source=await importTextSource(text,options);
  assert.equal(source.spans.map(span=>span.text).join(''),text);
  for(const span of source.spans)assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(span.text));
});
test('default identity distinguishes identical content with different roles and labels',async()=>{
  const raw='名称：显示器\n数量：3\n';
  const contract=await importTextSource(raw,{label:'合成文件',role:'contract'});
  const order=await importTextSource(raw,{label:'合成文件',role:'order'});
  const anotherContract=await importTextSource(raw,{label:'另一合同',role:'contract'});
  assert.equal(new Set([contract.id,order.id,anotherContract.id]).size,3);
  assert.equal(contract.contentHash,order.contentHash);assert.equal(contract.contentHash,anotherContract.contentHash);
  assert.equal((await importTextSource(raw,{label:'合成文件',role:'contract'})).id,contract.id);
  assert.equal((await importTextSource(raw,{...options,id:'manual-id'})).id,'manual-id');
});
test('text evidence keeps a field and its complete value together near a span boundary',async()=>{
  const field='数量：1234';const raw='说明：'+'甲'.repeat(491)+'\r\n'+field+'\r\n名称：显示器';
  const source=await importTextSource(raw,options);
  assert.equal(source.spans.map(span=>span.text).join(''),raw);
  assert.equal(source.spans.filter(span=>span.text.includes(field)).length,1);
  assert.ok(source.spans.every(span=>span.text.length<=500));
});
test('text preserves quantity 10 as one complete line at the reported 500-unit boundary',async()=>{
  const raw='注'.repeat(495)+'\n数量：10\n物品：Part\n单位：pcs\n币种：USD\n总额：10';
  const source=await importTextSource(raw,options);
  assert.equal(source.spans.map(span=>span.text).join(''),raw);
  assert.equal(source.spans.filter(span=>span.text.includes('数量：10\n')).length,1);
  assert.ok(!source.spans.some(span=>span.text.endsWith('数量：1')));
});
test('text rejects oversized logical lines instead of making partial field evidence',async()=>{
  const raw='名称：'+'甲'.repeat(498)+'\n数量：3';
  await assert.rejects(importTextSource(raw,options),(error:unknown)=>error instanceof MaterialSourceError&&error.code==='CAPACITY_EXCEEDED');
});
test('text preserves CRLF after an exactly 500-unit line without splitting the next field',async()=>{
  const raw='甲'.repeat(500)+'\r\n数量：1234\r名称：显示器\n';const source=await importTextSource(raw,options);
  assert.equal(source.spans.map(span=>span.text).join(''),raw);
  assert.equal(source.spans.filter(span=>span.text.includes('数量：1234')).length,1);
});
test('options reject empty labels, long ids, unknown roles and extra fields',async()=>{
  for(const bad of [{...options,label:' '},{...options,label:'x'.repeat(121)},{...options,id:'x'.repeat(81)},{...options,role:'approve'},{...options,externalUrl:'https://example.com'}]){
    await assert.rejects(importTextSource('材料',bad as SourceOptions),invalid);
  }
});
test('VTT consumes BOM, CRLF, identifiers, settings, multiline and metadata safely',async()=>{
  const raw='\ufeffWEBVTT synthetic\r\n\r\nNOTE text\r\nignored\r\n\r\nSTYLE\r\n::cue {background:url(https://example.com)}\r\n\r\nREGION\r\nid:r\r\n\r\nc-1\r\n01:02.003 --> 01:03.004 region:r align:start\r\n<v 李><b>名称：显示器</b>\r\n数量：3台\r\n';
  const source=await importVttSource(raw,options);
  assert.equal(source.contentHash,hash(raw));assert.equal(source.spans.length,1);
  assert.equal(source.spans[0]!.text,'名称：显示器\n数量：3台');
  assert.equal(source.spans[0]!.startMs,62003);assert.equal(source.spans[0]!.endMs,63004);
  assert.equal(source.kind,'vtt');assert.equal(source.fixture,false);
});
test('VTT retains overlap, same-start cues, repeated cue identifiers and repeated content',async()=>{
  const source=await importVttSource(vtt('same\n'+cue('00:01.000','00:05.000','A'),'same\n'+cue('00:01.000','00:02.000','A'),cue('00:02.000','00:06.000','B')),options);
  assert.deepEqual(source.spans.map(s=>[s.startMs,s.endMs,s.text]),[[1000,5000,'A'],[1000,2000,'A'],[2000,6000,'B']]);
  assert.equal(new Set(source.spans.map(s=>s.id)).size,3);
});
test('VTT supports hours exceeding two digits',async()=>{
  const source=await importVttSource(vtt(cue('100:00:01.123','100:00:02.456')),options);
  assert.equal(source.spans[0]!.startMs,360001123);assert.equal(source.spans[0]!.endMs,360002456);
});
test('VTT strips markup without losing spoken content or executing HTML',async()=>{
  const source=await importVttSource(vtt(cue(undefined,undefined,'<img src="https://example.com" onerror="alert(1)">名称：<b>屏幕</b> <script>alert(1)</script> &amp; &lt;literal&gt;')),options);
  assert.equal(source.spans[0]!.text,'名称：屏幕 alert(1) & <literal>');
  assert.ok(!source.spans[0]!.text.includes('onerror'));assert.ok(!source.spans[0]!.text.includes('https://'));
});
for(const [name,start,end] of [['zero duration','00:01.000','00:01.000'],['reversed duration','00:02.000','00:01.000'],['invalid minutes','60:00.000','61:00.000'],['invalid seconds','00:60.000','01:00.001'],['missing fraction','00:01','00:02'],['one-digit hours','1:00:00.000','1:00:01.000'],['overflow hours','999999999999999999:00:00.000','999999999999999999:00:01.000']] as const){
  test(`VTT rejects ${name}`,async()=>{await assert.rejects(importVttSource(vtt(cue(start,end)),options),invalid);});
}
test('VTT rejects start-time regression even when previous cue is shorter',async()=>{
  await assert.rejects(importVttSource(vtt(cue('00:02.000','00:03.000'),cue('00:01.000','00:04.000')),options),invalid);
});
test('VTT rejects invalid headers and malformed cue blocks',async()=>{
  for(const raw of ['WEBVTTbad\n\n'+cue(),'WEBVTT --> invalid\n\n'+cue(),'WEBVTT\n'+cue(),vtt('identifier\nnot a timing\ntext'),vtt('00:01.000-->00:02.000\ntext'),vtt('NOTEonly\ntext'),vtt(cue(undefined,undefined,''))])await assert.rejects(importVttSource(raw,options),invalid);
});
test('VTT rejects excess evidence instead of silently truncating',async()=>{
  await assert.rejects(importVttSource(vtt(...Array.from({length:41},()=>cue())),options),invalid);
  await assert.rejects(importVttSource(vtt(cue(undefined,undefined,'x'.repeat(501))),options),invalid);
  await assert.rejects(importVttSource(vtt(...Array.from({length:9},()=>cue(undefined,undefined,'x'.repeat(500)))),options),invalid);
});
test('OCR retains page and region, hashes raw JSON, and marks fixture engine honestly',async()=>{
  const raw=JSON.stringify(ocr(),null,2);const source=await importOcrSource(raw,options);
  assert.equal(source.kind,'ocr');assert.equal(source.fixture,true);assert.equal(source.originalVerified,false);
  assert.equal(source.engine,'fixture:synthetic@1');assert.equal(source.originalHash,'a'.repeat(64));
  assert.equal(source.contentHash,hash(raw));assert.deepEqual(source.spans,ocr().spans);
});
test('OCR only marks optional original hash matching; mismatches and malformed hashes reject',async()=>{
  const raw=JSON.stringify(ocr());assert.equal((await importOcrSource(raw,options,'A'.repeat(64))).originalVerified,true);
  for(const computed of ['b'.repeat(64),'a',''])await assert.rejects(importOcrSource(raw,options,computed),invalid);
});
test('OCR preserves declared real OCR and text-layer providers without implying recognition was rerun',async()=>{
  for(const kind of ['ocr','text-layer']){const data=ocr();data.provider.kind=kind;const source=await importOcrSource(JSON.stringify(data),options);
    assert.equal(source.fixture,false);assert.equal(source.engine,`${kind}:synthetic@1`);assert.equal(source.originalVerified,false);
  }
});
test('OCR rejects unsupported schemas, extra fields and malformed JSON',async()=>{
  for(const data of [{...ocr(),schema:'other'},{...ocr(),confidence:1},{...ocr(),provider:{...ocr().provider,url:'https://example.com'}},{...ocr(),original:{...ocr().original,extra:true}},{...ocr(),spans:[{...ocr().spans[0],confidence:1}]}])await assert.rejects(importOcrSource(JSON.stringify(data),options),invalid);
  await assert.rejects(importOcrSource('{broken',options),invalid);
});
test('OCR rejects missing/invalid hash, pages and span page references',async()=>{
  for(const original of [{sha256:'bad',pages:2},{sha256:'a'.repeat(64),pages:0},{sha256:'a'.repeat(64),pages:4},{sha256:'a'.repeat(64),pages:1.5}])await assert.rejects(importOcrSource(JSON.stringify({...ocr(),original}),options),invalid);
  for(const page of [0,3,1.1])await assert.rejects(importOcrSource(JSON.stringify({...ocr(),spans:[{...ocr().spans[0],page}]}),options),invalid);
});
test('OCR rejects out-of-page, empty and malformed bounding boxes',async()=>{
  for(const bbox of [[-0.1,0,0.1,0.1],[0,0,0,0.1],[0,0,0.1,0],[0.9,0,0.2,0.1],[0,0.9,0.1,0.2],[0,0,0.1],[0,0,0.1,0.1,0]])await assert.rejects(importOcrSource(JSON.stringify({...ocr(),spans:[{...ocr().spans[0],bbox}]}),options),invalid);
});
test('OCR rejects duplicate IDs, empty and excess spans, oversized text and provider names',async()=>{
  for(const spans of [[],[ocr().spans[0],ocr().spans[0]],Array.from({length:41},(_,i)=>({...ocr().spans[0],id:`p-${i}`})),[{...ocr().spans[0],text:'x'.repeat(501)}]])await assert.rejects(importOcrSource(JSON.stringify({...ocr(),spans}),options),invalid);
  await assert.rejects(importOcrSource(JSON.stringify({...ocr(),provider:{name:'x'.repeat(1000),version:'1',kind:'fixture'}}),options),invalid);
});
test('server validation returns detached valid sources and rejects unknown fields and hashes',async()=>{
  const source=await importTextSource('材料',options);const checked=validateMaterialSource(source);
  assert.deepEqual(checked,source);checked.spans[0]!.text='变更';assert.equal(source.spans[0]!.text,'材料');
  for(const bad of [{...source,contentHash:'bad'},{...source,externalUrl:'https://example.com'},{...source,spans:[{...source.spans[0],confidence:1}]},{...source,spans:[source.spans[0],source.spans[0]]}])assert.throws(()=>validateMaterialSource(bad),invalid);
});
test('server validation enforces source kind page and time contracts',async()=>{
  const text=await importTextSource('材料',options);const timed=await importVttSource(vtt(cue(),cue('00:02.000','00:03.000')),options);const scan=await importOcrSource(JSON.stringify(ocr()),options);
  for(const bad of [{...text,spans:[{...text.spans[0],page:1}]},{...text,originalVerified:true},{...text,engine:'ocr:fake@1'},{...timed,spans:[{...timed.spans[0],startMs:-1}]},{...timed,spans:[{...timed.spans[0],endMs:1000}]},{...timed,spans:[timed.spans[1],timed.spans[0]]},{...scan,spans:[{...scan.spans[0],page:4}]},{...scan,fixture:false},{...scan,originalHash:undefined},{...scan,engine:undefined}])assert.throws(()=>validateMaterialSource(bad),invalid);
});
