/**
 * mongo-docgen.js
 * Usage:
 *   NODE_OPTIONS=--max-old-space-size=4096 node mongo-docgen.js \
 *     --uri="mongodb+srv://user:pass@cluster.mongodb.net/dbname" \
 *     --out=./db-docs --sample=500
 *
 * What it does:
 * - Connects to MongoDB
 * - Lists all collections
 * - Samples up to `sample` docs from each collection (default 200)
 * - Infers field types and examples
 * - Detects probable references by checking ObjectId values against other collections' _id samples
 * - Generates ./db-docs/db-schema.md and ./db-docs/schema-mermaid.mmd
 */

const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');

const args = require('minimist')(process.argv.slice(2), {
  string: ['uri', 'out'],
  integer: ['sample'],
  default: { sample: 200, out: './db-docs' },
});

if (!args.uri) {
  console.error('Missing --uri parameter. Example: --uri="mongodb+srv://user:pass@cluster/db"');
  process.exit(1);
}

const SAMPLE_SIZE = parseInt(args.sample, 10) || 200;
const OUT_DIR = args.out;

function typeOf(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  if (val instanceof Date) return 'date';
  if (ObjectId.isValid(val) && (typeof val === 'object' || typeof val === 'string')) return 'ObjectId';
  return typeof val;
}

function mergeType(a, b) {
  if (a === b) return a;
  const set = new Set([...(Array.isArray(a) ? a : [a]), ...(Array.isArray(b) ? b : [b])]);
  return Array.from(set);
}

function extractFields(doc, prefix = '') {
  const fields = {};
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    for (const [k, v] of Object.entries(doc)) {
      const name = prefix ? `${prefix}.${k}` : k;
      const t = typeOf(v);
      if (t === 'array') {
        fields[name] = fields[name] || { types: new Set(), examples: new Set(), count: 0 };
        fields[name].types.add('array');
        fields[name].examples.add(JSON.stringify(v).slice(0, 200));
        fields[name].count++;
        // inspect first element if exists
        if (v.length > 0 && typeof v[0] === 'object' && !Array.isArray(v[0])) {
          // treat nested object sample as subfields: name.[].sub
          const nested = extractFields(v[0], `${name}[]`);
          Object.assign(fields, nested);
        }
      } else if (t === 'ObjectId') {
        fields[name] = fields[name] || { types: new Set(), examples: new Set(), count: 0 };
        fields[name].types.add('ObjectId');
        fields[name].examples.add(String(v));
        fields[name].count++;
      } else if (t === 'object') {
        fields[name] = fields[name] || { types: new Set(), examples: new Set(), count: 0 };
        fields[name].types.add('object');
        fields[name].examples.add(JSON.stringify(v).slice(0, 200));
        fields[name].count++;
        const nested = extractFields(v, name);
        Object.assign(fields, nested);
      } else {
        fields[name] = fields[name] || { types: new Set(), examples: new Set(), count: 0 };
        fields[name].types.add(t);
        fields[name].examples.add(String(v).slice(0, 200));
        fields[name].count++;
      }
    }
  }
  return fields;
}

