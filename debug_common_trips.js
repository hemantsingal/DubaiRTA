const fs = require('fs');
const content = fs.readFileSync('data/stop_times.txt', 'utf8').split('\n');
const stopA = '12901';
const stopB = '13402';
const tripsA = new Set();
const tripsB = new Set();
content.forEach(line => {
  const parts = line.split(',');
  if (parts.length < 4) return;
  const tripId = parts[0].replace(/"/g, '');
  const stopId = parts[3].replace(/"/g, '');
  
  if(stopId === stopA) tripsA.add(tripId);
  if(stopId === stopB) tripsB.add(tripId);
});

console.log('Trips with A:', tripsA.size);
console.log('Trips with B:', tripsB.size);
const common = [...tripsA].filter(x => tripsB.has(x));
console.log('Common trips:', common.length);
if(common.length > 0) console.log('Example common trip:', common[0]);

