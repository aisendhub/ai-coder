// Express-compatible middleware and plain Node HTTP adapter. No Express dependency.
import { createAuth as createFetchAuth } from './auth.js';

export function createAuth(options) {
  const auth=createFetchAuth(options);
  function request(req) {
    const path=req.originalUrl ?? req.url;
    if(typeof path!=='string' || !path.startsWith('/') || path.startsWith('//'))throw new Error('Invalid request path');
    const h=new Headers();
    for(const [name,value] of Object.entries(req.headers))if(value!==undefined){for(const item of Array.isArray(value)?value:[value])h.append(name,item);}
    return new Request(new URL(path,auth.origin),{method:req.method ?? 'GET',headers:h});
  }
  const router=()=>async(req,res,next)=>{
    try {
      const incoming=request(req);
      const pathname=new URL(incoming.url).pathname;
      if(!pathname.startsWith(auth.authPath+'/')){if(next)return next();res.statusCode=404;res.end();return;}
      const response=await auth.handle(incoming);
      res.statusCode=response.status;
      for(const [name,value] of response.headers)if(name!=='set-cookie')res.setHeader(name,value);
      const cookies=response.headers.getSetCookie();
      const existing=res.getHeader?.('Set-Cookie');
      if(cookies.length)res.setHeader('Set-Cookie',[...(Array.isArray(existing)?existing:typeof existing==='string'?[existing]:[]),...cookies]);
      res.end(new Uint8Array(await response.arrayBuffer()));
    }catch{
      res.statusCode=500;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.end('{"error":"auth_unavailable"}');
    }
  };
  return {...auth,router,getProfile:req=>auth.getProfile(req instanceof Request?req:request(req))};
}
