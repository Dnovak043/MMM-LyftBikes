/* MMM-LyftBikes — node helper
 * Fetches GBFS data server-side and pushes it to each module instance.
 */

"use strict";

const NodeHelper = require("node_helper");
const Log = require("logger");
const { GbfsClient } = require("./gbfs");

module.exports = NodeHelper.create({
	start () {
		this.instances = new Map(); // identifier -> { config, client, timer, views }
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "LYFTBIKES_CONFIG") {
			const { identifier, config } = payload;
			const existing = this.instances.get(identifier);
			if (existing) clearTimeout(existing.timer);

			const client = new GbfsClient({
				system: config.system,
				language: config.language,
				baseUrl: config.feedBaseUrl
			});
			this.instances.set(identifier, { config, client, timer: null, views: existing ? existing.views : {} });
			this.poll(identifier);
		} else if (notification === "LYFTBIKES_VIEWS") {
			// A map announced (or changed) its view: answer straight away from the last download.
			const instance = this.instances.get(payload.identifier);
			if (!instance) return;
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
		if (!instance) return;
		const { config, client } = instance;

		try {
			const data = await client.getStations(config.stations);
			// Use the map views as they are *now*: a map may have announced itself while we were downloading.
			data.maps = client.stationsInViews(instance.views);
			this.logMaps(instance, data.maps);
			for (const st of data.stations) {
				if (st.error && st.candidates && st.candidates.length) {
					Log.warn(`${st.error}. Candidates:\n` +
						st.candidates.map((c) => `   ${c.id}  ${c.name}`).join("\n"));
				}
			}
			this.sendSocketNotification("LYFTBIKES_DATA", { identifier, ...data, fetchedAt: Date.now() });
		} catch (err) {
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
		for (const inst of this.instances.values()) clearTimeout(inst.timer);
	}
});
