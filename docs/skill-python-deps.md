# Bundled skill Python dependencies

The Windows installer ships a portable CPython runtime at `resources/python-win`.
`scripts/setup-python-runtime.js` prepares the interpreter only; this feature adds
a build-time step that also preinstalls the Python packages the shipped skills
need, so a freshly installed app never has to reach the network.

| Path | Role |
|---|---|
| `SKILLs/python-deps.json` | Package → exact version. Hand-edited, committed. The single source of truth. |
| `scripts/skill-python-deps.cjs` | Config validation, manifest id. |
| `scripts/setup-skill-python-deps.js` | Resolve, download, install, verify, write the manifest. |
| `.cache/pip-wheelhouse/` | Local wheel cache (gitignored; see "The wheel cache" below). |

Windows only. macOS and Linux do not bundle a Python runtime, so the step logs
`Windows-only capability; skipping on <platform>` and exits 0. `dist:mac*` and
`dist:linux` are untouched.

**There is no lock file.** The config's pins are the single source of truth and
pip resolves the transitive closure at build time. The trade-off, accepted
deliberately in exchange for a much smaller surface: installs are not
hash-verified, so a rebuild can pick up a newer transitive dependency of an
unchanged pin, and an offline wheel cache is validated by resolving against it
rather than by comparing hashes.

## Adding or changing a package

`SKILLs/python-deps.json` is a flat table — no groups, no skill mapping, no
default set, no lock. Adding a package is one line:

```jsonc
{
  "version": 1,
  "target": { "platform": "win_amd64", "implementation": "cp", "pythonVersion": "311" },
  "packages": {
    "requests": "==2.34.2",
    "lxml": "==6.1.3"
  }
}
```

To add a package whose version you don't know, put `"==0.0.0"` as a placeholder and
resolve it:

```bash
npm run skill-python-deps:resolve   # == --resolve --write
```

That runs one pip resolution pass for the whole set against the target platform
(`--only-binary=:all: --platform win_amd64 --python-version 311 --implementation
cp`), prints what would change, and writes the resolved versions into the config.
Resolving everything together is what keeps the set self-consistent: two declared
packages that share a dependency cannot end up disagreeing about its version.

To bump a version, edit it by hand and then run the same command: it re-verifies
the pin against the index. A pin the index cannot satisfy fails the command.

### Rules enforced at build time

Each is a hard failure, so a misconfiguration cannot ship:

- **Every version is an exact `==` pin.** `>=`, `~=`, `*`, `!=`, environment
  markers and `name @ url` forms are rejected. Packaged builds must be
  reproducible.
- **The version must be resolved.** `==0.0.0` is the "not resolved yet"
  placeholder and is rejected; `--resolve --write` fills it from the index. A
  version is never invented by hand.
- **No package LobsterAI owns inside the runtime.** `pip`, `setuptools` and
  `wheel` are refused in code (`DENIED_PACKAGES`), not by config: installing any
  of them overwrites the pip shim at `Lib/site-packages/pip`. That shim is
  byte-identity-checked between `scripts/setup-python-runtime.js` and
  `src/main/libs/pythonPipShim.ts` by `pythonPipShim.test.ts` — do not edit either.

### The other direction: coverage

`tests/skillPythonDepsCoverage.test.ts` walks the shipped skills' Python sources
and fails on any third-party import the table does not provide. That is what
keeps a flat hand-maintained list honest: adding `import foo` to a shipped skill
forces a decision — pin it, or record it in `INTENTIONALLY_NOT_BUNDLED` with a
reason. It also catches a package that is preinstalled but no longer needed.

## What is deliberately not bundled

Documented here because the config no longer records it. Each of these was a
decision, not an oversight:

| Package | Why not |
|---|---|
| `anthropic` | Only `skill-creator`'s evaluation scripts (`run_loop.py`, `improve_description.py`) import it. Its closure pulls native `pydantic-core` + `jiter`, ~22 MB unpacked — roughly two thirds of the whole dependency budget for a feature most users never touch. **Consequence: those two scripts cannot run offline.** Installing it needs network access. Recorded in the coverage test. |
| `markitdown[pptx]` | Pulls magika → onnxruntime (~100 MB). `pptx/SKILL.md` already documents it as optional. |
| `pytesseract` | Needs the tesseract binary, which is not a pip package. |
| poppler | `pdf2image` shells out to `pdftoppm`; not distributable through pip. |
| tesseract | OCR of scanned documents; not a pip package. |
| LibreOffice | Some document-to-PDF conversions in `docx` / `pptx`; not a pip package. |

The non-pip entries cannot be solved by pip at all — the affected skills need the
user to provide the binary.

## Building

```bash
npm run setup:python-runtime        # interpreter into resources/python-win
npm run setup:skill-python-deps     # pinned packages into it (needs the above first)
npm run dist:win                    # chains both, then packs
```

Useful flags:

| Flag | Effect |
|---|---|
| `--required` | Fail (non-zero exit) instead of warning and skipping. Used by the packaging chain. |
| `--resolve [--write]` | Refresh the pins in the config from the package index. |
| `--offline` | Never touch the network; fail if the wheel cache cannot satisfy the set. |
| `--wheelhouse <dir>` | Wheel cache directory (default `.cache/pip-wheelhouse`). |
| `--verify-only` | Skip download and install; just verify the runtime. |
| `--force` | Bypass the "manifest id already matches" shortcut. |

