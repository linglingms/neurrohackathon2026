"""OpenBCI stream wrapper with safe fallback behavior."""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np

try:
    from brainflow.board_shim import BoardShim, BrainFlowInputParams
except ImportError:  # pragma: no cover - optional at runtime
    BoardShim = None
    BrainFlowInputParams = None

logger = logging.getLogger(__name__)


class OpenBCIStream:
    """Handles live EEG acquisition from OpenBCI via BrainFlow."""

    def __init__(self, board_id: int = 1, serial_port: str = ""):
        self.board_id = board_id
        self.serial_port = serial_port
        self.board = None
        self.connected = False

    def connect(self) -> dict:
        if BoardShim is None or BrainFlowInputParams is None:
            return {
                "status": "unavailable",
                "message": "brainflow is not installed in this environment",
            }

        if self.connected:
            return {"status": "connected", "message": "already connected"}

        params = BrainFlowInputParams()
        if self.serial_port:
            params.serial_port = self.serial_port

        try:
            self.board = BoardShim(self.board_id, params)
            self.board.prepare_session()
            self.board.start_stream()
            self.connected = True
            return {"status": "connected", "board_id": self.board_id}
        except Exception as exc:  # pragma: no cover - depends on hardware
            logger.exception("Failed to connect OpenBCI stream")
            self.connected = False
            self.board = None
            return {"status": "error", "message": str(exc)}

    def disconnect(self) -> dict:
        if not self.connected or self.board is None:
            return {"status": "disconnected", "message": "already disconnected"}

        try:
            self.board.stop_stream()
            self.board.release_session()
        except Exception as exc:  # pragma: no cover - depends on hardware
            logger.warning("OpenBCI disconnect warning: %s", exc)

        self.board = None
        self.connected = False
        return {"status": "disconnected"}

    def status(self) -> dict:
        return {
            "connected": self.connected,
            "board_id": self.board_id,
            "serial_port": self.serial_port,
            "brainflow_available": BoardShim is not None,
        }

    def get_recent_eeg(self, n_samples: int = 500) -> Optional[np.ndarray]:
        """Return EEG channels as (n_channels, n_samples), or None if unavailable."""
        if not self.connected or self.board is None:
            return None

        try:
            data = self.board.get_current_board_data(n_samples)
            eeg_channels = BoardShim.get_eeg_channels(self.board_id)
            if data is None or len(eeg_channels) == 0:
                return None
            eeg = data[eeg_channels, :]
            if eeg.size == 0:
                return None
            return np.asarray(eeg, dtype=float)
        except Exception as exc:  # pragma: no cover - depends on hardware
            logger.warning("OpenBCI read warning: %s", exc)
            return None
