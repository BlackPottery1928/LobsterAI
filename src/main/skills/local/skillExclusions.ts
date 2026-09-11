/**
 * Fork-local skills excluded from this build.
 *
 * Every skill listed here is hidden from the skills UI, from the IM auto-routing
 * prompt, and from OpenClaw's `skills.entries`, so it can neither be invoked nor
 * loaded by the gateway. The skill directories stay on disk: excluding at this
 * layer keeps the fork's diff to two one-line hooks instead of deleting bundled
 * content that upstream keeps changing.
 *
 * Most entries are here because they need public internet. Each entry's `reason`
 * is the authority on why it was removed, not this comment.
 *
 * See ./README.md for what to re-check after merging upstream.
 */

export interface ExcludedSkill {
  /** Skill directory name, used to filter the skill list. */
  id: string;
  /**
   * The SKILL.md frontmatter `name`, used for OpenClaw `skills.entries` keys.
   * OpenClaw resolves entries through `resolveSkillKey()`, which keys off the
   * frontmatter name — for some skills this differs from the directory name.
   */
  name: string;
  /** Why the skill is excluded. Kept for compliance review. */
  reason: string;
}

export const EXCLUDED_SKILLS: readonly ExcludedSkill[] = [
  {
    id: 'web-search',
    name: 'web-search',
    reason: 'Real-time web search through a Playwright-controlled browser; requires public internet.',
  },
  {
    id: 'technology-news-search',
    name: 'technology-search',
    reason: 'Fetches 36kr, Hacker News, dev.to and other public tech sites.',
  },
  {
    id: 'daily-trending',
    name: 'daily-trending',
    reason: 'Fetches trending boards from tophub.today.',
  },
  {
    id: 'content-planner',
    name: 'content-planner',
    reason: 'Searches WeChat public accounts through Sogou.',
  },
  {
    id: 'films-search',
    name: 'films-search',
    reason: 'Searches public cloud drives for film and TV resources.',
  },
  {
    id: 'music-search',
    name: 'music-search',
    reason: 'Searches public cloud drives for music resources.',
  },
  {
    id: 'seedance',
    name: 'seedance',
    reason: 'Calls the Volcengine Ark video API at ark.cn-beijing.volces.com.',
  },
  {
    id: 'seedream',
    name: 'seedream',
    reason: 'Calls the Volcengine Ark image API at ark.cn-beijing.volces.com.',
  },
  {
    id: 'youdaonote',
    name: 'youdaonote',
    reason: 'Calls the Youdao Note public API.',
  },
  {
    id: 'stock-explorer',
    name: 'stock-explorer',
    reason: 'Fetches OHLCV data from Yahoo Finance via yfinance.',
  },
  {
    id: 'stock-analyzer',
    name: 'stock-analyzer',
    reason: 'Fetches Yahoo Finance data via yfinance.',
  },
  {
    id: 'stock-announcements',
    name: 'stock-announcements',
    reason: 'Downloads disclosure PDFs from pdf.dfcfw.com.',
  },
  {
    id: 'weather',
    name: 'weather',
    reason: 'Calls api.open-meteo.com and wttr.in.',
  },
  {
    id: 'imap-smtp-email',
    name: 'imap-smtp-email',
    reason: 'Reads and sends mail through external IMAP/SMTP servers.',
  },
  {
    id: 'skill-vetter',
    name: 'skill-vetter',
    reason: 'Queries api.github.com and raw.githubusercontent.com.',
  },
  {
    id: 'develop-web-game',
    name: 'develop-web-game',
    reason: 'Drives a Playwright browser loop; needs the Playwright CLI and browser binaries from public package/browser CDNs.',
  },
  {
    id: 'remotion',
    name: 'remotion-best-practices',
    reason: 'Needs the Remotion npm package from the public registry; its rules reference remotion.media assets.',
  },
  {
    id: 'skin-creator',
    name: 'skin-creator',
    reason: 'Removed by product decision together with the AI Skin Designer kit, which loads its bundle and icon from public CDNs.',
  },
];

const buildIdSet = (): ReadonlySet<string> => new Set(EXCLUDED_SKILLS.map(skill => skill.id));

const buildEntryOverrides = (): Record<string, { enabled: false }> => {
  const overrides: Record<string, { enabled: false }> = {};
  for (const skill of EXCLUDED_SKILLS) {
    overrides[skill.name] = { enabled: false };
  }
  return overrides;
};

export const EXCLUDED_SKILL_IDS: ReadonlySet<string> = buildIdSet();

/** True when the skill directory name is excluded from this build. */
export const isSkillExcluded = (id: string): boolean => EXCLUDED_SKILL_IDS.has(id);

/**
 * Force-disable overrides merged into OpenClaw's `skills.entries`, so the
 * gateway does not re-discover these skills through `skills.load.extraDirs`.
 */
export const EXCLUDED_SKILL_ENTRY_OVERRIDES: Record<string, { enabled: false }> = buildEntryOverrides();
