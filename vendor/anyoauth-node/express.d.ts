import type {Profile} from './index.js';
import type {AuthOptions, ManagedAuth} from './auth.js';
export interface IncomingRequest { url?: string; originalUrl?: string; method?: string; headers: Record<string, string | string[] | undefined> }
export interface OutgoingResponse { statusCode: number; setHeader(name: string, value: string | string[]): unknown; getHeader?(name: string): string | string[] | number | undefined; end(body?: string | Uint8Array): unknown }
export interface ExpressAuth extends Omit<ManagedAuth,'getProfile'> {
  router(): (req: IncomingRequest, res: OutgoingResponse, next?: () => void) => Promise<void>;
  getProfile(request: IncomingRequest | Request): Promise<Profile | null>;
}
export function createAuth(options: AuthOptions): ExpressAuth;
