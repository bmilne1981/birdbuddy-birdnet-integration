#!/usr/bin/env node
/**
 * Incremental Bird Buddy database update
 * Scans archive for new sightings not already in the database
 * Also enriches any new species with basic info via web lookup
 */

const { initDb, saveDb, getDb } = require('./db');
const fs = require('fs');
const path = require('path');

const ARCHIVE_PATH = '/path/to/workspace/data/birdbuddy';

async function update() {
  await initDb();
  const db = getDb();

  // Get existing sighting timestamps to avoid duplicates
  const existingResult = db.exec('SELECT timestamp FROM sightings');
  const existingTimestamps = new Set();
  if (existingResult.length > 0) {
    existingResult[0].values.forEach(row => existingTimestamps.add(row[0]));
  }

  // Get existing species
  const speciesResult = db.exec('SELECT name FROM species');
  const existingSpecies = new Set();
  if (speciesResult.length > 0) {
    speciesResult[0].values.forEach(row => existingSpecies.add(row[0]));
  }

  let newSightings = 0;
  let newMedia = 0;
  let newSpecies = 0;
  let verificationUpdates = 0;

  // Scan archive
  const dateDirs = fs.readdirSync(ARCHIVE_PATH).filter(f => f.match(/^\d{4}-\d{2}-\d{2}$/));

  for (const dateDir of dateDirs.sort()) {
    const datePath = path.join(ARCHIVE_PATH, dateDir);
    const metaFiles = fs.readdirSync(datePath).filter(f => f.endsWith('_meta.json'));

    for (const metaFile of metaFiles) {
      const metaPath = path.join(datePath, metaFile);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

      // If already imported, check if verification data needs updating
      if (existingTimestamps.has(meta.timestamp)) {
        if (meta.verification) {
          // Normalize verified_species to match canonical species name (case-insensitive)
          let verifiedSpecies = meta.verification.verified_species || null;
          if (verifiedSpecies) {
            const canonical = db.exec('SELECT name FROM species WHERE LOWER(name) = LOWER(?)', [verifiedSpecies]);
            if (canonical.length > 0 && canonical[0].values.length > 0) {
              verifiedSpecies = canonical[0].values[0][0];
            }
          }
          db.run(
            `UPDATE sightings SET 
              verified = 1, 
              verified_species = ?, 
              confidence = ?, 
              interesting = ?, 
              notes = ?
            WHERE timestamp = ? AND (verified = 0 OR verified IS NULL OR verified_species != ?)`,
            [
              verifiedSpecies,
              meta.verification.confidence || null,
              meta.verification.interesting ? 1 : 0,
              meta.verification.notes || null,
              meta.timestamp,
              verifiedSpecies
            ]
          );
          const changes = db.getRowsModified();
          if (changes > 0) verificationUpdates++;
        }
        continue;
      }

      // Get or create species
      let result = db.exec('SELECT id FROM species WHERE name = ?', [meta.species]);
      let speciesId;

      if (result.length === 0 || result[0].values.length === 0) {
        db.run('INSERT INTO species (name, is_bird) VALUES (?, ?)', [
          meta.species,
          meta.species.toLowerCase().includes('squirrel') || meta.species.toLowerCase().includes('chipmunk') ? 0 : 1
        ]);
        result = db.exec('SELECT id FROM species WHERE name = ?', [meta.species]);
        speciesId = result[0].values[0][0];
        newSpecies++;
        console.log(`🆕 New species: ${meta.species}`);
      } else {
        speciesId = result[0].values[0][0];
      }

      const timestamp = new Date(meta.timestamp);
      const date = timestamp.toISOString().split('T')[0];
      const time = timestamp.toISOString().split('T')[1].substring(0, 8);

      // Dedup: skip if a sighting for the same species exists within 2 minutes
      const tsEpoch = Math.floor(timestamp.getTime() / 1000);
      const nearbyDupe = db.exec(
        `SELECT id FROM sightings WHERE species_id = ? AND ABS(CAST(strftime('%s', timestamp) AS INTEGER) - ?) < 120`,
        [speciesId, tsEpoch]
      );
      if (nearbyDupe.length > 0 && nearbyDupe[0].values.length > 0) {
        // Already have a sighting for this species within 2 minutes — skip
        continue;
      }

      const photoCount = (meta.files || []).filter(f => f.match(/\.(jpg|jpeg|png|gif)$/i)).length;
      const videoCount = (meta.files || []).filter(f => f.match(/\.(mp4|mov|webm)$/i)).length;

      // Insert sighting
      db.run(
        `INSERT INTO sightings (species_id, timestamp, date, time, photo_count, video_count, media_source, verified, verified_species, confidence, interesting, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          speciesId,
          meta.timestamp,
          date,
          time,
          photoCount,
          videoCount,
          meta.media_source || 'unknown',
          meta.verification ? 1 : 0,
          (() => { 
            const vs = meta.verification?.verified_species; 
            if (!vs) return null; 
            const c = db.exec('SELECT name FROM species WHERE LOWER(name) = LOWER(?)', [vs]); 
            return (c.length > 0 && c[0].values.length > 0) ? c[0].values[0][0] : vs; 
          })(),
          meta.verification?.confidence || null,
          meta.verification?.interesting ? 1 : 0,
          meta.verification?.notes || null
        ]
      );

      const sightingResult = db.exec('SELECT last_insert_rowid()');
      const sightingId = sightingResult[0].values[0][0];
      newSightings++;

      // Insert media files
      for (const file of (meta.files || [])) {
        if (file.endsWith('_meta.json')) continue;

        const isVideo = file.match(/\.(mp4|mov|webm)$/i);
        const type = isVideo ? 'video' : 'photo';
        const numMatch = file.match(/_(\d+)\.\w+$/);
        const fileNumber = numMatch ? parseInt(numMatch[1]) : null;

        db.run(
          'INSERT INTO media (sighting_id, filename, filepath, type, file_number) VALUES (?, ?, ?, ?, ?)',
          [sightingId, file, path.join(dateDir, file), type, fileNumber]
        );
        newMedia++;
      }
    }
  }

  // Update species stats
  db.run(`
    UPDATE species SET
      total_sightings = (SELECT COUNT(*) FROM sightings WHERE species_id = species.id),
      first_seen = (SELECT MIN(timestamp) FROM sightings WHERE species_id = species.id),
      last_seen = (SELECT MAX(timestamp) FROM sightings WHERE species_id = species.id)
  `);

  if (newSightings > 0 || verificationUpdates > 0) {
    saveDb();
    const parts = [];
    if (newSightings > 0) parts.push(`${newSightings} sightings, ${newMedia} media files, ${newSpecies} new species`);
    if (verificationUpdates > 0) parts.push(`${verificationUpdates} verification updates`);
    console.log(`✅ ${parts.join(', ')}`);
    // Tell the web server to reload the DB from disk
    try {
      const { execSync } = require('child_process');
      execSync('curl -s -X POST http://127.0.0.1:8801/api/reload-db', { timeout: 5000 });
      console.log('🔄 Web server DB reloaded');
    } catch (e) {
      console.log(`⚠️ Could not reload web server: ${e.message}`);
    }
  } else {
    console.log('✅ Database up to date — no new sightings or verification changes');
  }
}

update().catch(err => {
  console.error('❌ Update failed:', err);
  process.exit(1);
});
