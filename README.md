# NeuroHackathon 2026 - NeuroSignal Interview App

Real-time biosignal analysis app for desktop and mobile browsers, built for OpenBCI + LSL/serial backend.

## Live App
- Production URL: `https://neurrohackathon2026.vercel.app`
- Health check: `https://neurrohackathon2026.vercel.app/api/health`
- Deploy this repo on Vercel: `https://vercel.com/new/clone?repository-url=https://github.com/linglingms/neurrohackathon2026`

## Important Note
This project estimates stress and cognitive load from biosignals. It is not a validated forensic lie detector.

## Current Functionality
- `Start Interview` starts a live interview session.
- Browser microphone captures live speech-to-text captions.
- Transcript table columns:
	- `Role`
	- `Transcription`
	- `Node 1` .. `Node 8`
	- `Overall Confidence`
- Speaker role assignment supports:
	- `Auto Detect`
	- `Interviewer Speaking`
	- `Interviewee Speaking`
- `End Interview` stops capture and shows session summary.
- Scores are restricted to **Interviewee-only** + **OpenBCI data source**.

## Scoring Rules In App
- Interviewer speech is transcribed but does not change score/stat panels.
- Interviewee speech can update scoring only when data source is `OpenBCI`.
- During active sessions with OpenBCI connected, the app also pulls EEG windows continuously (~1 second interval) for live score updates.

## What Is In This Repo
- `backend/`: Flask API for sessions, EEG processing, and scoring
- `frontend/`: Mobile-friendly web dashboard
- `analysis.ipynb`: Notebook space for experiments

## Deploy (Vercel)

1. Open:

```bash
https://vercel.com/new/clone?repository-url=https://github.com/linglingms/neurrohackathon2026
```

2. Import the repository and click `Deploy`.

3. After deployment, open your app URL:

```bash
https://<your-vercel-project>.vercel.app
```

The default hosted API route is:

```bash
https://<your-vercel-project>.vercel.app/api/health
```

## Run On Localhost

1. Install backend dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

2. (Optional but recommended) set OpenBCI serial port:

```bash
export OPENBCI_PORT=/dev/cu.usbserial-XXXX
```

3. Start backend API:

```bash
source .venv/bin/activate
python -m backend.app
```

4. Start frontend static server:

```bash
cd frontend
python -m http.server 8080 --bind 0.0.0.0
```

5. Open local app:

```bash
http://localhost:8080/?api=http://localhost:5050/api
```

The frontend can also point to any API with `?api=<url>`.

## API Endpoints
- `GET /api/health`: service status
- `POST /api/session/start`: start a scoring session
- `POST /api/session/process`: process one EEG batch
- `POST /api/session/end`: end session and return summary
- `POST /api/session/export`: export session summary/results to JSON

## OpenBCI Troubleshooting
- If health shows `hardware_connected: false`, the board is not attached yet.
- Check serial devices on macOS:

```bash
ls /dev/cu.* | grep -Ei 'usb|serial|usbmodem|usbserial'
```

- Restart backend with correct port:

```bash
source .venv/bin/activate
OPENBCI_PORT=/dev/cu.<YOUR_DEVICE> python -m backend.app
```

- Verify connection:

```bash
curl http://localhost:5050/api/health
```

## Hardware Plan
- OpenBCI headset for EEG capture
- Laptop/desktop machine running the Python backend locally
