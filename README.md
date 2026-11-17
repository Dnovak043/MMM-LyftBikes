# MMM-LyftBikes

A [MagicMirror²](https://magicmirror.builders) module that shows live bike, e-bike and (optionally) open-dock availability at your Lyft bike-share station, in a compact one-row-per-station layout modelled on [MMM-Bubi](https://github.com/balassy/MMM-Bubi). Built for Bay Wheels, and works with any Lyft-run system (Citi Bike, Divvy, Capital Bikeshare, BIKETOWN, …).

Data comes from Lyft's public GBFS feeds — no account or API key needed. Refreshes every 60 seconds by default.

*This is an independent project. It is not affiliated with, endorsed by or supported by Lyft, Inc.*

## Install

```bash
cd ~/MagicMirror/modules
git clone https://github.com/Dnovak043/MMM-LyftBikes
```

To update later: `cd ~/MagicMirror/modules/MMM-LyftBikes && git pull`, then restart MagicMirror.

No `npm install` needed; it has no dependencies (needs Node 18+, which current MagicMirror already requires).

## Find your station

Run this on the Pi (or any machine with Node 18+):

```bash
cd ~/MagicMirror/modules/MMM-LyftBikes

# the 10 closest stations to your address (looked up with OpenStreetMap)
node find-station.js --address "1 Ferry Building, San Francisco, CA"

# or by coordinates (right-click your house in Google Maps to copy them)
node find-station.js --near 37.7955,-122.3937

# or by part of the station name
node find-station.js "Market St"
```

It prints each station's exact name, its id, and how many bikes are there right now. Copy the name (or id) into your config.

## Configure

Add to `config/config.js`:

```js
{
	module: "MMM-LyftBikes",
	position: "top_right",
	header: "Bay Wheels",
	config: {
		stationName: "Your Station Name"   // exact name from find-station.js
	}
},
```

Two stations (e.g. home plus a backup down the block), with your own labels:

```js
config: {
	stations: [
		{ name: "Your Station Name", label: "Home" },
		{ id: "bbb-222", label: "Backup" }
	]
}
```

Different values per station (e.g. bikes at home, open docks near work):

```js
config: {
	stations: [
		{ name: "Your Station Name", label: "Home", showEbikes: true, showClassic: true, showDocks: false },
		{ name: "Work station name", label: "Work", showEbikes: false, showClassic: false, showDocks: true }
	]
}
```

Anything a station doesn't set falls back to the module-wide option.

Consecutive stations that show the same values form a **group** with its own columns, and a thin divider separates groups — e.g. your start station (e-bikes and bikes), then your destinations (parking only). Add `divider: true` to a station to start a new group yourself.

### Showing stations on a map

Add [MMM-MirrorMap](https://github.com/Dnovak043/MMM-MirrorMap) to your config with `layers: ["lyft"]`. This module answers it automatically with a Lyft-style pin for every station in that map's area — no extra Lyft requests, since it reuses the station data it already downloads. Each map can have its own area and zoom; each gets just the stations it shows.

For example:

```js
{ module: "MMM-LyftBikes", position: "top_left", config: { stationName: "Your Station Name" } },
{ module: "MMM-MirrorMap", position: "top_left", config: {
	layers: ["lyft"], centerLat: 37.7955, centerLon: -122.3937, zoom: 16 } },
```

`node find-station.js --address "..."` prints your coordinates for `centerLat` / `centerLon`.

### What goes to maps: the `map` block

Everything this module sends to [MMM-MirrorMap](https://github.com/Dnovak043/MMM-MirrorMap) lives in one `map` block, separate from the list settings:

```js
map: {
	layer: "lyft",          // layer name maps subscribe to (default "lyft")
	maps: ["lyft-map"],     // only these maps get the data; leave out = any map showing the layer
	count: "bikes",         // pins show: "bikes" (e-bikes and bikes, like the Lyft app), "ebikes" or "docks"
	color: "#8a1a83"        // pin colour
}
```

Every key is optional. The older flat options `mapLayer`, `mapCount` and `mapColor` still work.

### Options

| Option | Default | What it does |
|---|---|---|
| `stationName` | `null` | Station name. Exact match, or a partial match if it's unique. |
| `stationId` | `null` | Station id (or the short code printed on the kiosk). Survives Lyft renaming a station. |
| `stations` | `[]` | Several stations. Each entry is a name string, or `{ name or id, label }`, optionally with its own `showEbikes` / `showClassic` / `showDocks`. |
| `system` | `"bay"` | Lyft system code: `bay` (Bay Wheels), `bkn` (Citi Bike), `chi` (Divvy), `dca-cabi` (Capital Bikeshare), `pdx` (BIKETOWN), … |
| `language` | `"en"` | Feed language folder. |
| `updateInterval` | `60` | Seconds between refreshes (minimum 30). |
| `showClassic` / `showEbikes` | `true` | Toggle each counter. |
| `showDocks` | `false` | Also show open docks (to return a bike). |
| `showStationName` | `true` | Station name (or your label) after the counts. |
| `align` | `"left"` | `"left"` or `"right"`; use `"right"` when the module sits on the right side of the mirror. |
| `map` | `{}` | What this module sends to maps — see [the `map` block](#what-goes-to-maps-the-map-block) above. `false` = send nothing. |
| `feedBaseUrl` | `null` | Full feed folder URL override, in case Lyft moves the feeds. |

## When a station goes missing

Lyft occasionally renames, removes or temporarily closes stations. The module notices and says why in the MagicMirror log (`pm2 logs MagicMirror`), once when it happens and once when it's resolved:

| Shown on the mirror | Log says | What to do |
|---|---|---|
| (keeps working) | `"…" was renamed by Lyft to "…"` | Nothing urgent — it follows the rename. Switch that station to `{ id: "…" }` in config.js. |
| `removed by Lyft` | `… is no longer in Lyft's station list` + the nearest stations to where it was | Pick a replacement from the list. |
| `not found` | `… isn't in Lyft's station list` + similar names | Check the spelling, or run `node find-station.js`. |
| `not reporting` | `… is listed but Lyft isn't reporting its bikes` | Usually temporary; wait. |

To recognise renames and removals, the module remembers which Lyft station each of your stations matched, in `station-memory.json` in this folder (safe to delete; not committed to git). Using `id` instead of `name` in your config avoids rename problems altogether.

## How it works

`node_helper.js` fetches `station_information.json`, `vehicle_types.json` (both once, at startup) and `station_status.json` from `https://gbfs.lyft.com/gbfs/2.3/<system>/en/`, matches your station, and splits bikes into e-bike vs classic using the vehicle types. If the vehicle-type feed isn't available it falls back to `num_bikes_available − num_ebikes_available`.

Each refresh updates only the numbers that changed, fading each one out and back in; the rest of the module stays put. A station that isn't renting right now is shown greyed out. If a refresh fails, the mirror keeps showing the last good numbers rather than going blank. If Lyft renames your station, restart MagicMirror. If a name matches more than one station, the module says so on screen and the MagicMirror log lists the candidates and their ids.

## Credits

List layout and bike icons adapted from [MMM-Bubi](https://github.com/balassy/MMM-Bubi) by György Balássy (MIT). The icons are Material Design icons (Apache 2.0).

