/**
 * Transit Finder with Place-based Search
 * 
 * This script finds the next direct transit from a stop to either:
 * 1. Another specific stop (traditional mode)
 * 2. The nearest stop to a given place (new --to-place mode)
 * 
 * Usage:
 *   Mode 1: node find_next_transit.js <STOP_A_ID> <STOP_B_ID> [HH:MM:SS] [route_type]
 *   Mode 2: node find_next_transit.js --to-place <STOP_ID> <PLACE_NAME> [HH:MM:SS] [route_type]
 * 
 * Examples:
 *   node find_next_transit.js 12901 13402 08:00:00 1
 *   node find_next_transit.js --to-place 13402 "Dubai Mall" 08:00:00 1
 * 
 * Route types: 0=Tram, 1=Metro, 2=Rail, 3=Bus, 4=Ferry
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');

// ===== CONFIGURATION =====
// Add your Google Maps API key here
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
// =========================

// Helper to parse CSV lines that are fully quoted like "val","val"
function parseCSV(content) {
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

    const data = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const values = [];
        let current = '';
        let inQuote = false;

        for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (char === '"') {
                inQuote = !inQuote;
            } else if (char === ',' && !inQuote) {
                values.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        values.push(current);

        const entry = {};
        headers.forEach((h, idx) => {
            entry[h] = values[idx] ? values[idx].replace(/^"|"$/g, '') : '';
        });
        data.push(entry);
    }
    return data;
}

function loadFile(filename) {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filename}`);
        return [];
    }
    return parseCSV(fs.readFileSync(filePath, 'utf8'));
}

function getDayName() {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return days[new Date().getDay()];
}

function getCurrentTime() {
    const now = new Date();
    return now.toTimeString().split(' ')[0]; // HH:MM:SS
}

function getYYYYMMDD() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return parseInt(`${y}${m}${d}`, 10);
}

/**
 * Get latitude and longitude of a place using Google Maps Geocoding API
 * @param {string} place - The place name or address to geocode
 * @returns {Promise<{lat: number, lng: number, formatted_address: string}>}
 */
