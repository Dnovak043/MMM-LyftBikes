/* MMM-LyftBikes
 * Shows live bike and e-bike availability for Lyft-operated bike-share stations
 * (Bay Wheels, Citi Bike, Divvy, Capital Bikeshare, BIKETOWN, ...).
 * List layout modelled on MMM-Bubi (https://github.com/balassy/MMM-Bubi).
 * Also publishes nearby stations as pins for any MMM-MirrorMap on the mirror.
 */

/* global Module */

// Material Design icons "pedal_bike", "electric_bike" and "local_parking" (Apache 2.0), as used by MMM-Bubi.
const LB_ICONS = {
	bike: "M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2M5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5m0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5m5.8-10 2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V9c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L7.8 8.4c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 14v5h2v-6.2zM19 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5m0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5",
	ebike: "M19 7h-.82l-1.7-4.68C16.19 1.53 15.44 1 14.6 1H12v2h2.6l1.46 4h-4.81l-.36-1H12V4H7v2h1.75l1.82 5H9.9c-.44-2.23-2.31-3.88-4.65-3.99C2.45 6.87 0 9.2 0 12s2.2 5 5 5c2.46 0 4.45-1.69 4.9-4h4.2c.44 2.23 2.31 3.88 4.65 3.99 2.8.13 5.25-2.19 5.25-5C24 9.2 21.8 7 19 7M7.82 13c-.4 1.17-1.49 2-2.82 2-1.68 0-3-1.32-3-3s1.32-3 3-3c1.33 0 2.42.83 2.82 2H5v2zm6.28-2h-1.4l-.73-2H15c-.44.58-.76 1.25-.9 2m4.9 4c-1.68 0-3-1.32-3-3 0-.93.41-1.73 1.05-2.28l.96 2.64 1.88-.68-.97-2.67c.02 0 .05-.01.08-.01 1.68 0 3 1.32 3 3s-1.32 3-3 3m-8 5H7l6 3v-2h4l-6-3z",
	docks: "M13 3H6v18h4v-6h3c3.31 0 6-2.69 6-6s-2.69-6-6-6m.2 8H10V7h3.2c1.1 0 2 .9 2 2s-.9 2-2 2"
};

// Column order, left to right.
const LB_COLUMNS = [
	{ field: "ebikes", icon: "ebike" },
	{ field: "classic", icon: "bike" },
	{ field: "docks", icon: "docks", symbolClass: "symbol-dock-cell" }
];

