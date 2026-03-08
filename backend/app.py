"""Flask + Socket.IO API server for NeuroHackathon biosignal scoring.

Supports two data modes:
  1. LSL mode (preferred): lsl_bridge.py publishes EEG over LSL; this server
     subscribes via StreamInlet and pushes scored results to the browser over
     Socket.IO in real time.
  2. Direct BrainFlow mode (legacy fallback): connects to the OpenBCI board
     directly and uses HTTP polling.
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_socketio import SocketIO
import logging
import os
import threading
import time

import numpy as np

try:
    from backend.main import LieDetectorApp
    from backend.openbci_stream import OpenBCIStream
    from backend.lsl_stream import LSLStream
    import backend.config as config
except ModuleNotFoundError as exc:
    if exc.name and not exc.name.startswith('backend'):
        raise
    from main import LieDetectorApp
    from openbci_stream import OpenBCIStream
    from lsl_stream import LSLStream
    import config as config

try:
    from pylsl import StreamInlet, resolve_byprop
    LSL_AVAILABLE = True
except ImportError:
    LSL_AVAILABLE = False

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

detector = LieDetectorApp()
serial_stream = OpenBCIStream(serial_port=config.SERIAL_PORT)
lsl_stream = LSLStream(
    stream_type=os.getenv('LSL_STREAM_TYPE', 'EEG'),
    stream_name=os.getenv('LSL_STREAM_NAME') or None,
    eeg_channels=config.EEG_CHANNELS,
    sampling_rate=config.SAMPLING_RATE,
)
session_active = False
last_hardware_error = None
lsl_connected = False
lsl_stream_name = None
audio_lsl_connected = False
audio_lsl_stream_name = None

CONNECT_RETRY_ATTEMPTS = int(os.getenv('OPENBCI_CONNECT_RETRIES', '3'))
CONNECT_RETRY_DELAY_SEC = float(os.getenv('OPENBCI_CONNECT_RETRY_DELAY_SEC', '1.0'))


def _connect_with_retry(port, attempts=CONNECT_RETRY_ATTEMPTS, delay_sec=CONNECT_RETRY_DELAY_SEC):
    """Try opening the board multiple times to survive transient board-not-ready races."""
    last_error = None
    for attempt in range(1, max(1, attempts) + 1):
        try:
            logger.info(f"Hardware connect attempt {attempt}/{attempts} on {port}")
            serial_stream.connect(port=port)
            return
        except Exception as exc:
            last_error = exc
            logger.warning(f"Hardware connect attempt {attempt} failed on {port}: {exc}")
            if attempt < attempts:
                time.sleep(delay_sec)

    if last_error is not None:
        raise last_error


def _active_stream():
    """Return (source, stream_obj) for the currently connected live source."""
    if lsl_stream.connected:
        return 'lsl', lsl_stream
    if serial_stream.connected:
        return 'serial', serial_stream
    return None, None


def _active_port_label():
    source, stream_obj = _active_stream()
    if source == 'lsl' and stream_obj:
        return f"LSL:{stream_obj.active_stream_name or 'EEG'}"
    if source == 'serial' and stream_obj:
        return stream_obj.serial_port
    return None


def _lsl_status_payload(timeout=0.3):
    """Return a consistent LSL status shape for API responses."""
    return {
        'lsl_connected': lsl_stream.connected,
        'lsl_stream_name': lsl_stream.active_stream_name,
        'available_lsl_streams': lsl_stream.available_streams(timeout=timeout),
    }


# ---------------------------------------------------------------------------
# LSL consumer thread -- reads EEG from LSL and pushes scored results via WS
# ---------------------------------------------------------------------------
_lsl_thread = None
_lsl_stop = threading.Event()
_audio_thread = None
_audio_stop = threading.Event()


def _lsl_consumer_loop():
    """Background thread: resolve an LSL EEG stream, pull chunks, score, emit."""
    global lsl_connected, lsl_stream_name

    logger.info("LSL consumer: resolving EEG stream...")
    while not _lsl_stop.is_set():
        streams = resolve_byprop("type", "EEG", timeout=2.0)
        if streams:
            break
        logger.info("LSL consumer: no EEG stream found yet, retrying...")
    else:
        logger.warning("LSL consumer: stopped before finding a stream")
        return

    inlet = StreamInlet(streams[0], max_chunklen=32)
    info = inlet.info()
    srate = int(info.nominal_srate())
    n_ch = info.channel_count()
    lsl_stream_name = info.name()
    lsl_connected = True
    logger.info(f"LSL consumer: connected to '{lsl_stream_name}' ({n_ch} ch @ {srate} Hz)")

    # Emit connection event to browser
    socketio.emit("hardware_status", {
        "connected": True,
        "source": "lsl",
        "stream_name": lsl_stream_name,
        "channels": n_ch,
        "srate": srate,
    })

    # Accumulation buffer -- collect ~1 second of data before scoring
    buffer = np.zeros((n_ch, 0))
    window_samples = config.WINDOW_SIZE * 2  # same as the HTTP endpoint uses

    while not _lsl_stop.is_set():
        samples, timestamps = inlet.pull_chunk(timeout=0.05, max_samples=64)

        if not timestamps:
            continue

        chunk = np.array(samples).T  # (n_ch, n_samples)
        buffer = np.hstack([buffer, chunk])

        # Once we have enough data, score and emit
        if buffer.shape[1] >= window_samples:
            eeg_data = buffer[:, :window_samples].tolist()
            buffer = buffer[:, window_samples:]  # keep remainder

            if session_active:
                result = detector.process_eeg_data(eeg_data)
                if result:
                    result["data_source"] = "lsl"
                    result["server_timestamp_ms"] = int(time.time() * 1000)
                    socketio.emit("eeg_score", result)

    lsl_connected = False
    logger.info("LSL consumer: stopped")


def _resolve_audio_stream(timeout=2.0):
    """Resolve an LSL audio stream from configurable type list and optional name."""
    stream_types = [
        value.strip() for value in os.getenv("LSL_AUDIO_STREAM_TYPES", "Audio,AUDIO").split(",") if value.strip()
    ]
    preferred_name = os.getenv("LSL_AUDIO_STREAM_NAME")

    for stream_type in stream_types:
        streams = resolve_byprop("type", stream_type, timeout=timeout)
        if not streams:
            continue
        if preferred_name:
            for stream in streams:
                if stream.name() == preferred_name:
                    return stream
        return streams[0]

    return None


def _audio_consumer_loop():
    """Background thread: pull LSL audio chunks and emit timeline levels."""
    global audio_lsl_connected, audio_lsl_stream_name

    logger.info("Audio LSL consumer: resolving stream...")
    stream = None
    while not _audio_stop.is_set() and stream is None:
        stream = _resolve_audio_stream(timeout=2.0)
        if stream is None:
            logger.info("Audio LSL consumer: no audio stream found yet, retrying...")

    if stream is None:
        logger.warning("Audio LSL consumer: stopped before finding a stream")
        return

    inlet = StreamInlet(stream, max_chunklen=256)
    info = inlet.info()
    audio_lsl_stream_name = info.name()
    audio_lsl_connected = True

    socketio.emit("audio_status", {
        "connected": True,
        "stream_name": audio_lsl_stream_name,
        "srate": int(info.nominal_srate()),
        "channels": info.channel_count(),
    })

    logger.info(
        "Audio LSL consumer: connected to '%s' (%s ch @ %s Hz)",
        audio_lsl_stream_name,
        info.channel_count(),
        int(info.nominal_srate()),
    )

    while not _audio_stop.is_set():
        samples, timestamps = inlet.pull_chunk(timeout=0.1, max_samples=256)
        if not timestamps:
            continue

        arr = np.asarray(samples, dtype=np.float32)
        if arr.size == 0:
            continue

        # RMS amplitude is a compact and robust audio activity signal.
        rms = float(np.sqrt(np.mean(np.square(arr))))
        peak = float(np.max(np.abs(arr)))
        socketio.emit("audio_level", {
            "server_timestamp_ms": int(time.time() * 1000),
            "lsl_timestamp": float(timestamps[-1]),
            "rms": rms,
            "peak": peak,
            "n_samples": int(arr.shape[0]),
            "stream_name": audio_lsl_stream_name,
        })

    audio_lsl_connected = False
    socketio.emit("audio_status", {
        "connected": False,
        "stream_name": audio_lsl_stream_name,
    })
    logger.info("Audio LSL consumer: stopped")


def start_lsl_consumer():
    """Start the background LSL reader thread (idempotent)."""
    global _lsl_thread
    if _lsl_thread and _lsl_thread.is_alive():
        return  # already running

    _lsl_stop.clear()
    _lsl_thread = threading.Thread(target=_lsl_consumer_loop, daemon=True)
    _lsl_thread.start()
    logger.info("LSL consumer thread started")


def stop_lsl_consumer():
    """Signal the LSL reader thread to stop."""
    global lsl_connected
    _lsl_stop.set()
    lsl_connected = False


def start_audio_consumer():
    """Start background LSL audio reader thread (idempotent)."""
    global _audio_thread
    if _audio_thread and _audio_thread.is_alive():
        return

    _audio_stop.clear()
    _audio_thread = threading.Thread(target=_audio_consumer_loop, daemon=True)
    _audio_thread.start()
    logger.info("Audio LSL consumer thread started")


def stop_audio_consumer():
    _audio_stop.set()


# ---------------------------------------------------------------------------
# Auto-connect at startup -- try LSL first, then serial, plus LSL consumer
# ---------------------------------------------------------------------------
def _try_auto_connect():
    """Attempt to connect to live source on startup (LSL first, serial fallback)."""
    if os.getenv('LSL_AUTOCONNECT', 'true').lower() in ('1', 'true', 'yes', 'on'):
        try:
            logger.info("Auto-connect: trying LSL stream...")
            lsl_stream.connect()
            logger.info("Auto-connect: LSL SUCCESS on %s", lsl_stream.active_stream_name)
            return
        except Exception as e:
            logger.warning("Auto-connect: LSL failed: %s", e)

    # Fallback to serial board.
    try:
        logger.info(f"Auto-connect: trying configured port {serial_stream.serial_port}...")
        serial_stream.connect()
        logger.info(f"Auto-connect: SUCCESS on {serial_stream.serial_port}")
        return
    except Exception as e:
        logger.warning(f"Auto-connect: configured port {serial_stream.serial_port} failed: {e}")

    for candidate in OpenBCIStream.scan_ports():
        if candidate['port'] == serial_stream.serial_port:
            continue  # already tried
        if not candidate['likely_openbci']:
            continue
        try:
            logger.info(f"Auto-connect: trying scanned port {candidate['port']}...")
            serial_stream.connect(port=candidate['port'])
            logger.info(f"Auto-connect: SUCCESS on {candidate['port']}")
            return
        except Exception as e:
            logger.warning(f"Auto-connect: {candidate['port']} failed: {e}")

    logger.warning("Auto-connect: no OpenBCI board found via direct serial")


# Try direct connection first; also start LSL consumer in parallel so it
# picks up the stream if lsl_bridge.py is running separately.
_try_auto_connect()
if LSL_AVAILABLE:
    start_lsl_consumer()
    if os.getenv('LSL_AUDIO_ENABLE', 'true').lower() in ('1', 'true', 'yes', 'on'):
        start_audio_consumer()


# ---------------------------------------------------------------------------
# Socket.IO events
# ---------------------------------------------------------------------------
@socketio.on("connect")
def on_ws_connect():
    logger.info("WebSocket client connected")
    source, _ = _active_stream()
    socketio.emit("hardware_status", {
        "connected": bool(source) or lsl_connected,
        "source": "lsl" if lsl_connected else (source if source else "none"),
        "stream_name": lsl_stream_name,
    })
    socketio.emit("audio_status", {
        "connected": audio_lsl_connected,
        "stream_name": audio_lsl_stream_name,
    })


# ---------------------------------------------------------------------------
# REST API (kept for compatibility with existing frontend)
# ---------------------------------------------------------------------------
@app.route('/api/health', methods=['GET'])
def health():
    source, _ = _active_stream()
    lsl_status = _lsl_status_payload(timeout=0.2)
    return jsonify({
        'status': 'healthy',
        'service': 'lie-detector-backend',
        'hardware_connected': bool(source),
        'hardware_port': _active_port_label(),
        'hardware_source': source,
        **lsl_status,
        'audio_lsl_connected': audio_lsl_connected,
        'audio_lsl_stream_name': audio_lsl_stream_name,
        'session_active': session_active,
        'hardware_error': last_hardware_error,
    })


@app.route('/api/hardware/connect', methods=['POST', 'GET'])
def hardware_connect():
    global last_hardware_error
    source, _ = _active_stream()
    if source:
        return jsonify({'status': 'already_connected', 'port': _active_port_label(), 'source': source})

    if request.method == 'GET':
        mode = request.args.get('mode', 'auto').lower()
        port = request.args.get('port', config.SERIAL_PORT)
        stream_name = request.args.get('stream_name')
    else:
        data = request.get_json(silent=True) or {}
        mode = str(data.get('mode', 'auto')).lower()
        port = data.get('port', config.SERIAL_PORT)
        stream_name = data.get('stream_name')

    try:
        if mode in ('auto', 'lsl'):
            try:
                lsl_stream.connect(stream_name=stream_name)
                last_hardware_error = None
                return jsonify({
                    'status': 'connected',
                    'port': _active_port_label(),
                    'source': 'lsl',
                    'sampling_rate': lsl_stream.sampling_rate,
                })
            except Exception as lsl_error:
                if mode == 'lsl':
                    raise lsl_error
                logger.warning('LSL connect failed in auto mode: %s', lsl_error)

        _connect_with_retry(port=port)
        last_hardware_error = None
        return jsonify({
            'status': 'connected',
            'port': _active_port_label(),
            'source': 'serial',
            'sampling_rate': serial_stream.sampling_rate,
        })
    except Exception as e:
        logger.error(f"Hardware connect failed: {e}")
        last_hardware_error = str(e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/hardware/disconnect', methods=['POST'])
def hardware_disconnect():
    global last_hardware_error
    source, _ = _active_stream()
    if not source:
        return jsonify({'status': 'already_disconnected'})
    if lsl_stream.connected:
        lsl_stream.disconnect()
    if serial_stream.connected:
        serial_stream.disconnect()
    last_hardware_error = None
    return jsonify({'status': 'disconnected'})


@app.route('/api/hardware/scan', methods=['GET'])
def hardware_scan():
    """Scan for available serial ports and visible LSL streams."""
    source, _ = _active_stream()
    ports = OpenBCIStream.scan_ports()
    lsl_streams = lsl_stream.available_streams(timeout=0.5)
    return jsonify({
        'ports': ports,
        'lsl_streams': lsl_streams,
        'current_port': _active_port_label() or serial_stream.serial_port,
        'connected': bool(source),
        'source': source,
    })


@app.route('/api/hardware/status', methods=['GET'])
def hardware_status():
    source, _ = _active_stream()
    lsl_status = _lsl_status_payload(timeout=0.5)
    return jsonify({
        'connected': bool(source),
        'source': source,
        'port': _active_port_label() or serial_stream.serial_port,
        'available_ports': serial_stream.list_available_ports(),
        **lsl_status,
        'board': 'Cyton+Daisy',
        'channels': config.EEG_CHANNELS,
        'sampling_rate': config.SAMPLING_RATE,
        'error': last_hardware_error,
    })


@app.route('/api/hardware/lsl/status', methods=['GET'])
def lsl_status():
    source, _ = _active_stream()
    payload = _lsl_status_payload(timeout=0.5)
    payload.update({
        'connected': bool(source),
        'source': source,
        'audio_lsl_connected': audio_lsl_connected,
        'audio_lsl_stream_name': audio_lsl_stream_name,
        'hardware_error': last_hardware_error,
    })
    return jsonify(payload)


@app.route('/api/hardware/ports', methods=['GET'])
def hardware_ports():
    return jsonify({
        'configured_port': serial_stream.serial_port,
        'available_ports': serial_stream.list_available_ports(),
        'available_lsl_streams': lsl_stream.available_streams(timeout=0.5),
    })


@app.route('/api/session/start', methods=['POST'])
def start_session():
    global session_active
    detector.start_session()
    session_active = True
    # Notify WebSocket clients
    socketio.emit("session_status", {"active": True})
    return jsonify({'status': 'session_started', 'message': 'New session initialized', 'session_active': session_active})


@app.route('/api/session/status', methods=['GET'])
def session_status():
    source, _ = _active_stream()
    return jsonify({
        'session_active': session_active,
        'hardware_connected': bool(source),
        'hardware_source': source,
    })


@app.route('/api/session/process', methods=['POST'])
def process_eeg():
    """HTTP fallback for scoring -- used when LSL/Socket.IO isn't available."""
    data = request.get_json(silent=True) or {}
    eeg_data = data.get('eeg_data')
    data_source = 'provided'

    if eeg_data is None:
        source, active = _active_stream()
        if active:
            # Pull one window of live data from active source (LSL or serial).
            raw = active.get_data(n_samples=config.WINDOW_SIZE * 2)
            eeg_data = raw.tolist()
            data_source = f'live_{source}'
        else:
            eeg_data = detector.generate_mock_eeg(
                n_channels=config.EEG_CHANNELS,
                n_samples=config.WINDOW_SIZE * 2,
                deceptive=bool(data.get('deceptive', False)),
            )
            data_source = 'mock'
            logger.warning("Processing mock EEG data -- hardware not connected")

    result = detector.process_eeg_data(eeg_data)
    if result:
        result['data_source'] = data_source
        result['server_timestamp_ms'] = int(time.time() * 1000)
        return jsonify(result)
    return jsonify({'error': 'No predictions made', 'data_source': data_source})


@app.route('/api/session/end', methods=['POST'])
def end_session():
    global session_active
    report = detector.end_session()
    session_active = False
    socketio.emit("session_status", {"active": False})
    return jsonify(report if report else {'error': 'No session data'})


@app.route('/api/session/export', methods=['POST'])
def export_session():
    export_result = detector.export_session()
    return jsonify(export_result if export_result else {'error': 'No session data to export'}), (200 if export_result else 400)


@app.route('/api/config', methods=['GET'])
def get_config():
    return jsonify({
        'sampling_rate': config.SAMPLING_RATE,
        'eeg_channels': config.EEG_CHANNELS,
        'deception_threshold': config.DECEPTION_THRESHOLD,
        'window_size': config.WINDOW_SIZE,
    })


if __name__ == '__main__':
    logger.info('Starting Lie Detector API Server (Socket.IO enabled)')
    socketio.run(app, host='0.0.0.0', port=int(os.getenv('PORT', '5050')),
                 debug=True, use_reloader=False, allow_unsafe_werkzeug=True)
