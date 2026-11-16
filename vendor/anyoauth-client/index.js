// Generated from sdks/spec/openapi.json. Docs: docs/sdk/contract.md
const contract = {"schemas":{"LoginSessionResponse":{"type":"object","required":["authorization_url","expires_in"],"properties":{"authorization_url":{"$ref":"#/components/schemas/RedirectUri"},"expires_in":{"type":"integer","const":600}},"additionalProperties":true},"LoginResult":{"type":"object","required":["status"],"properties":{"status":{"type":"string","enum":["pending","succeeded","failed"]},"profile":{"$ref":"#/components/schemas/Profile"},"error":{"type":"string","enum":["access_denied","invalid_provider_response","provider_unavailable"]}},"additionalProperties":true},"Provider":{"type":"string","enum":["google","github","email"]},"RedirectUri":{"type":"string","format":"uri","maxLength":2048,"x-validation":"redirect","description":"Exact registered HTTPS URL or HTTP loopback; no credentials, query or fragment."},"TokenResponse":{"type":"object","required":["access_token","token_type","expires_in","scope"],"properties":{"access_token":{"type":"string","pattern":"^aop_[A-Za-z0-9_-]{43}$"},"token_type":{"type":"string","const":"Bearer"},"expires_in":{"type":"integer","const":900},"scope":{"type":"string","const":"profile"}},"additionalProperties":true},"Profile":{"type":"object","required":["subject","provider","providerSubject","name","username","email","emailVerified","avatarUrl"],"properties":{"subject":{"type":"string"},"provider":{"$ref":"#/components/schemas/Provider"},"providerSubject":{"type":"string"},"name":{"type":["string","null"]},"username":{"type":["string","null"]},"email":{"type":["string","null"]},"emailVerified":{"type":"boolean"},"avatarUrl":{"type":["string","null"]}},"additionalProperties":true},"ProviderStatus":{"type":"object","required":["id","configured","enabled","available"],"properties":{"id":{"$ref":"#/components/schemas/Provider"},"configured":{"type":"boolean"},"enabled":{"type":"boolean"},"available":{"type":"boolean"}},"additionalProperties":true},"ProviderStatuses":{"type":"array","items":{"$ref":"#/components/schemas/ProviderStatus"}},"ApiError":{"type":"object","required":["error"],"properties":{"error":{"type":"string"},"message":{"type":"string"}},"additionalProperties":true},"Transaction":{"type":"object","required":["state","codeVerifier","codeChallenge","createdAt","expiresAt"],"properties":{"state":{"type":"string","pattern":"^[A-Za-z0-9_-]{43}$"},"codeVerifier":{"type":"string","pattern":"^[A-Za-z0-9._~-]{43,128}$"},"codeChallenge":{"type":"string","pattern":"^[A-Za-z0-9_-]{43}$"},"createdAt":{"type":"integer"},"expiresAt":{"type":"integer"}},"additionalProperties":true}},"operations":{},"authorization":{"operationId":"authorizationUrl","x-sdk-local":true,"description":"Construct this URL locally and navigate the browser. Persist state/verifier in the initiating application session; validate and consume the transaction on callback. Never include a client secret.","parameters":[{"name":"client_id","in":"query","required":true,"schema":{"type":"string","minLength":1}},{"name":"provider","in":"query","required":true,"schema":{"$ref":"#/components/schemas/Provider"}},{"name":"redirect_uri","in":"query","required":true,"schema":{"$ref":"#/components/schemas/RedirectUri"}},{"name":"state","in":"query","required":true,"schema":{"type":"string","minLength":16,"maxLength":512}},{"name":"code_challenge","in":"query","required":true,"schema":{"type":"string","pattern":"^[A-Za-z0-9_-]{43}$"}},{"name":"code_challenge_method","in":"query","required":true,"schema":{"type":"string","const":"S256"}},{"name":"response_type","in":"query","required":true,"schema":{"type":"string","const":"code"}}],"responses":{"302":{"description":"Browser redirect to configured provider","headers":{"Location":{"schema":{"type":"string","format":"uri"}}}},"default":{"$ref":"#/components/responses/Error"}}},"helpers":{"createTransaction":{"lifetimeSeconds":600,"entropyBytes":32,"description":"Create random state and a PKCE verifier/challenge. Persist this transaction in the initiating browser or app session.","input":{"type":"object","properties":{},"additionalProperties":false}},"pkceChallenge":{"algorithm":"SHA-256","encoding":"base64url","description":"Compute the RFC 7636 S256 challenge for the original verifier.","input":{"type":"object","required":["codeVerifier"],"properties":{"codeVerifier":{"$ref":"#/components/schemas/TokenRequest/properties/code_verifier"}},"additionalProperties":false}},"authorizationUrl":{"operation":"authorizationUrl","description":"Construct the URL locally and navigate the initiating browser; never include a client secret."},"validateCallback":{"description":"Exact saved callback, state and expiry. Reject duplicate state/code/error and simultaneous code/error. Caller owns browser binding and atomic consumption.","input":{"type":"object","required":["callbackUrl","redirectUri","state","expiresAt"],"properties":{"callbackUrl":{"type":"string"},"redirectUri":{"$ref":"#/components/schemas/RedirectUri"},"state":{"type":"string","minLength":1},"expiresAt":{"type":"integer"}},"additionalProperties":false}}},"origin":"https://api.anyoauth.com"};

