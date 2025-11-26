/**
 * Transit Finder with Breadth-First Search (BFS) for Multi-Leg Journeys
 * 
 * Implements Approach 2: Breadth-First Search (BFS) from multi-leg-journey-strategies.md
 * 
 * This script finds routes from a stop to a place using BFS to find paths with fewest transfers.
 * Supports up to N transfers (default: 3).
 * 
 * Usage:
 *   node find_transit_bfs.js <STOP_ID> <PLACE_NAME> [HH:MM:SS] [route_type] [max_transfers]
 * 
 * Examples:
 *   node find_transit_bfs.js 227102 "Dubai Mall"
 *   node find_transit_bfs.js 227102 "Dubai Mall" 08:00:00
 *   node find_transit_bfs.js 227102 "Dubai Mall" 08:00:00 1 2
 * 
 * Route types: 0=Tram, 1=Metro, 2=Rail, 3=Bus, 4=Ferry
 * max_transfers: Maximum number of transfers allowed (default: 3)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');

// ===== CONFIGURATION =====
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const TRANSFER_TIME_MINUTES = 5; // Minimum transfer time in minutes
const MAX_DESTINATIONS_NEAR_PLACE = 20; // How many stops near destination to check
const DEFAULT_MAX_TRANSFERS = 2; // Default maximum transfers allowed
const MAX_NEARBY_STOPS_TO_CHECK = 20; // Max nearby walkable stops to check
const MAX_WALKING_DISTANCE_KM = 0.5; // Maximum walking distance (500m)
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
 * Builds connections on-the-fly for BFS
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
 * BFS Search to find route with fewest transfers, prioritizing closer target stops
 * @param {string} startStop - Starting stop ID
 * @param {Set} targetStops - Set of target stop IDs
 * @param {Array} targetStopsList - Array of target stops with distance info {stop_id, distance, ...}
 * @param {string} startTime - Starting time (HH:MM:SS)
 * @param {number} maxTransfers - Maximum number of transfers allowed
 * @param {Object} preloadedData - Preloaded transit data
 * @returns {Object|null} - Found path or null
 */
