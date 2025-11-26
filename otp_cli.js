require('dotenv').config();
const minimist = require('minimist');
const apiKey = process.env.GOOGLE_MAPS_API_KEY;
const otpUrl = 'http://localhost:8080/otp/routers/default/index/graphql';

const args = minimist(process.argv.slice(2), {
    string: ['time', 'date', 'from', 'to'],
    boolean: ['verbose', 'short', 'help'],
    alias: { t: 'time', d: 'date', v: 'verbose', s: 'short', h: 'help' },
    default: {
        'walk-dist': 3000,
        'walk-reluctance': 5,
        limit: 3
    }
});

if (args.help || (!args.from && !args._[0]) || (!args.to && !args._[1])) {
    console.log(`
Usage: node otp_cli.js [options] "Origin" "Destination"

Options:
  --time, -t <HH:mm>       Departure time (default: current time)
  --date, -d <YYYY-MM-DD>  Departure date (default: today)
  --verbose, -v            Show detailed itinerary (stops, wait times)
  --short, -s              Show only summary (duration, modes)
  --limit <n>              Number of itineraries to show (default: 3)
  --walk-dist <meters>     Max walking distance (default: 3000m)
  --walk-reluctance <val>  Penalty for walking (default: 5)

Examples:
  node otp_cli.js "Dubai Mall" "Al Nasr Leisureland"
  node otp_cli.js --time 23:00 "Burj Khalifa" "Mall of the Emirates"
  node otp_cli.js --verbose "Union Metro Station" "Airport Terminal 1"
`);
    process.exit(0);
}

const originName = args.from || args._[0];
const destName = args.to || args._[1];

// Helper: Get current date/time if not provided
const now = new Date();
const queryDate = args.date || now.toISOString().split('T')[0];
const queryTime = args.time ? (args.time.length === 5 ? args.time + ':00' : args.time) : now.toTimeString().split(' ')[0];

async function geocode(place) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(place)}&key=${apiKey}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.status !== 'OK' || !data.results || data.results.length === 0) {
            throw new Error(`Geocoding failed for "${place}": ${data.status}`);
        }
        return {
            name: data.results[0].formatted_address,
            lat: data.results[0].geometry.location.lat,
            lng: data.results[0].geometry.location.lng
        };
    } catch (e) {
        throw new Error(`Geocoding error: ${e.message}`);
    }
}

async function getRoute(from, to) {
    const query = `
    {
      plan(
        from: { lat: ${from.lat}, lon: ${from.lng} }
        to: { lat: ${to.lat}, lon: ${to.lng} }
        date: "${queryDate}"
        time: "${queryTime}"
        transportModes: [{ mode: TRANSIT }, { mode: WALK }]
        maxWalkDistance: ${args['walk-dist']}
        walkReluctance: ${args['walk-reluctance']}
        numItineraries: ${args.limit}
      ) {
        itineraries {
          duration
          startTime
          endTime
          waitingTime
          walkTime
          legs {
            mode
            startTime
            endTime
            distance
            from { name }
            to { name }
            route { shortName longName }
          }
        }
      }
    }
    `;

    try {
        const response = await fetch(otpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });
        const data = await response.json();
        if (data.errors) {
            throw new Error(`OTP Error: ${JSON.stringify(data.errors)}`);
        }
        return data.data.plan.itineraries;
    } catch (e) {
        throw new Error(`Routing error: ${e.message}`);
    }
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatTime(ms) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

async function main() {
    try {
        console.log(`\n🔍 Planning trip for ${queryDate} at ${queryTime}...`);

        console.log(`📍 Origin: "${originName}"`);
        const originCoords = await geocode(originName);
        console.log(`   -> Resolved: ${originCoords.name} (${originCoords.lat.toFixed(4)}, ${originCoords.lng.toFixed(4)})`);

        console.log(`📍 Dest:   "${destName}"`);
        const destCoords = await geocode(destName);
        console.log(`   -> Resolved: ${destCoords.name} (${destCoords.lat.toFixed(4)}, ${destCoords.lng.toFixed(4)})`);

        console.log(`\n🚀 Fetching routes...`);
        const itineraries = await getRoute(originCoords, destCoords);

        if (!itineraries || itineraries.length === 0) {
            console.log('❌ No route found.');
            return;
        }

        console.log(`✅ Found ${itineraries.length} options:\n`);

        itineraries.forEach((itinerary, i) => {
            const duration = formatDuration(itinerary.duration);
            const start = formatTime(itinerary.startTime);
            const end = formatTime(itinerary.endTime);
            const modes = itinerary.legs.map(l => l.mode).join(' -> ');

            console.log(`Option ${i + 1}: ${duration} (${start} - ${end})`);
            console.log(`   Modes: ${modes}`);

            if (args.verbose) {
                console.log(`   Stats: Walk: ${formatDuration(itinerary.walkTime)} | Wait: ${formatDuration(itinerary.waitingTime)}`);
                console.log(`   Details:`);
                itinerary.legs.forEach((leg, idx) => {
                    const legMode = leg.mode === 'WALK' ? '🚶 Walk' : (leg.mode === 'SUBWAY' ? '🚇 Metro' : `🚌 Bus`);
                    const routeInfo = leg.route ? `(${leg.route.shortName || leg.route.longName})` : '';
                    const legDur = formatDuration((leg.endTime - leg.startTime) / 1000);
                    console.log(`      ${idx + 1}. ${legMode} ${routeInfo} - ${legDur}`);
                    console.log(`         ${formatTime(leg.startTime)} ${leg.from.name}`);
                    console.log(`         ${formatTime(leg.endTime)}   ${leg.to.name}`);
                });
            }
            console.log('');
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

main();
