export function allowedCloudOrigin(rawUrl:string,exactOrigins:string[],previewProject?:string):boolean {
  let url:URL;try{url=new URL(rawUrl);}catch{return false;}
  if(url.protocol!=='https:'||url.username||url.password||url.port)return false;
  if(exactOrigins.includes(url.origin))return true;
  if(!previewProject||!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(previewProject))return false;
  const suffix='.'+previewProject+'.pages.dev';
  if(!url.hostname.endsWith(suffix))return false;
  const label=url.hostname.slice(0,-suffix.length);
  return /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(label);
}
