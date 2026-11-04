/* MMM-LyftBikes — GBFS client
 * Reads Lyft's public GBFS 2.3 feeds (Bay Wheels, Citi Bike, Divvy, Capital Bikeshare, BIKETOWN, ...)
 * No API key needed. Uses Node's built-in fetch (Node 18+).
 */

"use strict";

function feedBase (system, language = "en") {
	return `https://gbfs.lyft.com/gbfs/2.3/${system}/${language}/`;
}

async function getJson (url, timeoutMs = 15000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": "MMM-LyftBikes (MagicMirror module)" }
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

function distanceMeters (a, b) {
	const R = 6371000;
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLon = toRad(b.lon - a.lon);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

/** Normalise a selector from config into { id, name, label }. */
function normaliseSelector (sel) {
	if (typeof sel === "string") return { id: sel, name: sel, label: null };
	return { id: sel.id || null, name: sel.name || null, label: sel.label || null };
}

/** Find the station a selector refers to: exact id, short_name, exact name, then partial name. */
function resolveSelector (sel, stationList) {
	const s = normaliseSelector(sel);
	const byId = s.id && stationList.find((st) => st.station_id === s.id || st.short_name === s.id);
	if (byId) return { station: byId, candidates: [] };

	if (!s.name) return { station: null, candidates: [] };
	const q = s.name.trim().toLowerCase();
	const exact = stationList.find((st) => (st.name || "").toLowerCase() === q);
	if (exact) return { station: exact, candidates: [] };

	const partial = stationList.filter((st) => (st.name || "").toLowerCase().includes(q));
	return { station: partial.length === 1 ? partial[0] : null, candidates: partial };
}

/** Turn a station_status record into classic / e-bike / scooter / dock counts. */
function summarise (status, vehicleTypes) {
	let classic = 0;
	let ebikes = 0;
	let scooters = 0;
	let usedTypes = false;

	if (Array.isArray(status.vehicle_types_available) && vehicleTypes.size > 0) {
		for (const vt of status.vehicle_types_available) {
			const type = vehicleTypes.get(vt.vehicle_type_id);
			if (!type) continue;
			usedTypes = true;
			const count = Number(vt.count) || 0;
			if (type.form_factor === "scooter" || type.form_factor === "scooter_standing") scooters += count;
			else if (type.propulsion_type === "human") classic += count;
			else ebikes += count;
		}
	}

	if (!usedTypes) {
		// Fallback on the plain counters. In Lyft's 2.3 feeds num_bikes_available includes e-bikes.
		const total = Number(status.num_bikes_available) || 0;
		ebikes = Number(status.num_ebikes_available) || 0;
		classic = Math.max(0, total - ebikes);
		scooters = Number(status.num_scooters_available) || 0;
	}

	return {
		classic,
		ebikes,
		scooters,
		bikes: classic + ebikes,
		docks: Number(status.num_docks_available) || 0,
		bikesDisabled: Number(status.num_bikes_disabled) || 0,
		isRenting: status.is_renting === undefined ? true : Boolean(status.is_renting),
		isReturning: status.is_returning === undefined ? true : Boolean(status.is_returning),
		isInstalled: status.is_installed === undefined ? true : Boolean(status.is_installed),
		lastReported: status.last_reported ? Number(status.last_reported) * 1000 : null
	};
}

class GbfsClient {
	constructor ({ system = "bay", language = "en", baseUrl = null, timeoutMs = 15000 } = {}) {
		this.base = baseUrl || feedBase(system, language);
		if (!this.base.endsWith("/")) this.base += "/";
		this.timeoutMs = timeoutMs;
		this.stationList = [];
		this.vehicleTypes = new Map();
		this.statusById = null; // latest station_status, kept so new map views can be answered without a new download
	}

	async loadStatic () {
		if (this.stationList.length) return; // loaded once at startup
		const info = await getJson(`${this.base}station_information.json`, this.timeoutMs);
		this.stationList = (info.data && info.data.stations) || [];
		try {
			const vt = await getJson(`${this.base}vehicle_types.json`, this.timeoutMs);
			this.vehicleTypes = new Map(((vt.data && vt.data.vehicle_types) || []).map((t) => [t.vehicle_type_id, t]));
		} catch (e) {
			this.vehicleTypes = new Map(); // optional feed; fall back to num_* counters
		}
	}

	/** Returns one entry per selector: { label, name, stationId, capacity, ...counts } or { error }.
	 *  With `views` ({ mapId: bounds }), also returns the stations inside each map's bounds. */
	async getStations (selectors, views = {}) {
		await this.loadStatic();
		const statusJson = await getJson(`${this.base}station_status.json`, this.timeoutMs);
		const statusById = new Map(((statusJson.data && statusJson.data.stations) || []).map((s) => [s.station_id, s]));
		this.statusById = statusById;

		const results = [];
		for (const raw of selectors) {
			const sel = normaliseSelector(raw);
			const { station, candidates } = resolveSelector(sel, this.stationList);

			if (!station) {
				results.push({
					label: sel.label || sel.name || sel.id,
					error: candidates.length
						? `"${sel.name}" matches ${candidates.length} stations — use the full name or id`
						: `Station "${sel.name || sel.id}" not found`,
					candidates: candidates.slice(0, 10).map((c) => ({ id: c.station_id, name: c.name }))
				});
				continue;
			}

			const status = statusById.get(station.station_id);
			if (!status) {
				results.push({ label: sel.label || station.name, error: "No live status for this station" });
				continue;
			}

			results.push({
				label: sel.label || station.name,
				name: station.name,
				stationId: station.station_id,
				capacity: station.capacity || null,
				lat: station.lat,
				lon: station.lon,
				...summarise(status, this.vehicleTypes)
			});
		}

		return { stations: results, maps: this.stationsInViews(views), feedUpdated: statusJson.last_updated ? Number(statusJson.last_updated) * 1000 : Date.now() };
	}

	/** Stations inside each map's bounds (with a small margin so pins at the edge aren't cut off),
	 *  from the latest downloaded status. { mapId: [ { id, lat, lon, ebikes, classic, docks, active } ] } */
	stationsInViews (views) {
		const out = {};
		if (!this.statusById) return out;
		for (const [mapId, b] of Object.entries(views || {})) {
			if (!b) continue;
			const padLat = (b.north - b.south) * 0.1;
			const padLon = (b.east - b.west) * 0.1;
			out[mapId] = [];
			for (const st of this.stationList) {
				if (st.lat > b.north + padLat || st.lat < b.south - padLat) continue;
				if (st.lon > b.east + padLon || st.lon < b.west - padLon) continue;
				const status = this.statusById.get(st.station_id);
				if (!status) continue;
				const s = summarise(status, this.vehicleTypes);
				out[mapId].push({
					id: st.station_id,
					lat: st.lat,
					lon: st.lon,
					ebikes: s.ebikes,
					classic: s.classic,
					docks: s.docks,
					active: s.isInstalled && s.isRenting
				});
			}
		}
		return out;
	}
}

module.exports = { GbfsClient, feedBase, getJson, resolveSelector, summarise, normaliseSelector, distanceMeters };
