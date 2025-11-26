/**
 * Benchmark Script: Compare BFS vs Single Transfer Methods
 * 
 * This script randomly selects N stops and runs both transit finding scripts
 * to Dubai Mall, recording performance metrics and journey details.
 * 
 * Features:
 * - Parallel execution: Both scripts run simultaneously for each stop
 * - Concurrent workers: Multiple stops processed in parallel
 * - 120 second timeout per script execution
 * - Detailed CSV output with journey metrics
 * - Summary statistics
 * 
 * Usage:
 *   node benchmark_transit_scripts.js [numStops] [concurrency]
 * 
 * Examples:
 *   node benchmark_transit_scripts.js           # 10 stops, 3 concurrent workers (default)
 *   node benchmark_transit_scripts.js 5         # 5 stops, 3 concurrent workers
 *   node benchmark_transit_scripts.js 20 5      # 20 stops, 5 concurrent workers
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_CSV = 'benchmark_results.csv';

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

/**
 * Randomly select N stops from stops.txt
 */
function selectRandomStops(n = 10) {
    const stops = loadFile('stops.txt');
    const validStops = stops.filter(s => s.stop_id && s.stop_name);
    
    // Shuffle and pick N
    const shuffled = validStops.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, n);
}

/**
 * Run a script and measure execution time with timeout
 */
function runScript(scriptPath, stopId, destination, timeoutMs = 120000) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const command = `node ${scriptPath} ${stopId} "${destination}"`;
        
        const child = exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            const endTime = Date.now();
            const executionTime = endTime - startTime;
            
            if (error) {
                // Check if it was killed due to timeout
                if (error.killed) {
                    resolve({
                        success: false,
                        executionTime,
                        timeout: true,
                        error: 'Timeout exceeded',
                        output: stdout || ''
                    });
                    return;
                }
                
                resolve({
                    success: false,
                    executionTime,
                    timeout: false,
                    error: error.message,
                    output: stdout || ''
                });
                return;
            }
            
            resolve({
                success: true,
                executionTime,
                timeout: false,
                output: stdout,
                stderr
            });
        });
        
        // Set timeout
        setTimeout(() => {
            if (!child.killed) {
                child.kill();
            }
        }, timeoutMs);
    });
}

/**
 * Parse script output to extract journey details
 */
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
    
    // Check if route was found
    if (output.includes('✓ Route found') || output.includes('✓ Best route found')) {
        result.routeFound = true;
    } else if (output.includes('✗ No route found') || output.includes('✗ No path found')) {
        return result;
    }
    
    // Extract journey time
    const journeyTimeMatch = output.match(/Total journey time: (\d+) minutes/);
    if (journeyTimeMatch) {
        result.journeyTime = parseInt(journeyTimeMatch[1], 10);
    }
    
    // Extract number of transfers
    // Match patterns like "1 transfer(s)", "with 1 transfer:", "with walk + 1 transfer:"
    const transferMatch = output.match(/(\d+) transfer\(s?\)|with (?:walk \+ )?(\d+) transfer/);
    if (transferMatch) {
        result.numTransfers = parseInt(transferMatch[1] || transferMatch[2], 10);
    } else if (output.includes('DIRECT (no transfers)') || output.includes('no transfers')) {
        result.numTransfers = 0;
        result.isDirect = true;
    }
    
    // Count legs (LEG 1, LEG 2, etc.)
    const legMatches = output.match(/LEG \d+:/g);
    if (legMatches) {
        result.numLegs = legMatches.length;
    } else if (result.isDirect && result.routeFound) {
        // Direct routes have 1 leg but may not have "LEG 1:" prefix
        result.numLegs = 1;
    }
    
    // Extract distance to destination
    const distanceMatch = output.match(/Final distance to [^:]+: ([\d.]+) km/);
    if (distanceMatch) {
        result.distance = parseFloat(distanceMatch[1]);
    }
    
    // Check if walk is included
    result.hasWalk = output.includes('WALK') || output.includes('walk');
    
    return result;
}

