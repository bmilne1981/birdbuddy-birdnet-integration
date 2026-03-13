#!/usr/bin/env node
/**
 * BirdNET-Pi → Bird App Sync
 * 
 * Pulls detection data from BirdWeather API (station KROC / ID 24073)
 * and integrates it with the Bird Buddy web app database.
 * 
 * Features:
 * - Adds audio-only species to the species table with enrichment
 * - Creates "audio sighting" records for tracking
 * - Generates hourly activity heatmap data
 * - Alerts on unusual/interesting species detections
 * 
 * Usage: node birdnet-sync.js [--alert] [--heatmap] [--full]
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BIRDWEATHER_STATION_ID = 24073;
const BIRDWEATHER_API = 'https://app.birdweather.com/api/v1';
const BIRDNET_PI_URL = 'http://YOUR_BIRDNET_PI_IP';
const DB_PATH = '/path/to/workspace/birdbuddy-app/birdbuddy.db';
const STATE_FILE = '/path/to/workspace/memory/birdnet-state.json';
const ALERT_HOOK = 'http://127.0.0.1:18789/hooks/alert';
const ALERT_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || '';

// Species that are too common to alert on
const BORING_SPECIES = [
  'House Sparrow', 'Dark-eyed Junco', 'House Finch',
  'European Starling', 'Common Grackle', 'Mourning Dove',
  'American Crow', 'Canada Goose', 'Ring-billed Gull'
];

// Species data for enrichment (audio-only species not in Bird Buddy)
const SPECIES_INFO = {
  'American Robin': {
    scientific: 'Turdus migratorius',
    description: 'One of North America\'s most familiar songbirds, the American Robin is a thrush with a warm orange-red breast. Often seen hopping across lawns pulling up earthworms.',
    fun_facts: 'Robins can eat up to 14 feet of earthworms in a day. Their cheerful "cheerily, cheer-up" song is one of the first heard at dawn.',
    habitat: 'Lawns, gardens, parks, forests, woodlands',
    diet: 'Earthworms, insects, berries, fruit',
    migration: 'Short-distance migrant. Some overwinter in northern areas near fruit trees.'
  },
  'Song Sparrow': {
    scientific: 'Melospiza melodia',
    description: 'A medium-sized sparrow with bold breast streaking that often converges into a central spot. One of the most widespread and variable songbirds in North America.',
    fun_facts: 'Song Sparrows learn their songs from neighboring males, creating local "dialects." A single male may know 6-20 different song variations.',
    habitat: 'Shrubby areas, marsh edges, gardens, backyards',
    diet: 'Seeds, insects, berries',
    migration: 'Partial migrant. Northern populations move south; many in NY are year-round.'
  },
  'Common Redpoll': {
    scientific: 'Acanthis flammea',
    description: 'A small, streaky finch with a bright red cap (poll) and often a rosy-pink breast on males. An irruptive winter visitor from the boreal north.',
    fun_facts: 'Redpolls can survive temperatures of -65°F! They have a special pouch in their esophagus where they store seeds to digest later in sheltered spots.',
    habitat: 'Birch and alder forests, weedy fields, feeders in winter',
    diet: 'Birch and alder seeds, small seeds, occasionally insects',
    migration: 'Irruptive — some winters they flood south in huge numbers, other years almost none appear.'
  },
  'Pine Siskin': {
    scientific: 'Spinus pinus',
    description: 'A small, heavily streaked finch with subtle yellow edging on wings and tail. Often mistaken for a sparrow until it flies and flashes yellow.',
    fun_facts: 'Pine Siskins are nomadic and irruptive — they can appear in huge flocks one winter and be completely absent the next. They\'re closely related to goldfinches.',
    habitat: 'Coniferous and mixed forests, feeders',
    diet: 'Seeds (especially thistle/nyjer), conifer seeds, some insects',
    migration: 'Irruptive — unpredictable movements based on food supply in boreal forests.'
  },
  'American Woodcock': {
    scientific: 'Scolopax minor',
    description: 'A chunky, short-legged shorebird that lives in forests and fields rather than shores. Famous for its spectacular "sky dance" courtship display at dusk.',
    fun_facts: 'The Woodcock\'s eyes are set so far back on its head that it has 360-degree vision — it can see behind itself without turning its head! Its spiraling sky dance involves flying up to 300 feet before zigzagging back down.',
    habitat: 'Young forests, shrubby fields, forest edges. Displays in open clearings at dusk.',
    diet: 'Primarily earthworms — can eat its body weight in worms daily',
    migration: 'Medium-distance migrant. One of the earliest spring migrants — arrives in NY late Feb/March.'
  },
  'Blue Jay': {
    scientific: 'Cyanocitta cristata',
    description: 'A large, crested songbird with brilliant blue, white, and black plumage. Intelligent, bold, and vocal — often the first to sound alarm calls.',
    fun_facts: 'Blue Jays can mimic hawk calls to scare other birds away from feeders. Their blue color isn\'t from pigment — it\'s structural coloring from light scattering.',
    habitat: 'Forests, parks, suburban areas, feeders',
    diet: 'Nuts (especially acorns), seeds, insects, occasionally eggs',
    migration: 'Partial migrant — some migrate, some don\'t, and individuals may migrate one year but not the next.'
  },
  'American Crow': {
    scientific: 'Corvus brachyrhynchos',
    description: 'A large, entirely black bird known for exceptional intelligence. One of the smartest animals on Earth, capable of tool use, facial recognition, and complex problem-solving.',
    fun_facts: 'Crows hold "funerals" — when one dies, others gather around the body, apparently to learn about potential dangers. They can recognize individual human faces for years.',
    habitat: 'Nearly everywhere — fields, forests, towns, cities',
    diet: 'Omnivorous — insects, seeds, fruit, small animals, garbage, carrion',
    migration: 'Partial migrant. Northern birds form massive winter roosts of thousands.'
  },
  'Ring-billed Gull': {
    scientific: 'Larus delawarensis',
    description: 'The most common gull in North America. Medium-sized with a distinctive black ring near the tip of its yellow bill.',
    fun_facts: 'Ring-billed Gulls have adapted perfectly to human environments — parking lots, fast food restaurants, dumps. They\'ve increased dramatically since the 1970s.',
    habitat: 'Lakes, rivers, coasts, parking lots, landfills',
    diet: 'Extremely varied — fish, insects, earthworms, rodents, grain, garbage, french fries',
    migration: 'Medium-distance migrant. Common year-round near Lake Ontario.'
  },
  'Canada Goose': {
    scientific: 'Branta canadensis',
    description: 'A large goose with a distinctive black head and neck, white chinstrap, and brown body. One of the most recognizable birds in North America.',
    fun_facts: 'Canada Geese mate for life and can live 25+ years. Their V-formation flying reduces wind resistance — geese take turns at the front.',
    habitat: 'Lakes, ponds, rivers, parks, golf courses, lawns',
    diet: 'Grasses, aquatic plants, grain, berries',
    migration: 'Many populations are now year-round residents ("resident geese"). Migratory populations fly in iconic V formations.'
  },
  'Northern Cardinal': {
    scientific: 'Cardinalis cardinalis',
    description: 'A striking songbird — males are brilliant red with a black face mask, females are warm brown with red accents. Both sexes sing.',
    fun_facts: 'Unlike most songbirds where only males sing, female Cardinals also sing — often from the nest, possibly to tell the male to bring food.',
    habitat: 'Woodland edges, thickets, gardens, feeders',
    diet: 'Seeds, berries, insects',
    migration: 'Non-migratory — year-round resident.'
  }
};

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

function postHook(message) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text: message });
    const url = new URL(ALERT_HOOK);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(ALERT_TOKEN ? { 'Authorization': `Bearer ${ALERT_TOKEN}` } : {})
      }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      lastSync: null,
      lastDetectionId: null,
      alertedSpecies: {},  // species -> last alert timestamp
      dailySpecies: {},    // date -> [species list]
      heatmap: {}          // date -> { hour -> { species -> count } }
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function getDetections(limit = 200) {
  const data = await fetch(
    `${BIRDWEATHER_API}/stations/${BIRDWEATHER_STATION_ID}/detections?limit=${limit}&order=desc`
  );
  return data.success ? data.detections : [];
}

async function getSpeciesList() {
  const data = await fetch(
    `${BIRDWEATHER_API}/stations/${BIRDWEATHER_STATION_ID}/species?period=all&limit=200`
  );
  return data.success ? data.species : [];
}

function buildHeatmap(detections) {
  const heatmap = {};
  for (const det of detections) {
    const ts = new Date(det.timestamp);
    const date = ts.toISOString().split('T')[0];
    const hour = ts.getHours();
    const species = det.species.commonName;

    if (!heatmap[date]) heatmap[date] = {};
    if (!heatmap[date][hour]) heatmap[date][hour] = {};
    heatmap[date][hour][species] = (heatmap[date][hour][species] || 0) + 1;
  }
  return heatmap;
}

function findInterestingDetections(detections, state) {
  const interesting = [];
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];

  for (const det of detections) {
    const species = det.species.commonName;
    
    // Skip boring species
    if (BORING_SPECIES.includes(species)) continue;
    
    // Skip if we already alerted for this species today
    const lastAlert = state.alertedSpecies[species];
    if (lastAlert && lastAlert.startsWith(today)) continue;

    // Check if this is a new species for the station
    const isNewToStation = !state.dailySpecies[today]?.includes(species);
    
    interesting.push({
      species,
      scientificName: det.species.scientificName,
      confidence: det.confidence,
      timestamp: det.timestamp,
      certainty: det.certainty,
      audioUrl: det.soundscape?.url,
      isNewToStation
    });

    // Mark as alerted
    state.alertedSpecies[species] = new Date().toISOString();
  }

  // Deduplicate by species (keep highest confidence)
  const bySpecies = {};
  for (const det of interesting) {
    if (!bySpecies[det.species] || det.confidence > bySpecies[det.species].confidence) {
      bySpecies[det.species] = det;
    }
  }

  return Object.values(bySpecies);
}

async function syncSpeciesToDB(speciesList) {
  // This generates SQL that can be piped to sqlite3
  // We stop the server, apply changes, restart
  const sql = [];
  
  for (const sp of speciesList) {
    const name = sp.commonName;
    const info = SPECIES_INFO[name];
    
    if (!info) continue; // Skip species we don't have enrichment for

    sql.push(`INSERT OR IGNORE INTO species (name, scientific_name, description, fun_facts, habitat, diet, migration_pattern, is_bird)
      VALUES ('${name.replace(/'/g, "''")}', '${info.scientific.replace(/'/g, "''")}', '${info.description.replace(/'/g, "''")}', '${info.fun_facts.replace(/'/g, "''")}', '${info.habitat.replace(/'/g, "''")}', '${info.diet.replace(/'/g, "''")}', '${info.migration.replace(/'/g, "''")}', 1);`);
  }

  return sql.join('\n');
}

function generateHeatmapHTML(heatmap) {
  // Generate a simple JSON file that the web app can consume
  const output = {};
  for (const [date, hours] of Object.entries(heatmap)) {
    output[date] = {};
    for (let h = 0; h < 24; h++) {
      if (hours[h]) {
        output[date][h] = hours[h];
      }
    }
  }
  return output;
}

async function main() {
  const args = process.argv.slice(2);
  const doAlert = args.includes('--alert') || args.includes('--full');
  const doHeatmap = args.includes('--heatmap') || args.includes('--full');
  const doSync = args.includes('--sync') || args.includes('--full');
  const dryRun = args.includes('--dry-run');

  console.log(`[BirdNET Sync] Starting... (alert=${doAlert}, heatmap=${doHeatmap}, sync=${doSync})`);

  const state = loadState();
  
  // Fetch latest detections
  const detections = await getDetections(200);
  console.log(`[BirdNET Sync] Fetched ${detections.length} detections`);

  // Get species list
  const speciesList = await getSpeciesList();
  console.log(`[BirdNET Sync] Station has ${speciesList.length} species total`);

  // Track today's species
  const today = new Date().toISOString().split('T')[0];
  state.dailySpecies[today] = [...new Set(detections.map(d => d.species.commonName))];

  // --- ALERTS ---
  if (doAlert) {
    const interesting = findInterestingDetections(detections, state);
    if (interesting.length > 0) {
      console.log(`[BirdNET Sync] Found ${interesting.length} interesting detections:`);
      for (const det of interesting) {
        console.log(`  🎵 ${det.species} (${(det.confidence * 100).toFixed(0)}% confidence) at ${det.timestamp}`);
        
        if (!dryRun) {
          const msg = `🎵 BirdNET Audio Detection: **${det.species}** (*${det.scientificName}*) heard at ${new Date(det.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} with ${(det.confidence * 100).toFixed(0)}% confidence. This species was detected by audio only (BirdNET-Pi), not at the feeder.`;
          try {
            await postHook(msg);
            console.log(`  → Alert sent`);
          } catch (e) {
            console.log(`  → Alert failed: ${e.message}`);
          }
        }
      }
    } else {
      console.log('[BirdNET Sync] No interesting detections to alert on');
    }
  }

  // --- HEATMAP ---
  if (doHeatmap) {
    const heatmap = buildHeatmap(detections);
    const heatmapData = generateHeatmapHTML(heatmap);
    const heatmapPath = '/path/to/workspace/birdbuddy-app/public/api/birdnet-heatmap.json';
    
    // Ensure directory exists
    const dir = path.dirname(heatmapPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    fs.writeFileSync(heatmapPath, JSON.stringify(heatmapData, null, 2));
    console.log(`[BirdNET Sync] Heatmap data written to ${heatmapPath}`);
    
    // Also write a summary
    console.log('[BirdNET Sync] Today\'s activity by hour:');
    const todayData = heatmap[today] || {};
    for (let h = 0; h < 24; h++) {
      if (todayData[h]) {
        const total = Object.values(todayData[h]).reduce((a, b) => a + b, 0);
        const species = Object.keys(todayData[h]).length;
        console.log(`  ${h.toString().padStart(2, '0')}:00 - ${total} detections, ${species} species`);
      }
    }
  }

  // --- DB SYNC ---
  if (doSync) {
    const sql = await syncSpeciesToDB(speciesList);
    if (sql) {
      const sqlPath = '/tmp/birdnet-species-sync.sql';
      fs.writeFileSync(sqlPath, sql);
      console.log(`[BirdNET Sync] Species sync SQL written to ${sqlPath}`);
      console.log(`[BirdNET Sync] Run: sqlite3 ${DB_PATH} < ${sqlPath}`);
      if (!dryRun) {
        console.log('[BirdNET Sync] NOTE: Stop the bird app server before applying SQL!');
      }
    }
  }

  // --- CROSS-REFERENCE REPORT ---
  console.log('\n[BirdNET Sync] All species detected by BirdNET today:');
  for (const sp of speciesList) {
    const det = sp.detections;
    console.log(`  ${sp.commonName.padEnd(25)} | ${det.total} detections | ${det.almostCertain} certain`);
  }

  // Save state
  state.lastSync = new Date().toISOString();
  saveState(state);
  console.log(`\n[BirdNET Sync] State saved. Done!`);
}

main().catch(err => {
  console.error('[BirdNET Sync] Error:', err.message);
  process.exit(1);
});