Environment overrides, following the `LOBSTERAI_PORTABLE_PYTHON_*` convention:

| Variable | Effect |
|---|---|
| `LOBSTERAI_SKILL_PYTHON_DEPS_SKIP=1` | Skip preinstalling entirely — build an interpreter-only runtime, as before. |
| `LOBSTERAI_SKILL_PYTHON_WHEELHOUSE` | Wheel cache directory. |
| `LOBSTERAI_SKILL_PYTHON_INDEX_URL` | Internal mirror (`--index-url`). |
| `LOBSTERAI_SKILL_PYTHON_FIND_LINKS` | Extra `--find-links` source for downloads. |
| `LOBSTERAI_SKILL_PYTHON_RUNTIME_DIR` | Target runtime root. |

These are build caches, not channel state — deliberately **not** added to
`scripts/build-env.cjs`'s `BuildEnv`, whose values channel builds scrub.

### How the two pip steps split

The install step always runs `pip install --no-index --find-links <cache>`, so it
never needs the network. The only step that can reach out is the download step,
which runs when the cache cannot satisfy the set:

```
preflight:  pip install --dry-run --ignore-installed --no-index --find-links <cache> <pins>
            -> satisfiable: skip the download
            -> not satisfiable and --offline: fail
            -> not satisfiable: pip download --only-binary=:all: --platform ... -d <cache> <pins>
```

The preflight resolves the full transitive closure against the cache directory, so
it verifies real availability rather than just checking that some wheel files
exist. `--ignore-installed` is load-bearing: without it pip answers "requirement
already satisfied" using whatever the target runtime happens to have installed,
which would make an empty cache look complete.

## Network-isolated builds

The first build needs PyPI (or `LOBSTERAI_SKILL_PYTHON_INDEX_URL`). After that the
wheel cache makes builds work offline:

1. On a connected machine run the setup once, or copy `.cache/pip-wheelhouse/`
   from a machine that did.
2. Build with `--offline`, or just let the preflight short-circuit: it skips
   downloading when the cache already satisfies the declared pins.

A `--required` build with an empty cache and no network fails loudly on purpose.
Shipping an installer whose skills are missing their dependencies is worse than
failing the build.

## The wheel cache

`.cache/pip-wheelhouse/` is gitignored and lives **outside** `resources/` and
`SKILLs/` on purpose. Both of those directories feed the installer
(`extraResources` on mac/linux, the Windows resource tar), so a cache inside
either is one broad `resources/**` glob away from shipping ~18 MB of wheels that
are already unpacked into the runtime. `tests/skillPythonDeps.test.ts` asserts the
location, that no packaging config or hook mentions it, and that it is gitignored.

## How the runtime picks this up

Nothing extra is needed at runtime. `Lib/site-packages` is already on `sys.path`
via the embedded `python311._pth`, so the packages travel along the existing path:
runtime tree → `win-resources.tar` → install dir →
`userData/runtimes/python-win`. See
`specs/features/skill-python-deps-bundling/2026-09-26-skill-python-deps-bundling-design.md`.

The one runtime change is a fingerprint so existing installs get the new packages:
the build writes `resources/python-win/python-deps-manifest.json` with a
`manifestId` (a hash of the pins and the script version — deliberately excluding
the timestamp, or every release would force every install to re-copy tens of
megabytes). `src/main/libs/pythonRuntime.ts` re-syncs the user runtime when the
bundled id differs from the one recorded in `runtime.json`. A missing or
malformed manifest reads as "no manifest" and never triggers a re-sync.

## Not covered: user-installed packages

There is no supported way for a user to add Python packages for their own skills.
Only the built-in set above is preinstalled, and the runtime tree is deleted and
recopied on every re-sync, so anything dropped into
`userData/runtimes/python-win` does not survive an upgrade. Users who need extra
packages today have to install them per-skill, which means a network install at
first use — the exact problem this feature solves for the built-in skills.

## Verifying a build

```bash
# Interpreter, pip shim and imports, on the prepared runtime
resources/python-win/python.exe -m pip --version
resources/python-win/python.exe -c "import lxml.etree, defusedxml, docx, pptx, PIL, pypdf, openpyxl, yaml, six, requests, pdf2image"

# Idempotency: second run must be a fast no-op
node scripts/setup-skill-python-deps.js

# Pure offline
node scripts/setup-skill-python-deps.js --offline --force
```

Worth doing before a release: extract `build-tar/win-resources.tar` and run the
import check against the extracted `python-win`. It catches problems the tar
listing cannot — the tar packer drops `tests/`, `readme*`, `license*` and similar
files from every source, including `site-packages`.

## Tests

```bash
npm test -- skillPythonDeps            # config validation, manifest id, wheel cache stays out of packages
npm test -- skillPythonDepsCoverage    # shipped skills' imports are all covered
npm test -- pythonRuntime              # re-sync decision, manifest reading
npm test -- windowsInstallerContract   # pins the dist:win prefix; re-run after editing package.json
```
