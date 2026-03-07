"""Flask API server for NeuroHackathon biosignal scoring."""

from flask import Flask, jsonify, request
from flask_cors import CORS
import logging
import os

try:
    from backend.main import LieDetectorApp
    from backend.openbci_stream import OpenBCIStream
    import backend.config as config
except ModuleNotFoundError:
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


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'service': 'lie-detector-backend',
        'hardware_connected': stream.connected,
        'session_active': session_active,
    })


@app.route('/api/hardware/connect', methods=['POST'])
def hardware_connect():
    if stream.connected:
        return jsonify({'status': 'already_connected', 'port': stream.serial_port})
    try:
        stream.connect()
        return jsonify({'status': 'connected', 'port': stream.serial_port, 'sampling_rate': stream.sampling_rate})
    except Exception as e:
        logger.error(f"Hardware connect failed: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/hardware/disconnect', methods=['POST'])
def hardware_disconnect():
    if not stream.connected:
        return jsonify({'status': 'already_disconnected'})
    stream.disconnect()
    return jsonify({'status': 'disconnected'})


@app.route('/api/hardware/status', methods=['GET'])
def hardware_status():
    return jsonify({
        'connected': stream.connected,
        'port': stream.serial_port,
        'board': 'Cyton+Daisy',
        'channels': config.EEG_CHANNELS,
        'sampling_rate': config.SAMPLING_RATE,
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

    if eeg_data is None:
        if stream.connected:
            # Pull one window of live data from the board (shape: 16 x WINDOW_SIZE*2)
            raw = stream.get_data(n_samples=config.WINDOW_SIZE * 2)
            eeg_data = raw.tolist()
        else:
            eeg_data = detector.generate_mock_eeg(
                n_channels=config.EEG_CHANNELS,
                n_samples=config.WINDOW_SIZE * 2,
                deceptive=bool(data.get('deceptive', False)),
            )

    result = detector.process_eeg_data(eeg_data)
    return jsonify(result if result else {'error': 'No predictions made'})


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
    app.run(debug=True, host='0.0.0.0', port=int(os.getenv('PORT', '5050')))
