/**
 * Combined Transit Finder with Multi-Transfer Support
 * 
 * This script combines BFS and parallel processing to find the fastest route from a stop to a place.
 * 
 * Algorithm:
 * 1. Given a stop and a place
 * 2. Find 20 closest stops to the place
 * 3. Find direct route between given stop and those 20 stops
 * 4. If not found, find route with transfers (max 5 transfers)
 * 5. In parallel, find routes from walkable stops near the given stop
 * 6. Return the fastest route overall
 * 
 * Usage:
 *   node find_transit_combined.js <STOP_ID> <PLACE_NAME> [HH:MM:SS] [route_type]
 * 
 * Examples:
 *   node find_transit_combined.js 227102 "Dubai Mall"
 *   node find_transit_combined.js 227102 "Dubai Mall" 08:00:00
 *   node find_transit_combined.js 227102 "Dubai Mall" 08:00:00 1
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
const MAX_TRANSFERS = 5; // Maximum number of transfers allowed
const MAX_NEARBY_STOPS_TO_CHECK = 20; // Max nearby walkable stops to check
const MAX_WALKING_DISTANCE_KM = 0.5; // Maximum walking distance (500m)
const WALKING_SPEED_M_PER_MIN = 80; // Walking speed in meters per minute
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
 * Compare two time strings (HH:MM:SS)
 * Returns: -1 if time1 < time2, 0 if equal, 1 if time1 > time2
 */
