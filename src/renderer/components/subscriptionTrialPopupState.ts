import { localStore } from '../services/store';

const DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const POPUP_STATE_KEY = 'subscription_trial.client_popup.v1';

export interface SubscriptionTrialPopupState {
  nextShowAt: number;
  expiresAt: number;
}

export const getSubscriptionTrialPopupKey = (campaignCode: string, testMode: boolean): string => (
  `${POPUP_STATE_KEY}:${testMode}:${campaignCode}`
);

export const nextBeijingDay = (time: number): number => (
  (Math.floor((time + BEIJING_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - BEIJING_OFFSET_MS
);

export async function readSubscriptionTrialPopupState(key: string): Promise<SubscriptionTrialPopupState | null> {
  const value = await localStore.getItem<SubscriptionTrialPopupState>(key);
  return value && Number.isFinite(value.nextShowAt) && Number.isFinite(value.expiresAt) ? value : null;
}

export async function saveSubscriptionTrialPopupState(key: string, value: SubscriptionTrialPopupState): Promise<void> {
  await localStore.setItem(key, value);
}
