# Shader releases and updates

Shader follows LiveStage’s tagged-release process: GitHub Actions checks versions, runs the engine tests, creates a draft release, builds the app, signs its updater archive, checks `latest.json`, then publishes. A failed build leaves a draft. Published releases are never rebuilt: cut another version.

The release targets are **Windows x64** (NSIS installer) and **Apple silicon macOS 12.1+** (DMG). Both include the native Sony bridge, bundled camera engine/MCP executable, FFmpeg capture runtime and the Shader icon.

## On an installed computer

The app checks for updates 20 seconds after startup and every six hours. Settings announces a new version. Open **Settings → App updates → Check for updates**, review the notes, then **Install … and restart**. Downloads and restarts require this action. Installation checks in-flight camera writes and active preset recalls before and after downloading. Wait for camera changes and recalls to finish first. The updater also shuts its owned camera engine down gracefully before launching the installer, releasing its session lock. Development builds update from git.

Updates retain the app identifier `studio.shader.desktop` and the engine settings in `~/.shader`. Camera connections restart; credentials held only in memory must be entered again.

## Cut a release

Commit your changes on `main`, then:

```sh
npm run release -- patch --notes "What changed"
git push origin HEAD v0.1.2
```

Use `minor`, `major`, or an explicit version instead of `patch`. The command synchronizes `package.json`, `package-lock.json`, `Cargo.toml`, and `Cargo.lock`, commits them, and creates an annotated tag. `tauri.conf.json` reads the version from `package.json`. `--dry-run` changes nothing. CI checks these files against the tag.

Tags with prerelease suffixes publish as prereleases and are not offered to installed apps. To retry an unpublished draft, rerun its failed Actions job or dispatch the Release workflow with the tag.

## Sony SDK builds

The user authorized the Sony Camera Remote SDK license for this application. Each CI runner downloads the official SDK 2.02.00 archive for its platform, verifies the SHA-256 in `native/sony/sdk.json`, and builds the same C++ bridge from source. Mac builds use Clang; Windows builds use MSVC with Unicode SDK types and Windows CRT file descriptors. Vendor sources stay under ignored `native/sony/vendor`; only the required runtime libraries, bridge and third-party notices enter the app. `SONY_SDK_ROOT` and `SONY_SDK_README` allow local licensed SDK overrides.

Windows network connections need no USB driver. Sony USB cameras may require the driver supplied with Sony’s SDK; the app does not install kernel drivers automatically. Hardware connection/readback still needs testing on the actual cameras.

FFmpeg is fetched from the pinned sources and checksums in `scripts/fetch-ffmpeg.ts` and packaged as a sidecar on both platforms. Those builds include x264 under GPL v3; the upstream source for the pinned FFmpeg version is available at https://github.com/FFmpeg/FFmpeg/tree/n9.0.2, with build sources documented by Martin Riedl and gyan.dev. Capture devices still need the appropriate vendor device drivers; Windows DeckLink capture uses a separate native helper built by `npm run build:decklink` and staged in `src-tauri/resources/decklink/`; the Tauri hooks build it automatically using MSVC and MIDL. Desktop Video remains a user-installed prerequisite. The release workflow runs the helper’s hardware-independent WIC JPEG self-test. Other platforms still need a DeckLink-enabled FFmpeg override. See `native/decklink/README.md`.

## Signing

The updater verifies every update against Shader’s public key embedded in `tauri.conf.json`. The separate private key is at `~/.tauri/shader.key` (owner-only permissions) and the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`. This key has an empty password; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` may be omitted. Keep an independent secure backup of the private key. Never commit it or reuse LiveStage’s private key.

Updater signatures are separate from Apple Developer ID signing/notarization. Windows installers are not Authenticode-signed; SmartScreen may require **More info → Run anyway**. Mac installers are **not notarized**. After dragging Shader into Applications, a Mac may require:

```sh
xattr -cr "/Applications/Shader.app"
```

## Local builds

`npm run desktop:build` builds Sony locally and produces the `.app`, `.dmg`, `.app.tar.gz` and updater signature, requiring `TAURI_SIGNING_PRIVATE_KEY` in the build environment. For a local installer without updater artifacts, use `npm run build:installer`.

The published release contains the Windows NSIS installer, Mac DMG installer, signed app update files, `.sig` files and `latest.json` covering both platforms. The app’s existing icon and MCP server are included in the release.

## Recorder Studio packaging

Release builds include the Rust recorder and private GStreamer libraries/plugins on Windows and macOS. Windows uses the official MSVC x64 1.28.8 installer pinned by SHA-256 in `native/recorder/install-windows.ps1`. macOS copies the plugin dependency closure from Homebrew, relocates every non-system Mach-O dependency, retains package licenses/SBOMs/build recipes, and signs the staged files. `RUNTIME.json` records the version. `NOTICE.txt` links upstream source and dependency recipes.

CI checks the staged executable, performs synthetic ProRes/PCM recording with scene markers, and tests worker failure and recovery before packaging. These checks do not qualify a particular PC, disk, Desktop Video driver or eight-input DeckLink load. Recorder Studio is included as a preview pending that on-site qualification.
