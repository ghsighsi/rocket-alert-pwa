# 🚀 Rocket Alert PWA — צבע אדום

Real-time rocket alert Progressive Web App for Israel. Displays active alerts on an interactive map with push notifications support.

![Hebrew](https://img.shields.io/badge/lang-Hebrew-blue)
![Docker](https://img.shields.io/badge/docker-ready-blue)
![PWA](https://img.shields.io/badge/PWA-installable-green)

## Features

- **Real-time alerts** — polls for active rocket/missile alerts every 2 seconds
- **Interactive map** — displays affected areas on a Leaflet map with GeoJSON overlays
- **Push notifications** — browser notifications for your selected home city
- **Installable PWA** — works as a standalone app on mobile and desktop
- **Alert sound** — audio notification on release/all-clear
- **Dark theme** — optimized for quick readability under stress
- **Fully RTL** — native Hebrew interface

## Quick Start

### Docker (recommended)

```bash
docker compose up -d
```

The app will be available at `http://localhost:3088`.

### Manual

```bash
npm install
node server.js
```

Open `http://localhost:3088` and select your home city from the settings menu.

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla JS, Leaflet.js, Chart.js
- **Deployment:** Docker (nginx not required — Express serves static files)

## License

MIT
