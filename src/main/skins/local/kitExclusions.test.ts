import { describe, expect, test } from 'vitest';

import { ComputerUseKitId } from '../../../shared/computerUse/constants';
import { SkinPackKitId } from '../../../shared/skin/kit';
import { createSkinPackKitLifecycle } from '../skinPackKitLifecycle';
import { EXCLUDED_KIT_IDS, EXCLUDED_KITS, isKitExcluded } from './kitExclusions';

/**
 * Remote kit ids only exist in the LobsterAI kit store, so they cannot be
 * checked against a constant here; this at least catches whitespace, casing,
 * and copy-paste damage.
 */
const KIT_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('EXCLUDED_KITS', () => {
  test('has no duplicate ids', () => {
    const ids = EXCLUDED_KITS.map(kit => kit.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('uses well-formed kit ids', () => {
    const malformed = EXCLUDED_KITS.filter(kit => !KIT_ID_PATTERN.test(kit.id)).map(kit => kit.id);
    expect(malformed).toEqual([]);
  });

  test('records a reason for every entry', () => {
    const missing = EXCLUDED_KITS.filter(kit => !kit.reason.trim()).map(kit => kit.id);
    expect(missing).toEqual([]);
  });
});

describe('isKitExcluded', () => {
  test('matches the excluded id set', () => {
    expect([...EXCLUDED_KIT_IDS].sort()).toEqual(EXCLUDED_KITS.map(kit => kit.id).sort());
  });

  test('reports the AI Skin Designer kit as excluded', () => {
    expect(isKitExcluded(SkinPackKitId.BuiltIn)).toBe(true);
  });

  test('reports the remote Bio Research kit as excluded', () => {
    expect(isKitExcluded('bio-research')).toBe(true);
  });

  test('reports kits that are not listed as available', () => {
    expect(isKitExcluded(ComputerUseKitId.BuiltIn)).toBe(false);
    expect(isKitExcluded('some-remote-kit')).toBe(false);
  });
});

describe('kit store filtering', () => {
  const buildLifecycle = () => createSkinPackKitLifecycle({
    getStore: () => ({ get: () => undefined, set: () => undefined }),
    getSkillManager: () => ({
      listSkills: () => [],
      setSkillEnabled: () => undefined,
      startWatching: () => undefined,
      stopWatching: () => undefined,
      syncBundledSkillsToUserData: () => undefined,
    }),
    notifySkillsChanged: () => undefined,
    syncOpenClawConfig: async () => ({ success: true, changed: false }),
  });

  type Catalog = { kits: Array<{ id: string }> };

  // The online path keeps `value` as a JSON string; the offline fallback passes
  // it through as an object.
  const readCatalogIds = (response: string): string[] => {
    const envelope = JSON.parse(response) as { data: { value: string | Catalog } };
    const catalog: Catalog = typeof envelope.data.value === 'string'
      ? JSON.parse(envelope.data.value) as Catalog
      : envelope.data.value;
    return catalog.kits.map(kit => kit.id);
  };

  test('drops an excluded kit that the remote catalog ships', () => {
    const response = buildLifecycle().appendToStoreResponse(JSON.stringify({
      data: {
        value: JSON.stringify({
          kits: [{ id: 'bio-research' }, { id: 'design' }],
        }),
      },
    }));

    expect(readCatalogIds(response)).toEqual(['design']);
  });

  test('keeps remote kits that are not excluded', () => {
    const response = buildLifecycle().appendToStoreResponse(JSON.stringify({
      data: {
        value: JSON.stringify({
          kits: [{ id: 'engineering' }, { id: 'legal' }],
        }),
      },
    }));

    expect(readCatalogIds(response)).toEqual(['engineering', 'legal']);
  });

  test('does not offer the excluded built-in kit in the offline catalog', () => {
    const response = buildLifecycle().buildOfflineStoreResponse();

    expect(readCatalogIds(response)).not.toContain(SkinPackKitId.BuiltIn);
  });
});
