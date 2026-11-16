// These browser helpers use the application's backend; they are not public-client OAuth.
import { SDKError, validateSchema } from './index.js';
function endpoint(authUrl,path) {
  if(typeof authUrl!=='string' || !authUrl || authUrl.length>2048 || /[\s\\]/u.test(authUrl) || [...authUrl].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw new SDKError();
  const location=globalThis.location;
  let base;try{base=new URL(authUrl,location?.href);}catch{throw new SDKError();}
  if(base.search || base.hash || base.username || base.password || (location && base.origin!==location.origin) || !(base.protocol==='https:' || (base.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))))throw new SDKError();
  base.pathname=base.pathname.replace(/\/$/,'')+path;
  return base.href;
}
export function startLogin(provider,authUrl="/auth") {
  validateSchema('Provider',provider);
  const url=endpoint(authUrl,'/login/'+provider);
  if(!globalThis.location?.assign)throw new SDKError(0,'invalid_argument','startLogin requires a browser.');
  globalThis.location.assign(url);
}
export async function getProfile(authUrl="/auth") {
  let response;
  try {response=await fetch(endpoint(authUrl,'/profile'),{credentials:'same-origin',redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});}
  catch(error){if(error instanceof SDKError)throw error;throw new SDKError(0,'transport_error','Could not read the application session.');}
  if(response.status===401)return null;
  if(response.status!==200)throw new SDKError(response.status,'request_failed','Could not read the application session.');
  try {return validateSchema('Profile',await response.json());}
  catch{throw new SDKError(200,'protocol_error','Invalid session profile.');}
}
export async function logout(authUrl="/auth") {
  let response;
  try {response=await fetch(endpoint(authUrl,'/logout'),{method:'POST',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(10000)});}
  catch(error){if(error instanceof SDKError)throw error;throw new SDKError(0,'transport_error','Could not sign out.');}
  if(response.status!==204)throw new SDKError(response.status,'request_failed','Could not sign out.');
}
