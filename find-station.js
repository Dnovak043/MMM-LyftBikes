#!/usr/bin/env node
/* Find your station's exact name / id.
 *
 *   node find-station.js "Market St"               # search Bay Wheels by name
 *   node find-station.js --address "1 Ferry Building, San Francisco, CA"   # 10 closest to your address
 *   node find-station.js --near 37.7955,-122.3937  # 10 closest stations to a lat,lon
 *   node find-station.js --system bkn "Bedford"    # other Lyft systems (bkn = Citi Bike, chi = Divvy, ...)
 */

"use strict";

const { GbfsClient, getJson, distanceMeters } = require("./gbfs");

async function main () {
	const args = process.argv.slice(2);
	let system = "bay";
	let near = null;
	let baseUrl = null;
	let address = null;
	const terms = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--system") system = args[++i];
		else if (args[i] === "--base-url") baseUrl = args[++i];
		else if (args[i] === "--address") address = args.slice(i + 1).join(" "), i = args.length;
		else if (args[i] === "--near") {
			// Accept "37.80,-122.39", "37.80, -122.39" (Google Maps copies it with a space), or "37.80 -122.39"
			const parts = [];
			while (i + 1 < args.length && /^[-+\d.,\s°NSEW]+$/i.test(args[i + 1]) && !args[i + 1].startsWith("--")) parts.push(args[++i]);
			near = parts.join(" ");
		} else terms.push(args[i]);
	}
	const query = terms.join(" ").trim().toLowerCase();
	if (!query && near === null && !address) {
		console.log("Usage:");
		console.log('  node find-station.js --address "1 Ferry Building, San Francisco, CA"');
		console.log("  node find-station.js --near 37.7955,-122.3937");
		console.log('  node find-station.js "part of station name"');
		process.exit(1);
	}

	if (address) {
		// Free OpenStreetMap geocoder; only the address you type is sent.
		const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(address);
		const hits = await getJson(url);
		if (!hits.length) {
			console.log(`Couldn't find "${address}". Try adding the city and state, e.g. "1 Ferry Building, San Francisco, CA".`);
			process.exit(1);
		}
		console.log(`Address found: ${hits[0].display_name}`);
		console.log(`Coordinates:   ${Number(hits[0].lat).toFixed(5)}, ${Number(hits[0].lon).toFixed(5)}   (use as centerLat / centerLon and homeLat / homeLon in MMM-MirrorMap)`);
		near = `${hits[0].lat},${hits[0].lon}`;
	}

	const client = new GbfsClient({ system, baseUrl });
	await client.loadStatic();
	let list = client.stationList;

	if (near !== null) {
		const nums = (near.match(/[-+]?\d+(?:\.\d+)?/g) || []).map(Number);
		if (nums.length !== 2) {
			console.log(`Couldn't read "${near}" as coordinates. Use: --near 37.7955,-122.3937`);
			process.exit(1);
		}
		let [lat, lon] = nums;
		if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat]; // pasted as lon,lat
		console.log(`Searching near ${lat}, ${lon}\n`);

		list = list
			.map((s) => ({ ...s, dist: distanceMeters({ lat, lon }, s) }))
			.sort((a, b) => a.dist - b.dist)
			.slice(0, 10);

		if (list.length && list[0].dist > 5000) {
			console.log(`Heads up: the closest station is ${(list[0].dist / 1000).toFixed(0)} km away, so the coordinates are probably off.`);
			if (system === "bay" && lon > 0) console.log("Bay Area longitudes are negative — did the minus sign get dropped? e.g. -122.3937");
			console.log("");
		}
	} else {
		list = list.filter((s) => (s.name || "").toLowerCase().includes(query));
	}

	if (!list.length) {
		console.log("No stations matched.");
		return;
	}

	const { stations } = await client.getStations(list.map((s) => ({ id: s.station_id })));
	list.forEach((s, i) => {
		const st = stations[i];
		const counts = st.error ? st.error : `${st.ebikes} e-bikes, ${st.classic} classic, ${st.docks} docks`;
		const dist = s.dist !== undefined ? `  (${Math.round(s.dist)} m)` : "";
		console.log(`${s.name}${dist}\n   id: ${s.station_id}   short: ${s.short_name || "-"}   now: ${counts}\n`);
	});
}

main().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
