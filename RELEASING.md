# Releasing LTX Desktop

## Prerequisites

- Push access to the `main` branch
- Ability to create tags (or use `npm version` which creates them)

## How to create a release

Use `npm version` from the `ltx-video/` directory to bump the version in `package.json` and create a git tag in one step:

```bash
cd ltx-video
npm version 1.0.1        # explicit version
# or: npm version patch   # 1.0.0 → 1.0.1
# or: npm version minor   # 1.0.0 → 1.1.0
# or: npm version major   # 1.0.0 → 2.0.0
cd ..
git push --follow-tags    # pushes the version bump commit + v1.0.1 tag
```

This keeps `package.json` and the tag in sync by design.

## How to create a prerelease

Use semver prerelease identifiers:

```bash
cd ltx-video
npm version 1.1.0-beta.1
cd ..
git push --follow-tags
```

Prerelease versions (any version containing a hyphen, e.g., `1.1.0-beta.1`, `2.0.0-rc.1`) are automatically detected and marked as prerelease on GitHub. Prerelease builds use a separate auto-update channel, so stable users won't receive them.

## What happens automatically

When you push a tag matching `v*.*.*`:

1. **Release gate** validates the tag matches `package.json` and creates a **draft** GitHub Release
2. **Build** runs in parallel on macOS and Windows, producing signed installers
3. electron-builder uploads installers and auto-update manifests directly to the draft release
4. **Finalize** verifies the expected assets are present and un-drafts the release

Users see nothing until the finalize step completes. If any platform fails, the draft stays as-is for investigation.

## Testing a build before release

Every push to `main` triggers a full build on both platforms. To test:

1. Push or merge to `main`
2. Go to the [Actions tab](../../actions) and find the latest "Release" run
3. Download the `release-macos` or `release-windows` artifact
4. Test the installer locally
5. If issues are found, fix and push again — a new build starts automatically

You can also trigger a build manually via the **Run workflow** button on the Actions page.

## Troubleshooting

### Build failed during a release

The draft release stays on GitHub. To retry:

1. Delete the failed draft release from the [Releases page](../../releases)
2. Delete the tag: `git push origin :refs/tags/v1.0.1`
3. Fix the issue and re-tag:
   ```bash
   cd ltx-video
   npm version 1.0.1
   cd ..
   git push --follow-tags
   ```

### Version mismatch error

The `release-gate` job checks that the tag version matches `package.json`. If they're out of sync, always use `npm version` to set both at once (see above).

### Cleaning up failed drafts

```bash
gh release delete v1.0.1 --yes
git push origin :refs/tags/v1.0.1
```

## Code signing

Code signing is **not yet configured**. The workflow has placeholder environment variables ready to enable:

- **macOS**: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- **Windows**: `CSC_LINK`, `CSC_KEY_PASSWORD`

Add these as GitHub Actions secrets and uncomment the `env:` blocks in `release.yml` to enable signing.

Without code signing, users will see OS-level warnings when installing (Gatekeeper on macOS, SmartScreen on Windows).

## Auto-updates

LTX Desktop uses `electron-updater` to check for new releases. When electron-builder publishes to a GitHub Release, it uploads manifest files (`latest.yml` for Windows, `latest-mac.yml` for macOS) containing checksums and file sizes. The app checks these manifests on launch to detect available updates.

Update channels:
- **latest** (stable): Users on stable versions receive updates from non-prerelease GitHub Releases
- **beta/alpha**: Users who opt into prerelease channels receive updates from prerelease GitHub Releases
