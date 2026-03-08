# Main entry point for the NeuroHackathon Lie Detector App

import numpy as np
import logging
import json
from datetime import datetime
from pathlib import Path
from scipy import signal

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
        self.baseline_alpha_beta_ratio = None
        self._baseline_ratio_samples = []

    def start_session(self):
        # Start a new lie detection session
        logger.info("Starting new lie detection session")
        self.results = []
        self.last_report = None
        self.session_started_at = datetime.utcnow().isoformat() + "Z"
        self.baseline_alpha_beta_ratio = None
        self._baseline_ratio_samples = []

    @staticmethod
    def _band_power_from_psd(freqs, psd, low_hz, high_hz):
        mask = (freqs >= low_hz) & (freqs < high_hz)
        if not np.any(mask):
            return 0.0
        return float(np.trapz(psd[mask], freqs[mask]))

    def _alpha_beta_ratio(self, channel_data):
        filtered = self.processor.bandpass_filter(channel_data)
        filtered = self.processor.notch_filter(filtered)

        nperseg = min(len(filtered), max(config.WINDOW_SIZE, 64))
        freqs, psd = signal.welch(
            filtered,
            fs=config.SAMPLING_RATE,
            nperseg=nperseg,
            noverlap=nperseg // 2,
            scaling='density',
        )

        alpha_low, alpha_high = config.STRESS_ALPHA_BAND
        beta_low, beta_high = config.STRESS_BETA_BAND

        alpha_power = self._band_power_from_psd(freqs, psd, alpha_low, alpha_high)
        beta_power = self._band_power_from_psd(freqs, psd, beta_low, beta_high)

        eps = 1e-9
        ratio = alpha_power / max(beta_power, eps)
        total_power = alpha_power + beta_power
        return ratio, alpha_power, beta_power, total_power

    @staticmethod
    def _ratio_to_stress(current_ratio, baseline_ratio):
        eps = 1e-9
        normalized = current_ratio / max(baseline_ratio, eps)
        stress = 1.0 - normalized
        return float(np.clip(stress, 0.0, 1.0))

    def _compute_confidence(self, baseline_ratio, current_ratio, per_channel_stress, per_channel_power):
        eps = 1e-9

        # Signal confidence rises when current ratio meaningfully departs baseline.
        ratio_sep = abs(current_ratio - baseline_ratio) / max(baseline_ratio, eps)
        ratio_component = float(np.clip(ratio_sep / max(config.STRESS_CONFIDENCE_RATIO_SEP_REF, eps), 0.0, 1.0))

        # Agreement confidence rises when channel stress values are consistent.
        stress_std = float(np.std(per_channel_stress)) if per_channel_stress else 1.0
        agreement_component = 1.0 - float(np.clip(stress_std / max(config.STRESS_CONFIDENCE_STD_REF, eps), 0.0, 1.0))

        # Quality confidence rises with stronger alpha+beta signal power.
        mean_power = float(np.mean(per_channel_power)) if per_channel_power else 0.0
        power_component = float(np.clip(mean_power / max(config.STRESS_CONFIDENCE_POWER_REF, eps), 0.0, 1.0))

        # During baseline warmup confidence should be conservative.
        baseline_ready_component = 1.0 if self.baseline_alpha_beta_ratio is not None else 0.55

        confidence = (
            0.45 * ratio_component
            + 0.30 * agreement_component
            + 0.15 * power_component
            + 0.10 * baseline_ready_component
        )
        confidence = float(np.clip(confidence, 0.0, 1.0))

        return confidence, {
            'ratio_component': ratio_component,
            'agreement_component': agreement_component,
            'power_component': power_component,
            'baseline_ready_component': baseline_ready_component,
            'channel_stress_std': stress_std,
            'mean_band_power': mean_power,
        }

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

        channel_ratios = []
        channel_powers = []
        n_channels_for_stress = min(eeg_array.shape[0], 8)

        for channel_idx in range(n_channels_for_stress):
            channel_data = eeg_array[channel_idx]
            if len(channel_data) < 32:
                continue
            ratio, _, _, total_power = self._alpha_beta_ratio(channel_data)
            channel_ratios.append(float(ratio))
            channel_powers.append(float(total_power))

        if not channel_ratios:
            logger.warning("No valid channel ratios computed for stress scoring")
            return None

        current_ratio = float(np.mean(channel_ratios))

        if self.baseline_alpha_beta_ratio is None:
            self._baseline_ratio_samples.append(current_ratio)
            baseline_window_count = max(1, int(config.STRESS_BASELINE_WINDOWS))
            if len(self._baseline_ratio_samples) >= baseline_window_count:
                self.baseline_alpha_beta_ratio = float(np.mean(self._baseline_ratio_samples))

        baseline_ratio = (
            self.baseline_alpha_beta_ratio
            if self.baseline_alpha_beta_ratio is not None
            else float(np.mean(self._baseline_ratio_samples))
        )

        overall_stress = self._ratio_to_stress(current_ratio, baseline_ratio)
        node_stress = [self._ratio_to_stress(ratio, baseline_ratio) for ratio in channel_ratios]
        if len(node_stress) < 8:
            node_stress.extend([overall_stress] * (8 - len(node_stress)))
        else:
            node_stress = node_stress[:8]

        # Keep legacy model inference as supplemental metadata.
        legacy_predictions = []
        for channel_idx in range(eeg_array.shape[0]):
            channel_data = eeg_array[channel_idx]
            windows = self.processor.process_batch(channel_data)
            for window_features in windows:
                feature_vector = np.array(list(window_features.values()))
                legacy_predictions.append(float(self.model.predict(feature_vector)))

        confidence, confidence_details = self._compute_confidence(
            baseline_ratio=baseline_ratio,
            current_ratio=current_ratio,
            per_channel_stress=node_stress,
            per_channel_power=channel_powers,
        )
        result = {
            'deception_probability': overall_stress,
            'is_deceptive': bool(overall_stress > config.DECEPTION_THRESHOLD),
            'confidence': confidence,
            'predictions': [float(v) for v in node_stress],
            'windows_processed': len(legacy_predictions) if legacy_predictions else 1,
            'node_stress': [float(v) for v in node_stress],
            'node_labels': [f'Node {i}' for i in range(1, 9)],
            'alpha_beta_ratio_current': current_ratio,
            'alpha_beta_ratio_baseline': baseline_ratio,
            'baseline_ready': self.baseline_alpha_beta_ratio is not None,
            'legacy_model_probability': float(np.mean(legacy_predictions)) if legacy_predictions else None,
            'confidence_details': confidence_details,
        }

        self.results.append(result)
        return result

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
