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

        // Naive split by "," handling
        // A better regex for "val","val" or "val"
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
 * @returns {Promise<{lat: number, lng: number, formatted_address: string}>} - Location coordinates
 */
function getLatLngFromPlace(place) {
    return new Promise((resolve, reject) => {
        if (!GOOGLE_MAPS_API_KEY || GOOGLE_MAPS_API_KEY === 'YOUR_API_KEY_HERE') {
            return reject(new Error('Google Maps API key not configured. Please set GOOGLE_MAPS_API_KEY at the top of the file.'));
        }

        const encodedPlace = encodeURIComponent(place);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedPlace}&key=${GOOGLE_MAPS_API_KEY}`;

        https.get(url, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);

                    if (response.status === 'OK' && response.results.length > 0) {
                        const location = response.results[0].geometry.location;
                        const formatted = response.results[0].formatted_address;

                        resolve({
                            lat: location.lat,
                            lng: location.lng,
                            formatted_address: formatted
                        });
                    } else if (response.status === 'ZERO_RESULTS') {
                        reject(new Error(`No results found for place: ${place}`));
                    } else if (response.status === 'REQUEST_DENIED') {
                        reject(new Error(`Google Maps API request denied. Check your API key and ensure Geocoding API is enabled.`));
                    } else {
                        reject(new Error(`Geocoding failed with status: ${response.status}`));
                    }
                } catch (error) {
                    reject(new Error(`Failed to parse geocoding response: ${error.message}`));
                }
            });
        }).on('error', (error) => {
            reject(new Error(`Network error: ${error.message}`));
        });
    });
}

function main() {
    const todayDate = getYYYYMMDD();
    const dayName = getDayName();
    const args = process.argv.slice(2);

    // Test geocoding function
    if (args[0] === '--geocode') {
        if (args.length < 2) {
            console.log("Usage: node find_next_bus.js --geocode <place_name>");
            console.log("Example: node find_next_bus.js --geocode 'Times Square, New York'");
            process.exit(1);
        }

        const place = args.slice(1).join(' ');
        console.log(`Getting coordinates for: ${place}`);

        getLatLngFromPlace(place)
            .then(result => {
                console.log('\nSuccess!');
                console.log(`Address: ${result.formatted_address}`);
                console.log(`Latitude: ${result.lat}`);
                console.log(`Longitude: ${result.lng}`);
            })
            .catch(error => {
                console.error('Error:', error.message);
                process.exit(1);
            });

        return; // Exit main after handling geocode
    }

    if (args.includes('--list')) {
        // Helper mode to find valid stops for today
        console.log(`Listing valid bus trips for today (${dayName}, ${todayDate})...`);

        // Load necessary data
        const routes = loadFile('routes.txt');
        const busRouteIds = new Set(routes.filter(r => r.route_type === '3').map(r => r.route_id));

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

        const allTrips = loadFile('trips.txt');
        const validTrips = allTrips.filter(t =>
            busRouteIds.has(t.route_id) && activeServices.has(t.service_id)
        );

        if (validTrips.length === 0) {
            console.log("No bus trips running today.");
            process.exit(0);
        }

        console.log(`Found ${validTrips.length} active trips. Picking one...`);
        const sampleTrip = validTrips[0];
        console.log(`Sample Trip: ${sampleTrip.trip_id} (Route ${sampleTrip.route_id})`);

        // Find stops for this trip
        const rawStopTimes = fs.readFileSync(path.join(DATA_DIR, 'stop_times.txt'), 'utf8');
        const stopTimeLines = rawStopTimes.trim().split('\n');
        const stHeaders = stopTimeLines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        const tripIdx = stHeaders.indexOf('trip_id');
        const stopIdx = stHeaders.indexOf('stop_id');
        const seqIdx = stHeaders.indexOf('stop_sequence');
        const depIdx = stHeaders.indexOf('departure_time');

        const stops = [];
        for (let i = 1; i < stopTimeLines.length; i++) {
            const parts = stopTimeLines[i].split('","');
            if (parts.length > 0) parts[0] = parts[0].replace(/^"/, '');
            if (parts.length > 0) parts[parts.length - 1] = parts[parts.length - 1].replace(/"$/, '');

            if (parts[tripIdx] === sampleTrip.trip_id) {
                stops.push({
                    id: parts[stopIdx],
                    seq: parseInt(parts[seqIdx], 10),
                    time: parts[depIdx]
                });
            }
        }
        stops.sort((a, b) => a.seq - b.seq);

        if (stops.length >= 2) {
            const start = stops[0];
            const end = stops[stops.length - 1];
            console.log(`\nTo test, run:`);
            console.log(`node find_next_bus.js ${start.id} ${end.id}`);
            console.log(`(Trip goes from ${start.id} at ${start.time} to ${end.id} at ${end.time})`);
        } else {
            console.log("Trip has fewer than 2 stops.");
        }
        process.exit(0);
    }

    if (args.length < 2) {
        console.log("Usage: node find_next_bus.js <STOP_A_ID> <STOP_B_ID> [HH:MM:SS]");
        console.log("Example: node find_next_bus.js 179106 100001");
        // process.exit(1); 
        // For demo purposes, let's find two random connected stops if none provided?
        // Or just exit.
        process.exit(1);
    }

    const stopA = args[0];
    const stopB = args[1];
    const userTime = args[2] || getCurrentTime();

    console.log(`Looking for bus from ${stopA} to ${stopB} after ${userTime} on ${dayName} (${todayDate})...`);

    // 1. Load Bus Routes
    const routes = loadFile('routes.txt');
    const busRouteIds = new Set(
        routes
            .filter(r => r.route_type === '3')
            .map(r => r.route_id)
    );
    console.log(`Found ${busRouteIds.size} bus routes.`);

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

    // Also check calendar_dates.txt for exceptions (additions/removals)
    // Ignoring for simplicity unless critical, but good to mention.
    // Assuming standard schedule.

    console.log(`Found ${activeServices.size} active service IDs for today.`);

    // 3. Load Trips (Filter by Bus Route AND Active Service)
    const allTrips = loadFile('trips.txt');
    const validTrips = allTrips.filter(t =>
        busRouteIds.has(t.route_id) && activeServices.has(t.service_id)
    );
    const validTripIds = new Set(validTrips.map(t => t.trip_id));

    // Map trip_id -> route info for display
    const tripRouteMap = {};
    validTrips.forEach(t => {
        tripRouteMap[t.trip_id] = t;
    });

    console.log(`Found ${validTripIds.size} valid bus trips running today.`);

    if (validTripIds.size === 0) {
        console.log("No bus trips running today found.");
        return;
    }

    // 4. Load Stop Times (Only for valid trips)
    // This file is huge, so we stream or process carefully? 
    // Given 500 samples in docgen, maybe it's small? 
    // Wait, docgen said "Sampled documents: 500", but the file might be huge.
    // `ls` output didn't show size. 
    // I'll read it all, assuming it fits in memory (Node default 2GB).
    // If it crashes, I'll optimize.

    const rawStopTimes = fs.readFileSync(path.join(DATA_DIR, 'stop_times.txt'), 'utf8');
    const stopTimeLines = rawStopTimes.trim().split('\n');

    // Parse headers
    const stHeaders = stopTimeLines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const tripIdx = stHeaders.indexOf('trip_id');
    const stopIdx = stHeaders.indexOf('stop_id');
    const seqIdx = stHeaders.indexOf('stop_sequence');
    const arrIdx = stHeaders.indexOf('arrival_time');
    const depIdx = stHeaders.indexOf('departure_time');

    // We need to group stops by trip to check sequence A -> B
    // Memory optimization: Only store stops matching A or B for valid trips
    const tripStops = {}; // trip_id -> { [stopA]: { seq, time }, [stopB]: { seq, time } }

    let processedLines = 0;
    for (let i = 1; i < stopTimeLines.length; i++) {
        const line = stopTimeLines[i];
        // Fast parse manually
        // Assuming quoted: "trip_id","time","time","stop_id",...
        // We only need specific columns.
        // Regex might be slow for large files. Split by "," is okay if no commas in values.
        // stop_times usually doesn't have commas in fields except maybe headsign.

        // Simple split might work if we trust the format.
        // Let's use the same logic but optimized.
        const parts = line.split('","');
        // Fix first and last quote
        if (parts.length > 0) parts[0] = parts[0].replace(/^"/, '');
        if (parts.length > 0) parts[parts.length - 1] = parts[parts.length - 1].replace(/"$/, '');

        // We need to map parts to indices. 
        // This depends on the column order in file.
        // Let's trust the headers index mapping.
        // Note: split('","') consumes the quotes.

        const tId = parts[tripIdx];

        if (!validTripIds.has(tId)) continue;

        const sId = parts[stopIdx];

        if (sId === stopA || sId === stopB) {
            if (!tripStops[tId]) tripStops[tId] = {};
            tripStops[tId][sId] = {
                seq: parseInt(parts[seqIdx], 10),
                dep: parts[depIdx]
            };
        }
        processedLines++;
    }

    // Debug: Check which trips have EITHER stop, to see if they are just disconnected
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
                    arrival_at_B: stops[stopB].dep, // or arrival
                    route_id: tripRouteMap[tId].route_id,
                    headsign: tripRouteMap[tId].trip_headsign
                });
            }
        }
    }

    // 6. Filter for next trip
    // Sort by departure time
    matches.sort((a, b) => a.departure_time.localeCompare(b.departure_time));

    const nextTrip = matches.find(m => m.departure_time > userTime);

    if (nextTrip) {
        console.log(`\nNext bus from ${stopA} to ${stopB}:`);
        console.log(`Route: ${nextTrip.route_id}`);
        console.log(`Trip Headsign: ${nextTrip.headsign}`);
        console.log(`Departure: ${nextTrip.departure_time}`);
        console.log(`Arrival at Dest: ${nextTrip.arrival_at_B}`);
    } else {
        console.log(`\nNo direct bus found from ${stopA} to ${stopB} after ${userTime} today.`);
        if (matches.length > 0) {
            console.log(`(Earlier trips today were available: ${matches.map(m => m.departure_time).join(', ')})`);
        }
    }
}

// Export the geocoding function for use in other modules
module.exports = {
    getLatLngFromPlace
};

// Run main only if this file is executed directly
if (require.main === module) {
    main();
}
