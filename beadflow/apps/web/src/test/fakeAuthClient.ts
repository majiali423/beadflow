import { vi } from 'vitest';

import type { AuthClient, AuthUser, SignUpResult } from '../features/auth/authClient';

export class FakeAuthClient implements AuthClient {
  currentUser: AuthUser | null;
  getCurrentUserError: Error | null = null;
  signInError: Error | null = null;
  signUpError: Error | null = null;
  resetError: Error | null = null;
  updatePasswordError: Error | null = null;
  signOutError: Error | null = null;
  signUpResult: SignUpResult = 'confirmation_required';
  private readonly listeners = new Set<(user: AuthUser | null) => void>();

  constructor(user: AuthUser | null = null) {
    this.currentUser = user;
  }

  getCurrentUser = vi.fn(async () => {
    if (this.getCurrentUserError) throw this.getCurrentUserError;
    return this.currentUser;
  });

  getAccessToken = vi.fn(async () => (this.currentUser ? 'fake-access-token' : null));

  subscribe = vi.fn((listener: (user: AuthUser | null) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  });

  signIn = vi.fn(async (email: string, password: string) => {
    void password;
    if (this.signInError) throw this.signInError;
    const user = { id: 'signed-in-user', email };
    this.emit(user);
    return user;
  });

  signUp = vi.fn(async (email: string, password: string) => {
    void password;
    if (this.signUpError) throw this.signUpError;
    if (this.signUpResult === 'authenticated') {
      this.emit({ id: 'registered-user', email });
    }
    return this.signUpResult;
  });

  sendPasswordReset = vi.fn(async (email: string) => {
    void email;
    if (this.resetError) throw this.resetError;
  });

  updatePassword = vi.fn(async (password: string) => {
    void password;
    if (this.updatePasswordError) throw this.updatePasswordError;
  });

  signOut = vi.fn(async () => {
    if (this.signOutError) throw this.signOutError;
    this.emit(null);
  });

  private emit(user: AuthUser | null) {
    this.currentUser = user;
    this.listeners.forEach((listener) => listener(user));
  }
}
