/**
 * Transit Finder with Single Transfer Support
 * 
 * Implements Approach 1: Single Transfer (2-Leg Journey) from multi-leg-journey-strategies.md
 * 
 * This script finds routes from a stop to a place that may require one transfer.
 * 
 * Usage:
 *   node find_transit_with_transfer.js <STOP_ID> <PLACE_NAME> [HH:MM:SS] [route_type]
 * 
 * Examples:
 *   node find_transit_with_transfer.js 227102 "Dubai Mall"
 *   node find_transit_with_transfer.js 227102 "Dubai Mall" 08:00:00
 *   node find_transit_with_transfer.js 227102 "Dubai Mall" 08:00:00 1
 * 
 * Route types: 0=Tram, 1=Metro, 2=Rail, 3=Bus, 4=Ferry
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');

// ===== CONFIGURATION =====
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const TRANSFER_TIME_MINUTES = 5; // Minimum transfer time in minutes
const MAX_DESTINATIONS_NEAR_PLACE = 20; // How many stops near destination to check
const MAX_INTERMEDIATE_STOPS = 50; // Max intermediate stops to check for transfers
// =========================

// Helper to parse CSV lines
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
 * Get transit type name from route type code
 */
function getTransitTypeName(routeType) {
    const types = {
        '0': 'Tram',
        '1': 'Metro',
        '2': 'Rail',
        '3': 'Bus',
        '4': 'Ferry',
        '5': 'Cable car',
        '6': 'Gondola',
        '7': 'Funicular'
    };
    return types[routeType] || 'Transit';
}

/**
 * Get latitude and longitude of a place using Google Maps Geocoding API
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
 * Add minutes to a time string (HH:MM:SS)
 */