/**
 * Process a single stop - runs both scripts in parallel
 */
async function processStop(stop, stopNum, totalStops, destination) {
    console.log(`  [${stopNum}/${totalStops}] Testing from ${stop.stop_name}...`);
    
    // Run both scripts in parallel
    const [bfsResult, transferResult] = await Promise.all([
        runScript('find_transit_bfs.js', stop.stop_id, destination),
        runScript('find_transit_with_transfer.js', stop.stop_id, destination)
    ]);
    
    const bfsParsed = bfsResult.success ? parseOutput(bfsResult.output) : {};
    const transferParsed = transferResult.success ? parseOutput(transferResult.output) : {};
    
    const result = {
        stopId: stop.stop_id,
        stopName: stop.stop_name,
        bfs: {
            ...bfsParsed,
            executionTime: bfsResult.executionTime,
            success: bfsResult.success,
            timeout: bfsResult.timeout || false
        },
        transfer: {
            ...transferParsed,
            executionTime: transferResult.executionTime,
            success: transferResult.success,
            timeout: transferResult.timeout || false
        }
    };
    
    const bfsStatus = bfsResult.timeout ? '⏱️ TIMEOUT' : `${bfsResult.executionTime}ms`;
    const transferStatus = transferResult.timeout ? '⏱️ TIMEOUT' : `${transferResult.executionTime}ms`;
    console.log(`     ✓ BFS: ${bfsStatus} | Transfer: ${transferStatus}\n`);
    
    return result;
}

/**
 * Process stops with concurrency limit
 */
async function processStopsWithConcurrency(stops, destination, concurrency = 3) {
    const results = [];
    const queue = [...stops];
    let completed = 0;
    
    async function worker() {
        while (queue.length > 0) {
            const stop = queue.shift();
            if (!stop) break;
            
            const stopNum = completed + 1;
            const result = await processStop(stop, stopNum, stops.length, destination);
            results.push(result);
            completed++;
        }
    }
    
    // Create worker pool
    const workers = Array(Math.min(concurrency, stops.length))
        .fill(null)
        .map(() => worker());
    
    await Promise.all(workers);
    
    return results;
}

/**
 * Main benchmark function
 */