function bfsSearch(startStop, targetStops, targetStopsList, startTime, maxTransfers, preloadedData) {
    // Create distance map for quick lookup: stop_id -> distance
    const stopDistanceMap = new Map();
    targetStopsList.forEach(stop => {
        stopDistanceMap.set(stop.stop_id, stop.distance);
    });

    /**
     * Get minimum distance from a stop to any target stop
     */
    function getMinDistanceToTarget(stopId) {
        if (stopDistanceMap.has(stopId)) {
            return stopDistanceMap.get(stopId);
        }
        // If stop not in target list, return a large distance
        return Infinity;
    }
    // Check if start stop is already a target (direct connection - no transit needed)
    if (targetStops.has(startStop)) {
        return {
            path: [],
            finalStop: startStop,
            finalTime: startTime,
            numTransfers: 0,
            distanceToDestination: getMinDistanceToTarget(startStop)
        };
    }

    // Queue: [{ stop, time, path, numTransfers, distanceToTarget }]
    // path is array of leg objects: [{ from, to, departure, arrival, trip_id, route_id, headsign }]
    const initialDistance = getMinDistanceToTarget(startStop);
    const queue = [{
        stop: startStop,
        time: startTime,
        path: [],
        numTransfers: 0,
        distanceToTarget: initialDistance
    }];

    // Visited: Set of (stop, numTransfers) to avoid revisiting same state with same or more transfers
    // Using (stop, transfers) allows exploring same stop with fewer transfers
    const visited = new Set();

    // Track best route found so far (closest to destination)
    let bestRoute = null;
    let bestDistance = Infinity;

    let iterations = 0;
    const MAX_ITERATIONS = 20000; // Safety limit

    while (queue.length > 0 && iterations < MAX_ITERATIONS) {
        iterations++;

        const current = queue.shift(); // dequeue

        // Check if we reached target
        if (targetStops.has(current.stop)) {
            const distance = getMinDistanceToTarget(current.stop);

            // Update best route if this is closer
            if (distance < bestDistance) {
                bestDistance = distance;
                bestRoute = {
                    path: current.path,
                    finalStop: current.stop,
                    finalTime: current.time,
                    numTransfers: current.numTransfers,
                    distanceToDestination: distance
                };
            }

            // Continue searching for potentially closer stops
            // Only stop early if we found a very close stop (< 0.35 km)
            if (distance < 0.35) {
                return bestRoute;
            }
            continue;
        }

        // If we already have a direct route (0 transfers), skip exploring transfer routes
        if (bestRoute && bestRoute.numTransfers === 0 && current.path.length > 0) {
            continue;
        }

        // Skip if exceeded max transfers
        if (current.numTransfers > maxTransfers) {
            continue;
        }

        // If we have a good result and current path is getting far from target, we can stop exploring this branch
        if (bestRoute && current.distanceToTarget > bestDistance * 2) {
            continue;
        }

        // Create visited key (stop + numTransfers)
        // Allow revisiting same stop if we've found a path with fewer transfers
        const visitedKey = `${current.stop}:${current.numTransfers}`;
        if (visited.has(visitedKey)) {
            continue;
        }
        visited.add(visitedKey);

        // Get all direct connections from current stop
        const connections = getDirectConnections(current.stop, current.time, preloadedData);

        // Add transfer time for next connection (if not first leg)
        const nextAvailableTime = current.path.length > 0
            ? addMinutesToTime(current.time, TRANSFER_TIME_MINUTES)
            : current.time;

        for (const conn of connections) {
            // Skip if connection departs before we can transfer
            if (compareTime(conn.departure_time, nextAvailableTime) < 0) {
                continue;
            }

            // Check if this connection reaches a target stop directly
            if (targetStops.has(conn.stop_id)) {
                // Found a path to a target stop!
                const newLeg = {
                    from: current.stop,
                    to: conn.stop_id,
                    departure: conn.departure_time,
                    arrival: conn.arrival_time,
                    trip_id: conn.trip_id,
                    route_id: conn.route_id,
                    headsign: conn.headsign
                };

                // Check if this is a transfer
                const isTransfer = current.path.length > 0 &&
                    (current.path[current.path.length - 1].route_id !== conn.route_id ||
                        current.path[current.path.length - 1].trip_id !== conn.trip_id);

                const finalNumTransfers = isTransfer ? current.numTransfers + 1 : current.numTransfers;

                const distance = getMinDistanceToTarget(conn.stop_id);

                // Update best route if this is closer
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestRoute = {
                        path: [...current.path, newLeg],
                        finalStop: conn.stop_id,
                        finalTime: conn.arrival_time,
                        numTransfers: finalNumTransfers,
                        distanceToDestination: distance
                    };
                }

                // If very close (< 0.35 km), return immediately regardless of transfers
                if (distance < 0.35) {
                    return bestRoute;
                }

                // Continue to check for closer stops
                continue;
            }

            // Check if we should explore this connection
            // If we already have a direct route (0 transfers), skip exploring transfer routes
            if (bestRoute && bestRoute.numTransfers === 0) {
                continue;
            }

            // Skip if numTransfers would exceed max
            const isTransfer = current.path.length > 0 &&
                (current.path[current.path.length - 1].route_id !== conn.route_id ||
                    current.path[current.path.length - 1].trip_id !== conn.trip_id);

            const newNumTransfers = isTransfer ? current.numTransfers + 1 : current.numTransfers;

            if (newNumTransfers > maxTransfers) {
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

            // Calculate distance to nearest target stop for prioritization
            const distanceToTarget = getMinDistanceToTarget(conn.stop_id);

            // Add to queue with priority based on distance to target
            // Queue items are: { stop, time, path, numTransfers, distanceToTarget }
            const queueItem = {
                stop: conn.stop_id,
                time: conn.arrival_time,
                path: [...current.path, newLeg],
                numTransfers: newNumTransfers,
                distanceToTarget: distanceToTarget
            };

            // Insert in priority order: prioritize by distance to target, then by numTransfers
            // Use binary search to find insertion point for better performance
            let insertIndex = queue.length;
            for (let i = 0; i < queue.length; i++) {
                const item = queue[i];
                const itemDistance = item.distanceToTarget !== undefined ? item.distanceToTarget : Infinity;

                // Prioritize: closer distance first, then fewer transfers
                if (distanceToTarget < itemDistance ||
                    (distanceToTarget === itemDistance && newNumTransfers < (item.numTransfers || 0))) {
                    insertIndex = i;
                    break;
                }
            }

            queue.splice(insertIndex, 0, queueItem);
        }
    }

    if (iterations >= MAX_ITERATIONS) {
        console.log(`  Warning: Reached max iterations (${MAX_ITERATIONS}), search may be incomplete`);
    }

    // Return best route found (closest to destination)
    return bestRoute;
}

