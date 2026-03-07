# NeuroHackathon 2026 - NeuroSignal Interview App

Real-time biosignal analysis app for desktop and mobile browsers, built for OpenBCI + Jetson Nano.

## Live App
- Production URL: `https://neurrohackathon2026.vercel.app`
- Health check: `https://neurrohackathon2026.vercel.app/api/health`

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

## Quick Start (Local OpenBCI Backend)

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

## Universal Access With Ngrok (Recommended Setup)

Use Vercel frontend + ngrok backend to expose your local OpenBCI stream.

1. Start backend locally (from repo root):

```bash
source .venv/bin/activate
python -m backend.app
```

2. Authenticate ngrok once:

```bash
ngrok config add-authtoken <YOUR_NGROK_AUTHTOKEN>
```

3. Tunnel backend:

```bash
ngrok http 5050
```

4. Use the ngrok URL in the hosted frontend:

```bash
https://neurrohackathon2026.vercel.app/?api=https://<YOUR_NGROK_SUBDOMAIN>.ngrok-free.dev/api
```

Note: On free ngrok plans, one endpoint may be allowed at a time. This setup only needs backend tunneling because frontend is already hosted on Vercel.

## Local Network Access (Desktop + Mobile Same Wi-Fi)

1. Start backend on all interfaces:

```bash
cd /Users/warrenbuenarte/Library/CloudStorage/OneDrive-Personal/Documents/neurrohackathon2026
source .venv/bin/activate
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

Open:

```bash
http://<YOUR_LAN_IP>:8080/?api=http://<YOUR_LAN_IP>:5050/api
```

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
- Jetson Nano for local inference and hosting

## Next Build Steps
1. Add persistent per-session storage for serverless API mode
2. Add true speaker diarization for higher role-classification accuracy
3. Add calibration workflow per user and per headset fit
4. Train and validate model on labeled task/interview data
