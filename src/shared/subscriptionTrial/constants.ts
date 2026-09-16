export const SubscriptionTrialIpc = {
  Status: 'subscription-trial:status',
  ClaimPopup: 'subscription-trial:claim-popup',
} as const;

export const SubscriptionTrialApi = {
  Status: '/api/subscription-trial',
  ClaimPopup: '/api/subscription-trial/popup/claim',
} as const;

export interface SubscriptionTrialState {
  campaignCode: string;
  active: boolean;
  visible: boolean;
  eligible: boolean;
  serverTimeEpochMs: number;
  endAtEpochMs: number | null;
  showPopup?: boolean;
}

export interface SubscriptionTrialPopupInput {
  campaignCode: string;
  alreadyShown: boolean;
}

export interface SubscriptionTrialBridge {
  status: () => Promise<SubscriptionTrialState | null>;
  claimPopup: (input: SubscriptionTrialPopupInput) => Promise<SubscriptionTrialState | null>;
}
