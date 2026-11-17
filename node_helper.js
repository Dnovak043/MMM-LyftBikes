/* MMM-LyftBikes — node helper
 * Fetches GBFS data server-side and pushes it to each module instance.
 * While an instance is suspended (hidden on the mirror) nothing runs for it: no timer, no download.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { GbfsClient } = require("./gbfs");

// Remembers which Lyft station each configured station resolved to (so renames keep working and
// removals can be explained). Small JSON file in this module's folder; safe to delete.
const MEMORY_FILE = path.join(__dirname, "station-memory.json");

module.exports = NodeHelper.create({
	start () {
		this.instances = new Map(); // identifier -> { config, client, timer, views, reported, suspended }
		try {
			this.memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
		} catch (e) {
			this.memory = {};
		}
		this.memoryJson = JSON.stringify(this.memory);
	},

	saveMemory () {
		const json = JSON.stringify(this.memory);
		if (json === this.memoryJson) return;
		// Only rewrite when a station's id/name/position changed, not just its "seen" time.
		const strip = (m) => JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [v.id, v.name, v.lat, v.lon]])));
		if (strip(this.memory) === strip(JSON.parse(this.memoryJson)) && Date.now() - (this.memorySaved || 0) < 24 * 3600 * 1000) return;
		try {
			fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.memory, null, 2));
			this.memoryJson = json;
			this.memorySaved = Date.now();
		} catch (err) {
			Log.warn(`couldn't save ${path.basename(MEMORY_FILE)}: ${err.message}`);
		}
	},

	// Log each station problem once when it starts, and once when it's resolved (not on every refresh).
	reportStations (instance, stations) {
		instance.reported = instance.reported || new Map();
		const current = new Map();
		for (const st of stations) {
			const issue = st.problem || st.notice;
			if (!issue) continue;
			const id = `${st.label}|${issue.type}`;
			current.set(id, true);
			if (instance.reported.has(id)) continue;
			const list = (issue.suggestions || []).map((c) =>
				`   ${c.name}${c.distance != null ? `  (${c.distance} m)` : ""}   id: ${c.id}`).join("\n");
			Log.warn(issue.message + (list ? `\n${list}` : ""));
			instance.reported.set(id, st.label);
		}
		for (const [id, label] of instance.reported) {
			if (current.has(id)) continue;
			Log.info(`"${label}" is OK again`);
			instance.reported.delete(id);
		}
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "LYFTBIKES_CONFIG") {
			const { identifier, config } = payload;
			const existing = this.instances.get(identifier);
			if (existing) {
				clearTimeout(existing.timer);
				existing.client.cancel(); // it is being replaced: stop its download too
			}

			const client = new GbfsClient({
				system: config.system,
				language: config.language,
				baseUrl: config.feedBaseUrl
			});
			this.instances.set(identifier, { config, client, timer: null, views: existing ? existing.views : {}, suspended: false });
			this.poll(identifier);
		} else if (notification === "LYFTBIKES_SUSPEND") {
			// The module was hidden: stop its timer and the download in progress. Nothing runs until it resumes.
			const instance = this.instances.get(payload.identifier);
			if (!instance || instance.suspended) return;
			instance.suspended = true;
			clearTimeout(instance.timer);
			instance.timer = null;
			instance.client.cancel();
			if (payload.unload) {
				// unloadOnSuspend: also forget the downloaded station list and status, and the map areas.
				instance.client.unload();
				instance.views = {};
				instance.logged = new Set();
			}
		} else if (notification === "LYFTBIKES_RESUME") {
			// The module is shown again: refresh now, then carry on at the usual interval.
			const instance = this.instances.get(payload.identifier);
			if (!instance || !instance.suspended) return;
			instance.suspended = false;
			instance.views = payload.views || {};
			this.poll(payload.identifier);
		} else if (notification === "LYFTBIKES_VIEWS") {
			// A map announced (or changed) its view: answer straight away from the last download.
			const instance = this.instances.get(payload.identifier);
			if (!instance || instance.suspended) return;
			instance.views = payload.views || {};
			instance.logged = new Set(); // log each map's station count again for its new area
			if (instance.client.statusById) {
				const maps = instance.client.stationsInViews(instance.views);
				this.logMaps(instance, maps);
				this.sendSocketNotification("LYFTBIKES_MAPS", { identifier: payload.identifier, maps });
			}
		}
	},

	async poll (identifier) {
		const instance = this.instances.get(identifier);
		if (!instance || instance.suspended) return;
		const { config, client } = instance;
		// This refresh no longer counts if the module was suspended, resumed or reconfigured while it downloaded.
		const run = instance.run = (instance.run || 0) + 1;
		const stale = () => this.instances.get(identifier) !== instance || instance.suspended || instance.run !== run;

		try {
			const data = await client.getStations(config.stations, {}, this.memory);
			if (stale()) return;
			this.saveMemory();
			this.reportStations(instance, data.stations);
			// Use the map views as they are *now*: a map may have announced itself while we were downloading.
			data.maps = client.stationsInViews(instance.views);
			this.logMaps(instance, data.maps);
			this.sendSocketNotification("LYFTBIKES_DATA", { identifier, ...data, fetchedAt: Date.now() });
		} catch (err) {
			if (stale()) return; // cancelled by a suspend: not an error
			Log.error(err.message);
			this.sendSocketNotification("LYFTBIKES_ERROR", { identifier, message: err.message });
		}

		instance.timer = setTimeout(() => this.poll(identifier), Math.max(30, config.updateInterval) * 1000);
	},

	// One line per map when it (re)announces its area, so it's easy to see what each map was sent.
	logMaps (instance, maps) {
		instance.logged = instance.logged || new Set();
		for (const [mapId, stations] of Object.entries(maps)) {
			if (instance.logged.has(mapId)) continue;
			instance.logged.add(mapId);
			const b = instance.views[mapId];
			const area = b ? ` (lat ${b.south.toFixed(4)}…${b.north.toFixed(4)}, lon ${b.west.toFixed(4)}…${b.east.toFixed(4)})` : "";
			if (stations.length) Log.info(`${mapId}: sending ${stations.length} stations in its area${area}`);
			else Log.warn(`${mapId}: no bike-share stations in its area${area} — check centerLat/centerLon`);
		}
	},

	stop () {
		for (const inst of this.instances.values()) {
			clearTimeout(inst.timer);
			inst.client.cancel();
		}
	}
});
