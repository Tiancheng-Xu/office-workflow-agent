interface Env {OFFICE_RUNTIME:{fetch:(request:Request)=>Promise<Response>}}
export const onRequest=async({request,env}:{request:Request;env:Env})=>env.OFFICE_RUNTIME.fetch(request);
