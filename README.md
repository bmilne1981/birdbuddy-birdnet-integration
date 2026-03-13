# Bird Buddy + BirdNET-Pi Integration

A complete pipeline for archiving Bird Buddy feeder camera postcards, integrating BirdNET-Pi audio detections, and serving a combined bird activity web app.

## Components

### `birdbuddy-webhook.js` — Bird Buddy Postcard Archiver
Polls Home Assistant for new Bird Buddy postcards, downloads media (photos + videos), archives to local storage and Synology NAS, and notifies OpenClaw for AI-powered species verification.

**Features:**
- Polls HA automation trigger + entity picture for new postcards
- Downloads media via Bird Buddy API (with HA entity_picture fallback)
- Archives to local filesystem + Synology NAS via rsync
- Triggers DB rebuild for the web app
- Fires webhook for AI species verification
- Health endpoint on configurable port

**Environment variables:**
- `HA_TOKEN` — Home Assistant long-lived access token
- `OPENCLAW_HOOK_TOKEN` — OpenClaw webhook auth token

### `birdnet-sync.js` — BirdNET-Pi Data Sync
Pulls detection data from BirdWeather API and integrates with the Bird Buddy web app database. Generates activity heatmaps and alerts on interesting species.

**Features:**
- Fetches detections from BirdWeather station API
- Cross-references audio-only species with feeder camera sightings
- Generates hourly activity heatmap JSON
- Alerts on unusual/interesting species (skips common ones)
- Enriches species data with descriptions, fun facts, habitat info

**Usage:**
```bash
node birdnet-sync.js --full        # Run everything
node birdnet-sync.js --alert       # Only check for interesting detections
node birdnet-sync.js --heatmap     # Only regenerate heatmap data
node birdnet-sync.js --sync        # Only sync species to DB
```

### Web App Files
- `server.js` — Express server with species guide, sightings, BirdNET activity page
- `db.js` — SQLite database interface (sql.js, in-memory)
- `update-db.js` — DB rebuild from archived postcard metadata
- `views/index.ejs` — Main species guide page
- `views/birdnet.ejs` — BirdNET audio detection activity page

## Architecture

```
Bird Buddy Camera → Home Assistant → birdbuddy-webhook.js → Local Archive + Synology
                                                          → OpenClaw (AI species verification)
                                                          → update-db.js → birdbuddy.db

BirdNET-Pi (mic) → BirdWeather API → birdnet-sync.js → Heatmap JSON + Alerts
                                                      → Species enrichment SQL → birdbuddy.db

Web App (server.js) ← birdbuddy.db + heatmap JSON → Browser
```

## Setup

1. Configure Home Assistant with Bird Buddy integration
2. Set up BirdNET-Pi and connect to BirdWeather
3. Copy files and update paths/IPs in configuration sections
4. Set environment variables for tokens
5. Run `birdbuddy-webhook.js` as a daemon (LaunchAgent/systemd)
6. Schedule `birdnet-sync.js` via cron (every 2-3 hours)
7. Run `server.js` for the web interface

## Notes

- Uses `curl` for HA API calls due to macOS network permission restrictions on Node.js
- sql.js holds DB in memory — stop the server before editing the DB file directly
- Species verification uses vision AI to confirm Bird Buddy's sometimes-wrong identifications
- All credentials have been removed from this public version — use environment variables
