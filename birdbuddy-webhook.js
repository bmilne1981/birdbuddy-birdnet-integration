#!/usr/bin/env node
/**
 * Bird Buddy Postcard Archiver
 * 
 * Polls Home Assistant for new Bird Buddy postcards by watching the
 * "Collect Bird Buddy Postcard" automation's last_triggered timestamp
 * and the recent_visitor entity_picture URL.
 * 
 * When a new postcard is detected, downloads the media and archives
 * to Synology.
 * 
 * Also exposes a health endpoint on port 8790.
 * 
 * Note: Uses curl for HA API calls due to macOS Sequoia local network
 * permission restrictions on Node.js sockets.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Config
const HTTP_PORT = 8790;
const HTTP_BIND = '127.0.0.1';
const HA_URL = 'http://YOUR_HA_IP:8123';
const HA_TOKEN = 'process.env.HA_TOKEN';
const LOCAL_BASE = '/path/to/workspace/data/birdbuddy';
const SYNOLOGY_HOST = 'user@your-nas-ip';
const SYNOLOGY_PATH = '/your/synology/path';
const SSH_KEY = '~/.ssh/your_key';
const LOG_FILE = '/path/to/workspace/logs/birdbuddy-archive.log';
const STATE_FILE = path.join(LOCAL_BASE, 'archiver-state.json');
const POLL_INTERVAL_MS = 60000; // Check every 60 seconds

let eventCount = 0;
let lastEvent = null;

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    console.error('Failed to write log:', e.message);
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return {
    lastAutomationTriggered: null,
    lastEntityPicture: null,
    lastSpecies: null
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function haGet(endpoint) {
  try {
    const result = execSync(
      `curl -s -m 10 -H "Authorization: Bearer ${HA_TOKEN}" "${HA_URL}${endpoint}"`,
      { timeout: 15000 }
    );
    return JSON.parse(result.toString());
  } catch (e) {
    log(`ERROR calling HA API ${endpoint}: ${e.message}`);
    return null;
  }
}

function downloadFile(url, dest) {
  try {
    // Use curl for downloads too (Node can't reach LAN)
    execSync(`curl -s -L -o "${dest}" "${url}"`, { timeout: 60000 });
    if (fs.existsSync(dest)) {
      const stats = fs.statSync(dest);
      if (stats.size > 0) return true;
    }
    return false;
  } catch (e) {
    log(`ERROR downloading: ${e.message}`);
    return false;
  }
}

function syncToSynology(localDir, remoteDir) {
  try {
    execSync(
      `ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no ${SYNOLOGY_HOST} "mkdir -p '${remoteDir}'"`,
      { timeout: 15000 }
    );
    execSync(
      `rsync -avz -e "ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no" "${localDir}/" "${SYNOLOGY_HOST}:${remoteDir}/"`,
      { timeout: 60000 }
    );
    return true;
  } catch (e) {
    log(`ERROR syncing to Synology: ${e.message}`);
    return false;
  }
}

function guessExtension(url) {
  const urlPath = (url || '').split('?')[0];
  const ext = path.extname(urlPath).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.webm'].includes(ext)) {
    return ext;
  }
  if (url && url.includes('CONTENT')) return '.jpg';
  if (url && (url.includes('video') || url.includes('VIDEO'))) return '.mp4';
  return '.jpg';
}

function fetchAllMedia() {
  // Call Python helper to get all media (photos + videos) from recent postcards
  try {
    const result = execSync(
      `/usr/local/opt/python@3.12/bin/python3.12 "/Users/brianmilne/clawd/scripts/birdbuddy-media.py" --since 1`,
      { timeout: 60000 }
    );
    return JSON.parse(result.toString());
  } catch (e) {
    log(`WARNING: Could not fetch full media via Bird Buddy API: ${e.message}`);
    return null;
  }
}

function notifyOpenClaw(species, photoPath, meta) {
  // Fire webhook to OpenClaw for species verification + alerting
  const hookToken = 'process.env.OPENCLAW_HOOK_TOKEN';
  const payload = JSON.stringify({
    species,
    photoPath,
    timestamp: meta.timestamp,
    downloaded: meta.downloaded,
    media_source: meta.media_source,
  });
  try {
    execSync(
      `curl -s -X POST "http://127.0.0.1:18789/hooks/birdbuddy" -H "Content-Type: application/json" -H "Authorization: Bearer ${hookToken}" -d '${payload.replace(/'/g, "'\\''")}'`,
      { timeout: 10000 }
    );
    log(`  📡 Notified OpenClaw for verification`);
  } catch (e) {
    log(`  ⚠️ Failed to notify OpenClaw: ${e.message}`);
  }
}

async function archivePostcard(species, pictureUrl) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const safeSpecies = (species || 'Unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  
  log(`🐦 New postcard detected: ${species}`);
  
  const localDir = path.join(LOCAL_BASE, dateStr);
  ensureDir(localDir);
  
  let downloaded = 0;
  const files = [];
  
  // Try to get all media (photos + videos) via Bird Buddy API
  const allMedia = fetchAllMedia();
  let usedApi = false;
  
  if (allMedia && Array.isArray(allMedia) && allMedia.length > 0 && !allMedia[0].error) {
    // Find the postcard matching this species (not just the first one!)
    const postcard = allMedia.find(p => p.species === species) || null;
    if (!postcard) {
      log(`  ⚠️ No API postcard matches species "${species}" (API has: ${allMedia.map(p => p.species).join(', ')}). Falling back to HA photo.`);
    }
    const mediaItems = postcard ? (postcard.media || []) : [];
    
    for (let i = 0; i < mediaItems.length; i++) {
      const item = mediaItems[i];
      const isVideo = item.type === 'MediaVideo';
      const ext = isVideo ? '.mp4' : '.jpg';
      const typeLabel = isVideo ? 'video' : 'photo';
      const filename = `${timeStr}_${safeSpecies}_${typeLabel}_${i + 1}${ext}`;
      const filepath = path.join(localDir, filename);
      
      if (item.content_url && downloadFile(item.content_url, filepath)) {
        const stats = fs.statSync(filepath);
        const sizeStr = stats.size > 1048576
          ? `${(stats.size / 1048576).toFixed(1)} MB`
          : `${(stats.size / 1024).toFixed(1)} KB`;
        log(`  ✅ ${filename} (${sizeStr})`);
        files.push(filename);
        downloaded++;
      } else {
        log(`  ❌ Failed to download ${typeLabel} ${i + 1}`);
      }
    }
    usedApi = postcard != null && downloaded > 0;
  }
  
  // Fallback: download entity_picture from HA if API didn't work or no matching postcard
  if (!usedApi && pictureUrl) {
    const ext = guessExtension(pictureUrl);
    const filename = `${timeStr}_${safeSpecies}_photo${ext}`;
    const filepath = path.join(localDir, filename);
    
    if (downloadFile(pictureUrl, filepath)) {
      const stats = fs.statSync(filepath);
      log(`  ✅ ${filename} (${(stats.size / 1024).toFixed(1)} KB) [HA fallback]`);
      files.push(filename);
      downloaded++;
    } else {
      log(`  ❌ Failed to download photo`);
    }
  }
  
  // Write metadata
  const meta = {
    species,
    timestamp: now.toISOString(),
    picture_url: pictureUrl,
    media_source: usedApi ? 'birdbuddy_api' : 'ha_entity_picture',
    files,
    downloaded
  };
  const metaFile = path.join(localDir, `${timeStr}_${safeSpecies}_meta.json`);
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  files.push(`${timeStr}_${safeSpecies}_meta.json`);
  
  // Sync to Synology
  const remoteDir = `${SYNOLOGY_PATH}/${dateStr}`;
  const synced = syncToSynology(localDir, remoteDir);
  if (synced) {
    log(`  📦 Synced to Synology: ${remoteDir}`);
    // Trigger DB rebuild so the archive website updates immediately
    try {
      execSync(
        '/usr/local/bin/node /path/to/workspace/birdbuddy-app/update-db.js',
        { cwd: '/path/to/workspace/birdbuddy-app', timeout: 30000 }
      );
      log(`  🔄 DB rebuild triggered`);
    } catch (e) {
      log(`  ⚠️ DB rebuild failed: ${e.message}`);
    }
  }
  
  // Notify OpenClaw for species verification (uses first photo)
  const firstPhoto = files.find(f => f.endsWith('.jpg'));
  if (firstPhoto) {
    notifyOpenClaw(species, path.join(localDir, firstPhoto), meta);
  }
  
  lastEvent = { species, timestamp: now.toISOString(), downloaded, synced };
  eventCount++;
  
  return { species, downloaded, synced };
}

function poll() {
  const state = loadState();
  
  // Check automation last_triggered
  const automationState = haGet('/api/states/automation.collect_bird_buddy_postcard');
  if (!automationState) return;
  
  const lastTriggered = automationState.attributes?.last_triggered;
  
  // Check recent visitor sensor
  const visitorState = haGet('/api/states/sensor.kristin10_s_bird_buddy_recent_visitor');
  if (!visitorState) return;
  
  const currentPicture = visitorState.attributes?.entity_picture || null;
  const currentSpecies = visitorState.state || 'Unknown';
  
  // Extract media UUID from CDN URL (ignoring expiry/signature params)
  // URL format: .../media/<feeder-uuid>/media/<media-uuid>/CONTENT.jpg?Expires=...
  function extractMediaId(url) {
    if (!url) return null;
    const match = url.match(/\/media\/([a-f0-9-]+)\/CONTENT/i);
    return match ? match[1] : url.split('?')[0]; // fallback to URL without query params
  }

  // Detect new postcard: automation triggered more recently than our last check
  // OR media UUID changed (new photo, ignoring CDN signature rotation)
  const automationChanged = lastTriggered && lastTriggered !== state.lastAutomationTriggered;
  const currentMediaId = extractMediaId(currentPicture);
  const lastMediaId = extractMediaId(state.lastEntityPicture);
  const pictureChanged = currentMediaId && currentMediaId !== lastMediaId;
  
  if (automationChanged || pictureChanged) {
    // Skip if automation changed but media is the same (prevents duplicates from re-triggers)
    if (automationChanged && !pictureChanged && currentMediaId === lastMediaId) {
      log(`Automation re-triggered but same media (${currentMediaId}) — skipping`);
      state.lastAutomationTriggered = lastTriggered;
      saveState(state);
      return;
    }
    const reason = automationChanged && pictureChanged ? 'automation+picture'
      : automationChanged ? 'automation' : 'picture';
    log(`Change detected (${reason}): ${currentSpecies}`);
    
    // Archive it
    archivePostcard(currentSpecies, currentPicture).then(() => {
      // Update state after successful archive
      state.lastAutomationTriggered = lastTriggered;
      state.lastEntityPicture = currentPicture;
      state.lastSpecies = currentSpecies;
      saveState(state);
    }).catch(e => {
      log(`ERROR archiving: ${e.message}`);
    });
  } else {
    // No change — just update automation trigger timestamp if we haven't seen it yet
    if (lastTriggered && !state.lastAutomationTriggered) {
      state.lastAutomationTriggered = lastTriggered;
      state.lastEntityPicture = currentPicture;
      state.lastSpecies = currentSpecies;
      saveState(state);
      log(`Initialized state: ${currentSpecies} (last triggered: ${lastTriggered})`);
    }
  }
}

// ---- HTTP health endpoint ----

const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    const state = loadState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'birdbuddy-archiver',
      poll_interval_sec: POLL_INTERVAL_MS / 1000,
      events_archived: eventCount,
      last_event: lastEvent,
      state
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ---- Start ----

ensureDir(LOCAL_BASE);
ensureDir(path.dirname(LOG_FILE));

httpServer.listen(HTTP_PORT, HTTP_BIND, () => {
  log(`Health endpoint: http://${HTTP_BIND}:${HTTP_PORT}/health`);
});

log('Bird Buddy Archiver started (polling mode)');
log(`  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
log(`  Local archive: ${LOCAL_BASE}`);
log(`  Synology target: ${SYNOLOGY_HOST}:${SYNOLOGY_PATH}`);

// Initial poll
poll();

// Regular polling
setInterval(poll, POLL_INTERVAL_MS);