function addMinutesToTime(timeStr, minutes) {
    const [h, m, s] = timeStr.split(':').map(Number);
    const totalMinutes = h * 60 + m + minutes;
    const newH = Math.floor(totalMinutes / 60) % 24;
    const newM = totalMinutes % 60;
    return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Calculate time difference in minutes
 */
function timeDifferenceMinutes(time1, time2) {
    const [h1, m1] = time1.split(':').map(Number);
    const [h2, m2] = time2.split(':').map(Number);
    return (h2 * 60 + m2) - (h1 * 60 + m1);
}

/**
 * Preload all transit data once for efficiency
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
        stHeaders,
        routes
    };
}

/**
 * Find all stops reachable from stopA after userTime (LEG 1)
 * Returns array of intermediate stops with arrival times
 */
function getReachableStops(stopA, userTime, preloadedData) {
    const { validTripIds, tripRouteMap, stopTimeLines, stHeaders } = preloadedData;

    const tripIdx = stHeaders.indexOf('trip_id');
    const stopIdx = stHeaders.indexOf('stop_id');
    const seqIdx = stHeaders.indexOf('stop_sequence');
    const arrIdx = stHeaders.indexOf('arrival_time');
    const depIdx = stHeaders.indexOf('departure_time');

    // Build map of trip -> all stops with times
    const tripStopMap = {}; // trip_id -> [{stop_id, seq, arr, dep}, ...]

    for (let i = 1; i < stopTimeLines.length; i++) {
        const line = stopTimeLines[i];
        const parts = line.split('","');
        if (parts.length > 0) parts[0] = parts[0].replace(/^"/, '');
        if (parts.length > 0) parts[parts.length - 1] = parts[parts.length - 1].replace(/"$/, '');

        const tId = parts[tripIdx];
        if (!validTripIds.has(tId)) continue;

        const sId = parts[stopIdx];
        const seq = parseInt(parts[seqIdx], 10);
        const arr = parts[arrIdx];
        const dep = parts[depIdx];

        if (!tripStopMap[tId]) tripStopMap[tId] = [];
        tripStopMap[tId].push({ stop_id: sId, seq, arr, dep });
    }

    // Find trips that pass through stopA and depart after userTime
    const reachableStops = {}; // stop_id -> {earliest arrival, trip info}

    for (const [tripId, stops] of Object.entries(tripStopMap)) {
        // Sort by sequence
        stops.sort((a, b) => a.seq - b.seq);

        // Find stopA in this trip
        const stopAIndex = stops.findIndex(s => s.stop_id === stopA);
        if (stopAIndex === -1) continue;

        const stopAInfo = stops[stopAIndex];
        if (stopAInfo.dep <= userTime) continue; // Trip leaves before userTime

        // All stops after stopA are reachable
        for (let i = stopAIndex + 1; i < stops.length; i++) {
            const destStop = stops[i];
            const destStopId = destStop.stop_id;

            // Keep earliest arrival to each stop
            if (!reachableStops[destStopId] || destStop.arr < reachableStops[destStopId].arrival) {
                reachableStops[destStopId] = {
                    stop_id: destStopId,
                    arrival: destStop.arr,
                    departure_from_A: stopAInfo.dep,
                    trip_id: tripId,
                    route_id: tripRouteMap[tripId].route_id,
                    headsign: tripRouteMap[tripId].trip_headsign
                };
            }
        }
    }

    return Object.values(reachableStops);
}

/**
 * Find direct routes from start stop to any target stop (no transfers)
 */
function findDirectRoutes(startStopId, afterTime, targetStops, preloadedData) {
    const { validTripIds, tripRouteMap, stopTimeLines, stHeaders } = preloadedData;

    const tripIdx = stHeaders.indexOf('trip_id');
    const stopIdx = stHeaders.indexOf('stop_id');
    const seqIdx = stHeaders.indexOf('stop_sequence');
    const arrIdx = stHeaders.indexOf('arrival_time');
    const depIdx = stHeaders.indexOf('departure_time');

    const candidateStopIds = new Set(targetStops.map(s => s.stop_id));
    const tripStops = {};

    for (let i = 1; i < stopTimeLines.length; i++) {
        const line = stopTimeLines[i];
        const parts = line.split('","');
        if (parts.length > 0) parts[0] = parts[0].replace(/^"/, '');
        if (parts.length > 0) parts[parts.length - 1] = parts[parts.length - 1].replace(/"$/, '');

        const tId = parts[tripIdx];
        if (!validTripIds.has(tId)) continue;

        const sId = parts[stopIdx];

        if (sId === startStopId || candidateStopIds.has(sId)) {
            if (!tripStops[tId]) tripStops[tId] = {};
            tripStops[tId][sId] = {
                seq: parseInt(parts[seqIdx], 10),
                dep: parts[depIdx],
                arr: parts[arrIdx]
            };
        }
    }

    // Find trips with start -> target
    const matches = [];

    for (const [tId, stops] of Object.entries(tripStops)) {
        if (stops[startStopId]) {
            const startInfo = stops[startStopId];

            // Must depart after specified time
            if (startInfo.dep <= afterTime) continue;

            // Check each target stop
            for (const targetStop of targetStops) {
                const targetStopId = targetStop.stop_id;
                if (stops[targetStopId] && startInfo.seq < stops[targetStopId].seq) {
                    matches.push({
                        trip_id: tId,
                        departure_time: startInfo.dep,
                        arrival_time: stops[targetStopId].arr,
                        route_id: tripRouteMap[tId].route_id,
                        headsign: tripRouteMap[tId].trip_headsign,
                        target_stop_id: targetStopId,
                        target_stop: targetStop
                    });
                }
            }
        }
    }

    // Return all matches sorted by arrival time and distance to destination
    if (matches.length === 0) return [];

    matches.sort((a, b) => {
        // First prioritize by distance to destination
        const distA = a.target_stop.distance;
        const distB = b.target_stop.distance;
        if (distA !== distB) return distA - distB;
        // Then by arrival time
        return a.arrival_time.localeCompare(b.arrival_time);
    });

    return matches;
}

/**
 * Find best direct trip from intermediate stop to any target stop after transfer time (LEG 2)
 */
function findConnectionFromIntermediate(intermediateStopId, afterTime, targetStops, preloadedData) {
    const { validTripIds, tripRouteMap, stopTimeLines, stHeaders } = preloadedData;

    const tripIdx = stHeaders.indexOf('trip_id');
    const stopIdx = stHeaders.indexOf('stop_id');
    const seqIdx = stHeaders.indexOf('stop_sequence');
    const arrIdx = stHeaders.indexOf('arrival_time');
    const depIdx = stHeaders.indexOf('departure_time');

    const candidateStopIds = new Set(targetStops.map(s => s.stop_id));
    const tripStops = {};

    for (let i = 1; i < stopTimeLines.length; i++) {
        const line = stopTimeLines[i];
        const parts = line.split('","');
        if (parts.length > 0) parts[0] = parts[0].replace(/^"/, '');
        if (parts.length > 0) parts[parts.length - 1] = parts[parts.length - 1].replace(/"$/, '');

        const tId = parts[tripIdx];
        if (!validTripIds.has(tId)) continue;

        const sId = parts[stopIdx];

        if (sId === intermediateStopId || candidateStopIds.has(sId)) {
            if (!tripStops[tId]) tripStops[tId] = {};
            tripStops[tId][sId] = {
                seq: parseInt(parts[seqIdx], 10),
                dep: parts[depIdx],
                arr: parts[arrIdx]
            };
        }
    }

    // Find trips with intermediate -> target
    const matches = [];

    for (const [tId, stops] of Object.entries(tripStops)) {
        if (stops[intermediateStopId]) {
            const intermediateInfo = stops[intermediateStopId];

            // Must depart after transfer time
            if (intermediateInfo.dep <= afterTime) continue;

            // Check each target stop
            for (const targetStop of targetStops) {
                const targetStopId = targetStop.stop_id;
                if (stops[targetStopId] && intermediateInfo.seq < stops[targetStopId].seq) {
                    matches.push({
                        trip_id: tId,
                        departure_time: intermediateInfo.dep,
                        arrival_time: stops[targetStopId].arr,
                        route_id: tripRouteMap[tId].route_id,
                        headsign: tripRouteMap[tId].trip_headsign,
                        target_stop_id: targetStopId,
                        target_stop: targetStop
                    });
                }
            }
        }
    }

    // Return earliest connection
    if (matches.length === 0) return null;

    matches.sort((a, b) => a.departure_time.localeCompare(b.departure_time));
    return matches[0];
}

/**
 * Main function to find route with single transfer
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.log("Usage: node find_transit_with_transfer.js <STOP_ID> <PLACE_NAME> [HH:MM:SS] [route_type]");
        console.log("\nExamples:");
        console.log("  node find_transit_with_transfer.js 227102 'Dubai Mall'");
        console.log("  node find_transit_with_transfer.js 227102 'Dubai Mall' 08:00:00");
        console.log("  node find_transit_with_transfer.js 227102 'Dubai Mall' 08:00:00 1");
        console.log("\nRoute types: 0=Tram, 1=Metro, 2=Rail, 3=Bus, 4=Ferry");
        process.exit(1);
    }

    const stopA = args[0];
    const placeName = args[1];
    const userTime = args[2] || getCurrentTime();
    const routeType = args[3] || null;

    const todayDate = getYYYYMMDD();
    const dayName = getDayName();

    console.log(`\nFinding route from stop ${stopA} to "${placeName}"...`);
    console.log(`Date: ${dayName} (${todayDate}), Departure after: ${userTime}`);
    if (routeType) {
        const types = { '0': 'Tram', '1': 'Metro', '2': 'Rail', '3': 'Bus', '4': 'Ferry' };
        console.log(`Route type filter: ${types[routeType] || routeType}`);
    }

    try {
        // STEP 1: Geocode destination
        console.log(`\n[1/5] Geocoding destination "${placeName}"...`);
        const placeLocation = await getLatLngFromPlace(placeName);
        console.log(`  ✓ ${placeLocation.formatted_address}`);
        console.log(`  ✓ Coordinates: ${placeLocation.lat}, ${placeLocation.lng}`);

        // STEP 2: Find nearest stops to destination
        console.log(`\n[2/5] Finding stops near destination...`);
        const targetStops = findNearestStops(placeLocation.lat, placeLocation.lng, MAX_DESTINATIONS_NEAR_PLACE);
        console.log(`  ✓ Found ${targetStops.length} stops near destination`);
        targetStops.slice(0, 3).forEach((stop, idx) => {
            console.log(`     ${idx + 1}. ${stop.stop_name} (${stop.stop_id}) - ${stop.distance.toFixed(2)} km`);
        });

        // STEP 3: Preload transit data
        console.log(`\n[3/5] Loading transit data...`);
        const preloadedData = preloadTransitData(dayName, todayDate, routeType);

        const allStops = loadFile('stops.txt');
        const stopAInfo = allStops.find(s => s.stop_id === stopA);

        // STEP 4: Check for direct routes first (no transfers)
        console.log(`\n[4/6] Checking for direct routes...`);
        const directRoutes = findDirectRoutes(stopA, userTime, targetStops, preloadedData);

        let bestRoute = null;
        let bestTotalTime = Infinity;

        if (directRoutes.length > 0) {
            console.log(`  ✓ Found ${directRoutes.length} direct route(s)`);

            // Get the best direct route (closest to destination)
            const bestDirect = directRoutes[0];
            const totalMinutes = timeDifferenceMinutes(bestDirect.departure_time, bestDirect.arrival_time);

            // Get route type for display
            const route = preloadedData.routes.find(r => r.route_id === bestDirect.route_id);

            bestRoute = {
                direct: true,
                leg1: {
                    from: stopAInfo,
                    to: bestDirect.target_stop,
                    departure: bestDirect.departure_time,
                    arrival: bestDirect.arrival_time,
                    route_id: bestDirect.route_id,
                    headsign: bestDirect.headsign,
                    trip_id: bestDirect.trip_id,
                    route_type: route ? route.route_type : null
                },
                totalTime: totalMinutes
            };
            bestTotalTime = totalMinutes;

            console.log(`  ✓ Best direct route: ${bestDirect.route_id} (${totalMinutes} min, ${bestDirect.target_stop.distance.toFixed(2)} km to destination)`);
            console.log(`  ✓ Skipping transfer search (direct route available)`);
        } else {
            console.log(`  ✗ No direct routes found`);

            // STEP 5: Find all reachable intermediate stops from stopA (only if no direct route)
            console.log(`\n[5/6] Finding reachable stops for transfer routes...`);
            const reachableStops = getReachableStops(stopA, userTime, preloadedData);
            console.log(`  ✓ Found ${reachableStops.length} reachable stops from ${stopA}`);

            let intermediateStopsToCheck = [];

            if (reachableStops.length === 0) {
                if (!bestRoute) {
                    console.log(`\n✗ No trips depart from stop ${stopA} after ${userTime}`);
                    process.exit(0);
                }
            } else {
                // Sort by arrival time (check nearest ones first)
                reachableStops.sort((a, b) => a.arrival.localeCompare(b.arrival));

                // Limit to first N intermediate stops for performance
                intermediateStopsToCheck = reachableStops.slice(0, MAX_INTERMEDIATE_STOPS);
                console.log(`  ✓ Checking top ${intermediateStopsToCheck.length} intermediate stops for connections...`);

                // STEP 6: For each intermediate stop, check if it can reach destination
                console.log(`\n[6/6] Searching for transfer connections to destination...`);

                for (let i = 0; i < intermediateStopsToCheck.length; i++) {
                    const intermediate = intermediateStopsToCheck[i];

                    if ((i + 1) % 10 === 0 || i === 0) {
                        console.log(`  Checking intermediate stop ${i + 1}/${intermediateStopsToCheck.length}...`);
                    }

                    // Calculate minimum time at intermediate stop (arrival + transfer buffer)
                    const transferTime = addMinutesToTime(intermediate.arrival, TRANSFER_TIME_MINUTES);

                    // Find connection from intermediate to any target stop
                    const leg2 = findConnectionFromIntermediate(
                        intermediate.stop_id,
                        transferTime,
                        targetStops,
                        preloadedData
                    );

                    if (leg2) {
                        // Calculate total journey time
                        const totalMinutes = timeDifferenceMinutes(intermediate.departure_from_A, leg2.arrival_time);

                        if (totalMinutes < bestTotalTime) {
                            const intermediateStopInfo = allStops.find(s => s.stop_id === intermediate.stop_id);

                            bestTotalTime = totalMinutes;
                            // Get route types for display
                            const route1 = preloadedData.routes.find(r => r.route_id === intermediate.route_id);
                            const route2 = preloadedData.routes.find(r => r.route_id === leg2.route_id);

                            bestRoute = {
                                leg1: {
                                    from: stopAInfo,
                                    to: intermediateStopInfo,
                                    departure: intermediate.departure_from_A,
                                    arrival: intermediate.arrival,
                                    route_id: intermediate.route_id,
                                    headsign: intermediate.headsign,
                                    trip_id: intermediate.trip_id,
                                    route_type: route1 ? route1.route_type : null
                                },
                                transfer: {
                                    stop: intermediateStopInfo,
                                    arrival: intermediate.arrival,
                                    next_departure: leg2.departure_time,
                                    wait_time: timeDifferenceMinutes(intermediate.arrival, leg2.departure_time)
                                },
                                leg2: {
                                    from: intermediateStopInfo,
                                    to: leg2.target_stop,
                                    departure: leg2.departure_time,
                                    arrival: leg2.arrival_time,
                                    route_id: leg2.route_id,
                                    headsign: leg2.headsign,
                                    trip_id: leg2.trip_id,
                                    route_type: route2 ? route2.route_type : null
                                },
                                totalTime: totalMinutes
                            };

                            console.log(`  ✓ Found route via ${intermediateStopInfo.stop_name} (${totalMinutes} min total)`);
                        }
                    }
                }
            }

            // If no route found, try nearby walkable stops
            if (!bestRoute) {
                console.log(`\n  No direct route found. Checking nearby walkable stops...`);

                const nearbyStops = findNearestStops(
                    parseFloat(stopAInfo.stop_lat),
                    parseFloat(stopAInfo.stop_lon),
                    20  // Check top 20 nearest stops
                ).filter(s => s.stop_id !== stopA && s.distance <= 0.5); // Within 500m

                if (nearbyStops.length > 0) {
                    console.log(`  Found ${nearbyStops.length} walkable stops near ${stopA} (within 500m)`);
                    nearbyStops.slice(0, 3).forEach((stop, idx) => {
                        const distDisplay = stop.distance < 1
                            ? `${(stop.distance * 1000).toFixed(0)}m`
                            : `${stop.distance.toFixed(2)}km`;
                        console.log(`     ${idx + 1}. ${stop.stop_name} (${stop.stop_id}) - ${distDisplay}`);
                    });

                    console.log(`\n  Searching for routes from nearby stops...`);

                    for (const nearbyStop of nearbyStops) {
                        console.log(`  Trying ${nearbyStop.stop_name}...`);

                        // Get reachable stops from this nearby stop
                        const reachableFromNearby = getReachableStops(nearbyStop.stop_id, userTime, preloadedData);

                        if (reachableFromNearby.length === 0) continue;

                        // Check connections from these reachable stops
                        const intermediateStopsNearby = reachableFromNearby.slice(0, MAX_INTERMEDIATE_STOPS);

                        for (const intermediate of intermediateStopsNearby) {
                            const transferTime = addMinutesToTime(intermediate.arrival, TRANSFER_TIME_MINUTES);
                            const leg2 = findConnectionFromIntermediate(
                                intermediate.stop_id,
                                transferTime,
                                targetStops,
                                preloadedData
                            );

                            if (leg2) {
                                const totalMinutes = timeDifferenceMinutes(intermediate.departure_from_A, leg2.arrival_time);
                                const walkTime = Math.ceil(nearbyStop.distance * 1000 / 80); // 80m/min
                                const totalWithWalk = totalMinutes + walkTime;

                                if (totalWithWalk < bestTotalTime) {
                                    const intermediateStopInfo = allStops.find(s => s.stop_id === intermediate.stop_id);

                                    // Get route types for display
                                    const route1 = preloadedData.routes.find(r => r.route_id === intermediate.route_id);
                                    const route2 = preloadedData.routes.find(r => r.route_id === leg2.route_id);

                                    bestTotalTime = totalWithWalk;
                                    bestRoute = {
                                        walk: {
                                            from: stopAInfo,
                                            to: nearbyStop,
                                            distance: nearbyStop.distance,
                                            time: walkTime
                                        },
                                        leg1: {
                                            from: nearbyStop,
                                            to: intermediateStopInfo,
                                            departure: intermediate.departure_from_A,
                                            arrival: intermediate.arrival,
                                            route_id: intermediate.route_id,
                                            headsign: intermediate.headsign,
                                            trip_id: intermediate.trip_id,
                                            route_type: route1 ? route1.route_type : null
                                        },
                                        transfer: {
                                            stop: intermediateStopInfo,
                                            arrival: intermediate.arrival,
                                            next_departure: leg2.departure_time,
                                            wait_time: timeDifferenceMinutes(intermediate.arrival, leg2.departure_time)
                                        },
                                        leg2: {
                                            from: intermediateStopInfo,
                                            to: leg2.target_stop,
                                            departure: leg2.departure_time,
                                            arrival: leg2.arrival_time,
                                            route_id: leg2.route_id,
                                            headsign: leg2.headsign,
                                            trip_id: leg2.trip_id,
                                            route_type: route2 ? route2.route_type : null
                                        },
                                        totalTime: totalWithWalk
                                    };

                                    console.log(`    ✓ Found route via ${nearbyStop.stop_name} (${totalWithWalk} min total including walk)`);
                                    break; // Found a route, stop checking this nearby stop
                                }
                            }
                        }

                        if (bestRoute) break; // Found a route, stop checking other nearby stops
                    }
                }
            }
        }

        // Display results
        console.log(`\n${'='.repeat(70)}`);
        console.log(`RESULTS`);
        console.log(`${'='.repeat(70)}`);

        if (bestRoute) {
            const hasWalk = !!bestRoute.walk;
            const isDirect = !!bestRoute.direct;

            if (isDirect) {
                console.log(`\n✓ Best route found - DIRECT (no transfers):`);
                console.log(`  Total journey time: ${bestRoute.totalTime} minutes`);

                // Direct route - only LEG 1
                const leg1Type = getTransitTypeName(bestRoute.leg1.route_type);
                console.log(`\n┌─ ${leg1Type} ${bestRoute.leg1.route_id}`);
                console.log(`│  From: ${bestRoute.leg1.from.stop_name} (${bestRoute.leg1.from.stop_id})`);
                console.log(`│  To: ${bestRoute.leg1.to.stop_name} (${bestRoute.leg1.to.stop_id})`);
                console.log(`│  Headsign: ${bestRoute.leg1.headsign}`);
                console.log(`│  Departure: ${bestRoute.leg1.departure}`);
                console.log(`│  Arrival: ${bestRoute.leg1.arrival}`);
                const leg1Duration = timeDifferenceMinutes(bestRoute.leg1.departure, bestRoute.leg1.arrival);
                console.log(`│  Duration: ${leg1Duration} minutes`);
                console.log(`└─`);

                console.log(`\n   Final distance to ${placeName}: ${bestRoute.leg1.to.distance.toFixed(2)} km`);
            } else {
                // Route with transfer
                if (hasWalk) {
                    console.log(`\n✓ Best route found with walk + 1 transfer:`);
                } else {
                    console.log(`\n✓ Best route found with 1 transfer:`);
                }
                console.log(`  Total journey time: ${bestRoute.totalTime} minutes`);

                // WALK (if applicable)
                if (hasWalk) {
                    const distDisplay = bestRoute.walk.distance < 1
                        ? `${(bestRoute.walk.distance * 1000).toFixed(0)} meters`
                        : `${bestRoute.walk.distance.toFixed(2)} km`;
                    console.log(`\n┌─ WALK`);
                    console.log(`│  From: ${bestRoute.walk.from.stop_name} (${bestRoute.walk.from.stop_id})`);
                    console.log(`│  To: ${bestRoute.walk.to.stop_name} (${bestRoute.walk.to.stop_id})`);
                    console.log(`│  Distance: ${distDisplay}`);
                    console.log(`│  Walking time: ~${bestRoute.walk.time} minutes`);
                    console.log(`│`);
                }

                // LEG 1
                const leg1Type = getTransitTypeName(bestRoute.leg1.route_type);
                if (hasWalk) {
                    console.log(`├─ LEG 1: ${leg1Type} ${bestRoute.leg1.route_id}`);
                } else {
                    console.log(`\n┌─ LEG 1: ${leg1Type} ${bestRoute.leg1.route_id}`);
                }
                console.log(`│  From: ${bestRoute.leg1.from.stop_name} (${bestRoute.leg1.from.stop_id})`);
                console.log(`│  To: ${bestRoute.leg1.to.stop_name} (${bestRoute.leg1.to.stop_id})`);
                console.log(`│  Headsign: ${bestRoute.leg1.headsign}`);
                console.log(`│  Departure: ${bestRoute.leg1.departure}`);
                console.log(`│  Arrival: ${bestRoute.leg1.arrival}`);
                const leg1Duration = timeDifferenceMinutes(bestRoute.leg1.departure, bestRoute.leg1.arrival);
                console.log(`│  Duration: ${leg1Duration} minutes`);

                // TRANSFER
                console.log(`│`);
                console.log(`├─ TRANSFER at ${bestRoute.transfer.stop.stop_name}`);
                console.log(`│  Wait time: ${bestRoute.transfer.wait_time} minutes`);
                console.log(`│  Next departure: ${bestRoute.transfer.next_departure}`);

                // LEG 2
                const leg2Type = getTransitTypeName(bestRoute.leg2.route_type);
                console.log(`│`);
                console.log(`└─ LEG 2: ${leg2Type} ${bestRoute.leg2.route_id}`);
                console.log(`   From: ${bestRoute.leg2.from.stop_name} (${bestRoute.leg2.from.stop_id})`);
                console.log(`   To: ${bestRoute.leg2.to.stop_name} (${bestRoute.leg2.to.stop_id})`);
                console.log(`   Headsign: ${bestRoute.leg2.headsign}`);
                console.log(`   Departure: ${bestRoute.leg2.departure}`);
                console.log(`   Arrival: ${bestRoute.leg2.arrival}`);
                const leg2Duration = timeDifferenceMinutes(bestRoute.leg2.departure, bestRoute.leg2.arrival);
                console.log(`   Duration: ${leg2Duration} minutes`);

                console.log(`\n   Final distance to ${placeName}: ${bestRoute.leg2.to.distance.toFixed(2)} km`);

                if (hasWalk) {
                    console.log(`\n   Note: Includes ${bestRoute.walk.time} min walk from ${bestRoute.walk.from.stop_name} to ${bestRoute.walk.to.stop_name}`);
                }
            }

        } else {
            console.log(`\n✗ No route found from stop ${stopA} to ${placeName}`);
            console.log(`\nThis could mean:`);
            console.log(`  - No connecting routes exist between reachable stops and destination`);
            console.log(`  - Try a different departure time`);
            console.log(`  - The journey may require 2+ transfers (not supported yet)`);
        }

        console.log(`\n${'='.repeat(70)}\n`);

    } catch (error) {
        console.error(`\n✗ Error: ${error.message}`);
        process.exit(1);
    }
}

main();

