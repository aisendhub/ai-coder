export type LoginSessionResponse = { "authorization_url": RedirectUri; "expires_in": 600 };
export type LoginResult = { "status": "pending" | "succeeded" | "failed"; "profile"?: Profile; "error"?: "access_denied" | "invalid_provider_response" | "provider_unavailable" };
export type Provider = "google" | "github" | "email";
export type RedirectUri = string;
export type TokenResponse = { "access_token": string; "token_type": "Bearer"; "expires_in": 900; "scope": "profile" };
export type Profile = { "subject": string; "provider": Provider; "providerSubject": string; "name": string | null; "username": string | null; "email": string | null; "emailVerified": boolean; "avatarUrl": string | null };
export type ProviderStatus = { "id": Provider; "configured": boolean; "enabled": boolean; "available": boolean };
export type ProviderStatuses = Array<ProviderStatus>;
export type ApiError = { "error": string; "message"?: string };
export type Transaction = { "state": string; "codeVerifier": string; "codeChallenge": string; "createdAt": number; "expiresAt": number };
export interface ModelMap { LoginSessionResponse: LoginSessionResponse; LoginResult: LoginResult; Provider: Provider; RedirectUri: RedirectUri; TokenResponse: TokenResponse; Profile: Profile; ProviderStatus: ProviderStatus; ProviderStatuses: ProviderStatuses; ApiError: ApiError; Transaction: Transaction }
export function validateSchema<N extends keyof ModelMap>(name: N, value: unknown): ModelMap[N];
export interface ExchangeParameters { code: string; codeVerifier: string; redirectUri: string }
export interface AuthorizationParameters { provider: Provider; redirectUri: string; state: string; codeChallenge: string }
export interface CallbackParameters { callbackUrl: string; redirectUri: string; state: string; expiresAt: number }
export class SDKError extends Error { readonly status: number; readonly code: string; constructor(status?: number, code?: string, message?: string) }
export class AnyOAuth {
  constructor(options: {clientId: string; baseUrl?: string; timeoutMs?: number});
  createLoginAttempt(): Promise<Transaction>;
  createLoginURL(params: AuthorizationParameters): string;
  validateLoginCallback(params: CallbackParameters): {state: string; code: string} | {state: string; error: string};
  pkceChallenge(params: {codeVerifier: string}): Promise<string>;
  createTransaction(): Promise<Transaction>;
  authorizationUrl(params: AuthorizationParameters): string;
  validateCallback(params: CallbackParameters): {state: string; code: string} | {state: string; error: string};

}
export { AnyOAuth as Client };

/** Navigate to your backend; browser-only OAuth is not supported. */
export function startLogin(provider: Provider, authUrl?: string): void;
export function getProfile(authUrl?: string): Promise<Profile | null>;
export function logout(authUrl?: string): Promise<void>;
