"""Flask API server for NeuroHackathon biosignal scoring."""

from flask import Flask, jsonify, request
from flask_cors import CORS
import logging
import os
import time

try:
    from backend.main import LieDetectorApp
    from backend.openbci_stream import OpenBCIStream
    import backend.config as config
except ModuleNotFoundError as exc:
    # Only fall back to local imports when package-style imports are unavailable.
    # Re-raise dependency errors (e.g., missing 'serial') so the real fix is visible.
    if exc.name and not exc.name.startswith('backend'):
        raise
    from main import LieDetectorApp
    from openbci_stream import OpenBCIStream
    import config as config

app = Flask(__name__)
CORS(app)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

detector = LieDetectorApp()
stream = OpenBCIStream(serial_port=config.SERIAL_PORT)
session_active = False
last_hardware_error = None

CONNECT_RETRY_ATTEMPTS = int(os.getenv('OPENBCI_CONNECT_RETRIES', '3'))
CONNECT_RETRY_DELAY_SEC = float(os.getenv('OPENBCI_CONNECT_RETRY_DELAY_SEC', '1.0'))


def _connect_with_retry(port, attempts=CONNECT_RETRY_ATTEMPTS, delay_sec=CONNECT_RETRY_DELAY_SEC):
    """Try opening the board multiple times to survive transient board-not-ready races."""
    last_error = None
    for attempt in range(1, max(1, attempts) + 1):
        try:
            logger.info(f"Hardware connect attempt {attempt}/{attempts} on {port}")
            stream.connect(port=port)
            return
        except Exception as exc:
            last_error = exc
            logger.warning(f"Hardware connect attempt {attempt} failed on {port}: {exc}")
            if attempt < attempts:
                time.sleep(delay_sec)

    if last_error is not None:
        raise last_error

# --- Auto-connect at startup ---
def _try_auto_connect():
    """Attempt to connect to the OpenBCI board on startup."""
    # First try the configured port
    try:
        logger.info(f"Auto-connect: trying configured port {stream.serial_port}...")
        stream.connect()
        logger.info(f"Auto-connect: SUCCESS on {stream.serial_port}")
        return
    except Exception as e:
        logger.warning(f"Auto-connect: configured port {stream.serial_port} failed: {e}")

    # Scan for likely OpenBCI ports and try each
    for candidate in OpenBCIStream.scan_ports():
        if candidate['port'] == stream.serial_port:
            continue  # already tried
        if not candidate['likely_openbci']:
            continue
        try:
            logger.info(f"Auto-connect: trying scanned port {candidate['port']}...")
            stream.connect(port=candidate['port'])
            logger.info(f"Auto-connect: SUCCESS on {candidate['port']}")
            return
        except Exception as e:
            logger.warning(f"Auto-connect: {candidate['port']} failed: {e}")

    logger.warning("Auto-connect: no OpenBCI board found — running in mock-data mode")

_try_auto_connect()


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'service': 'lie-detector-backend',
        'hardware_connected': stream.connected,
        'hardware_port': stream.serial_port if stream.connected else None,
        'session_active': session_active,
        'hardware_error': last_hardware_error,
    })


@app.route('/api/hardware/connect', methods=['POST', 'GET'])
def hardware_connect():
    global last_hardware_error
    if stream.connected:
        return jsonify({'status': 'already_connected', 'port': stream.serial_port})

    if request.method == 'GET':
        port = request.args.get('port', config.SERIAL_PORT)
    else:
        data = request.get_json(silent=True) or {}
        port = data.get('port', config.SERIAL_PORT)

    try:
        _connect_with_retry(port=port)
        last_hardware_error = None
        return jsonify({'status': 'connected', 'port': stream.serial_port, 'sampling_rate': stream.sampling_rate})
    except Exception as e:
        logger.error(f"Hardware connect failed: {e}")
        last_hardware_error = str(e)
        return jsonify({'error': str(e)}), 500


@app.route('/api/hardware/disconnect', methods=['POST'])
def hardware_disconnect():
    global last_hardware_error
    if not stream.connected:
        return jsonify({'status': 'already_disconnected'})
    stream.disconnect()
    last_hardware_error = None
    return jsonify({'status': 'disconnected'})


@app.route('/api/hardware/scan', methods=['GET'])
def hardware_scan():
    """Scan for available serial ports and flag likely OpenBCI devices."""
    ports = OpenBCIStream.scan_ports()
    return jsonify({'ports': ports, 'current_port': stream.serial_port, 'connected': stream.connected})


@app.route('/api/hardware/status', methods=['GET'])
def hardware_status():
    return jsonify({
        'connected': stream.connected,
        'port': stream.serial_port,
        'available_ports': stream.list_available_ports(),
        'board': 'Cyton+Daisy',
        'channels': config.EEG_CHANNELS,
        'sampling_rate': config.SAMPLING_RATE,
        'error': last_hardware_error,
    })


@app.route('/api/hardware/ports', methods=['GET'])
def hardware_ports():
    return jsonify({
        'configured_port': stream.serial_port,
        'available_ports': stream.list_available_ports(),
    })


@app.route('/api/session/start', methods=['POST'])
def start_session():
    # Start a new lie detection session
    global session_active
    detector.start_session()
    session_active = True
    return jsonify({'status': 'session_started', 'message': 'New session initialized', 'session_active': session_active})


@app.route('/api/session/status', methods=['GET'])
def session_status():
    return jsonify({
        'session_active': session_active,
        'hardware_connected': stream.connected,
    })


@app.route('/api/session/process', methods=['POST'])
def process_eeg():
    data = request.get_json(silent=True) or {}
    eeg_data = data.get('eeg_data')
    data_source = 'provided'

    if eeg_data is None:
        if stream.connected:
            # Pull one window of live data from the board (shape: 16 x WINDOW_SIZE*2)
            raw = stream.get_data(n_samples=config.WINDOW_SIZE * 2)
            eeg_data = raw.tolist()
            data_source = 'live'
        else:
            eeg_data = detector.generate_mock_eeg(
                n_channels=config.EEG_CHANNELS,
                n_samples=config.WINDOW_SIZE * 2,
                deceptive=bool(data.get('deceptive', False)),
            )
            data_source = 'mock'
            logger.warning("Processing mock EEG data — hardware not connected")

    result = detector.process_eeg_data(eeg_data)
    if result:
        result['data_source'] = data_source
        return jsonify(result)
    return jsonify({'error': 'No predictions made', 'data_source': data_source})


@app.route('/api/session/end', methods=['POST'])
def end_session():
    # End the session and get report
    global session_active
    report = detector.end_session()
    session_active = False
    return jsonify(report if report else {'error': 'No session data'})


@app.route('/api/session/export', methods=['POST'])
def export_session():
    export_result = detector.export_session()
    return jsonify(export_result if export_result else {'error': 'No session data to export'}), (200 if export_result else 400)


@app.route('/api/config', methods=['GET'])
def get_config():
    """Get configuration parameters."""
    return jsonify({
        'sampling_rate': config.SAMPLING_RATE,
        'eeg_channels': config.EEG_CHANNELS,
        'deception_threshold': config.DECEPTION_THRESHOLD,
        'window_size': config.WINDOW_SIZE,
    })


if __name__ == '__main__':
    logger.info('Starting Lie Detector API Server')
    # use_reloader=False prevents Flask from spawning a child process that
    # fights over the serial port with the parent.
    app.run(debug=True, use_reloader=False, host='0.0.0.0', port=int(os.getenv('PORT', '5050')))
