"""Machine learning model for lie/deception detection."""

import numpy as np

try:
    import backend.config as config
except ImportError:
    import config as config


class LieDetectorModel:
    """Heuristic model for deception-like stress scoring from EEG features."""

    def __init__(self, input_dim=config.FEATURE_DIM):
        """Initialize the model."""
        self.input_dim = input_dim
        self.model = "heuristic"

    def build_model(self):
        """Kept for interface compatibility."""
        self.model = "heuristic"

    def train(self, X_train, y_train, X_val=None, y_val=None, epochs=50, batch_size=32):
        """Kept for compatibility with planned ML training pipeline."""
        return {
            "status": "not_implemented",
            "message": "Heuristic mode active. Replace with trained model later.",
        }

    def predict(self, features):
        """Predict deception-like stress probability from extracted features."""
        vec = np.asarray(features, dtype=float).flatten()
        if vec.size < 11:
            return 0.5

        # Feature order from EEGProcessor.extract_features:
        # mean, std, max, min, rms, skewness, kurtosis, delta, theta, alpha, beta, gamma
        std = abs(vec[1])
        alpha = max(abs(vec[9]), 1e-6)
        beta = max(abs(vec[10]), 0.0)
        gamma = max(abs(vec[11]) if vec.size > 11 else 0.0, 0.0)

        beta_alpha_ratio = min(beta / alpha, 4.0) / 4.0
        gamma_alpha_ratio = min(gamma / alpha, 4.0) / 4.0
        normalized_variability = min(std / 25.0, 1.0)

        score = (
            0.50 * beta_alpha_ratio
            + 0.30 * gamma_alpha_ratio
            + 0.20 * normalized_variability
        )
        return float(np.clip(score, 0.0, 1.0))

    def save_model(self, path=config.MODEL_PATH):
        """No-op in heuristic mode."""
        return {"status": "skipped", "path": path, "mode": "heuristic"}

    def load_model(self, path=config.MODEL_PATH):
        """No-op in heuristic mode."""
        self.model = "heuristic"
