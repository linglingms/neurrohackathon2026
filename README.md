# NeuroHackathon 2026 - NeuroSignal Interview App

Real-time biosignal analysis app for desktop and mobile browsers, built for OpenBCI + Jetson Nano.

## Important Note
This project estimates stress and cognitive load from biosignals. It is not a validated forensic lie detector.

## What Is In This Repo
- `backend/`: Flask API for sessions, EEG processing, and scoring
- `frontend/`: Mobile-friendly web dashboard
- `analysis.ipynb`: Notebook space for experiments

## Quick Start

1. Install backend dependencies:

```bash
cd backend
pip install -r requirements.txt
```

2. Start backend API:

```bash
cd ..
python -m backend.app
```

3. Open frontend:

```bash
open frontend/index.html
```

The frontend uses `http://localhost:5050/api` by default.

## Deploy On Local Network (Desktop + Mobile)

1. Start backend on all interfaces:

```bash
cd /Users/warrenbuenarte/Library/CloudStorage/OneDrive-Personal/Documents/neurrohackathon2026
python -m backend.app
```

2. In a second terminal, serve frontend on all interfaces:

```bash
cd /Users/warrenbuenarte/Library/CloudStorage/OneDrive-Personal/Documents/neurrohackathon2026/frontend
python -m http.server 8080 --bind 0.0.0.0
```

3. Find your computer LAN IP and open on phone/computer:

```bash
ipconfig getifaddr en0
```

Open `http://<YOUR_LAN_IP>:8080` on any device on the same Wi-Fi.

## API Endpoints
- `GET /api/health`: service status
- `POST /api/session/start`: start a scoring session
- `POST /api/session/process`: process one EEG batch
- `POST /api/session/end`: end session and return summary
- `POST /api/session/export`: export session summary/results to JSON

## Hardware Plan
- OpenBCI headset for EEG capture
- Jetson Nano for local inference and hosting

## Next Build Steps
1. Replace mock EEG batch generation with real OpenBCI stream input
2. Add calibration workflow per user
3. Train and validate model on labeled task data
4. Add persistent session history and export
