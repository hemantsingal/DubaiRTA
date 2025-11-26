const fs = require('fs');
const path = require('path');

const otpUrl = 'http://localhost:8080/otp/routers/default/index/graphql';
const dubaiMallCoords = { lat: 25.1972295, lng: 55.279747 };

// Simple CSV parser for the specific format of stops.txt
function parseCSV(content) {
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());

    const data = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Split by "," to handle quoted fields
        const parts = line.split('","');

        // Clean up leading/trailing quotes on the first and last elements
        if (parts.length > 0) parts[0] = parts[0].replace(/^"/, '');
        if (parts.length > 0) parts[parts.length - 1] = parts[parts.length - 1].replace(/"$/, '');

        const row = {};
        // Map relevant fields (we only need name, lat, lon)
        // Indices based on: "stop_id","stop_name","stop_lat","stop_lon",...
        // 0: id, 1: name, 2: lat, 3: lon
        if (parts.length >= 4) {
            row.name = parts[1];
            row.lat = parseFloat(parts[2]);
            row.lon = parseFloat(parts[3]);
            data.push(row);
        }
    }
    return data;
}

async function getRoute(from, to) {
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
      ) {
        itineraries {
          duration
          startTime
          endTime
          legs {
            mode
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
            return null;
        }
        return data.data.plan.itineraries;
    } catch (e) {
        return null;
    }
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function main() {
    const stopsPath = path.join(__dirname, 'data', 'stops.txt');
    console.log(`📖 Reading stops from ${stopsPath}...`);

    const content = fs.readFileSync(stopsPath, 'utf8');
    const stops = parseCSV(content);
    console.log(`ℹ️  Total stops found: ${stops.length}`);

    // Pick 10 random stops
    const randomStops = [];
    for (let i = 0; i < 10; i++) {
        const randomIndex = Math.floor(Math.random() * stops.length);
        randomStops.push(stops[randomIndex]);
    }

    console.log(`\n🚀 Calculating routes to Dubai Mall for 10 random stops...\n`);

    for (const stop of randomStops) {
        process.stdout.write(`📍 ${stop.name} ... `);
        const itineraries = await getRoute(stop, dubaiMallCoords);

        if (itineraries && itineraries.length > 0) {
            const best = itineraries[0];
            const modes = best.legs.map(l => l.mode).join(' -> ');
            console.log(`✅ ${formatDuration(best.duration)} (${modes})`);
        } else {
            console.log(`❌ No route found`);
        }
    }
}

main();
