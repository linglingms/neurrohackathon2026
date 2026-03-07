"""Flask API server for NeuroHackathon biosignal scoring."""

from flask import Flask, jsonify, request
from flask_cors import CORS
import logging

try:
    from backend.main import LieDetectorApp
    import backend.config as config
except ImportError:
    # Allows running from backend/ as `python app.py`
    from main import LieDetectorApp
    import config as config

app = Flask(__name__)
CORS(app)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

detector = LieDetectorApp()


@app.route('/api/health', methods=['GET'])
def health():
    # Health check endpoint
    return jsonify({'status': 'healthy', 'service': 'lie-detector-backend'})


@app.route('/api/session/start', methods=['POST'])
def start_session():
    # Start a new lie detection session
    detector.start_session()
    return jsonify({'status': 'session_started', 'message': 'New session initialized'})


@app.route('/api/session/process', methods=['POST'])
def process_eeg():
    # Process EEG data. If missing, use mock data for quick demos.
    data = request.get_json(silent=True) or {}
    eeg_data = data.get('eeg_data')
    if eeg_data is None:
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
    report = detector.end_session()
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
    app.run(debug=True, host='0.0.0.0', port=5000)