/**
 * Main function to find route using BFS
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.log("Usage: node find_transit_bfs.js <STOP_ID> <PLACE_NAME> [HH:MM:SS] [route_type] [max_transfers]");
        console.log("\nExamples:");
        console.log("  node find_transit_bfs.js 227102 'Dubai Mall'");
        console.log("  node find_transit_bfs.js 227102 'Dubai Mall' 08:00:00");
        console.log("  node find_transit_bfs.js 227102 'Dubai Mall' 08:00:00 1");
        console.log("  node find_transit_bfs.js 227102 'Dubai Mall' 08:00:00 1 2");
        console.log("\nRoute types: 0=Tram, 1=Metro, 2=Rail, 3=Bus, 4=Ferry");
        console.log("max_transfers: Maximum transfers allowed (default: 3)");
        process.exit(1);
    }

    const stopA = args[0];
    const placeName = args[1];
    const userTime = args[2] || getCurrentTime();

    // Parse route type - allow empty string to mean null
    let routeType = args[3] || null;
    if (routeType === '' || routeType === 'null' || routeType === 'undefined') {
        routeType = null;
    }

    // Parse max transfers - allow it to be in args[3] if route type not specified
    // Limit to maximum of 2 transfers
    let maxTransfers = DEFAULT_MAX_TRANSFERS;
    if (args[4]) {
        maxTransfers = Math.min(parseInt(args[4], 10), 2);
    } else if (args[3] && !isNaN(parseInt(args[3], 10)) && parseInt(args[3], 10) < 10) {
        // If args[3] is a small number, treat it as maxTransfers (not route type)
        maxTransfers = Math.min(parseInt(args[3], 10), 2);
        routeType = null;
    }
    // Cap at 2 transfers maximum
    maxTransfers = Math.min(maxTransfers, 2);

    const todayDate = getYYYYMMDD();
    const dayName = getDayName();

    console.log(`\nFinding route from stop ${stopA} to "${placeName}" using BFS...`);
    console.log(`Date: ${dayName} (${todayDate}), Departure after: ${userTime}`);
    console.log(`Max transfers: ${maxTransfers}`);
    if (routeType) {
        const types = { '0': 'Tram', '1': 'Metro', '2': 'Rail', '3': 'Bus', '4': 'Ferry' };
        console.log(`Route type filter: ${types[routeType] || routeType}`);
    }

    try {
        // STEP 1: Geocode destination
        console.log(`\n[1/4] Geocoding destination "${placeName}"...`);
        const placeLocation = await getLatLngFromPlace(placeName);
        console.log(`  ✓ ${placeLocation.formatted_address}`);
        console.log(`  ✓ Coordinates: ${placeLocation.lat}, ${placeLocation.lng}`);

        // STEP 2: Find nearest stops to destination
        console.log(`\n[2/4] Finding stops near destination...`);
        const targetStopsList = findNearestStops(placeLocation.lat, placeLocation.lng, MAX_DESTINATIONS_NEAR_PLACE);
        const targetStops = new Set(targetStopsList.map(s => s.stop_id));
        console.log(`  ✓ Found ${targetStopsList.length} stops near destination`);
        targetStopsList.slice(0, 5).forEach((stop, idx) => {
            console.log(`     ${idx + 1}. ${stop.stop_name} (${stop.stop_id}) - ${stop.distance.toFixed(2)} km`);
        });

        // STEP 3: Preload transit data
        console.log(`\n[3/4] Loading transit data...`);
        const preloadedData = preloadTransitData(dayName, todayDate, routeType);

        // STEP 4: Run BFS search
        console.log(`\n[4/4] Running BFS search (max ${maxTransfers} transfers)...`);
        console.log(`  Exploring paths from stop ${stopA} (prioritizing ${targetStopsList.length} closest stops)...`);
        let result = bfsSearch(stopA, targetStops, targetStopsList, userTime, maxTransfers, preloadedData);

        if (!result) {
            console.log(`  ✗ No path found within ${maxTransfers} transfers`);

            // Try nearby walkable stops if no route found
            console.log(`\n  Checking nearby walkable stops...`);

            const allStops = loadFile('stops.txt');
            const stopAInfo = allStops.find(s => s.stop_id === stopA);

            if (stopAInfo && stopAInfo.stop_lat && stopAInfo.stop_lon) {
                // Find stops within walking distance of source (500m)
                const nearbyStops = findNearestStops(
                    parseFloat(stopAInfo.stop_lat),
                    parseFloat(stopAInfo.stop_lon),
                    MAX_NEARBY_STOPS_TO_CHECK
                ).filter(s => s.stop_id !== stopA && s.distance <= MAX_WALKING_DISTANCE_KM);

                if (nearbyStops.length > 0) {
                    console.log(`  Found ${nearbyStops.length} walkable stops near ${stopA} (within ${MAX_WALKING_DISTANCE_KM * 1000}m)`);
                    nearbyStops.slice(0, 3).forEach((stop, idx) => {
                        const distDisplay = stop.distance < 1
                            ? `${(stop.distance * 1000).toFixed(0)}m`
                            : `${stop.distance.toFixed(2)}km`;
                        console.log(`     ${idx + 1}. ${stop.stop_name} (${stop.stop_id}) - ${distDisplay}`);
                    });

                    console.log(`\n  Searching for routes from nearby stops...`);

                    // Try BFS from each nearby stop
                    for (const nearbyStop of nearbyStops) {
                        console.log(`  Trying ${nearbyStop.stop_name}...`);

                        const nearbyResult = bfsSearch(
                            nearbyStop.stop_id,
                            targetStops,
                            targetStopsList,
                            userTime,
                            maxTransfers,
                            preloadedData
                        );

                        if (nearbyResult) {
                            // Calculate walk time (80m/min walking speed)
                            const walkTime = Math.ceil(nearbyStop.distance * 1000 / 80);

                            // Add walk information to the result
                            result = {
                                ...nearbyResult,
                                walk: {
                                    from: stopAInfo,
                                    to: nearbyStop,
                                    distance: nearbyStop.distance,
                                    time: walkTime
                                }
                            };

                            console.log(`    ✓ Found route via ${nearbyStop.stop_name} (includes ${walkTime} min walk)`);
                            break; // Found a route, stop checking other nearby stops
                        }
                    }

                    if (!result) {
                        console.log(`  ✗ No routes found from nearby walkable stops either`);
                    }
                } else {
                    console.log(`  No walkable stops found near ${stopA} (within ${MAX_WALKING_DISTANCE_KM * 1000}m)`);
                }
            }
        } else {
            console.log(`  ✓ Path found with ${result.numTransfers} transfer(s)`);
        }

        // Display results
        console.log(`\n${'='.repeat(70)}`);
        console.log(`RESULTS`);
        console.log(`${'='.repeat(70)}`);

        if (result) {
            if (result.path.length === 0) {
                // Direct connection - start stop is already a target
                const allStops = loadFile('stops.txt');
                const startStopInfo = allStops.find(s => s.stop_id === stopA);
                const targetStopsList = findNearestStops(placeLocation.lat, placeLocation.lng, MAX_DESTINATIONS_NEAR_PLACE);
                const finalStop = targetStopsList.find(s => s.stop_id === result.finalStop);

                console.log(`\n✓ Direct connection: Start stop is already near destination!`);
                console.log(`  Start: ${startStopInfo ? startStopInfo.stop_name : stopA} (${stopA})`);
                console.log(`  Destination: ${finalStop ? finalStop.stop_name : result.finalStop} (${result.finalStop})`);
                if (finalStop) {
                    console.log(`  Distance to ${placeName}: ${finalStop.distance.toFixed(2)} km`);
                }
            } else {
                const hasWalk = !!result.walk;

                if (hasWalk) {
                    console.log(`\n✓ Route found with walk + ${result.numTransfers} transfer(s):`);
                } else {
                    console.log(`\n✓ Route found with ${result.numTransfers} transfer(s):`);
                }

                const allStops = loadFile('stops.txt');
                const routes = preloadedData.routes;

                let totalMinutes = 0;
                let startTime = null;

                // Display WALK if applicable
                if (hasWalk) {
                    const distDisplay = result.walk.distance < 1
                        ? `${(result.walk.distance * 1000).toFixed(0)} meters`
                        : `${result.walk.distance.toFixed(2)} km`;
                    console.log(`\n┌─ WALK`);
                    console.log(`│  From: ${result.walk.from.stop_name} (${result.walk.from.stop_id})`);
                    console.log(`│  To: ${result.walk.to.stop_name} (${result.walk.to.stop_id})`);
                    console.log(`│  Distance: ${distDisplay}`);
                    console.log(`│  Walking time: ~${result.walk.time} minutes`);
                    console.log(`│`);
                }

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

                    totalMinutes = timeDifferenceMinutes(startTime, leg.arrival);

                    // Show transfer if not last leg
                    if (idx < result.path.length - 1) {
                        const nextLeg = result.path[idx + 1];
                        const waitTime = timeDifferenceMinutes(leg.arrival, nextLeg.departure);
                        console.log(`│`);
                        const transferStop = toStop;
                        console.log(`├─ TRANSFER at ${transferStop ? transferStop.stop_name : leg.to}`);
                        console.log(`│  Wait time: ${waitTime} minutes`);
                        console.log(`│  Next departure: ${nextLeg.departure}`);
                    }
                });

                console.log(`│`);
                const totalWithWalk = hasWalk ? totalMinutes + result.walk.time : totalMinutes;
                console.log(`└─ Total journey time: ${totalWithWalk} minutes${hasWalk ? ` (includes ${result.walk.time} min walk)` : ''}`);

                const finalStop = targetStopsList.find(s => s.stop_id === result.finalStop);
                if (finalStop) {
                    console.log(`\n   Final distance to ${placeName}: ${finalStop.distance.toFixed(2)} km`);
                }

                if (hasWalk) {
                    console.log(`\n   Note: Includes ${result.walk.time} min walk from ${result.walk.from.stop_name} to ${result.walk.to.stop_name}`);
                }
            }

        } else {
            console.log(`\n✗ No route found from stop ${stopA} to ${placeName} with ${maxTransfers} or fewer transfers`);
            console.log(`\nThis could mean:`);
            console.log(`  - No connecting routes exist within ${maxTransfers} transfers`);
            console.log(`  - Try increasing max transfers (currently ${maxTransfers})`);
            console.log(`  - Try a different departure time`);
            console.log(`  - The destination may be unreachable by transit`);
        }

        console.log(`\n${'='.repeat(70)}\n`);

    } catch (error) {
        console.error(`\n✗ Error: ${error.message}`);
        process.exit(1);
    }
}

main();

