#!/usr/bin/env node
/**
 * Bird Buddy Web App Server
 * Serves the photo archive, species database, and timeline
 */

const express = require('express');
const { initDb, getDb, reloadDb } = require('./db');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 8801;
const ARCHIVE_PATH = '/path/to/workspace/data/birdbuddy';
const BASE_PATH = process.env.BASE_PATH || '';

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', './views');

// Make basePath available to all templates
app.use((req, res, next) => {
  res.locals.basePath = BASE_PATH;
  next();
});

// Helper to execute query and return results
function query(sql, params = []) {
  const db = getDb();
  const result = db.exec(sql, params);
  
  if (result.length === 0) return [];
  
  const columns = result[0].columns;
  const values = result[0].values;
  
  return values.map(row => {
    const obj = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj;
  });
}

function queryOne(sql, params = []) {
  const results = query(sql, params);
  return results.length > 0 ? results[0] : null;
}

// ---- Species normalization ----
// Strips parenthetical suffixes ("House Finch (male)" → "House Finch")
// and consolidates squirrel variants ("Eastern Gray Squirrel" → "Squirrel")
function normSp(expr) {
  return `CASE
    WHEN (${expr}) = 'Eastern Gray Squirrel' THEN 'Squirrel'
    WHEN INSTR((${expr}), ' (') > 0 THEN TRIM(SUBSTR((${expr}), 1, INSTR((${expr}), ' (') - 1))
    ELSE (${expr})
  END`;
}

// ---- Routes ----

