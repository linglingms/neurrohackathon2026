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

The frontend uses `http://localhost:5000/api` by default.

## API Endpoints
- `GET /api/health`: service status
- `POST /api/session/start`: start a scoring session
- `POST /api/session/process`: process one EEG batch
- `POST /api/session/end`: end session and return summary
- `POST /api/session/export`: export session summary/results to JSON
- `GET /api/openbci/status`: OpenBCI connection status
- `POST /api/openbci/connect`: connect to OpenBCI stream
- `POST /api/openbci/disconnect`: disconnect OpenBCI stream

## Hardware Plan
- OpenBCI headset for EEG capture
- Jetson Nano for local inference and hosting

## Next Build Steps
1. Replace mock EEG batch generation with real OpenBCI stream input
2. Add calibration workflow per user
3. Train and validate model on labeled task data
4. Add persistent session history and export
