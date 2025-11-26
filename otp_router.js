require('dotenv').config();
const apiKey = process.env.GOOGLE_MAPS_API_KEY;
const otpUrl = 'http://localhost:8080/otp/routers/default/index/graphql';

async function geocode(place) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(place)}&key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
        throw new Error(`Geocoding failed for "${place}": ${data.status}`);
    }
    return data.results[0].geometry.location;
}

async function getRoute(from, to) {
    const query = `
    {
      plan(
        from: { lat: ${from.lat}, lon: ${from.lng} }
        to: { lat: ${to.lat}, lon: ${to.lng} }
        date: "2025-11-27"
        time: "09:00:00"
        transportModes: [{ mode: TRANSIT }, { mode: WALK }]
        maxWalkDistance: 3000
        walkReluctance: 5
      ) {
        itineraries {
          duration
          startTime
          endTime
          legs {
            mode
            startTime
            endTime
            from { name }
            to { name }
            route { shortName longName }
          }
        }
      }
    }
    `;

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
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log('Usage: node otp_router.js "Origin" "Destination"');
        process.exit(1);
    }

    const [originName, destName] = args;

    try {
        console.log(`🔍 Geocoding "${originName}"...`);
        const originCoords = await geocode(originName);
        console.log(`   📍 Found: ${originCoords.lat}, ${originCoords.lng}`);

        console.log(`🔍 Geocoding "${destName}"...`);
        const destCoords = await geocode(destName);
        console.log(`   📍 Found: ${destCoords.lat}, ${destCoords.lng}`);

        console.log(`🚀 Fetching route from OTP...`);
        const itineraries = await getRoute(originCoords, destCoords);

        if (!itineraries || itineraries.length === 0) {
            console.log('❌ No route found.');
            return;
        }

        const bestRoute = itineraries[0];
        console.log(`\n✅ Route Found!`);
        console.log(`⏱️  Total Duration: ${formatDuration(bestRoute.duration)}`);
        console.log(`📅 Start: ${formatTime(bestRoute.startTime)} | End: ${formatTime(bestRoute.endTime)}\n`);

        console.log('📝 Itinerary:');
        bestRoute.legs.forEach((leg, index) => {
            const modeIcon = leg.mode === 'WALK' ? '🚶' : (leg.mode === 'SUBWAY' ? '🚇' : '🚌');
            const routeInfo = leg.route ? `(${leg.route.shortName || leg.route.longName})` : '';
            console.log(`${index + 1}. ${modeIcon} ${leg.mode} ${routeInfo}`);
            console.log(`   From: ${leg.from.name}`);
            console.log(`   To:   ${leg.to.name}`);
            console.log(`   Time: ${formatDuration((leg.endTime - leg.startTime) / 1000)}`);
            console.log('');
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

main();
