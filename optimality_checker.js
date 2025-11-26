const fs = require('fs');
const path = require('path');

const otpUrl = 'http://localhost:8080/otp/routers/default/index/graphql';
const dubaiMallCoords = { lat: 25.1972295, lng: 55.279747 };

// Stops to check (from the >1h list)
const stopsToCheck = [
    "King Salman Bin Abdulaziz Al Saud Street 2-2",
    "Gulf Denims Limited 2",
    "Knowledge Village Main Gate 2",
    "Mamzar, Beach 8"
];

function parseCSV(content) {
    const lines = content.trim().split('\n');
    const data = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split('","');
        if (parts.length > 0) parts[0] = parts[0].replace(/^"/, '');
        if (parts.length > 0) parts[parts.length - 1] = parts[parts.length - 1].replace(/"$/, '');

        if (parts.length >= 4) {
            data.push({
                name: parts[1],
                lat: parseFloat(parts[2]),
                lon: parseFloat(parts[3])
            });
        }
    }
    return data;
}

async function getItineraries(from, to) {
    const query = `
    {
      plan(
        from: { lat: ${from.lat}, lon: ${from.lon} }
        to: { lat: ${to.lat}, lon: ${to.lng} }
        date: "2025-11-27"
        time: "09:00:00"
        transportModes: [{ mode: TRANSIT }, { mode: WALK }]
        maxWalkDistance: 3000
        walkReluctance: 5
        numItineraries: 5
      ) {
        itineraries {
          duration
          legs {
            mode
            route { shortName }
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
        return data.data?.plan?.itineraries || [];
    } catch (e) {
        return [];
    }
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function main() {
    const stopsPath = path.join(__dirname, 'data', 'stops.txt');
    const content = fs.readFileSync(stopsPath, 'utf8');
    const allStops = parseCSV(content);

    console.log(`🔍 Checking optimality for ${stopsToCheck.length} stops...\n`);

    for (const stopName of stopsToCheck) {
        const stopData = allStops.find(s => s.name === stopName);
        if (!stopData) {
            console.log(`❌ Could not find stop: ${stopName}`);
            continue;
        }

        console.log(`📍 ${stopName}`);
        const itineraries = await getItineraries(stopData, dubaiMallCoords);

        if (itineraries.length === 0) {
            console.log("   No routes found.");
            continue;
        }

        // Sort by duration to find the absolute fastest
        itineraries.sort((a, b) => a.duration - b.duration);
        const best = itineraries[0];

        console.log(`   🏆 Best Time: ${formatDuration(best.duration)}`);
        console.log(`   🚌 Route: ${best.legs.map(l => l.mode).join(' -> ')}`);

        if (itineraries.length > 1) {
            const worst = itineraries[itineraries.length - 1];
            const diff = worst.duration - best.duration;
            console.log(`   ℹ️  Alternatives check: Checked ${itineraries.length} options. Slower options exist (+${formatDuration(diff)}).`);
        }
        console.log('');
    }
}

main();