async function main() {
    // Allow command line arguments: numStops, concurrency
    const numStops = process.argv[2] ? parseInt(process.argv[2], 10) : 10;
    const concurrency = process.argv[3] ? parseInt(process.argv[3], 10) : 3;
    
    console.log('='.repeat(70));
    console.log('TRANSIT SCRIPT BENCHMARK');
    console.log('='.repeat(70));
    console.log(`Configuration: ${numStops} stops, ${concurrency} concurrent workers`);
    console.log('\n[1/3] Selecting random stops...');
    
    const randomStops = selectRandomStops(numStops);
    console.log(`  ✓ Selected ${randomStops.length} random stops\n`);
    
    randomStops.forEach((stop, idx) => {
        console.log(`     ${idx + 1}. ${stop.stop_name} (${stop.stop_id})`);
    });
    
    console.log('\n[2/3] Running benchmarks in parallel...');
    console.log(`  Running with ${concurrency} concurrent workers...\n`);
    
    const destination = 'Dubai Mall';
    const startTime = Date.now();
    
    const results = await processStopsWithConcurrency(randomStops, destination, concurrency);
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`  ✓ Completed all benchmarks in ${totalTime}s\n`);
    
    console.log('[3/3] Writing results to CSV...');
    
    // Create CSV
    const csvHeaders = [
        'stop_id',
        'stop_name',
        'script',
        'execution_time_ms',
        'timeout',
        'route_found',
        'journey_time_min',
        'num_transfers',
        'num_legs',
        'distance_km',
        'has_walk',
        'is_direct'
    ];
    
    const csvRows = [csvHeaders.join(',')];
    
    results.forEach(result => {
        // BFS row
        csvRows.push([
            result.stopId,
            `"${result.stopName}"`,
            'BFS',
            result.bfs.executionTime,
            result.bfs.timeout ? 'Yes' : 'No',
            result.bfs.routeFound ? 'Yes' : 'No',
            result.bfs.journeyTime || 'N/A',
            result.bfs.numTransfers !== null ? result.bfs.numTransfers : 'N/A',
            result.bfs.numLegs || 'N/A',
            result.bfs.distance || 'N/A',
            result.bfs.hasWalk ? 'Yes' : 'No',
            result.bfs.isDirect ? 'Yes' : 'No'
        ].join(','));
        
        // Transfer row
        csvRows.push([
            result.stopId,
            `"${result.stopName}"`,
            'Transfer',
            result.transfer.executionTime,
            result.transfer.timeout ? 'Yes' : 'No',
            result.transfer.routeFound ? 'Yes' : 'No',
            result.transfer.journeyTime || 'N/A',
            result.transfer.numTransfers !== null ? result.transfer.numTransfers : 'N/A',
            result.transfer.numLegs || 'N/A',
            result.transfer.distance || 'N/A',
            result.transfer.hasWalk ? 'Yes' : 'No',
            result.transfer.isDirect ? 'Yes' : 'No'
        ].join(','));
    });
    
    fs.writeFileSync(OUTPUT_CSV, csvRows.join('\n'));
    console.log(`  ✓ Results written to ${OUTPUT_CSV}\n`);
    
    // Print summary
    console.log('='.repeat(70));
    console.log('SUMMARY');
    console.log('='.repeat(70));
    
    let bfsTotalTime = 0;
    let transferTotalTime = 0;
    let bfsRoutesFound = 0;
    let transferRoutesFound = 0;
    let bfsTotalJourneyTime = 0;
    let transferTotalJourneyTime = 0;
    let bfsJourneyCount = 0;
    let transferJourneyCount = 0;
    
    results.forEach(r => {
        bfsTotalTime += r.bfs.executionTime;
        transferTotalTime += r.transfer.executionTime;
        
        if (r.bfs.routeFound) {
            bfsRoutesFound++;
            if (r.bfs.journeyTime) {
                bfsTotalJourneyTime += r.bfs.journeyTime;
                bfsJourneyCount++;
            }
        }
        
        if (r.transfer.routeFound) {
            transferRoutesFound++;
            if (r.transfer.journeyTime) {
                transferTotalJourneyTime += r.transfer.journeyTime;
                transferJourneyCount++;
            }
        }
    });
    
    console.log(`\nBFS Script:`);
    console.log(`  Routes found: ${bfsRoutesFound}/${results.length}`);
    console.log(`  Avg execution time: ${(bfsTotalTime / results.length).toFixed(0)}ms`);
    console.log(`  Avg journey time: ${bfsJourneyCount > 0 ? (bfsTotalJourneyTime / bfsJourneyCount).toFixed(1) : 'N/A'} min`);
    
    console.log(`\nTransfer Script:`);
    console.log(`  Routes found: ${transferRoutesFound}/${results.length}`);
    console.log(`  Avg execution time: ${(transferTotalTime / results.length).toFixed(0)}ms`);
    console.log(`  Avg journey time: ${transferJourneyCount > 0 ? (transferTotalJourneyTime / transferJourneyCount).toFixed(1) : 'N/A'} min`);
    
    console.log(`\nTotal benchmark time: ${totalTime}s`);
    console.log(`Speed-up from parallelization: ~${((bfsTotalTime + transferTotalTime) / 1000 / parseFloat(totalTime)).toFixed(1)}x`);
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Benchmark complete! Results saved to ${OUTPUT_CSV}`);
    console.log('='.repeat(70));
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});

