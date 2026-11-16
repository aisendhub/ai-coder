import type {ManagedAuthConfiguration, Profile} from './index.js';
export interface SessionAdapter {
  read(request: Request): Profile | null | Promise<Profile | null>;
  create(profile: Profile, request: Request): HeadersInit | void | Promise<HeadersInit | void>;
  destroy(request: Request): HeadersInit | void | Promise<HeadersInit | void>;
}
export type AuthOptions = ManagedAuthConfiguration & {
  onLogin?: (profile: Profile, request: Request) => void | Promise<void>;
  session?: SessionAdapter;
};
export interface ManagedAuth {
  handle(request: Request): Promise<Response>;
  getProfile(request: Request): Promise<Profile | null>;
  readonly origin: string;
  readonly authPath: string;
}
export function createAuth(options: AuthOptions): ManagedAuth;
