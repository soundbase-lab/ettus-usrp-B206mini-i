# Running your plugin in SoundBase

Everything up to here works without SoundBase installed. This page is the last
step: getting your plugin into the app and seeing its trace on the plot.

## Before you start

- **SoundBase Desktop.** Plugins are spawned by the desktop app. There is no
  browser path — the browser cannot reach your USB cable.
- **The `plugin-system` feature flag,** enabled for your account. Third-party
  drop-in plugins are gated behind it while the plugin system is in
  development. Ask your SoundBase contact to switch it on; without it your
  plugin is scanned, listed as disabled, and never spawned.

## Installing it — through the Lab

SoundBase installs plugins from the **Lab**, and that is the development flow
too: what you run inside SoundBase is a release you tagged, installed the way
a user's copy is installed. There is no folder to copy and no path to point
the app at.

1. **Cut a release.** *Actions → Release → Run workflow* with `bump` set to
   `patch`, `minor` or `major`; CI bumps, tags, checks and publishes a GitHub
   Release with the zip attached. [publishing.md](publishing.md) has every
   route and every rule the zip has to satisfy.
2. **Add it on the Lab's develop page.** Repository URL and the tag. The entry
   is private to your account — never listed, never moderated, invisible to
   anyone else — and the release is resolved exactly as a public one would be.
3. **Install it in SoundBase Desktop.** *Settings → Plugins* shows the entry
   with a *development* badge. Install downloads the zip, verifies it, boots
   it once as a probe and only then moves it into place.
4. **Iterate.** Tag the next version, re-point the develop entry at it, press
   *Update* in the Plugins tab.

**The dependencies travel in the zip.** SoundBase runs `main.js` as-is and
installs nothing, so a zip packed without `node_modules/` fails at its first
import, which looks exactly like a plugin that never handshakes. `npm run
pack:release` and the Release workflow include them; the boot probe catches a
zip that does not.

## The plugin manager

Once it is installed and the flag is on, your plugin appears in
**Settings → Plugins**, where a user can:

- see its name, version and status, and any manifest error that stopped it;
- enable or disable it (disabled plugins are not spawned);
- fill in the `pluginConfigFields` your manifest declares;
- read its log;
- update it, after you have re-pointed the develop entry at a new tag.

A plugin whose manifest fails validation is listed with its error rather than
silently skipped — one bad drop-in never stops the others.

## Seeing a device

Your devices appear where every other live-scan device appears:

1. Open a project in **Coord** and go to the plot.
2. In the plot's control bar, open the gear in the live-scan group — **Open
   Live Scan Data Settings**.
3. Your discovered devices are in the **Select a device** dropdown, named by
   what `discoverDevices` returned. Products that need addressing typed in
   appear as an "add a device" option, with the form your
   `deviceConfigFields` describe.
4. Save, then press **Live** to start sweeping. Your trace draws on the plot,
   and the sweep parameters (start/stop/centre/span, RBW, points, and any
   controls your adapter declared) are in the same dialog.

Device assignment is **per zone**, so a site can run several analyzers at once
and yours may be one of them.

## Reading the logs

Every line your plugin writes to stdout after the handshake is captured by the
host, per plugin:

| | |
|---|---|
| macOS | `~/Library/Application Support/SoundBase Desktop/pluginLogs/<id>.log` |
| Windows | `%APPDATA%\SoundBase Desktop\pluginLogs\<id>.log` |
| Linux | `~/.config/SoundBase Desktop/pluginLogs/<id>.log` |

The same lines are shown in the plugin manager. The shell prefixes its own with
a timestamp and level; `this.log('info', …)` from your plugin class joins them.

The first two lines after a successful start tell you which build is running:

```
[info] my-plugin 0.3.0 listening on 127.0.0.1:54321
[info] generated from soundbase-plugin-template 1.0.0
```

For a packed release that second line reads `packed sha256:… at <date>
(contract core 1.1, SpectrumAnalyzer 1.0)` instead — which is how support
works out *which copy* of your plugin a user is running.

## What the host does to your process

| | |
|---|---|
| Spawn | `main.js`, with `SB_PLUGIN_TOKEN` in the environment |
| Handshake | 10 s to print `SB_PLUGIN_READY`, then it gives up |
| Health | `GET /health` every 5 s; 3 consecutive failures counts as a crash |
| Restart | backoff 1, 2, 4, 8, 16 s; 5 restarts, then it stays down |
| Shutdown | best-effort `DELETE /devices`, then `SIGTERM`, then `SIGKILL` |

Enabling and disabling a plugin, and switching projects, both go through the
same path.

## When it does not appear

Work through [troubleshooting.md](troubleshooting.md). The short version: run
`npm run doctor` and then `npm run smoke` in the plugin folder — between them
they cover every failure that produces no visible error at all.