(async function main() {
 const client = new MongoClient(args.uri);

  await client.connect();
  const dbName = client.db().databaseName || (new URL(args.uri)).pathname.split('/').filter(Boolean)[0];
  const db = client.db();
  console.log('Connected to', dbName);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const collections = await db.listCollections().toArray();
  const colNames = collections.map(c => c.name);
  console.log('Collections found:', colNames.length);

  const metadata = {};
  const idSamples = {}; // collection -> Set of sample _id as string for quick lookup

  // First pass: sample docs and infer fields
  for (const col of colNames) {
    const coll = db.collection(col);
    const cursor = coll.aggregate([{ $sample: { size: Math.min(SAMPLE_SIZE, 1000) } }]);
    const fields = {};
    const seenIds = new Set();
    let count = 0;
    for await (const doc of cursor) {
      count++;
      if (doc && doc._id) seenIds.add(String(doc._id));
      const extracted = extractFields(doc);
      for (const [k, v] of Object.entries(extracted)) {
        if (!fields[k]) fields[k] = { types: new Set(), examples: new Set(), count: 0 };
        v.types.forEach(t => fields[k].types.add(t));
        v.examples.forEach(e => { if (fields[k].examples.size < 5) fields[k].examples.add(e); });
        fields[k].count += v.count;
      }
    }
    // convert sets to arrays for serialization
    const processed = {};
    for (const [k, v] of Object.entries(fields)) {
      processed[k] = {
        types: Array.from(v.types),
        examples: Array.from(v.examples),
        occurrences: v.count,
      };
    }
    metadata[col] = {
      sampledDocs: count,
      fields: processed,
    };
    idSamples[col] = seenIds;
    console.log(`Scanned ${count} docs for ${col}, fields: ${Object.keys(processed).length}`);
  }

  // Second pass: detect probable references
  const references = []; // { fromCollection, field, toCollection, sampleValue }
  for (const [col, meta] of Object.entries(metadata)) {
    for (const [field, info] of Object.entries(meta.fields)) {
      // consider fields that include ObjectId in types or examples that look like ObjectId hex
      const likelyObjId = info.types.includes('ObjectId') ||
        Array.from(info.examples).some(ex => /^[a-f0-9]{24}$/.test(ex));
      if (!likelyObjId) continue;

      // gather up to 5 example values to check against other collections' _id samples
      const examples = Array.from(info.examples).slice(0, 5);
      for (const ex of examples) {
        const exStr = ex.replace(/["']/g, '');
        for (const [otherCol, idSet] of Object.entries(idSamples)) {
          if (otherCol === col) continue;
          if (idSet.has(exStr)) {
            references.push({ fromCollection: col, field, toCollection: otherCol, sampleValue: exStr });
          }
        }
      }
    }
  }

  // generate Mermaid ERD lines
  const edges = {};
  for (const r of references) {
    const key = `${r.toCollection}||--o{ ${r.fromCollection} : ${r.field}`;
    edges[key] = true;
  }
  const mermaid = ['```mermaid', 'erDiagram'];
  // erDiagram style from mermaid requires slightly different syntax; we'll use relationship notation
  // Alternatively, produce a simpler graph using graph LR
  const mermaid_graph = ['```mermaid', 'graph LR'];
  // produce nodes summary and edges graph LR style
  for (const col of colNames) {
    const count = metadata[col].sampledDocs || 0;
    mermaid_graph.push(`  ${col}["${col} (${count} samples)"]`);
  }
  for (const r of references) {
    // sanitize node names for mermaid
    const a = r.toCollection.replace(/[^a-zA-Z0-9_]/g, '_');
    const b = r.fromCollection.replace(/[^a-zA-Z0-9_]/g, '_');
    mermaid_graph.push(`  ${a} -->|${r.field}| ${b}`);
  }
  mermaid_graph.push('```');

  // write Markdown
  const mdPath = path.join(OUT_DIR, 'db-schema.md');
  const md = [];
  md.push(`# Database Schema Documentation`);
  md.push('');
  md.push(`Generated on ${new Date().toISOString()}`);
  md.push('');
  md.push(`**Database:** ${db.databaseName || dbName}`);
  md.push('');
  md.push(`**Sample size per collection:** up to ${SAMPLE_SIZE} documents, details per collection below.`);
  md.push('');
  md.push(`---`);
  md.push('');
  md.push(`## Collections`);
  md.push('');
  for (const col of colNames) {
    md.push(`### ${col}`);
    md.push('');
    md.push(`Sampled documents: ${metadata[col].sampledDocs}`);
    md.push('');
    md.push(`| Field | Types (inferred) | Example(s) | Occurrences in sample |`);
    md.push(`|---|---|---|---:|`);
    const fields = metadata[col].fields;
    const sortedFields = Object.keys(fields).sort((a, b) => (fields[b].occurrences || 0) - (fields[a].occurrences || 0));
    for (const f of sortedFields) {
      const info = fields[f];
      const types = Array.isArray(info.types) ? info.types.join(', ') : info.types;
      const examples = (info.examples || []).slice(0, 3).map(e => e.replace(/\n/g, ' ')).join(' | ');
      const occ = info.occurrences || 0;
      md.push(`| \`${f}\` | ${types} | \`${examples}\` | ${occ} |`);
    }
    md.push('');
  }

  md.push('---');
  md.push('');
  md.push('## Inferred references (probable relationships)');
  md.push('');
  if (references.length === 0) {
    md.push('No references inferred from sampled data. If you suspect relations, increase sample size or ensure ObjectId values are present in the sample.');
  } else {
    md.push('| From collection | Field | To collection | Sample value |');
    md.push('|---|---|---|---|');
    for (const r of references) {
      md.push(`| ${r.fromCollection} | \`${r.field}\` | ${r.toCollection} | \`${r.sampleValue}\` |`);
    }
  }
  md.push('');
  md.push('---');
  md.push('');
  md.push('## Entity Relationship Diagram (graph)');
  md.push('');
  md.push(...mermaid_graph);
  md.push('');
  md.push('---');
  md.push('');
  md.push('## Notes, limitations, and recommended next steps');
  md.push('');
  md.push(`1. This doc is automatically inferred from sampled documents, it is not authoritative unless your app enforces strict schema via Mongoose or validation rules.`);
  md.push(`2. Increase --sample to scan more documents for better detection, eg --sample=1000.`);
  md.push(`3. If you use Mongoose models or JSON Schema in your app, prefer exporting those models as canonical schema.`);
  md.push(`4. Embedded objects and arrays are listed with dotted paths; arrays show subfields under \`field[]\`.`);
  md.push(`5. For production ERD and diagrams, consider exporting the Mermaid block into mermaid.live or Mermaid CLI to render SVG/PDF.`);
  md.push('');
  md.push('---');
  md.push('');
  md.push('## How to convert to PDF');
  md.push('');
  md.push('Option 1, pandoc:');
  md.push('```bash');
  md.push('pandoc db-schema.md -o db-schema.pdf --pdf-engine=xelatex');
  md.push('```');
  md.push('');
  md.push('Option 2, md-to-pdf (node):');
  md.push('```bash');
  md.push('npm i -g md-to-pdf');
  md.push('md-to-pdf db-schema.md -o db-schema.pdf');
  md.push('```');
  md.push('');
  md.push('Option 3, upload to GitHub and use GitHub rendering of Mermaid then print to PDF from browser.');
  md.push('');

  fs.writeFileSync(mdPath, md.join('\n'), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'schema-mermaid.mmd'), mermaid_graph.join('\n'), 'utf8');

  console.log('Wrote', mdPath);
  await client.close();
  console.log('Done');
})().catch(err => { console.error(err); process.exit(2); });
