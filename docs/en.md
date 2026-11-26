# Browser state sync

Some plugin settings in this app exist only in `localStorage`: keybindings, the right sidebar's tab layout, the last tab selected in the schedule panel, the plugin-market registry choice. Clear site data once, open the same Harness through a second address (a default port and a reverse proxy port are two different origins), or switch browsers, and those settings are gone.

This bundle keeps them in one JSON file on the Host and writes them back **before the page boots**:

```
$DSH_HOME/localstate-sync/state.json
```

中文说明：[README.md](../README.md)

## How it works

1. **Capture.** The client bundle wraps `Storage.prototype.setItem / removeItem / clear`. It only records writes where `this === window.localStorage` and the key matches the allowlist. The original is always called first, its own bookkeeping sits in `try/catch`, and the original's exception behavior is unchanged. A 400 ms debounce batches the recorded changes into one `POST`.
2. **Persist.** The Host route `POST /api/localstate.v1` merges each key into the JSON document and assigns it a monotonically increasing `at` revision. Writes are atomic (`tmp` + `rename`), the file is mode `0600`, and bursts are coalesced over 120 ms.
3. **Restore.** `webserver/index-inject` writes the snapshot into `<head>` as `globalThis.__DSH_LOCALSTATE__`, immediately followed by an inline script that seeds `localStorage` from it **before the application boots**. No reload is needed, and no plugin can win the race by reading an old value during its own initialization.
4. **No fighting.** The browser keeps `__dsh.localstate.meta.v1`, recording the revision it has applied per key, and writes a value back only when the Host revision is newer. Deletes are stored as tombstones (`null`), so a deleted key does not come back on the next start.
5. **Visible conflicts.** Every write carries the revision it was built on (`base`). If that copy has moved on in another browser, the Host does not overwrite it: the response lists the key under `conflicts` with the remote value and revision, and the browser resends once with the fresh base — so the side that just edited wins, on purpose. If that retry clashes again, the local value is kept, the pair is recorded in `globalThis.__DSH_LOCALSTATE_CONFLICTS__`, and the config form shows a line about it. There is no retry loop.

## Notices

Nothing is announced while the revisions (`at`) already agree. Only two kinds of drift speak up:

| Situation | Notice | Then |
| --- | --- | --- |
| Saving and pushing while the local revision is older | A bottom-right alert: "Push failed: the synced copy already moved to revision N. Reload to take the newer value." | The local value stays on screen but no longer overwrites the shared copy; the reload picks the shared one up |
| Booting while the local revision is older | "Restored N keys from the synced copy (the local values were older)." Press "Details" to list which keys changed, their new revision, and a per-field diff of JSON values (`theme: "light" → "solar"`) | Already on the shared value |
| Same, but you want the local value | Press "Overwrite" on the push-failure alert | That key takes the local value even though the synced revision moved on; the alert turns into "Overwrote N keys" |

A push failure does **not** spam the corner: a key is announced once per synced revision, a later
message for the same key updates the existing card instead of stacking a second one, and pressing
"Overwrite" swaps the card's buttons. The notice language comes from the `language` option
(`auto` asks the browser, then the DSH locale, then falls back to English; `zh`/`en` pin it).

Conflicts are decided on the write path: a batch carries `base` (the `at` each value was written
on), the Host answers `conflicts` for keys that moved on, the client resends once against the fresh
revision, and a second conflict reports as above. A key already in conflict stays quiet while the
synced revision keeps moving on (901 → 902 → 903) — the card keeps the revision it was announced
with, and only a reload (taking the synced value) or "Overwrite" (keeping yours) ends the episode. The configuration page also lists the keys that
kept their local value.

## Configuration

Open this bundle's card on the **Plugins** page and the form renders inside it (values are written into the profile's `cordis.patch.yml` patch layer, and the bundle restarts once). The equivalent YAML:

