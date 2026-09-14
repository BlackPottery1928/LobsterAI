# Third-party OpenClaw plugin patches

`ensure-openclaw-plugins.cjs` applies these patches after copying the pinned
plugins into the runtime. Rebuild/sync the runtime before packaging; changes to
these scripts do not repair an already-installed application.

## POPO SDK imports (`moltbot-popo` 2.1.13)

The plugin's `src/openclaw-sdk.ts` facade uses a private `createRequire()` to
load OpenClaw SDK modules, including top-level reads of `channel-status` and
`reply-history`. If a host `import()` of the same ESM module is pending, the
private synchronous require can throw `ERR_REQUIRE_ESM_RACE_CONDITION` before
the plugin registers its channel. Node 24.15 reports the same condition as
`ERR_INTERNAL_ASSERTION`. Gateway startup can continue without a POPO listener.

`patchPopoSdkImports` replaces only that bounded facade with static ESM imports
for its six SDK subpaths. The SDK remains external and resolves through the
host's resolver or LobsterAI's SDK bridge, preserving shared runtime state.
Plugin registration stays synchronous; no sleeps, restart loops, or private
copies of the SDK are introduced.

The patch checks the plugin version, section boundaries, public bindings, and
SDK subpaths. Unknown layouts fail the build. Repeated application is a no-op.
The existing asynchronous Fabric CLI patches still apply. Remove the SDK patch
when the pinned POPO release provides equivalent ESM imports, after rerunning
the loading and channel smoke checks.

Validation:

```sh
npm test -- openclaw-plugin-patches-popo openclaw-plugin-sdk-bridge
```

The SDK tests use the original 2.1.13 facade and an isolated ESM host. They cover
the original race, cold loading, pending SDK imports, shared host state, helper
arguments, repeated application, CRLF input, and rejection of changed source.
On Windows they also run the loading cases with the app's Electron Node runtime.

Before release, rebuild the target runtime and verify gateway channel startup
and actual POPO replies on the QA Mac and Windows. Cover multiple accounts,
other enabled channels (including Discord), configuration-triggered restarts,
DM/group messages, pairing, and media. A `Fabric tools registered` log by itself
does not prove that the POPO account monitors have started.
