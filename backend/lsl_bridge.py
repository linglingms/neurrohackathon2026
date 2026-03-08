"""BrainFlow -> LSL bridge for OpenBCI Cyton+Daisy.

Run this script to read live EEG from the headset and publish it as an
LSL stream that the Flask backend (or any other LSL consumer) can pick up.

Usage:
    python -m backend.lsl_bridge              # uses default COM port from config
    python -m backend.lsl_bridge --port COM5  # override serial port
"""

import argparse
import logging
import time

import numpy as np
from brainflow.board_shim import BoardShim, BrainFlowInputParams, BoardIds
from pylsl import StreamInfo, StreamOutlet

try:
    import backend.config as config
except ImportError:
    import config as config

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Channel labels for the 6-node deception-detection montage.
# Positions map to the first 6 Cyton+Daisy EEG channels.
NODE_LABELS = ["Pz", "Fz", "Cz", "FCz", "F3", "T7",
               "Ch7", "Ch8", "Ch9", "Ch10", "Ch11", "Ch12",
               "Ch13", "Ch14", "Ch15", "Ch16"]


def create_eeg_outlet(n_channels: int, srate: int) -> StreamOutlet:
    """Create an LSL StreamOutlet for EEG data."""
    info = StreamInfo(
        name="OpenBCIEEG",
        type="EEG",
        channel_count=n_channels,
        nominal_srate=srate,
        channel_format="float32",
        source_id="openbci-cyton-daisy-eeg",
    )

    # Attach channel metadata
    chns = info.desc().append_child("channels")
    for i in range(n_channels):
        label = NODE_LABELS[i] if i < len(NODE_LABELS) else f"Ch{i+1}"
        ch = chns.append_child("channel")
        ch.append_child_value("label", label)
        ch.append_child_value("unit", "microvolts")
        ch.append_child_value("type", "EEG")

    return StreamOutlet(info)


def create_aux_outlet(n_channels: int, srate: int) -> StreamOutlet:
    """Create an LSL StreamOutlet for accelerometer data."""
    info = StreamInfo(
        name="OpenBCIAUX",
        type="AUX",
        channel_count=n_channels,
        nominal_srate=srate,
        channel_format="float32",
        source_id="openbci-cyton-daisy-aux",
    )

    chns = info.desc().append_child("channels")
    for label in ["X", "Y", "Z"][:n_channels]:
        ch = chns.append_child("channel")
        ch.append_child_value("label", label)

    return StreamOutlet(info)


def run_bridge(serial_port: str | None = None) -> None:
    """Connect to OpenBCI via BrainFlow and publish data over LSL."""
    port = serial_port or config.SERIAL_PORT

    BoardShim.enable_board_logger()

    params = BrainFlowInputParams()
    params.serial_port = port

    board_id = BoardIds.CYTON_DAISY_BOARD.value
    board = BoardShim(board_id, params)

    eeg_channels = BoardShim.get_eeg_channels(board_id)
    accel_channels = BoardShim.get_accel_channels(board_id)
    srate = BoardShim.get_sampling_rate(board_id)

    logger.info(f"Connecting to Cyton+Daisy on {port}...")
    board.prepare_session()
    board.start_stream(450_000)  # ring buffer size
    logger.info(f"Streaming {len(eeg_channels)} EEG + {len(accel_channels)} AUX channels @ {srate} Hz")

    eeg_outlet = create_eeg_outlet(len(eeg_channels), srate)
    aux_outlet = create_aux_outlet(len(accel_channels), srate)

    logger.info("LSL outlets created — streams are now discoverable")

    try:
        while True:
            # Flush the BrainFlow buffer so we never re-send samples
            data = board.get_board_data()

            if data.shape[1] == 0:
                time.sleep(0.005)
                continue

            # Push EEG chunk
            eeg_data = data[eeg_channels]  # (16, N)
            eeg_chunk = eeg_data.T.tolist()  # list of N samples, each 16 values
            eeg_outlet.push_chunk(eeg_chunk)

            # Push AUX chunk
            aux_data = data[accel_channels]  # (3, N)
            aux_chunk = aux_data.T.tolist()
            aux_outlet.push_chunk(aux_chunk)

    except KeyboardInterrupt:
        logger.info("Stopping bridge...")
    finally:
        board.stop_stream()
        board.release_session()
        logger.info("BrainFlow session released")


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenBCI -> LSL bridge")
    parser.add_argument("--port", default=None, help="Serial port (e.g. COM4)")
    args = parser.parse_args()
    run_bridge(serial_port=args.port)


if __name__ == "__main__":
    main()