export class SDKError extends Error {
  constructor(status = 0, code = 'invalid_argument', message = 'Invalid argument') {
    super(message); this.name = 'SDKError'; this.status = status; this.code = code;
  }
}
const fail = () => { throw new SDKError(); };
function safeURL(value, origin = false, query = false) {
  if (typeof value !== 'string' || /[\s\\\x00-\x1f\x7f]/u.test(value) || /%(?![0-9a-f]{2})/i.test(value)) fail();
  let u; try { u = new URL(value); } catch { fail(); }
  const authority = value.split('://')[1]?.split(/[/?#]/)[0];
  if (!authority || /[%@]/.test(authority) || u.username || u.password || value.includes('#') || (!query && value.includes('?')) ||
      !(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))) ||
      u.port === '0' || (origin && !/^https?:\/\/[^/?#]+\/?$/.test(value))) fail();
  return u;
}
function validate(s, value) {
  if (s.$ref) return validate(contract.schemas[s.$ref.split('/').at(-1)], value);
  const types = [].concat(s.type);
  const matches = {null:value === null,string:typeof value === 'string',boolean:typeof value === 'boolean',integer:Number.isSafeInteger(value),number:typeof value === 'number' && Number.isFinite(value),object:value !== null && typeof value === 'object' && !Array.isArray(value),array:Array.isArray(value)};
  if (!types.some(t=>matches[t])) fail();
  if (Object.hasOwn(s,'const') && value !== s.const) fail();
  if (s.enum && !s.enum.includes(value)) fail();
  if (typeof value === 'string') {
    const length = [...value].length;
    if (length < (s.minLength ?? 0) || length > (s.maxLength ?? Infinity)) fail();
    if (s.pattern) { const pattern = new RegExp(s.pattern); const match = pattern.exec(value); if (!match || (s.pattern.endsWith('$') && match.index + match[0].length !== value.length)) fail(); }
    if (s['x-validation'] === 'redirect') safeURL(value);
  }
  if (matches.object) {
    for (const k of s.required) if (!Object.hasOwn(value,k)) fail();
    for (const [k,v] of Object.entries(value)) { if (Object.hasOwn(s.properties,k)) validate(s.properties[k],v);  }
  }
  if (matches.array) for (const v of value) validate(s.items,v);
  return value;
}
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export function validateSchema(name,value) {
  if (!Object.hasOwn(contract.schemas,name)) fail();
  return validate(contract.schemas[name],value);
}
export class AnyOAuth {
  constructor({clientId, baseUrl = contract.origin, timeoutMs = 10000, cryptoProvider = globalThis.crypto}) {
    safeURL(baseUrl,true);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail();
    this.baseUrl = baseUrl.replace(/\/$/,''); this.clientId = clientId; this.timeoutMs = timeoutMs; this.cryptoProvider = cryptoProvider;
  }
  createLoginAttempt(params = {}) { return this.createTransaction(params); }
  createLoginURL(params = {}) { return this.authorizationUrl(params); }
  validateLoginCallback(params = {}) { return this.validateCallback(params); }
  async pkceChallenge({codeVerifier}) {
    // RFC7636 syntax is shared by the contract's transaction model.
    if (typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier) || /\n$/.test(codeVerifier)) fail();
    return base64url(new Uint8Array(await this.cryptoProvider.subtle.digest('SHA-256',Uint8Array.from(codeVerifier,c=>c.charCodeAt(0)))));
  }
  async createTransaction() {
    const settings = contract.helpers.createTransaction;
    const random = () => base64url(this.cryptoProvider.getRandomValues(new Uint8Array(settings.entropyBytes)));
    const state = random(), codeVerifier = random(), createdAt = Math.floor(Date.now()/1000);
    return validate(contract.schemas.Transaction,{state,codeVerifier,codeChallenge:await this.pkceChallenge({codeVerifier}),createdAt,expiresAt:createdAt+settings.lifetimeSeconds});
  }
  authorizationUrl(params) {
    const values = {...params,clientId:this.clientId}; const query = new URLSearchParams();
    for (const p of contract.authorization.parameters) {
      const key = p.name.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
      query.set(p.name,validate(p.schema,Object.hasOwn(p.schema,'const') ? p.schema.const : values[key]));
    }
    return this.baseUrl + '/authorize?' + query;
  }
  validateCallback({callbackUrl,redirectUri,state,expiresAt}) {
    validate(contract.schemas.RedirectUri,redirectUri); const u = safeURL(callbackUrl,false,true);
    if (callbackUrl.split('?')[0] !== redirectUri) throw new SDKError(0,'invalid_callback','Callback does not match saved redirect');
    if (!Number.isSafeInteger(expiresAt)) fail();
    if (expiresAt <= Math.floor(Date.now()/1000)) throw new SDKError(0,'transaction_expired','Transaction expired');
    const q = u.searchParams;
    for (const k of q.keys()) if (q.getAll(k).length > 1) fail();
    if (typeof state !== 'string' || !state || q.get('state') !== state) throw new SDKError(0,'state_mismatch','Callback state mismatch');
    if (q.has('code') === q.has('error')) fail();
    const key = q.has('code') ? 'code' : 'error', value = q.get(key);
    if (!value || value.includes('\uFFFD')) fail();
    return {[key]:value,state};
  }
}
export { AnyOAuth as Client };

export {startLogin, getProfile, logout} from './browser.js';
