# Fork-local code

`local/` directories hold code that belongs to this fork, not to upstream
LobsterAI. They exist so fork-specific changes stay out of files upstream also
edits, which keeps merges small. A `local/` directory sits next to the module it
hooks, so a merge conflict points straight at the behaviour that was changed.

There are two:

| Directory | Excludes | Documented here |
| --- | --- | --- |
| `src/main/skills/local/` | bundled skills | this file |
| `src/main/skins/local/` | expert kits | this file |

## What is here

### `src/main/skills/local/skillExclusions.ts`

The list of bundled skills removed from this build. Most are excluded because
they require public internet access; each entry's `reason` records the specific
justification. Excluded skills are filtered out of `SkillManager.listSkills()`
and force-disabled in OpenClaw's `skills.entries`.

Two one-line hooks consume it:

- `src/main/skills/skillManager.ts` → `listSkills()` skips excluded ids.
- `src/main/libs/openclawConfigSync.ts` → `skills.entries` spreads
  `EXCLUDED_SKILL_ENTRY_OVERRIDES`.

### `src/main/skins/local/kitExclusions.ts`

The list of expert kits removed from this build. Excluded kits are dropped from
the kit store response, both the incoming remote catalog and the built-in list,
and are rejected by the install handler. Existing installs of an excluded kit
are left alone — uninstall still works.

An excluded id may be a built-in kit defined in this repo, or a remote kit that
only the kit store knows about. To find the id of a remote kit named in the UI,
fetch `getKitStoreUrl()` (`src/main/libs/endpoints.ts:93`) and read the catalog —
the ids are not in this repo.

Two hooks consume it, both in `src/main/skins/skinPackKitLifecycle.ts`:

- `appendToStoreResponse()` drops excluded ids from the built-in list and from
  the remote catalog payload.
- `installIfHandled()` throws instead of installing an excluded kit.

`skinPackKitLifecycle.test.ts` skips four cases via
`test.skipIf(skinKitIsExcluded)`; they assert behaviour that only exists while
the AI Skin Designer kit is available, and resume on their own if it is ever
un-excluded.

Both sets of hooks sit next to the existing pattern they mirror: `listSkills()`
already skips `computer-use` conditionally, `MANAGED_SKILL_ENTRY_OVERRIDES`
already force-disables three OpenClaw skills, and `appendToStoreResponse()`
already de-duplicates built-in kits against the remote payload.

## After merging upstream

1. Run `npm test -- skillExclusions` and `npm test -- kitExclusions`. They fail
   if upstream renamed or removed an excluded skill, changed a frontmatter `name`
   so it no longer matches the list, or added a kit id the list does not know.
2. Review skills and kits upstream added since the last merge. Check each for
   outbound network calls (search engines, cloud APIs, finance data, mail
   servers, public CDNs) and add the offenders to the relevant list.
3. Confirm every hook is still in place — a merge conflict resolved the wrong way
   can silently drop one.
4. Run the full suite. `npm test -- skin` catches the skip guards above if
   upstream reworked the skin pack lifecycle.

Skill directories, kit lifecycle code, and `SKILLs/skills.config.json` are
intentionally left untouched, so excluded skills stay in the bundled-id allowlist
and remain non-deletable by users.