function compareTime(time1, time2) {
    const [h1, m1, s1] = time1.split(':').map(Number);
    const [h2, m2, s2] = time2.split(':').map(Number);
    const total1 = h1 * 3600 + m1 * 60 + s1;
    const total2 = h2 * 3600 + m2 * 60 + s2;
    if (total1 < total2) return -1;
    if (total1 > total2) return 1;
    return 0;
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
 * Get all direct connections from a stop after a given time
 * Returns array of { stop_id, arrival_time, departure_time, trip_id, route_id, headsign }
 */
function getDirectConnections(stopId, afterTime, preloadedData) {
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

    // Find all stops reachable from stopId after afterTime
    const connections = [];

    for (const [tripId, stops] of Object.entries(tripStopMap)) {
        // Sort by sequence
        stops.sort((a, b) => a.seq - b.seq);

        // Find stopId in this trip
        const stopIndex = stops.findIndex(s => s.stop_id === stopId);
        if (stopIndex === -1) continue;

        const stopInfo = stops[stopIndex];
        // Only include trips that depart after the specified time
        if (compareTime(stopInfo.dep, afterTime) <= 0) continue;

        // All stops after stopId are reachable
        for (let i = stopIndex + 1; i < stops.length; i++) {
            const destStop = stops[i];
            connections.push({
                stop_id: destStop.stop_id,
                arrival_time: destStop.arr,
                departure_time: stopInfo.dep,
                trip_id: tripId,
                route_id: tripRouteMap[tripId].route_id,
                headsign: tripRouteMap[tripId].trip_headsign
            });
        }
    }

    return connections;
}

/**
 * BFS Search to find route with fewest transfers
 * @param {string} startStop - Starting stop ID
 * @param {Set} targetStops - Set of target stop IDs
 * @param {Array} targetStopsList - Array of target stops with distance info
 * @param {string} startTime - Starting time (HH:MM:SS)
 * @param {number} maxTransfers - Maximum number of transfers allowed
 * @param {Object} preloadedData - Preloaded transit data
 * @param {string} searchLabel - Label for logging
 * @returns {Object|null} - Found path or null
 */
function bfsSearch(startStop, targetStops, targetStopsList, startTime, maxTransfers, preloadedData, searchLabel = '') {
    // Create distance map for quick lookup
    const stopDistanceMap = new Map();
    targetStopsList.forEach(stop => {
        stopDistanceMap.set(stop.stop_id, stop.distance);
    });

    function getMinDistanceToTarget(stopId) {
        if (stopDistanceMap.has(stopId)) {
            return stopDistanceMap.get(stopId);
        }
        return Infinity;
    }

    // Check if start stop is already a target
    if (targetStops.has(startStop)) {
        return {
            path: [],
            finalStop: startStop,
            finalTime: startTime,
            numTransfers: 0,
            distanceToDestination: getMinDistanceToTarget(startStop)
        };
    }

    // Priority: Direct routes first (0 transfers), then fewest transfers, then closest to destination
    const queue = [{
        stop: startStop,
        time: startTime,
        path: [],
        numTransfers: 0,
        distanceToTarget: getMinDistanceToTarget(startStop)
    }];

    const visited = new Set();

    let bestRoute = null;
    let bestScore = Infinity; // Score = transfers * 1000 + distance

    let iterations = 0;
    const MAX_ITERATIONS = 50000; // Increased for more transfers

    // Logging
    let lastLogTime = Date.now();
    const LOG_INTERVAL = 2000; // Log every 2 seconds

    console.log(`      ${searchLabel}Starting BFS from stop ${startStop} at ${startTime}`);

    while (queue.length > 0 && iterations < MAX_ITERATIONS) {
        iterations++;

        // Progress logging
        const now = Date.now();
        if (now - lastLogTime > LOG_INTERVAL) {
            console.log(`      ${searchLabel}Progress: ${iterations} iterations, queue size: ${queue.length}, visited: ${visited.size}, best: ${bestRoute ? bestRoute.numTransfers + ' transfers' : 'none'}`);
            lastLogTime = now;
        }

        const current = queue.shift();

        // Check if we reached target
        if (targetStops.has(current.stop)) {
            const distance = getMinDistanceToTarget(current.stop);
            const score = current.numTransfers * 1000 + distance * 10;

            if (score < bestScore) {
                bestScore = score;
                bestRoute = {
                    path: current.path,
                    finalStop: current.stop,
                    finalTime: current.time,
                    numTransfers: current.numTransfers,
                    distanceToDestination: distance
                };

                // If found direct route (0 transfers) or route with 1 transfer, return immediately
                if (current.numTransfers === 0) {
                    console.log(`      ${searchLabel}✓ Found direct route (0 transfers) to destination!`);
                    return bestRoute;
                } else if (current.numTransfers === 1) {
                    console.log(`      ${searchLabel}✓ Found route with 1 transfer to destination!`);
                    return bestRoute;
                }
            }

            continue;
        }

        // If we have a direct route, skip exploring any transfer routes
        if (bestRoute && bestRoute.numTransfers === 0 && current.path.length > 0) {
            continue;
        }

        // If we have a 1-transfer route, skip exploring 2+ transfer routes
        if (bestRoute && bestRoute.numTransfers === 1 && current.numTransfers >= 1) {
            continue;
        }

        // Skip if exceeded max transfers
        if (current.numTransfers > maxTransfers) {
            continue;
        }

        // Create visited key
        const visitedKey = `${current.stop}:${current.numTransfers}`;
        if (visited.has(visitedKey)) {
            continue;
        }
        visited.add(visitedKey);

        // Get all direct connections
        const connections = getDirectConnections(current.stop, current.time, preloadedData);

        // Add transfer time if not first leg
        const nextAvailableTime = current.path.length > 0
            ? addMinutesToTime(current.time, TRANSFER_TIME_MINUTES)
            : current.time;

        for (const conn of connections) {
            // Skip if connection departs before we can transfer
            if (compareTime(conn.departure_time, nextAvailableTime) < 0) {
                continue;
            }

            // Check if this is a transfer
            const isTransfer = current.path.length > 0 &&
                (current.path[current.path.length - 1].route_id !== conn.route_id ||
                    current.path[current.path.length - 1].trip_id !== conn.trip_id);

            const newNumTransfers = isTransfer ? current.numTransfers + 1 : current.numTransfers;

            if (newNumTransfers > maxTransfers) {
                continue;
            }

            // If we already have a direct route, skip exploring transfer routes
            if (bestRoute && bestRoute.numTransfers === 0 && newNumTransfers > 0) {
                continue;
            }

            // If we have a 1-transfer route, skip exploring 2+ transfer routes
            if (bestRoute && bestRoute.numTransfers === 1 && newNumTransfers >= 2) {
                continue;
            }

            // Create new path leg
            const newLeg = {
                from: current.stop,
                to: conn.stop_id,
                departure: conn.departure_time,
                arrival: conn.arrival_time,
                trip_id: conn.trip_id,
                route_id: conn.route_id,
                headsign: conn.headsign
            };

            // If this reaches a target stop
            if (targetStops.has(conn.stop_id)) {
                const distance = getMinDistanceToTarget(conn.stop_id);
                const score = newNumTransfers * 1000 + distance * 10;

                if (score < bestScore) {
                    bestScore = score;
                    bestRoute = {
                        path: [...current.path, newLeg],
                        finalStop: conn.stop_id,
                        finalTime: conn.arrival_time,
                        numTransfers: newNumTransfers,
                        distanceToDestination: distance
                    };

                    // If found direct route (0 transfers) or route with 1 transfer, return immediately
                    if (newNumTransfers === 0) {
                        console.log(`      ${searchLabel}✓ Found direct route (0 transfers) to destination!`);
                        return bestRoute;
                    } else if (newNumTransfers === 1) {
                        console.log(`      ${searchLabel}✓ Found route with 1 transfer to destination!`);
                        return bestRoute;
                    }
                }

                continue;
            }

            // If we have a direct route, skip exploring more transfers
            if (bestRoute && bestRoute.numTransfers === 0) {
                continue;
            }

            // If we have a 1-transfer route, skip exploring 2+ transfer routes
            if (bestRoute && bestRoute.numTransfers === 1 && newNumTransfers >= 2) {
                continue;
            }

            const distanceToTarget = getMinDistanceToTarget(conn.stop_id);

            const queueItem = {
                stop: conn.stop_id,
                time: conn.arrival_time,
                path: [...current.path, newLeg],
                numTransfers: newNumTransfers,
                distanceToTarget: distanceToTarget
            };

            // Insert in priority order: fewest transfers first, then closest distance
            let insertIndex = queue.length;
            for (let i = 0; i < queue.length; i++) {
                const item = queue[i];
                const itemDistance = item.distanceToTarget !== undefined ? item.distanceToTarget : Infinity;

                // Prioritize: fewer transfers first, then closer distance
                if (newNumTransfers < (item.numTransfers || 0) ||
                    (newNumTransfers === (item.numTransfers || 0) && distanceToTarget < itemDistance)) {
                    insertIndex = i;
                    break;
                }
            }

            queue.splice(insertIndex, 0, queueItem);
        }
    }

    if (iterations >= MAX_ITERATIONS) {
        console.log(`      ${searchLabel}⚠️  Warning: Reached max iterations (${MAX_ITERATIONS}), search may be incomplete`);
    }

    console.log(`      ${searchLabel}Completed: ${iterations} iterations, visited ${visited.size} stops`);

    return bestRoute;
}

/**
 * Calculate total journey time including walking time
 */
function calculateTotalTime(result, walkTime = 0) {
    if (!result || !result.path || result.path.length === 0) {
        return Infinity;
    }

    const firstLeg = result.path[0];
    const lastLeg = result.path[result.path.length - 1];

    const transitTime = timeDifferenceMinutes(firstLeg.departure, lastLeg.arrival);
    return transitTime + walkTime;
}

/**
 * Main function
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.log("Usage: node find_transit_combined.js <STOP_ID> <PLACE_NAME> [HH:MM:SS] [route_type]");
        console.log("\nExamples:");
        console.log("  node find_transit_combined.js 227102 'Dubai Mall'");
        console.log("  node find_transit_combined.js 227102 'Dubai Mall' 08:00:00");
        console.log("  node find_transit_combined.js 227102 'Dubai Mall' 08:00:00 1");
        console.log("\nRoute types: 0=Tram, 1=Metro, 2=Rail, 3=Bus, 4=Ferry");
        process.exit(1);
    }

    const stopA = args[0];
    const placeName = args[1];
    const userTime = args[2] || getCurrentTime();
    const routeType = args[3] || null;

    const todayDate = getYYYYMMDD();
    const dayName = getDayName();

    console.log(`\n${'='.repeat(70)}`);
    console.log(`COMBINED TRANSIT FINDER - Finding fastest route`);
    console.log(`${'='.repeat(70)}`);
    console.log(`\nFrom stop: ${stopA}`);
    console.log(`To place: "${placeName}"`);
    console.log(`Date: ${dayName} (${todayDate})`);
    console.log(`Departure after: ${userTime}`);
    console.log(`Max transfers: ${MAX_TRANSFERS}`);
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
        const targetStopsList = findNearestStops(placeLocation.lat, placeLocation.lng, MAX_DESTINATIONS_NEAR_PLACE);
        const targetStops = new Set(targetStopsList.map(s => s.stop_id));
        console.log(`  ✓ Found ${targetStopsList.length} stops near destination`);
        targetStopsList.slice(0, 5).forEach((stop, idx) => {
            console.log(`     ${idx + 1}. ${stop.stop_name} (${stop.stop_id}) - ${stop.distance.toFixed(2)} km`);
        });

        // STEP 3: Preload transit data
        console.log(`\n[3/5] Loading transit data...`);
        const preloadedData = preloadTransitData(dayName, todayDate, routeType);

        // STEP 4: Find nearby walkable stops
        console.log(`\n[4/5] Finding walkable stops near starting stop...`);
        const allStops = loadFile('stops.txt');
        const stopAInfo = allStops.find(s => s.stop_id === stopA);

        let nearbyStops = [];
        if (stopAInfo && stopAInfo.stop_lat && stopAInfo.stop_lon) {
            nearbyStops = findNearestStops(
                parseFloat(stopAInfo.stop_lat),
                parseFloat(stopAInfo.stop_lon),
                MAX_NEARBY_STOPS_TO_CHECK
            ).filter(s => s.stop_id !== stopA && s.distance <= MAX_WALKING_DISTANCE_KM);

            console.log(`  ✓ Found ${nearbyStops.length} walkable stops (within ${MAX_WALKING_DISTANCE_KM * 1000}m)`);
            nearbyStops.slice(0, 3).forEach((stop, idx) => {
                const distDisplay = stop.distance < 1
                    ? `${(stop.distance * 1000).toFixed(0)}m`
                    : `${stop.distance.toFixed(2)}km`;
                console.log(`     ${idx + 1}. ${stop.stop_name} (${stop.stop_id}) - ${distDisplay}`);
            });
        } else {
            console.log(`  ✗ Could not find coordinates for stop ${stopA}`);
        }

        // STEP 5: Search for routes (prioritize direct routes)
        console.log(`\n[5/5] Searching for routes...`);
        console.log(`  Strategy: Check for direct routes first, then search with transfers if needed`);

        let originalResult = null;
        let nearbyResults = [];
        let foundDirectRoute = false;

        // PHASE 1: Check for direct route from original stop
        console.log(`\n  [A] Searching from original stop ${stopA}...`);
        originalResult = bfsSearch(
            stopA,
            targetStops,
            targetStopsList,
            userTime,
            MAX_TRANSFERS,
            preloadedData,
            '[Original] '
        );

        if (originalResult) {
            console.log(`      ✓ Found route with ${originalResult.numTransfers} transfer(s)`);

            // If direct route found, stop immediately
            if (originalResult.numTransfers === 0) {
                console.log(`      🎯 DIRECT ROUTE FOUND! Stopping search.`);
                foundDirectRoute = true;
            }
        } else {
            console.log(`      ✗ No route found`);
        }

        // PHASE 2: Only check walkable stops if no direct route found
        if (!foundDirectRoute && nearbyStops.length > 0) {
            console.log(`\n  No direct route from original stop. Checking ${nearbyStops.length} walkable stops...`);

            for (let i = 0; i < nearbyStops.length; i++) {
                const nearbyStop = nearbyStops[i];
                console.log(`\n  [${String.fromCharCode(66 + i)}] Searching from ${nearbyStop.stop_name} (${nearbyStop.stop_id})...`);

                const nearbyResult = bfsSearch(
                    nearbyStop.stop_id,
                    targetStops,
                    targetStopsList,
                    userTime,
                    MAX_TRANSFERS,
                    preloadedData,
                    `[${nearbyStop.stop_name}] `
                );

                if (nearbyResult) {
                    const walkTime = Math.ceil(nearbyStop.distance * 1000 / WALKING_SPEED_M_PER_MIN);
                    nearbyResults.push({
                        result: nearbyResult,
                        walkInfo: {
                            from: stopAInfo,
                            to: nearbyStop,
                            distance: nearbyStop.distance,
                            time: walkTime
                        }
                    });
                    console.log(`      ✓ Found route with ${nearbyResult.numTransfers} transfer(s) + ${walkTime} min walk`);

                    // If direct route found from walkable stop, stop immediately
                    if (nearbyResult.numTransfers === 0) {
                        console.log(`      🎯 DIRECT ROUTE FOUND from walkable stop! Stopping search.`);
                        foundDirectRoute = true;
                        break;
                    }
                } else {
                    console.log(`      ✗ No route found`);
                }
            }
        } else if (foundDirectRoute) {
            console.log(`\n  ⏩ Skipping walkable stops check (direct route already found)`);
        }

        // STEP 6: Compare all results and pick the fastest
        console.log(`\n\nComparing all routes...`);

        let bestOverallRoute = null;
        let bestOverallTime = Infinity;
        let bestOverallScore = Infinity; // Score = time + transfers * 30 (prefer fewer transfers)

        // Check original route
        if (originalResult) {
            const totalTime = calculateTotalTime(originalResult);
            const score = totalTime + originalResult.numTransfers * 30;
            console.log(`  - Original stop: ${totalTime} min, ${originalResult.numTransfers} transfers (score: ${score.toFixed(1)})`);

            if (score < bestOverallScore) {
                bestOverallScore = score;
                bestOverallTime = totalTime;
                bestOverallRoute = {
                    result: originalResult,
                    walkInfo: null
                };
            }
        }

        // Check nearby routes
        for (const nearbyRouteInfo of nearbyResults) {
            const totalTime = calculateTotalTime(nearbyRouteInfo.result, nearbyRouteInfo.walkInfo.time);
            const score = totalTime + nearbyRouteInfo.result.numTransfers * 30;
            console.log(`  - ${nearbyRouteInfo.walkInfo.to.stop_name}: ${totalTime} min (${nearbyRouteInfo.walkInfo.time} walk + transit), ${nearbyRouteInfo.result.numTransfers} transfers (score: ${score.toFixed(1)})`);

            if (score < bestOverallScore) {
                bestOverallScore = score;
                bestOverallTime = totalTime;
                bestOverallRoute = nearbyRouteInfo;
            }
        }

        // Display results
        console.log(`\n${'='.repeat(70)}`);
        console.log(`FINAL RESULT - FASTEST ROUTE`);
        console.log(`${'='.repeat(70)}`);

        if (bestOverallRoute) {
            const result = bestOverallRoute.result;
            const hasWalk = !!bestOverallRoute.walkInfo;

            if (result.path.length === 0) {
                // Direct connection - start stop is already a target
                console.log(`\n✓ You are already at a stop near the destination!`);
                console.log(`  Start: ${stopAInfo ? stopAInfo.stop_name : stopA} (${stopA})`);
                const finalStop = targetStopsList.find(s => s.stop_id === result.finalStop);
                if (finalStop) {
                    console.log(`  Distance to ${placeName}: ${finalStop.distance.toFixed(2)} km`);
                }
            } else {
                if (hasWalk) {
                    console.log(`\n✓ FASTEST ROUTE: Walk + ${result.numTransfers} transfer(s)`);
                } else {
                    console.log(`\n✓ FASTEST ROUTE: ${result.numTransfers} transfer(s) from original stop`);
                }
                console.log(`  Total journey time: ${bestOverallTime} minutes`);

                const routes = preloadedData.routes;

                // Display WALK if applicable
                if (hasWalk) {
                    const distDisplay = bestOverallRoute.walkInfo.distance < 1
                        ? `${(bestOverallRoute.walkInfo.distance * 1000).toFixed(0)} meters`
                        : `${bestOverallRoute.walkInfo.distance.toFixed(2)} km`;
                    console.log(`\n┌─ WALK`);
                    console.log(`│  From: ${bestOverallRoute.walkInfo.from.stop_name} (${bestOverallRoute.walkInfo.from.stop_id})`);
                    console.log(`│  To: ${bestOverallRoute.walkInfo.to.stop_name} (${bestOverallRoute.walkInfo.to.stop_id})`);
                    console.log(`│  Distance: ${distDisplay}`);
                    console.log(`│  Walking time: ~${bestOverallRoute.walkInfo.time} minutes`);
                    console.log(`│`);
                }

                // Display each leg
                let startTime = null;
                result.path.forEach((leg, idx) => {
                    const legNum = idx + 1;
                    const fromStop = allStops.find(s => s.stop_id === leg.from);
                    const toStop = allStops.find(s => s.stop_id === leg.to);
                    const route = routes.find(r => r.route_id === leg.route_id);
                    const routeTypeName = route ? getTransitTypeName(route.route_type) : 'Unknown';

                    if (legNum === 1) {
                        startTime = leg.departure;
                        if (hasWalk) {
                            console.log(`├─ LEG ${legNum}: ${routeTypeName} ${leg.route_id}`);
                        } else {
                            console.log(`\n┌─ LEG ${legNum}: ${routeTypeName} ${leg.route_id}`);
                        }
                    } else {
                        console.log(`├─ LEG ${legNum}: ${routeTypeName} ${leg.route_id}`);
                    }
                    console.log(`│  From: ${fromStop ? fromStop.stop_name : leg.from} (${leg.from})`);
                    console.log(`│  To: ${toStop ? toStop.stop_name : leg.to} (${leg.to})`);
                    console.log(`│  Headsign: ${leg.headsign}`);
                    console.log(`│  Departure: ${leg.departure}`);
                    console.log(`│  Arrival: ${leg.arrival}`);

                    const legDuration = timeDifferenceMinutes(leg.departure, leg.arrival);
                    console.log(`│  Duration: ${legDuration} minutes`);

                    // Show transfer if not last leg
                    if (idx < result.path.length - 1) {
                        const nextLeg = result.path[idx + 1];
                        const waitTime = timeDifferenceMinutes(leg.arrival, nextLeg.departure);
                        console.log(`│`);
                        console.log(`├─ TRANSFER at ${toStop ? toStop.stop_name : leg.to}`);
                        console.log(`│  Wait time: ${waitTime} minutes`);
                        console.log(`│  Next departure: ${nextLeg.departure}`);
                    }
                });

                console.log(`│`);
                console.log(`└─ Total journey time: ${bestOverallTime} minutes${hasWalk ? ` (includes ${bestOverallRoute.walkInfo.time} min walk)` : ''}`);

                const finalStop = targetStopsList.find(s => s.stop_id === result.finalStop);
                if (finalStop) {
                    console.log(`\n   Final distance to ${placeName}: ${finalStop.distance.toFixed(2)} km`);
                }

                if (hasWalk) {
                    console.log(`\n   Note: Route starts with ${bestOverallRoute.walkInfo.time} min walk from ${bestOverallRoute.walkInfo.from.stop_name} to ${bestOverallRoute.walkInfo.to.stop_name}`);
                }
            }

        } else {
            console.log(`\n✗ No route found from stop ${stopA} to ${placeName}`);
            console.log(`\nThis could mean:`);
            console.log(`  - No connecting routes exist within ${MAX_TRANSFERS} transfers`);
            console.log(`  - Try a different departure time`);
            console.log(`  - The destination may be unreachable by transit`);
            console.log(`  - No services running at the specified time`);
        }

        console.log(`\n${'='.repeat(70)}\n`);

    } catch (error) {
        console.error(`\n✗ Error: ${error.message}`);
        console.error(error.stack);
        process.exit(1);
    }
}

main();