```yaml
- insert:
    - id: localstate-sync
      name: '@leonhoy/dsh-localstate-sync'
      config:
        includePrefixes: ['dsh.']   # collect keys with these prefixes
        includeExact: []            # extra exact keys
        excludeExact: []            # exact keys to skip
        maxBytes: 262144            # per-value and whole-snapshot limit
        maxKeys: 2000               # key cap: tombstones go first, then the oldest
        injectMaxBytes: 131072      # above this the snapshot is not injected; the page GETs it
        injectSnapshot: true        # false = save only, never restore automatically
        capture: true               # false = stop capturing (existing data is kept)
        file: 'localstate-sync/state.json'
        language: auto               # language of the notices and the form: auto | en | zh
```

The form talks to `GET/POST /api/localstate.config.v1`: GET returns the field descriptors, current values, which fields are explicitly overridden, and the resolved state-file path; POST submits only the changed fields, and the Host validates them through `configEditor` before touching the YAML, so an invalid value is rejected (`400`) before it lands. That route keeps working while the bundle is disabled (`enabled: false`), so it can be turned back on from the UI.

Session-scoped and pure-UI keys (`CONVERSATION_STORE_KEY.*`, width preferences) are **not** collected by default because their names do not start with `dsh.`. Add them to `includeExact` when you want them.

A useful example: the `dsh-purge` "User notice" acknowledgement lives in `localStorage` under `dsh-purge-user-notice-v1` (value `"1"`, **not** a cookie). Its name uses hyphens, not dots, so it misses the `dsh.` prefix and the notice appears again in every new browser. Add it to `includeExact` to remember it across browsers:

```json
{ "config": { "includeExact": ["dsh-purge-user-notice-v1"] } }
```

No reload is needed after changing the allowlist: a successful form save dispatches a page event and the client re-reads its configuration in place. Changes made in another tab take effect on the next load.

## Boundaries and known limits

- Only `localStorage` **string** values are synchronized. A value above `maxBytes` rejects the whole batch (`413`) instead of being truncated.
- One document is kept per profile. `localStorage` itself stays per-origin; the point of this bundle is to let different origins see the same values, not to merge the origins.
- What gets persisted is another plugin's private format. An upstream schema change will feed it an old value; DSH reads its own state defensively (a parse failure drops only that key), so the worst case is one item being reset.
- Under Desktop (`file://`) there is no `/api` channel, and the client skips itself.
- Both routes are exact `/api` routes behind the Host's cookie authentication, and only the owner principal can read or write them. They add no permission surface.
- The form registers on the `plugins.bundle.config` slot, keyed by the package name. On a host without a `slots` service (rare) the form does not appear; capture and restore are unaffected.
- Conflicts are detected on **write** only. There is no live cross-tab or cross-browser push (no `storage` listener), so the two sides converge on the next load; within one conflict the side that resends last wins — this is not a merge algorithm.

## Install

Use **Plugins → Add plugin** and pass this directory, or call `plugin_manager` `install_bundle` with it.

The bundle is **linked** into the profile, not copied, so editing these files and refreshing the page is enough; conversely, moving or deleting this directory breaks the install. Host-side code is not hot-reloaded: toggle the bundle off and on in the Plugins page (or restart the web server) to re-import it.

`package.json` declares a `schemastery` dependency (used by the `Config` schema). A linked install resolves dependencies from this directory's own `node_modules`, so run `npm install` here once.

## Verify

```bash
cat "$DSH_HOME/localstate-sync/state.json"
```

Each key looks like `{"v": "...", "at": 12, "t": 1764...}`; `{"del": true}` means the key was deleted and only its tombstone remains.

Offline self-check (no browser needed):

```bash
node test/verify.mjs   # 73/73 checks passed
```

It drives the real Host half through a fake Cordis context (route registration, index injection, merge, tombstones, allowlist, config route, write-time conflicts), loads the real client bundle with `node:vm` (slot registration, config-cell key, capture patch installed, a conflict resent once and then kept locally without looping), and runs the injected seeder script.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host half: data route, config route, `Config` schema, `index-inject` |
| `store.js` | Document I/O: merge, revisions, tombstones, pruning, atomic write |
| `seeder.js` | Inline `<head>` script that seeds `localStorage` before boot |
| `client.js` | Browser half: capture patch, flush/retry, configuration form |
| `cordis.patch.yml` | The row inserted into the profile (with default config) |
| `locale/*.json` | Plugin title/description and the detail-document pointers |
