# Main entry point for the NeuroHackathon Lie Detector App

import numpy as np
import logging
import json
from datetime import datetime
from pathlib import Path

try:
    from backend.eeg_processor import EEGProcessor
    from backend.model import LieDetectorModel
    import backend.config as config
except ImportError:
    # Allows running from backend/ as direct scripts.
    from eeg_processor import EEGProcessor
    from model import LieDetectorModel
    import config as config

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class LieDetectorApp:
    # Main application for real-time lie detection

    def __init__(self):
        # Initialize the lie detector application
        self.processor = EEGProcessor()
        self.model = LieDetectorModel()
        self.results = []
        self.session_started_at = None
        self.last_report = None

    def start_session(self):
        # Start a new lie detection session
        logger.info("Starting new lie detection session")
        self.results = []
        self.last_report = None
        self.session_started_at = datetime.utcnow().isoformat() + "Z"

    def process_eeg_data(self, eeg_data):
        # Process incoming EEG data and predict deception
        # Args: eeg_data - Array of shape (n_channels, n_samples)
        # Returns: Dictionary with predictions and metrics

        eeg_array = np.asarray(eeg_data, dtype=float)
        if eeg_array.ndim == 1:
            eeg_array = np.expand_dims(eeg_array, axis=0)
        if eeg_array.ndim != 2:
            logger.warning("Invalid EEG shape: %s", eeg_array.shape)
            return None

        predictions = []
        channel_averages = []

        for channel_idx in range(eeg_array.shape[0]):
            channel_data = eeg_array[channel_idx]
            windows = self.processor.process_batch(channel_data)
            channel_predictions = []

            for window_features in windows:
                feature_vector = np.array(list(window_features.values()))
                deception_prob = self.model.predict(feature_vector)
                predictions.append(deception_prob)
                channel_predictions.append(deception_prob)

            if channel_predictions:
                channel_averages.append(float(np.mean(channel_predictions)))

        if predictions:
            avg_probability = float(np.mean(predictions))
            is_deceptive = bool(avg_probability > config.DECEPTION_THRESHOLD)

            # Transcript UI expects eight nodes (Node 1..Node 8).
            if channel_averages:
                node_stress = channel_averages[:8]
                if len(node_stress) < 8:
                    node_stress.extend([avg_probability] * (8 - len(node_stress)))
            else:
                node_stress = [avg_probability] * 8

            result = {
                'deception_probability': avg_probability,
                'is_deceptive': is_deceptive,
                'confidence': float(max(avg_probability, 1 - avg_probability)),
                'predictions': [float(p) for p in predictions],
                'windows_processed': len(predictions),
                'node_stress': [float(v) for v in node_stress],
                'node_labels': [f'Node {i}' for i in range(1, 9)],
            }

            self.results.append(result)
            return result

        return None

    def generate_mock_eeg(self, n_channels=8, n_samples=500, deceptive=False):
        """Generate mock EEG for demos when hardware is not connected."""
        t = np.arange(n_samples) / float(config.SAMPLING_RATE)
        mock_channels = []

        for _ in range(n_channels):
            alpha = np.sin(2 * np.pi * 10 * t)
            beta = np.sin(2 * np.pi * 20 * t)
            noise = 0.2 * np.random.randn(n_samples)

            if deceptive:
                # Increase higher-frequency activity to simulate cognitive stress.
                channel = 0.4 * alpha + 1.1 * beta + noise
            else:
                channel = 1.0 * alpha + 0.4 * beta + noise

            mock_channels.append(channel)

        return np.array(mock_channels)

    def end_session(self):
        # End the session and generate report
        if not self.results:
            logger.warning("No results to report")
            return None

        avg_prob = np.mean([r['deception_probability'] for r in self.results])
        deception_count = sum(1 for r in self.results if r['is_deceptive'])
        
        report = {
            'session_started_at': self.session_started_at,
            'session_ended_at': datetime.utcnow().isoformat() + "Z",
            'total_windows': len(self.results),
            'deceptive_windows': deception_count,
            'average_deception_probability': avg_prob,
            'session_assessment': 'Likely Deceptive' if avg_prob > config.DECEPTION_THRESHOLD else 'Likely Truthful'
        }

        self.last_report = report
        logger.info(f"Session Report: {report}")
        return report

    def export_session(self, export_dir="exports"):
        """Export latest session report and frame-level results to JSON."""
        if not self.results:
            return None

        report = self.last_report or self.end_session()
        if report is None:
            return None

        root = Path(__file__).resolve().parents[1]
        export_path = root / export_dir
        export_path.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        output_file = export_path / f"session_{timestamp}.json"

        payload = {
            "report": report,
            "results": self.results,
        }

        with output_file.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)

        return {
            "status": "exported",
            "file": str(output_file),
            "entries": len(self.results),
        }


if __name__ == "__main__":
    app = LieDetectorApp()
    logger.info("Lie Detector App initialized successfully")
