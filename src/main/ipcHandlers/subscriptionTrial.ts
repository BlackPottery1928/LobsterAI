import type { IpcMainInvokeEvent } from 'electron';

import {
  SubscriptionTrialApi,
  SubscriptionTrialIpc,
  type SubscriptionTrialPopupInput,
  type SubscriptionTrialState,
} from '../../shared/subscriptionTrial/constants';
import type { ActivityIpcHandlerDeps } from './activity/handlers';

export function registerSubscriptionTrialIpcHandlers(deps: ActivityIpcHandlerDeps): void {
  const requireMainRenderer = (event: IpcMainInvokeEvent): void => {
    const window = deps.getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted trial sender');
  };
  async function request(path: string, body?: SubscriptionTrialPopupInput): Promise<SubscriptionTrialState | null> {
    if (body && !deps.hasAuthTokens()) return null;
    const fetcher = deps.hasAuthTokens() ? deps.fetchWithAuth : deps.fetchPublic;
    try {
      const response = await fetcher(`${deps.getServerBaseUrl()}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json() as { code: number; data?: SubscriptionTrialState };
      return response.ok && result.code === 0 && result.data ? result.data : null;
    } catch { return null; }
  }
  deps.ipcMain.handle(SubscriptionTrialIpc.Status, (event) => {
    requireMainRenderer(event);
    return request(SubscriptionTrialApi.Status);
  });
  deps.ipcMain.handle(SubscriptionTrialIpc.ClaimPopup, (event, input: SubscriptionTrialPopupInput) => {
    requireMainRenderer(event);
    if (!input || typeof input.campaignCode !== 'string' || !input.campaignCode
      || input.campaignCode.length > 64 || typeof input.alreadyShown !== 'boolean') {
      throw new Error('Invalid trial popup request');
    }
    return request(SubscriptionTrialApi.ClaimPopup, input);
  });
}