Module.register("MMM-LyftBikes", {
	defaults: {
		system: "bay",            // Lyft GBFS system code: bay, bkn (Citi Bike), chi (Divvy), dca-cabi, pdx, ...
		language: "en",
		feedBaseUrl: null,        // override the full feed folder URL if Lyft ever moves it

		// Pick your station(s). Any of these work:
		//   stationName: "Your Station Name"
		//   stationId: "a1b2c3..." (station_id or the short code printed on the kiosk)
		//   stations: ["Station A", { id: "...", label: "Home" }, { name: "Work St at 2nd", label: "Work" }]
		// Each station object can also set its own showEbikes / showClassic / showDocks.
		stationName: null,
		stationId: null,
		stations: [],

		updateInterval: 60,       // seconds (minimum 30)
		showClassic: true,
		showEbikes: true,
		showDocks: false,         // open docks to return a bike to
		showStationName: true,
		align: "left",            // "left" or "right" — match the side of the mirror the module is on

		// What this module sends to MMM-MirrorMap maps. Same shape in every data module:
		//   map: {
		//     layer: "lyft",         // layer name maps subscribe to
		//     maps: ["lyft-map"],    // only these maps (by mapId) get the data; leave out = any map showing the layer
		//     count: "bikes",        // number on each pin: "bikes", "ebikes" or "docks"
		//     color: "#8a1a83"       // pin colour
		//   }
		// or map: false to send nothing.
		map: {}
	},

	getStyles () {
		return ["MMM-LyftBikes.css"];
	},

	start () {
		// Map settings: defaults, then any old-style flat options (mapLayer/mapCount/mapColor), then the map block.
		const legacy = Object.fromEntries(
			[["layer", this.config.mapLayer], ["count", this.config.mapCount], ["color", this.config.mapColor]].filter(([, v]) => v !== undefined)
		);
		this.mapConfig = this.config.map === false || this.config.mapLayer === null
			? null
			: { layer: "lyft", maps: [], count: "bikes", color: "#8a1a83", ...legacy, ...(this.config.map || {}) };
		if (this.mapConfig && !Array.isArray(this.mapConfig.maps)) this.mapConfig.maps = this.mapConfig.maps ? [this.mapConfig.maps] : [];

		this.stations = null;
		this.error = null;
		this.mapViews = {}; // mapId -> bounds, for maps showing our layer

		const stations = [...this.config.stations];
		if (this.config.stationId) stations.unshift({ id: this.config.stationId });
		if (this.config.stationName) stations.unshift({ name: this.config.stationName });

		if (!stations.length) {
			this.error = "Set stationName, stationId or stations in config.js";
			return;
		}

		this.selectors = stations; // kept so each row can use its own show* options
		this.sendSocketNotification("LYFTBIKES_CONFIG", {
			identifier: this.identifier,
			config: { ...this.config, stations }
		});
	},

	/* ---------- Maps (MMM-MirrorMap) ---------- */

	notificationReceived (notification, payload) {
		if (!this.mapConfig || !this.selectors) return;
		if (notification === "DOM_OBJECTS_CREATED") {
			this.sendNotification("MAP_VIEW_REQUEST"); // ask maps that started before us to re-announce
		} else if (notification === "MAP_VIEW" && payload && payload.mapId && payload.bounds) {
			const layers = Array.isArray(payload.layers) ? payload.layers : [];
			if (layers.length && !layers.includes(this.mapConfig.layer)) return;
			if (this.mapConfig.maps.length && !this.mapConfig.maps.includes(payload.mapId)) return; // not one of our maps
			this.mapViews[payload.mapId] = payload.bounds;
			this.sendSocketNotification("LYFTBIKES_VIEWS", { identifier: this.identifier, views: this.mapViews });
		}
	},

	toMarker (st) {
		const mode = this.mapConfig.count;
		const count = mode === "ebikes" ? st.ebikes : mode === "docks" ? st.docks : st.ebikes + st.classic;
		let parts;
		if (mode === "docks") parts = [{ icon: "docks", count: st.docks }];
		else if (mode === "ebikes") parts = [{ icon: "ebike", count: st.ebikes }];
		else {
			// Like the Lyft app: e-bikes, then bikes — each type only when the station has some.
			parts = [];
			if (st.ebikes > 0) parts.push({ icon: "ebike", count: st.ebikes });
			if (st.classic > 0) parts.push({ icon: "bike", count: st.classic });
			if (!parts.length) parts.push({ icon: "bike", count: 0 });
		}
		const state = !st.active ? "off" : count === 0 ? "empty" : "ok";
		return { id: st.id, lat: st.lat, lon: st.lon, style: "pin", parts, state, color: this.mapConfig.color };
	},

	publishMaps (maps) {
		if (!this.mapConfig || !maps) return;
		for (const [mapId, stations] of Object.entries(maps)) {
			this.sendNotification("MAP_MARKERS", {
				layer: this.mapConfig.layer,
				mapId,
				markers: stations.map((st) => this.toMarker(st))
			});
		}
	},

	/* ---------- Data from the node helper ---------- */

	socketNotificationReceived (notification, payload) {
		if (!payload || payload.identifier !== this.identifier) return;
		if (notification === "LYFTBIKES_DATA") {
			const firstLoad = !this.stations;
			const key = this.layoutKey(payload.stations);
			this.stations = payload.stations;
			this.error = null;
			if (firstLoad) this.updateDom(500);                     // fade in once at startup
			else if (key !== this.lastLayoutKey) this.updateDom(0); // structure changed: swap instantly
			else this.updateValues();                               // normal case: just the numbers
			this.lastLayoutKey = key;
			this.publishMaps(payload.maps);
		} else if (notification === "LYFTBIKES_MAPS") {
			this.publishMaps(payload.maps);
		} else if (notification === "LYFTBIKES_ERROR") {
			this.error = payload.message;
			if (!this.stations) this.updateDom(0); // only matters before the first data arrives
		}
	},

	// Anything that changes the module's structure (not just a number) goes in here.
	layoutKey (stations) {
		return JSON.stringify(stations.map((st) => [st.label, st.error || "", !st.isInstalled || !st.isRenting]));
	},

	fadeText (el, value) {
		el.classList.add("lb-changing");
		setTimeout(() => {
			el.textContent = value;
			el.classList.remove("lb-changing");
		}, 400);
	},

	// Update only the numbers that changed, fading each one out and back in.
	updateValues () {
		const root = document.getElementById(this.identifier);
		const rows = root ? root.querySelectorAll("tr.lb-station") : [];
		this.stations.forEach((st, i) => {
			if (!rows[i]) return;
			rows[i].querySelectorAll("td[data-field]").forEach((cell) => {
				const value = String(st[cell.dataset.field]);
				if (cell.textContent !== value) this.fadeText(cell, value);
			});
		});
	},

	/* ---------- List ---------- */

	// Which values a station shows: its own showEbikes/showClassic/showDocks, else the module-wide setting.
	showFor (i) {
		const raw = (this.selectors || [])[i];
		const sel = raw && typeof raw === "object" ? raw : {};
		const pick = (key) => (sel[key] !== undefined ? sel[key] : this.config[key]);
		return { ebikes: pick("showEbikes"), classic: pick("showClassic"), docks: pick("showDocks") };
	},

	icon (name) {
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("width", "1em");
		svg.setAttribute("height", "1em");
		svg.setAttribute("fill", "currentColor");
		const path = document.createElementNS(ns, "path");
		path.setAttribute("d", LB_ICONS[name]);
		svg.appendChild(path);
		return svg;
	},

	cell (className, content) {
		const td = document.createElement("td");
		td.className = className;
		if (content instanceof Node) td.appendChild(content);
		else if (content !== undefined) td.textContent = content;
		return td;
	},

	addCount (row, iconName, field, value, symbolClass = "") {
		row.appendChild(this.cell(`dimmed symbol-cell ${symbolClass}`.trim(), this.icon(iconName)));
		const count = this.cell("count-cell", String(value));
		count.dataset.field = field;
		row.appendChild(count);
		row.appendChild(this.cell("space-cell"));
	},

	addBlank (row) {
		row.appendChild(this.cell("symbol-cell"));
		row.appendChild(this.cell("count-cell"));
		row.appendChild(this.cell("space-cell"));
	},

	renderStation (st, i, columns) {
		const row = document.createElement("tr");
		row.className = "lb-station";

		if (st.error) {
			const td = this.cell("dimmed small name-cell", `${st.label}: ${st.error}`);
			td.colSpan = 10;
			row.appendChild(td);
			return row;
		}

		// A station that isn't renting is shown greyed out.
		if (!st.isInstalled || !st.isRenting) row.classList.add("lb-offline");

		// Every row has the same columns so they line up; values this station doesn't show are left blank.
		const show = this.showFor(i);
		for (const col of LB_COLUMNS) {
			if (!columns.includes(col.field)) continue;
			if (show[col.field]) this.addCount(row, col.icon, col.field, st[col.field], col.symbolClass);
			else this.addBlank(row);
		}
		if (this.config.showStationName) row.appendChild(this.cell("dimmed small name-cell", st.label));
		return row;
	},

	getDom () {
		const wrapper = document.createElement("div");

		if (!this.stations) {
			wrapper.innerHTML = `<span class="dimmed small">${this.error ? this.error : "Loading…"}</span>`;
			return wrapper;
		}

		// Group consecutive stations that show the same things (e.g. your start station, then
		// parking-only destinations). Each group gets its own columns, packed toward the aligned side,
		// with a divider between groups. A station can also start a new group with `divider: true`.
		const align = this.config.align === "right" ? "right" : "left";
		const groups = [];
		let lastPattern = null;
		this.stations.forEach((st, i) => {
			const raw = (this.selectors || [])[i];
			const forced = Boolean(raw && typeof raw === "object" && raw.divider);
			const pattern = st.error ? lastPattern : JSON.stringify(this.showFor(i));
			if (!groups.length || forced || (pattern !== lastPattern && !st.error)) groups.push([]);
			groups[groups.length - 1].push(i);
			lastPattern = pattern;
		});

		for (const group of groups) {
			const table = document.createElement("table");
			table.className = `small lb-group align-${align}`;
			// A column appears if at least one station in this group shows it.
			const columns = LB_COLUMNS
				.map((col) => col.field)
				.filter((field) => group.some((i) => !this.stations[i].error && this.showFor(i)[field]));
			for (const i of group) table.appendChild(this.renderStation(this.stations[i], i, columns));
			wrapper.appendChild(table);
		}
		return wrapper;
	}
});
