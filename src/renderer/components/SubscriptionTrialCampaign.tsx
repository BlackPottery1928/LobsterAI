import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import type { SubscriptionTrialState } from '../../shared/subscriptionTrial/constants';
import { selectIsEnterpriseAccount } from '../features/enterpriseAccount/selectors';
import { getPortalSubscriptionTrialUrl, isTestModeEnabled } from '../services/endpoints';
import { i18nService } from '../services/i18n';
import type { RootState } from '../store';
import Modal from './common/Modal';

const FIRST_LOGIN_KEY = 'subscription_trial.waiting_for_first_login';
const POPUP_KEY = 'subscription_trial.shown.v1';
const DIALOG_SELECTOR = '[data-app-modal], [role="dialog"], [aria-modal="true"]';
const read = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* Server still enforces account frequency. */ }
};
const beijingDay = (time: number): string => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const otherDialogOpen = (): boolean => Array.from(document.querySelectorAll(DIALOG_SELECTOR)).some(node => (
  !node.querySelector('[data-subscription-trial]') && !node.hasAttribute('data-subscription-trial')
  && node.getClientRects().length > 0
));

interface Props { enabled: boolean; privacyAgreed: boolean | null }

const SubscriptionTrialCampaign: React.FC<Props> = ({ enabled, privacyAgreed }) => {
  const { isLoggedIn, isLoading, user, accountGeneration } = useSelector((state: RootState) => state.auth);
  const enterprise = useSelector(selectIsEnterpriseAccount);
  const identity = user?.yid ?? user?.userId ?? user?.id;
  const owner = `${accountGeneration}:${isLoggedIn ? identity : 'anonymous'}:${enterprise}`;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [pending, setPending] = useState<{ owner: string; state: SubscriptionTrialState } | null>(null);
  const [otherOpen, setOtherOpen] = useState(true);
  const [requiresLogin, setRequiresLogin] = useState(() => read(FIRST_LOGIN_KEY) === '1');
  const [opening, setOpening] = useState(false);
  const [, languageChanged] = useState(0);
  const shownInSession = useRef(new Set<string>());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => i18nService.subscribe(() => languageChanged(value => value + 1)), []);
  useEffect(() => {
    if (isLoggedIn) {
      write(FIRST_LOGIN_KEY, '0');
      setRequiresLogin(false);
    } else if (privacyAgreed === false) {
      write(FIRST_LOGIN_KEY, '1');
      setRequiresLogin(true);
    }
  }, [isLoggedIn, privacyAgreed]);

  useEffect(() => {
    const update = () => setOtherOpen(otherDialogOpen());
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let fetching = false;
    const current = () => !disposed && ownerRef.current === owner;
    const load = async () => {
      if (fetching || isLoading || privacyAgreed !== true || enterprise
        || (requiresLogin && !isLoggedIn) || (isLoggedIn && identity == null)) return;
      fetching = true;
      try {
        const state = await window.electron.subscriptionTrial.status();
        if (!current()) return;
        if (!state?.active || !state.visible || !state.endAtEpochMs || state.serverTimeEpochMs >= state.endAtEpochMs) {
          setPending(null);
          return;
        }
        const scope = `${POPUP_KEY}:${isTestModeEnabled()}:${state.campaignCode}`;
        const day = beijingDay(state.serverTimeEpochMs);
        const anonymousKey = `${scope}:anonymous`;
        const key = `${scope}:${isLoggedIn ? identity : 'anonymous'}`;
        const sessionKey = `${key}:${day}`;
        const anonymousShown = read(anonymousKey) === day || shownInSession.current.has(`${anonymousKey}:${day}`);
        if (shownInSession.current.has(sessionKey) || read(key) === day) return;
        // Merging an anonymous exposure happens even while another modal is open.
        if (isLoggedIn && anonymousShown) {
          const result = await window.electron.subscriptionTrial.claimPopup({ campaignCode: state.campaignCode, alreadyShown: true });
          if (current() && result) { write(key, day); shownInSession.current.add(sessionKey); }
          return;
        }
        if (!enabledRef.current || otherDialogOpen() || pendingRef.current?.owner === owner) return;
        if (isLoggedIn) {
          const result = await window.electron.subscriptionTrial.claimPopup({ campaignCode: state.campaignCode, alreadyShown: false });
          if (!current() || !result) return;
          if (!result.showPopup) { shownInSession.current.add(sessionKey); return; }
        }
        if (!current()) return;
        write(key, day);
        shownInSession.current.add(sessionKey);
        setPending({ owner, state });
      } finally { fetching = false; }
    };
    const run = () => { void load().catch(() => undefined); };
    run();
    const timer = window.setInterval(run, 30000);
    // Modal closure and app focus trigger an immediate eligibility check.
    const observer = new MutationObserver(() => { if (!otherDialogOpen()) run(); });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('focus', run);
    return () => { disposed = true; clearInterval(timer); observer.disconnect(); window.removeEventListener('focus', run); };
  }, [owner, identity, enterprise, isLoggedIn, isLoading, privacyAgreed, requiresLogin, enabled]);

  const close = () => setPending(null);
  const buy = async () => {
    if (!pending || opening) return;
    const code = pending.state.campaignCode;
    setOpening(true);
    try {
      const state = await window.electron.subscriptionTrial.status();
      if (ownerRef.current !== owner) return;
      if (!state?.visible || state.campaignCode !== code) { close(); return; }
      const result = await window.electron.shell.openExternal(getPortalSubscriptionTrialUrl(code));
      if (result?.success) close();
    } finally { setOpening(false); }
  };
  if (!enabled || otherOpen || !pending || pending.owner !== owner || enterprise) return null;
  return (
    <Modal onClose={close} onEscape={close} overlayClassName="non-draggable fixed inset-0 z-[210] flex items-center justify-center bg-black/50 p-6">
      <section data-subscription-trial role="dialog" aria-modal="true" aria-labelledby="subscription-trial-title"
        className="relative w-[420px] max-w-full rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-700 p-8 text-white shadow-modal">
        <button onClick={close} aria-label={i18nService.t('close')} className="absolute right-4 top-3 text-xl text-white/80">×</button>
        <p className="text-sm text-white/80">{i18nService.t('subscriptionTrialSubtitle')}</p>
        <h2 id="subscription-trial-title" className="mt-3 text-3xl font-semibold">{i18nService.t('subscriptionTrialTitle')}</h2>
        <p className="mt-5 text-sm leading-6 text-white/90">{i18nService.t('subscriptionTrialBenefits')}</p>
        <p className="mt-3 text-xs leading-5 text-white/75">{i18nService.t('subscriptionTrialRules')}</p>
        <button disabled={opening} onClick={() => { void buy().catch(() => undefined); }} className="mt-7 w-full rounded-full bg-lime-200 py-3 font-semibold text-indigo-950 disabled:opacity-60">
          {i18nService.t('subscriptionTrialAction')}
        </button>
        <p className="mt-3 text-center text-xs text-white/75">{i18nService.t('subscriptionTrialRenewal')}</p>
      </section>
    </Modal>
  );
};
export default SubscriptionTrialCampaign;
