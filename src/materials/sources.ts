import {z} from 'zod';
import type {MaterialSource, SourceOptions, SourceSpan} from './types.js';

export class MaterialSourceError extends Error {
  constructor(public readonly code:string,message:string){super(message);this.name='MaterialSourceError';}
}

const bounded=(max:number)=>z.string().min(1).max(max).refine(value=>value.trim().length>0&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const identifier=bounded(80).refine(value=>!/[\r\n\t]/u.test(value));
const sha256=z.string().regex(/^[a-f0-9]{64}$/i);
const role=z.enum(['procurement','contract','order','product']);
const optionsSchema=z.object({id:identifier.optional(),label:bounded(120),role}).strict();
const bboxSchema=z.tuple([z.number().finite().min(0).max(1),z.number().finite().min(0).max(1),z.number().finite().positive().max(1),z.number().finite().positive().max(1)])
  .refine(([x,y,w,h])=>x+w<=1&&y+h<=1,'region must fit inside the page');
const spanSchema=z.object({id:identifier,text:z.string().min(1).max(500),page:z.number().int().min(1).max(3).optional(),bbox:bboxSchema.optional(),startMs:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),endMs:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}).strict();
const spansSchema=z.array(spanSchema).min(1).max(40)
  .refine(spans=>new Set(spans.map(span=>span.id)).size===spans.length,'duplicate span id')
  .refine(spans=>spans.reduce((sum,span)=>sum+span.text.length,0)<=4000,'source text exceeds 4000 characters')
  .refine(spans=>spans.some(span=>span.text.trim().length>0),'source text is empty');
const sourceSchema=z.object({id:identifier,label:bounded(120),role,kind:z.enum(['text','vtt','ocr']),contentHash:sha256,originalHash:sha256.optional(),originalVerified:z.boolean(),engine:bounded(160).optional(),fixture:z.boolean(),spans:spansSchema}).strict().superRefine((source,ctx)=>{
  const issue=(message:string)=>ctx.addIssue({code:z.ZodIssueCode.custom,message});
  if(source.kind==='ocr'){
    if(!source.originalHash||!source.engine||!/^(ocr|text-layer|fixture):[^\r\n]+@[^\r\n]+$/u.test(source.engine))issue('OCR requires original hash and declared provider engine');
    if(source.fixture!==source.engine?.startsWith('fixture:'))issue('fixture flag must match declared provider');
  }else if(source.originalHash!==undefined||source.originalVerified||source.engine!==undefined||source.fixture)issue('text and VTT cannot claim OCR provider or original verification');
  let previousStart=-1;
  for(const span of source.spans){
    if(source.kind==='ocr'){
      if(span.page===undefined||span.bbox===undefined||span.startMs!==undefined||span.endMs!==undefined)issue('OCR span requires page and bbox only');
    }else if(source.kind==='vtt'){
      if(span.page!==undefined||span.bbox!==undefined||span.startMs===undefined||span.endMs===undefined||span.startMs>=span.endMs||span.startMs<previousStart)issue('VTT span requires increasing start time and positive duration only');
      previousStart=span.startMs??previousStart;
    }else if(span.page!==undefined||span.bbox!==undefined||span.startMs!==undefined||span.endMs!==undefined)issue('text span cannot claim page or cue timing');
  }
});
const ocrSchema=z.object({schema:z.literal('office-document-analysis-v1'),provider:z.object({name:bounded(80).refine(value=>!/[\r\n@]/u.test(value)),version:bounded(40).refine(value=>!/[\r\n@]/u.test(value)),kind:z.enum(['ocr','text-layer','fixture'])}).strict(),original:z.object({sha256,pages:z.number().int().min(1).max(3)}).strict(),spans:z.array(z.object({id:identifier,page:z.number().int().min(1).max(3),bbox:bboxSchema,text:bounded(500)}).strict()).min(1).max(40)}).strict();

