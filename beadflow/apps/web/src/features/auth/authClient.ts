import { createClient } from '@supabase/supabase-js';

export type AuthUser = {
  id: string;
  email: string | null;
};

export type SignUpResult = 'authenticated' | 'confirmation_required';

export interface AuthClient {
  getCurrentUser(): Promise<AuthUser | null>;
  getAccessToken(): Promise<string | null>;
  subscribe(listener: (user: AuthUser | null) => void): () => void;
  signIn(email: string, password: string): Promise<AuthUser>;
  signUp(email: string, password: string): Promise<SignUpResult>;
  sendPasswordReset(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  signOut(): Promise<void>;
}

function authUser(user: { id: string; email?: string | null }): AuthUser {
  return { id: user.id, email: user.email ?? null };
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const authConfigurationError =
  !supabaseUrl || !supabasePublishableKey
    ? '缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_PUBLISHABLE_KEY。'
    : null;

export const authClient: AuthClient | null =
  supabaseUrl && supabasePublishableKey
    ? (() => {
        const supabase = createClient(supabaseUrl, supabasePublishableKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        });

        return {
          async getCurrentUser() {
            const { data, error } = await supabase.auth.getSession();
            if (error) throw error;
            return data.session ? authUser(data.session.user) : null;
          },
          async getAccessToken() {
            const { data, error } = await supabase.auth.getSession();
            if (error) throw error;
            return data.session?.access_token ?? null;
          },
          subscribe(listener) {
            const {
              data: { subscription },
            } = supabase.auth.onAuthStateChange((_event, session) => {
              listener(session ? authUser(session.user) : null);
            });
            return () => subscription.unsubscribe();
          },
          async signIn(email, password) {
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) throw error;
            if (!data.user) throw new Error('AUTH_USER_MISSING');
            return authUser(data.user);
          },
          async signUp(email, password) {
            const { data, error } = await supabase.auth.signUp({ email, password });
            if (error) throw error;
            return data.session ? 'authenticated' : 'confirmation_required';
          },
          async sendPasswordReset(email) {
            const { error } = await supabase.auth.resetPasswordForEmail(email, {
              redirectTo: `${window.location.origin}/reset-password`,
            });
            if (error) throw error;
          },
          async updatePassword(password) {
            const { error } = await supabase.auth.updateUser({ password });
            if (error) throw error;
          },
          async signOut() {
            const { error } = await supabase.auth.signOut();
            if (error) throw error;
          },
        } satisfies AuthClient;
      })()
    : null;
