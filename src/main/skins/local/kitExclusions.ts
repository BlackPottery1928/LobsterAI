import { SkinPackKitId } from '../../../shared/skin/kit';

/**
 * Fork-local kit exclusions.
 *
 * Excluded kits are dropped from the kit store response (both the incoming
 * remote catalog and the built-in list), so they are neither listed nor
 * installable. The kit lifecycle code stays in place: excluding at this layer
 * keeps the fork's diff to two small hooks instead of deleting upstream code.
 *
 * An id may name a built-in kit that is defined in this repo, or a remote kit
 * that only the LobsterAI kit store knows about — `bio-research` is the latter,
 * so the kit store catalog is the only place its id is spelled out upstream.
 *
 * See ../../skills/local/README.md for the fork-local convention and the merge
 * checklist.
 */

export interface ExcludedKit {
  /** Kit id as it appears in the kit store and `kits_installed`. */
  id: string;
  /** Why the kit is excluded. Kept for compliance review. */
  reason: string;
}

export const EXCLUDED_KITS: readonly ExcludedKit[] = [
  {
    id: SkinPackKitId.BuiltIn,
    reason:
      'Removed together with its skin-creator skill; the kit icon and bundle are served from public CDNs.',
  },
  {
    id: 'bio-research',
    reason: 'Removed by product decision. Remote kit shipped by the LobsterAI kit store.',
  },
];

const buildIdSet = (): ReadonlySet<string> => new Set(EXCLUDED_KITS.map(kit => kit.id));

export const EXCLUDED_KIT_IDS: ReadonlySet<string> = buildIdSet();

/** True when the kit is excluded from this build. */
export const isKitExcluded = (id: string): boolean => EXCLUDED_KIT_IDS.has(id);
