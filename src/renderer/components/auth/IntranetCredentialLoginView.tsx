// [INTRA-ONLY] Full-page login screen for the intranet permission API.
//
// The form only collects the employee ID (工号) and password and hands them to
// whoever opened it; it never performs a network request itself. The caller
// reports failures back through the bridge so they render inline.
//
// Layout mirrors the other full-window overlays in this app
// (see `components/cowork/EngineStartupOverlay.tsx`).

import { ExclamationCircleIcon, LockClosedIcon, UserIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useId, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import {
  closeIntranetCredentialLogin,
  submitIntranetCredentialLogin,
  useIntranetCredentialLoginState,
} from './intranetCredentialLoginBridge';

const TITLE_ID = 'intranet-login-title';

const INPUT_CLASS_NAME = 'w-full rounded-xl border border-border bg-surface-raised py-2.5 pl-10 pr-3 text-sm text-foreground outline-none placeholder:text-secondary transition-colors hover:border-border focus:border-primary focus:ring-1 focus:ring-primary/40 disabled:opacity-60';

const INPUT_ICON_CLASS_NAME = 'pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary';

const LABEL_CLASS_NAME = 'mb-1.5 block text-sm font-medium text-foreground';

const IntranetCredentialLoginView: React.FC = () => {
  const { open, submitting, error } = useIntranetCredentialLoginState();
  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const employeeIdRef = useRef<HTMLInputElement>(null);
  const employeeIdInputId = useId();
  const passwordInputId = useId();
  const errorId = useId();

  const handleClose = useCallback(() => {
    if (submitting) return;
    setEmployeeId('');
    setPassword('');
    setValidationError(null);
    closeIntranetCredentialLogin();
  }, [submitting]);

  const handleSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const trimmedEmployeeId = employeeId.trim();
    if (!trimmedEmployeeId) {
      setValidationError(i18nService.t('intranetLoginEmployeeIdRequired'));
      employeeIdRef.current?.focus();
      return;
    }
    if (!password) {
      setValidationError(i18nService.t('intranetLoginPasswordRequired'));
      return;
    }
    setValidationError(null);
    submitIntranetCredentialLogin({ employeeId: trimmedEmployeeId, password });
  }, [employeeId, password, submitting]);

  if (!open) return null;

  const message = validationError ?? error;

  // The inner content fills the overlay, so backdrop dismissal can never fire;
  // Escape and the cancel button are the only ways out.
  return (
    <Modal
      onClose={handleClose}
      onEscape={handleClose}
      overlayClassName="non-draggable fixed inset-0 z-[10060] flex"
      className="flex h-full w-full items-center justify-center bg-background"
    >
      {/* brand gradient, same as WelcomeDialog */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(360deg, rgba(255, 0, 77, 0) 5.5%, rgba(255, 0, 77, 0.05) 100%)' }}
        aria-hidden="true"
      />

      <div
        className="relative z-10 flex w-[400px] flex-col items-center rounded-2xl border border-border bg-surface px-9 py-9 shadow-elevated"
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
      >
        <img
          src="logo.png"
          alt="LobsterAI"
          width={72}
          height={72}
          className="mb-5 select-none rounded-2xl"
          draggable={false}
        />

        <h1 id={TITLE_ID} className="text-center text-2xl font-bold text-foreground">
          {i18nService.t('intranetLoginTitle')}
        </h1>
        <p className="mb-6 mt-2 text-center text-sm text-secondary">
          {i18nService.t('intranetLoginDescription')}
        </p>

        <form className="w-full space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className={LABEL_CLASS_NAME} htmlFor={employeeIdInputId}>
              {i18nService.t('intranetLoginEmployeeIdLabel')}
            </label>
            <div className="relative">
              <UserIcon className={INPUT_ICON_CLASS_NAME} aria-hidden="true" />
              <input
                id={employeeIdInputId}
                ref={employeeIdRef}
                type="text"
                value={employeeId}
                onChange={event => {
                  setEmployeeId(event.target.value);
                  setValidationError(null);
                }}
                autoComplete="username"
                autoFocus
                disabled={submitting}
                aria-invalid={Boolean(message) || undefined}
                aria-describedby={message ? errorId : undefined}
                className={INPUT_CLASS_NAME}
              />
            </div>
          </div>

          <div>
            <label className={LABEL_CLASS_NAME} htmlFor={passwordInputId}>
              {i18nService.t('intranetLoginPasswordLabel')}
            </label>
            <div className="relative">
              <LockClosedIcon className={INPUT_ICON_CLASS_NAME} aria-hidden="true" />
              <input
                id={passwordInputId}
                type="password"
                value={password}
                onChange={event => {
                  setPassword(event.target.value);
                  setValidationError(null);
                }}
                autoComplete="current-password"
                disabled={submitting}
                aria-invalid={Boolean(message) || undefined}
                aria-describedby={message ? errorId : undefined}
                className={INPUT_CLASS_NAME}
              />
            </div>
          </div>

          {message ? (
            <p
              id={errorId}
              role="alert"
              className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
            >
              <ExclamationCircleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {message}
            </p>
          ) : null}

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="h-11 shrink-0 rounded-xl border border-border px-6 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-foreground text-sm font-medium text-surface transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <span
                    className="h-4 w-4 rounded-full border-2 border-surface/30 border-t-surface animate-spin"
                    aria-hidden="true"
                  />
                  {i18nService.t('intranetLoginSubmitting')}
                </>
              ) : (
                i18nService.t('intranetLoginSubmit')
              )}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
};

export default IntranetCredentialLoginView;