// Reload DB from disk (called after update-db.js writes new data)
app.post('/api/reload-db', (req, res) => {
  try {
    reloadDb();
    res.json({ ok: true, message: 'Database reloaded' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Home page
app.get('/', (req, res) => {
  const stats = queryOne(`
    SELECT 
      (SELECT COUNT(DISTINCT ${normSp('COALESCE(verified_species, (SELECT name FROM species WHERE id = species_id))')}) FROM sightings) as species_count,
      (SELECT COUNT(*) FROM sightings) as sighting_count,
      (SELECT COUNT(*) FROM media WHERE type = 'photo') as photo_count,
      (SELECT COUNT(*) FROM media WHERE type = 'video') as video_count
  `);
  
  res.render('index', { stats });
});

// API: Get all species
app.get('/api/species', (req, res) => {
  const species = query(`
    SELECT * FROM species
    ORDER BY total_sightings DESC, name ASC
  `);
  
  res.json(species);
});

// API: Get species detail
app.get('/api/species/:id', (req, res) => {
  const species = queryOne('SELECT * FROM species WHERE id = ?', [req.params.id]);
  
  if (!species) {
    return res.status(404).json({ error: 'Species not found' });
  }
  
  const sightings = query(`
    SELECT 
      s.*,
      COUNT(m.id) as media_count
    FROM sightings s
    LEFT JOIN media m ON s.id = m.sighting_id
    WHERE s.species_id = ?
    GROUP BY s.id
    ORDER BY s.timestamp DESC
  `, [species.id]);
  
  res.json({ species, sightings });
});

// API: Get timeline (all sightings)
app.get('/api/timeline', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  
  const sightings = query(`
    SELECT 
      s.*,
      ${normSp('COALESCE(s.verified_species, sp.name)')} as species_name,
      COALESCE(s.verified_species, sp.name) as species_name_raw,
      sp.name as bb_species,
      sp.scientific_name,
      sp.is_bird,
      s.verified,
      (SELECT filename FROM media WHERE sighting_id = s.id AND type = 'photo' ORDER BY file_number LIMIT 1) as thumbnail
    FROM sightings s
    JOIN species sp ON s.species_id = sp.id
    ORDER BY s.timestamp DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  
  res.json(sightings);
});

// API: Get sighting detail with all media
app.get('/api/sightings/:id', (req, res) => {
  const sighting = queryOne(`
    SELECT 
      s.*,
      COALESCE(s.verified_species, sp.name) as species_name,
      sp.name as bb_species,
      sp.scientific_name,
      sp.description,
      sp.fun_facts,
      s.verified,
      s.confidence,
      s.notes as verification_notes
    FROM sightings s
    JOIN species sp ON s.species_id = sp.id
    WHERE s.id = ?
  `, [req.params.id]);
  
  if (!sighting) {
    return res.status(404).json({ error: 'Sighting not found' });
  }
  
  const media = query(`
    SELECT * FROM media
    WHERE sighting_id = ?
    ORDER BY type DESC, file_number ASC
  `, [req.params.id]);
  
  res.json({ sighting, media });
});

// API: Get occurrence stats for charts
app.get('/api/stats/occurrences', (req, res) => {
  const groupBy = req.query.group || 'day';
  
  let dateFormat;
  if (groupBy === 'month') {
    dateFormat = 'substr(date, 1, 7)';
  } else if (groupBy === 'week') {
    dateFormat = "strftime('%Y-W%W', date)";
  } else {
    dateFormat = 'date';
  }
  
  const data = query(`
    SELECT 
      ${dateFormat} as period,
      ${normSp('COALESCE(s.verified_species, sp.name)')} as species,
      COUNT(*) as count
    FROM sightings s
    JOIN species sp ON s.species_id = sp.id
    GROUP BY period, species
    ORDER BY period ASC, count DESC
  `);
  
  res.json(data);
});

// API: Get species occurrence trends
app.get('/api/stats/species-trends', (req, res) => {
  const data = query(`
    SELECT 
      substr(date, 1, 7) as month,
      ${normSp('COALESCE(s.verified_species, sp.name)')} as species,
      COUNT(*) as sightings
    FROM sightings s
    JOIN species sp ON s.species_id = sp.id
    GROUP BY month, species
    ORDER BY month ASC
  `);
  
  res.json(data);
});

// ---- BirdNET Integration ----
const BIRDWEATHER_STATION = 24073;
const BIRDWEATHER_API_BASE = 'https://app.birdweather.com/api/v1';

// Helper to fetch from BirdWeather API
async function bwFetch(endpoint) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get(`${BIRDWEATHER_API_BASE}${endpoint}`, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

// API: BirdNET species list with detection counts
app.get('/api/birdnet/species', async (req, res) => {
  try {
    const period = req.query.period || 'all';
    const data = await bwFetch(`/stations/${BIRDWEATHER_STATION}/species?period=${period}&limit=200`);
    if (data.success) {
      res.json(data.species);
    } else {
      res.status(500).json({ error: 'BirdWeather API error' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: BirdNET recent detections
app.get('/api/birdnet/detections', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const species = req.query.species ? `&speciesId=${req.query.species}` : '';
    const data = await bwFetch(`/stations/${BIRDWEATHER_STATION}/detections?limit=${limit}&order=desc${species}`);
    if (data.success) {
      res.json(data.detections);
    } else {
      res.status(500).json({ error: 'BirdWeather API error' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: BirdNET hourly activity heatmap for today
app.get('/api/birdnet/heatmap', async (req, res) => {
  try {
    const data = await bwFetch(`/stations/${BIRDWEATHER_STATION}/detections?limit=200&order=desc`);
    if (!data.success) return res.status(500).json({ error: 'API error' });

    const heatmap = {};
    for (const det of data.detections) {
      const ts = new Date(det.timestamp);
      const date = ts.toISOString().split('T')[0];
      const hour = ts.getHours();
      const species = det.species.commonName;
      
      if (!heatmap[date]) heatmap[date] = {};
      if (!heatmap[date][hour]) heatmap[date][hour] = {};
      heatmap[date][hour][species] = (heatmap[date][hour][species] || 0) + 1;
    }
    res.json(heatmap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Cross-reference — species heard but not seen (and vice versa)
app.get('/api/birdnet/crossref', async (req, res) => {
  try {
    const bwData = await bwFetch(`/stations/${BIRDWEATHER_STATION}/species?period=all&limit=200`);
    if (!bwData.success) return res.status(500).json({ error: 'API error' });

    const audioSpeciesMap = {};
    bwData.species.forEach(s => { audioSpeciesMap[s.commonName.toLowerCase()] = s; });
    // Only count species that have actual feeder sightings (not just DB entries from BirdNET enrichment)
    const dbSpecies = query("SELECT sp.name FROM species sp WHERE sp.is_bird = 1 AND sp.total_sightings > 0");
    const visualSpeciesLower = new Set(dbSpecies.map(s => s.name.toLowerCase()));

    const audioOnly = bwData.species
      .filter(s => !visualSpeciesLower.has(s.commonName.toLowerCase()))
      .map(s => ({
        name: s.commonName,
        scientificName: s.scientificName,
        detections: s.detections.total,
        imageUrl: s.thumbnailUrl,
        latestDetection: s.latestDetectionAt
      }));

    const visualOnly = dbSpecies
      .filter(s => !audioSpeciesMap[s.name.toLowerCase()])
      .map(s => s.name);

    const both = dbSpecies
      .filter(s => audioSpeciesMap[s.name.toLowerCase()])
      .map(s => {
        const bw = audioSpeciesMap[s.name.toLowerCase()];
        return {
          name: s.name,
          audioDetections: bw ? bw.detections.total : 0
        };
      });

    const audioNames = new Set(Object.keys(audioSpeciesMap));
    res.json({ audioOnly, visualOnly, both, 
      totalAudio: audioNames.size, 
      totalVisual: visualSpeciesLower.size,
      totalCombined: new Set([...audioNames, ...visualSpeciesLower]).size
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// BirdNET page
app.get('/birdnet', (req, res) => {
  res.render('birdnet');
});

// Serve media files
app.get('/media/:date/:filename', (req, res) => {
  const filepath = path.join(ARCHIVE_PATH, req.params.date, req.params.filename);
  
  if (!fs.existsSync(filepath)) {
    return res.status(404).send('Media not found');
  }
  
  res.sendFile(filepath);
});

// Initialize database and start server
(async () => {
  await initDb();
  console.log('✅ Database loaded');
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🐦 Bird Buddy app running at http://localhost:${PORT}`);
    console.log(`📊 Archive: ${ARCHIVE_PATH}`);
  });
})();