function checked<T>(schema:z.ZodType<T>,value:unknown,code='SOURCE_INVALID'):T{
  const result=schema.safeParse(value);
  if(!result.success)throw new MaterialSourceError(code,result.error.issues.map(issue=>`${issue.path.join('.')||'source'}: ${issue.message}`).join('; '));
  return result.data;
}
function checkRaw(text:string,maxCharacters:number,maxBytes?:number):void{
  if(typeof text!=='string'||!text.trim())throw new MaterialSourceError('SOURCE_INVALID','source text is empty');
  if(text.length>maxCharacters||(maxBytes!==undefined&&new TextEncoder().encode(text).byteLength>maxBytes))throw new MaterialSourceError('CAPACITY_EXCEEDED','source input exceeds capacity');
}
async function contentHash(raw:string):Promise<string>{
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function build(raw:string,options:SourceOptions,kind:MaterialSource['kind'],spans:SourceSpan[],ocr?:Pick<MaterialSource,'originalHash'|'originalVerified'|'engine'|'fixture'>):Promise<MaterialSource>{
  const input=checked(optionsSchema,options);const digest=await contentHash(raw);
  const identity=input.id??`source-${(await contentHash(JSON.stringify([kind,input.role,input.label,digest]))).slice(0,24)}`;
  return validateMaterialSource({id:identity,label:input.label,role:input.role,kind,contentHash:digest,originalVerified:false,fixture:false,...ocr,spans});
}

/** Consumes local plain text. Evidence spans preserve every original character. */
export async function importTextSource(text:string,options:SourceOptions):Promise<MaterialSource>{
  checkRaw(text,4000);
  const spans:SourceSpan[]=[];
  const parts=text.split(/(\r\n|\r|\n)/u);let pending='';
  const append=(part:string)=>{
    if(pending.length+part.length>500){spans.push({id:`text-${spans.length+1}`,text:pending});pending='';}
    pending+=part;
  };
  for(let i=0;i<parts.length;i+=2){
    const line=parts[i]!;const separator=parts[i+1]??'';
    if(line.length>500)throw new MaterialSourceError('CAPACITY_EXCEEDED','a logical text line exceeds 500 characters; supply complete shorter lines');
    // Never manufacture complete field evidence from a partial logical line.
    if(line.length+separator.length<=500)append(line+separator);
    else{append(line);append(separator);}
  }
  if(pending)spans.push({id:`text-${spans.length+1}`,text:pending});
  return build(text,options,'text',spans);
}

function timestamp(value:string):number{
  const match=/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/u.exec(value);
  if(!match)throw new MaterialSourceError('VTT_INVALID','invalid WebVTT timestamp');
  const ms=Number(match[1]??0)*3600000+Number(match[2])*60000+Number(match[3])*1000+Number(match[4]);
  if(!Number.isSafeInteger(ms))throw new MaterialSourceError('VTT_INVALID','WebVTT timestamp exceeds safe integer range');
  return ms;
}
function cueText(raw:string):string{
  // This is plain text, never HTML. Consumers must render it with textContent.
  const entities:Record<string,string>={amp:'&',lt:'<',gt:'>',nbsp:'\u00a0',lrm:'\u200e',rlm:'\u200f',quot:'"',apos:"'"};
  return raw.replace(/<[^>]*>/gu,'').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|nbsp|lrm|rlm|quot|apos);/giu,(entity:string,name:string)=>{
    if(!name.startsWith('#'))return entities[name.toLowerCase()]??entity;
    const numeric=name.toLowerCase().startsWith('#x')?Number.parseInt(name.slice(2),16):Number.parseInt(name.slice(1),10);
    return numeric>0&&numeric<=0x10ffff&&!(numeric>=0xd800&&numeric<=0xdfff)?String.fromCodePoint(numeric):'\ufffd';
  });
}

/** Parses supplied subtitles only: no media loading, ASR, CSS or DOM execution. */
export async function importVttSource(text:string,options:SourceOptions):Promise<MaterialSource>{
  checkRaw(text,32768,32768);
  const normalized=text.replace(/^\ufeff/u,'').replace(/\r\n?/gu,'\n');
  const blocks=normalized.split(/\n[\t ]*\n+/u);
  const header=blocks.shift()??'';
  if(!/^WEBVTT(?:[\t ][^\n]*)?$/u.test(header)||header.includes('-->'))throw new MaterialSourceError('VTT_INVALID','invalid WebVTT header or missing blank separator');
  const spans:SourceSpan[]=[];let previousStart=-1;
  for(const block of blocks){
    if(!block.trim())continue;
    const lines=block.split('\n');const first=lines[0]!;
    if(/^NOTE(?:[\t ]|$)/u.test(first))continue;
    if(first==='STYLE'||first==='REGION'){
      if(spans.length)throw new MaterialSourceError('VTT_INVALID','style and region blocks must precede cues');
      continue;
    }
    const offset=first.includes('-->')?0:1;
    const timing=/^([\d:.]+)[\t ]+-->[\t ]+([\d:.]+)(?:[\t ]+[^\n]*)?$/u.exec(lines[offset]??'');
    if(!timing||lines[offset]!.split('-->').length!==2)throw new MaterialSourceError('VTT_INVALID','invalid WebVTT cue timing');
    const startMs=timestamp(timing[1]!);const endMs=timestamp(timing[2]!);
    if(startMs>=endMs||startMs<previousStart)throw new MaterialSourceError('VTT_INVALID','cue must have positive duration and ordered start time');
    previousStart=startMs;
    const payload=lines.slice(offset+1).join('\n').replace(/\n$/u,'');
    spans.push({id:`vtt-${spans.length+1}`,text:cueText(payload),startMs,endMs});
  }
  return build(text,options,'vtt',spans);
}

/** Consumes the upstream analysis contract; matching a file digest is not OCR QA. */
export async function importOcrSource(rawJSON:string,options:SourceOptions,computedOriginalHash?:string):Promise<MaterialSource>{
  checkRaw(rawJSON,16384,16384);
  let raw:unknown;
  try{raw=JSON.parse(rawJSON);}catch{throw new MaterialSourceError('OCR_INVALID','invalid OCR analysis JSON');}
  const document=checked(ocrSchema,raw,'OCR_INVALID');
  if(document.spans.some(span=>span.page>document.original.pages))throw new MaterialSourceError('OCR_INVALID','span page exceeds original document page count');
  let originalVerified=false;
  if(computedOriginalHash!==undefined){
    checked(sha256,computedOriginalHash,'HASH_INVALID');
    if(computedOriginalHash.toLowerCase()!==document.original.sha256.toLowerCase())throw new MaterialSourceError('HASH_MISMATCH','original document hash does not match upstream declaration');
    originalVerified=true;
  }
  return build(rawJSON,options,'ocr',document.spans,{originalHash:document.original.sha256.toLowerCase(),originalVerified,fixture:document.provider.kind==='fixture',engine:`${document.provider.kind}:${document.provider.name}@${document.provider.version}`});
}

/** Structural server validation only. Client-declared hashes/provider flags are not attestation. */
export function validateMaterialSource(value:unknown):MaterialSource{return checked(sourceSchema,value);}
