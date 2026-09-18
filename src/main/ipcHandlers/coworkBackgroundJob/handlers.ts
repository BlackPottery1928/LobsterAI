import { ipcMain } from 'electron';

import type { BackgroundJobKillResult, CoworkBackgroundJob } from '../../../shared/cowork/backgroundJobs';
import { CoworkIpcChannel } from '../../../shared/cowork/constants';

export interface CoworkBackgroundJobEngineRouter {
  listBackgroundJobs: (sessionId: string) => Promise<CoworkBackgroundJob[]>;
  killBackgroundJob: (sessionId: string, jobId: string) => Promise<BackgroundJobKillResult>;
  clearSettledBackgroundJobs: (sessionId: string) => Promise<CoworkBackgroundJob[]>;
}

export interface CoworkBackgroundJobHandlerDeps {
  getCoworkEngineRouter: () => CoworkBackgroundJobEngineRouter;
}

const readSessionId = (options: { sessionId?: unknown } | undefined): string =>
  typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';

export function registerCoworkBackgroundJobHandlers(deps: CoworkBackgroundJobHandlerDeps): void {
  const { getCoworkEngineRouter } = deps;

  ipcMain.handle(
    CoworkIpcChannel.BackgroundJobList,
    async (_event, options: { sessionId?: unknown }) => {
      const sessionId = readSessionId(options);
      if (!sessionId) return { success: false, error: 'sessionId is required', jobs: [] };
      try {
        const jobs = await getCoworkEngineRouter().listBackgroundJobs(sessionId);
        return { success: true, jobs };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list background jobs',
          jobs: [],
        };
      }
    },
  );

  ipcMain.handle(
    CoworkIpcChannel.BackgroundJobKill,
    async (_event, options: { sessionId?: unknown; jobId?: unknown }) => {
      const sessionId = readSessionId(options);
      const jobId = typeof options?.jobId === 'string' ? options.jobId.trim().slice(0, 128) : '';
      if (!sessionId || !jobId) return { success: false, error: 'sessionId and jobId are required' };
      try {
        const result = await getCoworkEngineRouter().killBackgroundJob(sessionId, jobId);
        return { success: true, ...result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to stop background job',
        };
      }
    },
  );

  ipcMain.handle(
    CoworkIpcChannel.BackgroundJobClearSettled,
    async (_event, options: { sessionId?: unknown }) => {
      const sessionId = readSessionId(options);
      if (!sessionId) return { success: false, error: 'sessionId is required', jobs: [] };
      try {
        const jobs = await getCoworkEngineRouter().clearSettledBackgroundJobs(sessionId);
        return { success: true, jobs };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to clear background jobs',
          jobs: [],
        };
      }
    },
  );
}
