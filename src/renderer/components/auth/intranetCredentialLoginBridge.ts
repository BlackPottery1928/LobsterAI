// [INTRA-ONLY] Bridge that lets `authService.login()` open the in-app intranet
// credential form without the service depending on React.
//
// Protocol: the caller awaits `requestIntranetCredentialLogin()` and receives
// the submitted credentials (or null when the user cancels). On a rejected
// attempt the caller reports the failure, which keeps the form open and shows
// the message inline, then awaits the next submission.
//
// Follows the module-level store + `useSyncExternalStore` pattern used by
// `startupCreditCampaignBridge.ts`.

import { useSyncExternalStore } from 'react';

export interface IntranetCredentialLoginInput {
  employeeId: string;
  password: string;
}

export interface IntranetCredentialLoginState {
  open: boolean;
  submitting: boolean;
  error: string | null;
}

const CLOSED_STATE: IntranetCredentialLoginState = {
  open: false,
  submitting: false,
  error: null,
};

let state: IntranetCredentialLoginState = CLOSED_STATE;
let pendingResolvers = new Set<(value: IntranetCredentialLoginInput | null) => void>();
let cancelRequested = false;

const listeners = new Set<() => void>();

function update(next: IntranetCredentialLoginState): void {
  if (
    state.open === next.open
    && state.submitting === next.submitting
    && state.error === next.error
  ) {
    return;
  }
  state = next;
  listeners.forEach(listener => listener());
}

function settle(value: IntranetCredentialLoginInput | null): void {
  const resolvers = [...pendingResolvers];
  pendingResolvers = new Set();
  resolvers.forEach(resolve => resolve(value));
}

export function subscribeIntranetCredentialLogin(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getIntranetCredentialLoginState(): IntranetCredentialLoginState {
  return state;
}

export function useIntranetCredentialLoginState(): IntranetCredentialLoginState {
  return useSyncExternalStore(
    subscribeIntranetCredentialLogin,
    getIntranetCredentialLoginState,
    () => CLOSED_STATE,
  );
}

/**
 * Open the form (if needed) and resolve with the next submitted credentials.
 * Resolves with null when the user cancels.
 */
export function requestIntranetCredentialLogin(): Promise<IntranetCredentialLoginInput | null> {
  cancelRequested = false;
  if (!state.open) {
    update({ open: true, submitting: false, error: null });
  }
  return new Promise<IntranetCredentialLoginInput | null>(resolve => {
    pendingResolvers.add(resolve);
  });
}

/** Called by the form when the user submits. Keeps the form open while pending. */
export function submitIntranetCredentialLogin(input: IntranetCredentialLoginInput): void {
  update({ open: true, submitting: true, error: null });
  settle(input);
}

/** Called by the caller when an attempt failed; shows the message inline. */
export function reportIntranetCredentialLoginFailure(message: string): void {
  update({ open: true, submitting: false, error: message });
}

export function closeIntranetCredentialLogin(): void {
  cancelRequested = true;
  update(CLOSED_STATE);
  settle(null);
}

export function isIntranetCredentialLoginCancelled(): boolean {
  return cancelRequested;
}