function getLatLngFromPlace(place) {
    return new Promise((resolve, reject) => {
        if (!GOOGLE_MAPS_API_KEY || GOOGLE_MAPS_API_KEY === 'YOUR_API_KEY_HERE') {
            return reject(new Error('Google Maps API key not configured.'));
        }

        const encodedPlace = encodeURIComponent(place);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedPlace}&key=${GOOGLE_MAPS_API_KEY}`;

        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.status === 'OK' && response.results.length > 0) {
                        const location = response.results[0].geometry.location;
                        resolve({
                            lat: location.lat,
                            lng: location.lng,
                            formatted_address: response.results[0].formatted_address
                        });
                    } else {
                        reject(new Error(`Geocoding failed: ${response.status}`));
                    }
                } catch (error) {
                    reject(new Error(`Failed to parse response: ${error.message}`));
                }
            });
        }).on('error', (error) => {
            reject(new Error(`Network error: ${error.message}`));
        });
    });
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lng1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lng2 - Longitude of point 2
 * @returns {number} - Distance in kilometers
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Find nearest stops to a given location
 * @param {number} targetLat - Target latitude
 * @param {number} targetLng - Target longitude
 * @param {number} maxResults - Maximum number of stops to return
 * @returns {Array} - Array of nearest stops with distance
 */
function findNearestStops(targetLat, targetLng, maxResults = 10) {
    const stops = loadFile('stops.txt');

    const stopsWithDistance = stops
        .filter(stop => stop.stop_lat && stop.stop_lon)
        .map(stop => {
            const distance = calculateDistance(
                targetLat,
                targetLng,
                parseFloat(stop.stop_lat),
                parseFloat(stop.stop_lon)
            );
            return {
                ...stop,
                distance: distance
            };
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, maxResults);

    return stopsWithDistance;
}

/**
 * Preload all transit data once for efficiency
 * @param {string} dayName - Day of week
 * @param {number} todayDate - Date in YYYYMMDD format
 * @param {string|null} routeType - Optional route type filter
 * @returns {Object} - Preloaded data object
 */
function preloadTransitData(dayName, todayDate, routeType) {
    console.log(`  Preloading transit data...`);

    // 1. Load Routes
    const routes = loadFile('routes.txt');
    const targetRouteIds = new Set(
        routes
            .filter(r => !routeType || r.route_type === routeType)
            .map(r => r.route_id)
    );

    // 2. Load Calendar (Active Services)
    const calendar = loadFile('calendar.txt');
    const activeServices = new Set(
        calendar
            .filter(c => {
                const startDate = parseInt(c.start_date, 10);
                const endDate = parseInt(c.end_date, 10);
                const isActiveDay = c[dayName] === '1';
                return isActiveDay && todayDate >= startDate && todayDate <= endDate;
            })
            .map(c => c.service_id)
    );

    // 3. Load Trips
    const allTrips = loadFile('trips.txt');
    const validTrips = allTrips.filter(t =>
        targetRouteIds.has(t.route_id) && activeServices.has(t.service_id)
    );
    const validTripIds = new Set(validTrips.map(t => t.trip_id));

    const tripRouteMap = {};
    validTrips.forEach(t => {
        tripRouteMap[t.trip_id] = t;
    });

    // 4. Load Stop Times (ONCE!)
    const rawStopTimes = fs.readFileSync(path.join(DATA_DIR, 'stop_times.txt'), 'utf8');
    const stopTimeLines = rawStopTimes.trim().split('\n');

    const stHeaders = stopTimeLines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

    console.log(`  ✓ Loaded ${validTripIds.size} valid trips and ${stopTimeLines.length - 1} stop times`);

    return {
        validTripIds,
        tripRouteMap,
        stopTimeLines,
        stHeaders
    };
}

/**
 * Find best direct trip from stopA to any of the candidate stops (using preloaded data)
 * @param {string} stopA - Source stop ID
 * @param {Array} candidateStops - Array of candidate destination stops
 * @param {string} userTime - Time in HH:MM:SS format
 * @param {Object} preloadedData - Preloaded transit data
 * @returns {Object|null} - Best trip or null if none found
 */
function findBestDirectTrip(stopA, candidateStops, userTime, preloadedData) {
    const { validTripIds, tripRouteMap, stopTimeLines, stHeaders } = preloadedData;

    if (validTripIds.size === 0) {
        return null;
    }

    const tripIdx = stHeaders.indexOf('trip_id');
    const stopIdx = stHeaders.indexOf('stop_id');
    const seqIdx = stHeaders.indexOf('stop_sequence');
    const arrIdx = stHeaders.indexOf('arrival_time');
    const depIdx = stHeaders.indexOf('departure_time');

    // Build a set of candidate stop IDs for quick lookup
    const candidateStopIds = new Set(candidateStops.map(s => s.stop_id));

    const tripStops = {};

    for (let i = 1; i < stopTimeLines.length; i++) {
        const line = stopTimeLines[i];
        const parts = line.split('","');
        if (parts.length > 0) parts[0] = parts[0].replace(/^"/, '');
        if (parts.length > 0) parts[parts.length - 1] = parts[parts.length - 1].replace(/"$/, '');

        const tId = parts[tripIdx];
        if (!validTripIds.has(tId)) continue;

        const sId = parts[stopIdx];

        // Check if this stop is either our source or one of the candidates
        if (sId === stopA || candidateStopIds.has(sId)) {
            if (!tripStops[tId]) tripStops[tId] = {};
            tripStops[tId][sId] = {
                seq: parseInt(parts[seqIdx], 10),
                dep: parts[depIdx],
                arr: parts[arrIdx]
            };
        }
    }

    // 5. Find trips with A -> any candidate stop, organized by destination
    const matchesByDest = {};

    for (const [tId, stops] of Object.entries(tripStops)) {
        if (stops[stopA]) {
            // Check each candidate stop
            for (const candidateStop of candidateStops) {
                const stopB = candidateStop.stop_id;
                if (stops[stopB] && stops[stopA].seq < stops[stopB].seq) {
                    if (!matchesByDest[stopB]) {
                        matchesByDest[stopB] = [];
                    }
                    matchesByDest[stopB].push({
                        trip_id: tId,
                        departure_time: stops[stopA].dep,
                        arrival_at_B: stops[stopB].arr,
                        route_id: tripRouteMap[tId].route_id,
                        headsign: tripRouteMap[tId].trip_headsign,
                        stopB: stopB
                    });
                }
            }
        }
    }

    // 6. Find the earliest next trip to the nearest reachable stop
    let bestTrip = null;
    let bestStopDistance = Infinity;

    for (const [stopB, matches] of Object.entries(matchesByDest)) {
        // Sort matches by departure time
        matches.sort((a, b) => a.departure_time.localeCompare(b.departure_time));

        // Find next available trip for this destination
        const nextTrip = matches.find(m => m.departure_time > userTime);

        if (nextTrip) {
            const stopDistance = candidateStops.find(s => s.stop_id === stopB).distance;

            // Prefer closer stops, but if distances are similar, prefer earlier departure
            if (!bestTrip || stopDistance < bestStopDistance * 0.8 ||
                (stopDistance < bestStopDistance * 1.2 && nextTrip.departure_time < bestTrip.departure_time)) {
                bestTrip = nextTrip;
                bestStopDistance = stopDistance;
            }
        }
    }

    console.log(`  Checked ${Object.keys(matchesByDest).length} destination stops with direct connections.`);

    return bestTrip;
}

async function main() {
    const todayDate = getYYYYMMDD();
    const dayName = getDayName();
    const args = process.argv.slice(2);

    // Check for --to-place mode
    const toPlaceMode = args[0] === '--to-place';

    if (toPlaceMode) {
        if (args.length < 3) {
            console.log("Usage: node find_next_transit.js --to-place <STOP_ID> <PLACE_NAME> [HH:MM:SS] [route_type]");
            console.log("Example: node find_next_transit.js --to-place 12901 'Dubai Mall' 08:00:00 1");
            console.log("\nRoute types: 0=Tram, 1=Metro, 2=Rail, 3=Bus, 4=Ferry");
            process.exit(1);
        }

        const stopA = args[1];
        const placeName = args[2];
        const userTime = args[3] || getCurrentTime();
        const routeType = args[4] || null;

        console.log(`Finding transit from stop ${stopA} to nearest stop to "${placeName}"...`);

        try {
            // Get coordinates of the place
            console.log(`\n[1/4] Geocoding "${placeName}"...`);
            const placeLocation = await getLatLngFromPlace(placeName);
            console.log(`✓ Found: ${placeLocation.formatted_address}`);
            console.log(`  Coordinates: ${placeLocation.lat}, ${placeLocation.lng}`);

            // Find nearest stops
            console.log(`\n[2/4] Finding nearest stops...`);
            const nearestStops = findNearestStops(placeLocation.lat, placeLocation.lng, 100);
            console.log(`✓ Found ${nearestStops.length} nearby stops:`);
            nearestStops.slice(0, 5).forEach((stop, idx) => {
                console.log(`  ${idx + 1}. ${stop.stop_name} (${stop.stop_id}) - ${stop.distance.toFixed(2)} km`);
            });

            // Preload all transit data once
            console.log(`\n[3/4] Searching for direct trips from ${stopA}...`);
            const preloadedData = preloadTransitData(dayName, todayDate, routeType);

            // Find direct trips from stopA to any of these nearest stops
            let result = findBestDirectTrip(stopA, nearestStops, userTime, preloadedData);

            // Load all stops for later use
            const allStops = loadFile('stops.txt');

            // If no direct trip found, check nearby walkable stops from source
            if (!result) {
                console.log(`  No direct connection found. Checking nearby walkable stops...`);

                // Get source stop coordinates
                const sourceStop = allStops.find(s => s.stop_id === stopA);

                if (sourceStop && sourceStop.stop_lat && sourceStop.stop_lon) {
                    // Find stops within walking distance of source (2km = ~20-25 min walk)
                    const nearbySourceStops = findNearestStops(
                        parseFloat(sourceStop.stop_lat),
                        parseFloat(sourceStop.stop_lon),
                        100
                    ).filter(s => s.stop_id !== stopA && s.distance <= 2.0); // 2000m in km

                    console.log(`  Found ${nearbySourceStops.length} walkable stops near ${stopA} (within 2km)`);

                    if (nearbySourceStops.length > 0) {
                        nearbySourceStops.slice(0, 3).forEach((stop, idx) => {
                            const distDisplay = stop.distance < 1
                                ? `${(stop.distance * 1000).toFixed(0)}m`
                                : `${stop.distance.toFixed(2)}km`;
                            console.log(`    ${idx + 1}. ${stop.stop_name} (${stop.stop_id}) - ${distDisplay}`);
                        });

                        // Try nearby source stops in parallel batches with progress indicator
                        let bestTransferOption = null;
                        let bestTransferStop = null;

                        const BATCH_SIZE = 10; // Process 10 stops at a time in parallel
                        let checked = 0;

                        for (let i = 0; i < nearbySourceStops.length; i += BATCH_SIZE) {
                            if (bestTransferOption) break; // Stop if we found one

                            const batch = nearbySourceStops.slice(i, i + BATCH_SIZE);
                            console.log(`  Checking stops ${i + 1}-${Math.min(i + BATCH_SIZE, nearbySourceStops.length)} of ${nearbySourceStops.length}...`);

                            // Check all stops in batch in parallel
                            const batchResults = await Promise.all(
                                batch.map(async (nearbyStop) => {
                                    const transferResult = findBestDirectTrip(
                                        nearbyStop.stop_id,
                                        nearestStops,
                                        userTime,
                                        preloadedData
                                    );
                                    return { nearbyStop, transferResult };
                                })
                            );

                            checked += batch.length;

                            // Check if any succeeded
                            for (const { nearbyStop, transferResult } of batchResults) {
                                if (transferResult) {
                                    bestTransferOption = transferResult;
                                    bestTransferStop = nearbyStop;
                                    console.log(`  ✓ Found connection via nearby stop: ${bestTransferStop.stop_name} (checked ${checked}/${nearbySourceStops.length} stops)`);
                                    break;
                                }
                            }
                        }

                        if (!bestTransferOption && checked > 0) {
                            console.log(`  ✗ No connections found after checking all ${checked} nearby stops`);
                        }

                        if (bestTransferOption) {
                            result = {
                                ...bestTransferOption,
                                requiresWalk: true,
                                walkFrom: stopA,
                                walkTo: bestTransferStop.stop_id,
                                walkDistance: bestTransferStop.distance,
                                walkTime: Math.ceil(bestTransferStop.distance * 1000 / 80) // 80m/min walking speed
                            };
                        }
                    }
                }
            }

            console.log(`\n[4/4] Results:`);
            if (result) {
                const destStop = nearestStops.find(s => s.stop_id === result.stopB);

                if (result.requiresWalk) {
                    // Show walk + transit option
                    const walkFromStop = allStops.find(s => s.stop_id === result.walkFrom);
                    const walkToStop = allStops.find(s => s.stop_id === result.walkTo);

                    const walkDistDisplay = result.walkDistance < 1
                        ? `${(result.walkDistance * 1000).toFixed(0)} meters`
                        : `${result.walkDistance.toFixed(2)} km`;

                    console.log(`\n✓ Found transit with walk:`);
                    console.log(`\n[WALK] ${walkFromStop.stop_name} → ${walkToStop.stop_name}`);
                    console.log(`  Distance: ${walkDistDisplay}`);
                    console.log(`  Walking time: ~${result.walkTime} minute(s)`);

                    console.log(`\n[TRANSIT] ${walkToStop.stop_name} → ${destStop.stop_name}`);
                    console.log(`  Route: ${result.route_id}`);
                    console.log(`  Trip Headsign: ${result.headsign}`);
                    console.log(`  Departure: ${result.departure_time}`);
                    console.log(`  Arrival: ${result.arrival_at_B}`);

                    const [depH, depM] = result.departure_time.split(':').map(Number);
                    const [arrH, arrM] = result.arrival_at_B.split(':').map(Number);
                    const transitMinutes = (arrH * 60 + arrM) - (depH * 60 + depM);
                    const totalMinutes = result.walkTime + transitMinutes;

                    console.log(`\n  Transit time: ${transitMinutes} minutes`);
                    console.log(`  Total time (walk + transit): ${totalMinutes} minutes`);
                    console.log(`  Final distance to ${placeName}: ${destStop.distance.toFixed(2)} km`);
                } else {
                    // Show direct option
                    console.log(`\n✓ Found direct transit to: ${destStop.stop_name} (${destStop.stop_id})`);
                    console.log(`  Distance from ${placeName}: ${destStop.distance.toFixed(2)} km`);
                    console.log(`\nRoute: ${result.route_id}`);
                    console.log(`Trip Headsign: ${result.headsign}`);
                    console.log(`Departure from ${stopA}: ${result.departure_time}`);
                    console.log(`Arrival at ${destStop.stop_id}: ${result.arrival_at_B}`);

                    const [depH, depM] = result.departure_time.split(':').map(Number);
                    const [arrH, arrM] = result.arrival_at_B.split(':').map(Number);
                    const travelMinutes = (arrH * 60 + arrM) - (depH * 60 + depM);
                    console.log(`Travel time: ${travelMinutes} minutes`);
                }
            } else {
                console.log(`\n✗ No transit found from stop ${stopA} (or nearby walkable stops) to ${placeName} after ${userTime}.`);
                console.log(`\nTry these alternatives:`);
                console.log(`  - Check earlier times today`);
                console.log(`  - Use a different starting stop`);
                console.log(`  - Consider multi-leg journeys with transfers`);
            }
        } catch (error) {
            console.error(`\nError: ${error.message}`);
            process.exit(1);
        }

        return;
    }

    // Original mode: two stop IDs
    if (args.length < 2) {
        console.log("Usage:");
        console.log("  Mode 1: node find_next_transit.js <STOP_A_ID> <STOP_B_ID> [HH:MM:SS] [route_type]");
        console.log("  Mode 2: node find_next_transit.js --to-place <STOP_ID> <PLACE_NAME> [HH:MM:SS] [route_type]");
        console.log("\nExamples:");
        console.log("  node find_next_transit.js 12901 13402 08:00:00 1");
        console.log("  node find_next_transit.js --to-place 12901 'Dubai Mall' 08:00:00");
        console.log("\nRoute types: 0=Tram, 1=Metro, 2=Rail, 3=Bus, 4=Ferry");
        process.exit(1);
    }

    const stopA = args[0];
    const stopB = args[1];
    const userTime = args[2] || getCurrentTime();
    const routeType = args[3] || null;

    const routeTypeNames = {
        '0': 'Tram', '1': 'Metro', '2': 'Rail', '3': 'Bus',
        '4': 'Ferry', '5': 'Cable car', '6': 'Gondola', '7': 'Funicular'
    };

    console.log(`Looking for transit from ${stopA} to ${stopB} after ${userTime} on ${dayName} (${todayDate})...`);
    if (routeType) {
        console.log(`Filtering for: ${routeTypeNames[routeType] || 'Unknown'} (type ${routeType})`);
    }

    // 1. Load Routes
    const routes = loadFile('routes.txt');
    const targetRouteIds = new Set(
        routes
            .filter(r => !routeType || r.route_type === routeType)
            .map(r => r.route_id)
    );
    console.log(`Found ${targetRouteIds.size} routes.`);

    // 2. Load Calendar (Active Services)
    const calendar = loadFile('calendar.txt');
    const activeServices = new Set(
        calendar
            .filter(c => {
                const startDate = parseInt(c.start_date, 10);
                const endDate = parseInt(c.end_date, 10);
                const isActiveDay = c[dayName] === '1';
                return isActiveDay && todayDate >= startDate && todayDate <= endDate;
            })
            .map(c => c.service_id)
    );

    console.log(`Found ${activeServices.size} active service IDs for today.`);

    // 3. Load Trips
    const allTrips = loadFile('trips.txt');
    const validTrips = allTrips.filter(t =>
        targetRouteIds.has(t.route_id) && activeServices.has(t.service_id)
    );
    const validTripIds = new Set(validTrips.map(t => t.trip_id));

    const tripRouteMap = {};
    validTrips.forEach(t => {
        tripRouteMap[t.trip_id] = t;
    });

    console.log(`Found ${validTripIds.size} valid trips running today.`);

    if (validTripIds.size === 0) {
        console.log("No trips running today found.");
        return;
    }

    // 4. Load Stop Times
    const rawStopTimes = fs.readFileSync(path.join(DATA_DIR, 'stop_times.txt'), 'utf8');
    const stopTimeLines = rawStopTimes.trim().split('\n');

    const stHeaders = stopTimeLines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const tripIdx = stHeaders.indexOf('trip_id');
    const stopIdx = stHeaders.indexOf('stop_id');
    const seqIdx = stHeaders.indexOf('stop_sequence');
    const arrIdx = stHeaders.indexOf('arrival_time');
    const depIdx = stHeaders.indexOf('departure_time');

    const tripStops = {};

    for (let i = 1; i < stopTimeLines.length; i++) {
        const line = stopTimeLines[i];
        const parts = line.split('","');
        if (parts.length > 0) parts[0] = parts[0].replace(/^"/, '');
        if (parts.length > 0) parts[parts.length - 1] = parts[parts.length - 1].replace(/"$/, '');

        const tId = parts[tripIdx];

        if (!validTripIds.has(tId)) continue;

        const sId = parts[stopIdx];

        if (sId === stopA || sId === stopB) {
            if (!tripStops[tId]) tripStops[tId] = {};
            tripStops[tId][sId] = {
                seq: parseInt(parts[seqIdx], 10),
                dep: parts[depIdx],
                arr: parts[arrIdx]
            };
        }
    }

    const tripsWithA = Object.values(tripStops).filter(s => s[stopA]).length;
    const tripsWithB = Object.values(tripStops).filter(s => s[stopB]).length;
    console.log(`Debug: Trips with Stop A (${stopA}): ${tripsWithA}`);
    console.log(`Debug: Trips with Stop B (${stopB}): ${tripsWithB}`);

    console.log(`Scanned stop_times, found relevant stops in ${Object.keys(tripStops).length} trips.`);

    // 5. Find trips with A -> B
    const matches = [];

    for (const [tId, stops] of Object.entries(tripStops)) {
        if (stops[stopA] && stops[stopB]) {
            if (stops[stopA].seq < stops[stopB].seq) {
                matches.push({
                    trip_id: tId,
                    departure_time: stops[stopA].dep,
                    arrival_at_B: stops[stopB].arr,
                    route_id: tripRouteMap[tId].route_id,
                    headsign: tripRouteMap[tId].trip_headsign
                });
            }
        }
    }

    // 6. Filter for next trip
    matches.sort((a, b) => a.departure_time.localeCompare(b.departure_time));

    const nextTrip = matches.find(m => m.departure_time > userTime);

    if (nextTrip) {
        console.log(`\n✓ Next transit from ${stopA} to ${stopB}:`);
        console.log(`Route: ${nextTrip.route_id}`);
        console.log(`Trip Headsign: ${nextTrip.headsign}`);
        console.log(`Departure: ${nextTrip.departure_time}`);
        console.log(`Arrival at Dest: ${nextTrip.arrival_at_B}`);

        // Calculate travel time
        const [depH, depM, depS] = nextTrip.departure_time.split(':').map(Number);
        const [arrH, arrM, arrS] = nextTrip.arrival_at_B.split(':').map(Number);
        const depMinutes = depH * 60 + depM;
        const arrMinutes = arrH * 60 + arrM;
        const travelMinutes = arrMinutes - depMinutes;
        console.log(`Travel time: ${travelMinutes} minutes`);
    } else {
        console.log(`\n✗ No direct transit found from ${stopA} to ${stopB} after ${userTime} today.`);
        if (matches.length > 0) {
            console.log(`\nEarlier trips today were available at: ${matches.slice(0, 5).map(m => m.departure_time).join(', ')}${matches.length > 5 ? ` ... and ${matches.length - 5} more` : ''}`);
        }
    }
}

main();

