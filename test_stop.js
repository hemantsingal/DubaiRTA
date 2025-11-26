/**
 * Quick test script for a specific stop
 * 
 * Usage:
 *   node test_stop.js <STOP_ID>
 * 
 * Example:
 *   node test_stop.js 13502
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

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
    return parseCSV(fs.readFileSync(filePath, 'utf8'));
}

function runScript(scriptPath, stopId, destination) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const command = `node ${scriptPath} ${stopId} "${destination}"`;
        
        exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            const endTime = Date.now();
            const executionTime = endTime - startTime;
            
            if (error) {
                resolve({ success: false, executionTime, error: error.message, output: stdout });
                return;
            }
            
            resolve({ success: true, executionTime, output: stdout, stderr });
        });
    });
}

function parseOutput(output) {
    const result = {
        routeFound: false,
        journeyTime: null,
        numTransfers: null,
        numLegs: 0,
        distance: null,
        hasWalk: false,
        isDirect: false
    };
    
    if (output.includes('✓ Route found') || output.includes('✓ Best route found')) {
        result.routeFound = true;
    } else if (output.includes('✗ No route found') || output.includes('✗ No path found')) {
        return result;
    }
    
    const journeyTimeMatch = output.match(/Total journey time: (\d+) minutes/);
    if (journeyTimeMatch) {
        result.journeyTime = parseInt(journeyTimeMatch[1], 10);
    }
    
    // Match patterns like "1 transfer(s)", "with 1 transfer:", "with walk + 1 transfer:"
    const transferMatch = output.match(/(\d+) transfer\(s?\)|with (?:walk \+ )?(\d+) transfer/);
    if (transferMatch) {
        result.numTransfers = parseInt(transferMatch[1] || transferMatch[2], 10);
    } else if (output.includes('DIRECT (no transfers)') || output.includes('no transfers')) {
        result.numTransfers = 0;
        result.isDirect = true;
    }
    
    const legMatches = output.match(/LEG \d+:/g);
    if (legMatches) {
        result.numLegs = legMatches.length;
    } else if (result.isDirect && result.routeFound) {
        // Direct routes have 1 leg but may not have "LEG 1:" prefix
        result.numLegs = 1;
    }
    
    const distanceMatch = output.match(/Final distance to [^:]+: ([\d.]+) km/);
    if (distanceMatch) {
        result.distance = parseFloat(distanceMatch[1]);
    }
    
    result.hasWalk = output.includes('WALK') || output.includes('walk');
    
    return result;
}

async function main() {
    if (!process.argv[2]) {
        console.log('Usage: node test_stop.js <STOP_ID>');
        console.log('Example: node test_stop.js 13502');
        process.exit(1);
    }
    
    const stopId = process.argv[2];
    const destination = 'Dubai Mall';
    
    console.log(`Testing stop ${stopId} to ${destination}...\n`);
    
    // Get stop name
    const stops = loadFile('stops.txt');
    const stopInfo = stops.find(s => s.stop_id === stopId);
    const stopName = stopInfo ? stopInfo.stop_name : 'Unknown';
    
    console.log(`Stop: ${stopName} (${stopId})\n`);
    
    // Run both scripts in parallel
    console.log('Running BFS and Transfer scripts in parallel...\n');
    const [bfsResult, transferResult] = await Promise.all([
        runScript('find_transit_bfs.js', stopId, destination),
        runScript('find_transit_with_transfer.js', stopId, destination)
    ]);
    
    const bfsParsed = bfsResult.success ? parseOutput(bfsResult.output) : {};
    const transferParsed = transferResult.success ? parseOutput(transferResult.output) : {};
    
    console.log('Results:');
    console.log(`  BFS: ${bfsResult.executionTime}ms - Route: ${bfsParsed.routeFound ? 'Found' : 'Not Found'}`);
    console.log(`  Transfer: ${transferResult.executionTime}ms - Route: ${transferParsed.routeFound ? 'Found' : 'Not Found'}`);
    console.log();
    
    // Generate CSV
    const csvHeaders = [
        'stop_id',
        'stop_name',
        'script',
        'execution_time_ms',
        'route_found',
        'journey_time_min',
        'num_transfers',
        'num_legs',
        'distance_km',
        'has_walk',
        'is_direct'
    ];
    
    const csvRows = [csvHeaders.join(',')];
    
    // BFS row
    csvRows.push([
        stopId,
        `"${stopName}"`,
        'BFS',
        bfsResult.executionTime,
        bfsParsed.routeFound ? 'Yes' : 'No',
        bfsParsed.journeyTime || 'N/A',
        bfsParsed.numTransfers !== null ? bfsParsed.numTransfers : 'N/A',
        bfsParsed.numLegs || 'N/A',
        bfsParsed.distance || 'N/A',
        bfsParsed.hasWalk ? 'Yes' : 'No',
        bfsParsed.isDirect ? 'Yes' : 'No'
    ].join(','));
    
    // Transfer row
    csvRows.push([
        stopId,
        `"${stopName}"`,
        'Transfer',
        transferResult.executionTime,
        transferParsed.routeFound ? 'Yes' : 'No',
        transferParsed.journeyTime || 'N/A',
        transferParsed.numTransfers !== null ? transferParsed.numTransfers : 'N/A',
        transferParsed.numLegs || 'N/A',
        transferParsed.distance || 'N/A',
        transferParsed.hasWalk ? 'Yes' : 'No',
        transferParsed.isDirect ? 'Yes' : 'No'
    ].join(','));
    
    const csv = csvRows.join('\n');
    
    console.log('CSV Output:');
    console.log('='.repeat(70));
    console.log(csv);
    console.log('='.repeat(70));
    
    // Save to file
    const filename = `test_stop_${stopId}.csv`;
    fs.writeFileSync(filename, csv);
    console.log(`\nSaved to ${filename}`);
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});



