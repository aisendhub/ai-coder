// Generated into the Node SDK. Uses Web APIs so the same handler works in Workers/Hono.
import { AnyOAuth, SDKError, validateSchema } from './index.js';
const contract = {"targets":["node"],"browserTargets":["js"],"description":"Backend-managed Google/GitHub login. Mount one handler; the SDK manages private login cookies, callback validation and authenticated sessions. Browser helpers talk to your backend, not directly to AnyOAuth. Public-client authentication is deferred.","entrypoints":{"fetch":"@anyoauth/node/auth","express":"@anyoauth/node/express","browser":"@anyoauth/client"},"factory":"createAuth","configuration":{"$ref":"#/x-sdk-schemas/ManagedAuthConfiguration"},"defaults":{"authPath":"/auth","returnTo":"/","sessionMaxAge":86400,"baseUrl":"https://api.anyoauth.com"},"limits":{"sessionMaxAgeMinimum":60,"sessionMaxAgeMaximum":2592000,"cookieMaxLength":3800},"operations":["createLoginSession","loginResult"],"routes":[{"method":"GET","path":"/login/{provider}","description":"Create a private login cookie and redirect to AnyOAuth."},{"method":"GET","path":"/callback","description":"Complete login, establish an application session and redirect to the fixed returnTo."},{"method":"GET","path":"/profile","response":{"$ref":"#/components/schemas/Profile"},"description":"Return the verified session profile; 401 when signed out."},{"method":"POST","path":"/logout","description":"Require the configured Origin and clear this browser's session; returns 204."}],"browserHelpers":{"startLogin":{"parameters":["provider","authUrl"],"input":{"$ref":"#/x-sdk-schemas/BrowserStartLoginParameters"},"defaultAuthUrl":"/auth","output":{"type":"null"},"description":"Navigate to the application's backend login route; no returned value."},"getProfile":{"parameters":["authUrl"],"input":{"$ref":"#/x-sdk-schemas/BrowserAuthParameters"},"defaultAuthUrl":"/auth","output":{"oneOf":[{"$ref":"#/components/schemas/Profile"},{"type":"null"}]},"description":"Read the backend-authenticated profile; null when signed out."},"logout":{"parameters":["authUrl"],"input":{"$ref":"#/x-sdk-schemas/BrowserAuthParameters"},"defaultAuthUrl":"/auth","output":{"type":"null"},"description":"POST to the backend logout route; no returned value. The application refreshes its UI afterward."}},"bindings":{"onLogin":"Optional async (profile, request) hook for application user records.","session":"Optional read(request), create(profile, request), destroy(request) adapter. create/destroy return Set-Cookie headers; read returns Profile or null."},"session":"Default: encrypted, authenticated, expiring HttpOnly cookies, Secure on HTTPS, SameSite=Lax. Purpose-separated keys derived from sessionSecret or clientSecret, bound to project/origin/authPath. Logout clears the browser cookie; immediate server-side revocation uses the optional session adapter."};
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const decode = text => {
  if(!/^[A-Za-z0-9_-]+$/.test(text))throw new SDKError();
  return Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
};
const invalid = message => {throw new SDKError(0,'invalid_argument',message);};
const headers = () => new Headers({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
const json = (value,status=200) => {const h=headers();h.set('Content-Type','application/json; charset=utf-8');return new Response(JSON.stringify(value),{status,headers:h});};

export function createAuth(options) {
  if(!options || typeof options!=='object' || Array.isArray(options))invalid('Configure clientId, clientSecret and origin.');
  const {onLogin,session,...provided}=options;
  const config={...contract.defaults,...provided};
  validateSchema('ManagedAuthConfiguration',config);
  const origin=new URL(config.origin);
  if(config.origin!==origin.origin)invalid('origin must be a canonical HTTPS origin or HTTP loopback origin, without a path or trailing slash.');
  const returnURL=new URL(config.returnTo,origin);
  if(!config.returnTo.startsWith('/') || config.returnTo.startsWith('//') || /[\s\\]/u.test(config.returnTo) || [...config.returnTo].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127) || returnURL.origin!==origin.origin)invalid('returnTo must be a local path on your application.');
  if(config.sessionMaxAge<contract.limits.sessionMaxAgeMinimum || config.sessionMaxAge>contract.limits.sessionMaxAgeMaximum)invalid('Invalid sessionMaxAge.');
  if(onLogin!==undefined && typeof onLogin!=='function')invalid('onLogin must be a function.');
  if(session && !['read','create','destroy'].every(name=>typeof session[name]==='function'))invalid('session must implement read, create and destroy.');
  const client=new AnyOAuth({clientId:config.clientId,clientSecret:config.clientSecret,baseUrl:config.baseUrl});
  const callbackURL=origin.origin+config.authPath+'/callback';
  const scope=`AnyOAuth managed auth v1\n${origin.origin}\n${config.clientId}\n${config.authPath}`;
  const encoder=new TextEncoder();
  const material=crypto.subtle.importKey('raw',encoder.encode(config.sessionSecret ?? config.clientSecret),'HKDF',false,['deriveKey']);
  const keys=new Map();
  const key=purpose=>{
    if(!keys.has(purpose))keys.set(purpose,material.then(value=>crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode(scope),info:encoder.encode(purpose)},value,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])));
    return keys.get(purpose);
  };
  const cookieNames=crypto.subtle.digest('SHA-256',encoder.encode(scope)).then(digest=>{
    const prefix=(origin.protocol==='https:'?'__Host-':'')+'anyoauth_'+encode(new Uint8Array(digest)).slice(0,16);
    return {login:prefix+'_login',session:prefix+'_session'};
  });
  const cookie=(name,value,seconds)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${origin.protocol==='https:'?'; Secure':''}`;
  const readCookie=(request,name)=>{
    const values=(request.headers.get('Cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
    return values.length===1?values[0].slice(name.length+1):null;
  };
  async function seal(value,purpose) {
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(scope+'\n'+purpose)},await key(purpose),encoder.encode(JSON.stringify(value)));
    const token=`ao1.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
    if(token.length>contract.limits.cookieMaxLength)throw new SDKError(0,'session_too_large','Session exceeds the cookie size limit. Use a custom session adapter.');
    return token;
  }
  async function open(value,purpose) {
    if(!value || value.length>contract.limits.cookieMaxLength)return null;
    try {
      const parts=value.split('.');if(parts.length!==3 || parts[0]!=='ao1')return null;
      const iv=decode(parts[1]);if(iv.length!==12)return null;
      const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(scope+'\n'+purpose)},await key(purpose),decode(parts[2]));
      const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
      validateSchema(purpose==='login'?'ManagedLoginCookie':'ManagedSessionCookie',data);
      if((purpose==='login'?data.loginAttempt.expiresAt:data.expiresAt)<=Math.floor(Date.now()/1000))return null;
      return data;
    }catch{return null;}
  }
  const redirect=url=>new Response(null,{status:303,headers:new Headers([...headers(),['Location',url]])});
  const failure=error=>{const url=new URL(returnURL);url.searchParams.set('auth_error',error);return redirect(url.href);};
  async function sessionHeaders(response,result) {
    if(!result)return;
    const incoming=new Headers(result);
    for(const [name] of incoming)if(name!=='set-cookie')invalid('Custom sessions may return only Set-Cookie headers.');
    for(const value of incoming.getSetCookie())response.headers.append('Set-Cookie',value);
  }
  async function getProfile(request) {
    if(new URL(request.url).origin!==origin.origin)return null;
    if(session){const profile=await session.read(request);return profile===null?null:validateSchema('Profile',profile);}
    const names=await cookieNames;
    const stored=await open(readCookie(request,names.session),'session');
    return stored?.profile ?? null;
  }
  async function handle(request) {
    const url=new URL(request.url);
    if(url.origin!==origin.origin)return json({error:'invalid_origin'},400);
    const route=url.pathname.slice(config.authPath.length);
    if(!url.pathname.startsWith(config.authPath+'/'))return json({error:'not_found'},404);
    const names=await cookieNames;
    if(route==='/profile' && request.method==='GET'){
      try {
        const profile=await getProfile(request);
        const response=profile?json(profile):json({error:'unauthorized'},401);
        if(!profile && !session)response.headers.append('Set-Cookie',cookie(names.session,'',0));
        return response;
      }catch{return json({error:'session_unavailable'},503);}
    }
    if(route==='/logout' && request.method==='POST'){
      if(request.headers.get('Origin')!==origin.origin)return json({error:'invalid_origin'},403);
      try {
        const response=new Response(null,{status:204,headers:headers()});
        if(session)await sessionHeaders(response,await session.destroy(request));
        response.headers.append('Set-Cookie',cookie(names.session,'',0));
        response.headers.append('Set-Cookie',cookie(names.login,'',0));
        return response;
      }catch{return json({error:'session_unavailable'},503);}
    }
    if(route.startsWith('/login/') && request.method==='GET'){
      const provider=route.slice('/login/'.length);
      if(!['google','github'].includes(provider) || url.search)return json({error:'invalid_request'},400);
      try {
        const login=await client.startLogin({provider,redirectUri:callbackURL});
        // A launch is allowed only on the configured AnyOAuth origin, never a response-supplied third party.
        const launch=new URL(login.url);
        if(launch.origin!==client.baseUrl || !/^\/auth\/login\/aol_[A-Za-z0-9_-]{43}$/.test(launch.pathname) || launch.search || launch.hash)throw new SDKError(200,'protocol_error','Invalid login destination');
        const response=redirect(launch.href);
        response.headers.append('Set-Cookie',cookie(names.login,await seal({provider,loginAttempt:login.loginAttempt},'login'),Math.max(0,login.loginAttempt.expiresAt-Math.floor(Date.now()/1000))));
        return response;
      }catch{
        const response=json({error:'login_unavailable'},502);response.headers.append('Set-Cookie',cookie(names.login,'',0));return response;
      }
    }
    if(route==='/callback' && request.method==='GET'){
      const failed=error=>{const response=failure(error);response.headers.append('Set-Cookie',cookie(names.login,'',0));return response;};
      if(request.url.includes('?'))return failed('sign_in_failed');
      const pending=await open(readCookie(request,names.login),'login');
      if(!pending)return failed('sign_in_failed');
      try {
        const result=await client.completeLogin({loginAttempt:pending.loginAttempt});
        if(result.status==='pending')return json({status:'pending'},202);
        if(result.status==='failed')return failed(result.error);
        if(result.profile.provider!==pending.provider)return failed('sign_in_failed');
        const profile=Object.fromEntries(['subject','provider','providerSubject','name','username','email','emailVerified','avatarUrl'].map(name=>[name,result.profile[name]]));
        if(onLogin)await onLogin(structuredClone(profile),request);
        const response=redirect(returnURL.href);
        if(session)await sessionHeaders(response,await session.create(profile,request));
        else response.headers.append('Set-Cookie',cookie(names.session,await seal({profile,expiresAt:Math.floor(Date.now()/1000)+config.sessionMaxAge},'session'),config.sessionMaxAge));
        response.headers.append('Set-Cookie',cookie(names.login,'',0));
        return response;
      }catch{return failed('sign_in_failed');}
    }
    const allowed=route==='/logout'?'POST':route==='/profile'||route==='/callback'||route.startsWith('/login/')?'GET':null;
    const response=json({error:allowed?'method_not_allowed':'not_found'},allowed?405:404);
    if(allowed)response.headers.set('Allow',allowed);
    return response;
  }
  return {handle,getProfile,origin:origin.origin,authPath:config.authPath};
}
