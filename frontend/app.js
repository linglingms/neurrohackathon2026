const host = window.location.hostname || "localhost";
const params = new URLSearchParams(window.location.search);
const apiOverride = params.get("api");
const isLocalStatic = window.location.port === "8080" || host === "localhost" || host === "127.0.0.1";

function normalizeApiBase(url) {
    if (!url) {
        return null;
    }

    const trimmed = url.replace(/\/+$/, "");
    return /\/api$/i.test(trimmed) ? trimmed : `${trimmed}/api`;
}

const API_BASE_URL = normalizeApiBase(apiOverride) || (isLocalStatic ? `http://${host}:5050/api` : `${window.location.origin}/api`);
const MAX_TRANSCRIPT_ROWS = 160;
const EEG_CAPTURE_INTERVAL_MS = 1000;
const STATUS_REFRESH_INTERVAL_MS = 5000;

const state = {
    active: false,
    scores: [],
    lastResult: null,
    transcript: [],
    requestInFlight: false,
    micEnabled: false,
    micListening: false,
    speechRecognition: null,
    lastAssignedRole: null,
    dataSource: "unknown",
    eegTimer: null,
    hardwareConnected: false,
    sessionActive: false,
};

const el = {
    health: document.getElementById("health-pill"),
    headsetStatus: document.getElementById("headset-status"),
    openbciStatus: document.getElementById("openbci-status"),
    micPill: document.getElementById("mic-pill"),
    startBtn: document.getElementById("start-btn"),
    sampleBtn: document.getElementById("sample-btn"),
    endBtn: document.getElementById("end-btn"),
    micBtn: document.getElementById("mic-btn"),
    speakerMode: document.getElementById("speaker-mode"),
    exportBtn: document.getElementById("export-btn"),
    scoreValue: document.getElementById("score-value"),
    scoreBar: document.getElementById("score-bar"),
    statusText: document.getElementById("status-text"),
    windowsValue: document.getElementById("windows-value"),
    avgValue: document.getElementById("avg-value"),
    confidenceValue: document.getElementById("confidence-value"),
    reportBox: document.getElementById("report-box"),
    transcriptLog: document.getElementById("transcript-log"),
    micCaption: document.getElementById("mic-caption"),
};

function setHeadsetStatus(connected) {
    if (!el.headsetStatus) {
        return;
    }

    const label = connected ? "Connected" : "Disconnected";
    const statusClass = connected ? "status-word status-word-ok" : "status-word status-word-bad";
    el.headsetStatus.innerHTML = `Headset: <span class="${statusClass}">${label}</span>`;
}

function setOpenBciStatus(started) {
    if (!el.openbciStatus) {
        return;
    }

    const label = started ? "Started" : "Not Started";
    const statusClass = started ? "status-word status-word-ok" : "status-word status-word-bad";
    el.openbciStatus.innerHTML = `OpenBCI Session: <span class="${statusClass}">${label}</span>`;
}

function updateConnectionStatus() {
    setHeadsetStatus(!!state.hardwareConnected);
    setOpenBciStatus(!!state.sessionActive);
}

function renderTranscript() {
    if (!state.transcript.length) {
        el.transcriptLog.innerHTML = '<div class="transcript-empty">Transcript will appear after the interview starts.</div>';
        return;
    }

    const headerCells = ["Role", "Transcription", "Node 1", "Node 2", "Node 3", "Node 4", "Node 5", "Node 6", "Node 7", "Node 8", "Overall Confidence"];
    const headerHtml = headerCells.map((label) => `<th>${label}</th>`).join("");

    const rowsHtml = state.transcript
        .map((entry) => {
            const nodeCells = entry.nodes
                .map((value) => `<td class="node-cell">${formatPercentCell(value)}</td>`)
                .join("");

            return [
                "<tr>",
                `<td><span class="speaker speaker-${entry.speaker.toLowerCase()}">${entry.speaker}</span></td>`,
                `<td class="transcription-cell">${entry.text}</td>`,
                nodeCells,
                `<td class="confidence-cell">${formatPercentCell(entry.confidence)}</td>`,
                "</tr>",
            ].join("");
        })
        .join("");

    el.transcriptLog.innerHTML = [
        '<table class="transcript-table">',
        `<thead><tr>${headerHtml}</tr></thead>`,
        `<tbody>${rowsHtml}</tbody>`,
        "</table>",
    ].join("");

    el.transcriptLog.scrollTop = el.transcriptLog.scrollHeight;
}

function formatPercentCell(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "--";
    }
    return `${Math.round(value)}%`;
}

function toPercent(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return null;
    }
    return Math.max(0, Math.min(100, value * 100));
}

function classifySpeaker(rawText) {
    const mode = el.speakerMode ? el.speakerMode.value : "auto";
    if (mode === "interviewer") {
        return "Interviewer";
    }
    if (mode === "interviewee") {
        return "Interviewee";
    }

    const text = (rawText || "").trim();
    const lower = text.toLowerCase();

    if (lower.startsWith("interviewer:") || lower.startsWith("question:")) {
        return "Interviewer";
    }
    if (lower.startsWith("interviewee:") || lower.startsWith("candidate:") || lower.startsWith("answer:")) {
        return "Interviewee";
    }

    const questionStarters = [
        "can you", "could you", "would you", "will you", "what", "why", "how", "when", "where", "who", "tell me", "describe", "explain",
    ];
    const answerStarters = [
        "i ", "my ", "in my", "we ", "our ", "yes", "no", "because", "sure", "absolutely", "honestly",
    ];
    const looksLikeQuestion = text.endsWith("?") || questionStarters.some((prefix) => lower.startsWith(prefix));
    const looksLikeAnswer = answerStarters.some((prefix) => lower.startsWith(prefix));

    if (looksLikeQuestion) {
        return "Interviewer";
    }
    if (looksLikeAnswer) {
        return "Interviewee";
    }

    // Fallback to conversational turn taking when auto mode is uncertain.
    if (state.lastAssignedRole === "Interviewer") {
        return "Interviewee";
    }
    if (state.lastAssignedRole === "Interviewee") {
        return "Interviewer";
    }

    return "Interviewer";
}

function normalizeTranscriptText(rawText) {
    return (rawText || "")
        .replace(/^\s*(interviewer|question|interviewee|candidate|answer)\s*:\s*/i, "")
        .trim();
}

function shouldScoreUtterance(speaker) {
    return speaker === "Interviewee" && state.dataSource === "openbci";
}

function buildNodeStressPercentages(result) {
    if (Array.isArray(result.node_stress) && result.node_stress.length >= 8) {
        return result.node_stress.slice(0, 8).map((value) => toPercent(value));
    }

    if (Array.isArray(result.predictions) && result.predictions.length > 0) {
        const values = result.predictions;
        const chunkSize = Math.max(1, Math.floor(values.length / 8));
        const nodes = [];

        for (let i = 0; i < 8; i += 1) {
            const start = i * chunkSize;
            const end = i === 7 ? values.length : Math.min(values.length, start + chunkSize);
            const chunk = values.slice(start, end);

            if (!chunk.length) {
                nodes.push(toPercent(result.deception_probability || 0));
                continue;
            }

            const average = chunk.reduce((acc, value) => acc + value, 0) / chunk.length;
            nodes.push(toPercent(average));
        }

        return nodes;
    }

    const overallPct = toPercent(result.deception_probability || 0);
    return new Array(8).fill(overallPct);
}

function addTranscriptLine(speaker, text, metrics = null) {
    const nodes = metrics && Array.isArray(metrics.nodes) && metrics.nodes.length === 8
        ? metrics.nodes
        : new Array(8).fill(null);
    const confidence = metrics && typeof metrics.confidence === "number" ? metrics.confidence : null;

    state.transcript.push({ speaker, text, nodes, confidence });
    state.lastAssignedRole = speaker;
    if (state.transcript.length > MAX_TRANSCRIPT_ROWS) {
        state.transcript = state.transcript.slice(-MAX_TRANSCRIPT_ROWS);
    }
    renderTranscript();
}

function getLatestMetrics() {
    if (!state.lastResult) {
        return null;
    }

    return {
        nodes: buildNodeStressPercentages(state.lastResult),
        confidence: toPercent(state.lastResult.confidence || 0),
    };
}

function updateMicUi() {
    if (!el.micPill || !el.micBtn) {
        return;
    }

    if (!state.micEnabled) {
        el.micPill.textContent = "Mic: Off";
        el.micPill.className = "pill mic-pill";
        el.micBtn.textContent = "Enable Microphone";
        return;
    }

    if (state.micListening) {
        el.micPill.textContent = "Mic: Listening";
        el.micPill.className = "pill mic-pill mic-pill-on";
        el.micBtn.textContent = "Disable Microphone";
    } else {
        el.micPill.textContent = "Mic: Enabled";
        el.micPill.className = "pill mic-pill mic-pill-idle";
        el.micBtn.textContent = "Disable Microphone";
    }
}

function stopEegCapture() {
    if (state.eegTimer) {
        clearInterval(state.eegTimer);
        state.eegTimer = null;
    }
}

async function captureEegWindow() {
    if (!state.active || state.dataSource !== "openbci" || state.requestInFlight) {
        return;
    }

    try {
        await scoreUtterance();
    } catch (error) {
        el.statusText.textContent = `EEG capture error: ${error.message}`;
    }
}

function startEegCapture() {
    stopEegCapture();
    if (state.dataSource !== "openbci") {
        return;
    }

    state.eegTimer = setInterval(() => {
        captureEegWindow();
    }, EEG_CAPTURE_INTERVAL_MS);
}

function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        return null;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
        state.micListening = true;
        updateMicUi();
    };

    recognition.onend = () => {
        state.micListening = false;
        updateMicUi();

        // Resume listening while active unless the user manually turned mic off.
        if (state.active && state.micEnabled) {
            setTimeout(() => {
                try {
                    recognition.start();
                } catch (error) {
                    // Ignore double-start timing races; browser will continue firing onend.
                }
            }, 150);
        }
    };

    recognition.onerror = (event) => {
        el.statusText.textContent = `Microphone error: ${event.error}`;
    };

    recognition.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const text = event.results[i][0].transcript.trim();
            if (event.results[i].isFinal) {
                const cleanedText = normalizeTranscriptText(text);
                const speaker = classifySpeaker(text);
                el.micCaption.textContent = `Mic transcript: ${cleanedText}`;

                if (!shouldScoreUtterance(speaker)) {
                    addTranscriptLine(speaker, cleanedText, null);
                    if (speaker === "Interviewer") {
                        el.statusText.textContent = "Interviewer speech captured; scores update only from interviewee OpenBCI data.";
                    } else if (state.dataSource !== "openbci") {
                        el.statusText.textContent = "Interviewee speech captured, waiting for OpenBCI data source.";
                    }
                    continue;
                }

                const metrics = getLatestMetrics();
                if (metrics) {
                    addTranscriptLine(speaker, cleanedText, metrics);
                } else {
                    scoreUtterance()
                        .then((freshMetrics) => {
                            addTranscriptLine(speaker, cleanedText, freshMetrics);
                        })
                        .catch((error) => {
                            el.statusText.textContent = `Scoring error: ${error.message}`;
                            addTranscriptLine(speaker, cleanedText, null);
                        });
                }
            } else {
                interim = text;
            }
        }

        if (interim) {
            el.micCaption.textContent = `Mic transcript (listening): ${interim}`;
        }
    };

    return recognition;
}

async function enableMic() {
    if (state.micEnabled) {
        return;
    }

    if (!state.speechRecognition) {
        state.speechRecognition = initSpeechRecognition();
    }
    if (!state.speechRecognition) {
        throw new Error("Speech recognition is not supported in this browser");
    }

    // Ask for microphone permission before starting recognition.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Microphone API not available in this browser");
    }

    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    media.getTracks().forEach((track) => track.stop());

    state.micEnabled = true;
    updateMicUi();

    if (state.active) {
        try {
            state.speechRecognition.start();
        } catch (error) {
            // Ignore duplicate starts if recognition is already running.
        }
    }
}

function disableMic() {
    state.micEnabled = false;
    state.micListening = false;
    if (state.speechRecognition) {
        state.speechRecognition.onend = null;
        try {
            state.speechRecognition.stop();
        } catch (error) {
            // No-op if recognition is not active.
        }
        state.speechRecognition = initSpeechRecognition();
    }
    el.micCaption.textContent = "Mic transcript: waiting...";
    updateMicUi();
}

async function toggleMic() {
    if (state.micEnabled) {
        disableMic();
        return;
    }
    await enableMic();
}

function updateButtons() {
    el.startBtn.disabled = state.active;
    el.sampleBtn.disabled = true;
    el.endBtn.disabled = !state.active;
    el.exportBtn.disabled = state.active;
    el.micBtn.disabled = false;
}

function updateSummary(result) {
    const scorePct = Math.round((result.deception_probability || 0) * 100);
    const confidencePct = Math.round((result.confidence || 0) * 100);
    const avg = state.scores.length
        ? Math.round((state.scores.reduce((a, b) => a + b, 0) / state.scores.length) * 100)
        : 0;

    el.scoreValue.textContent = `${scorePct}%`;
    el.scoreBar.style.width = `${scorePct}%`;
    el.scoreBar.textContent = `${scorePct}%`;
    el.windowsValue.textContent = String(state.scores.length);
    el.avgValue.textContent = `${avg}%`;
    el.confidenceValue.textContent = `${confidencePct}%`;

    el.statusText.textContent = result.is_deceptive
        ? "Likely elevated cognitive stress"
        : "Likely lower cognitive stress";
}

async function api(path, options = {}) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...options,
    });
    if (!response.ok) {
        throw new Error(`Request failed: ${path}`);
    }
    return response.json();
}

async function scoreUtterance() {
    const result = await api("/session/process", {
        method: "POST",
        body: JSON.stringify({}),
    });
    state.lastResult = result;
    state.scores.push(result.deception_probability || 0);
    updateSummary(result);

    return {
        nodes: buildNodeStressPercentages(result),
        confidence: toPercent(result.confidence || 0),
    };
}

function buildLocalSessionReport() {
    const total = state.scores.length;
    const deceptive = state.scores.filter((score) => score > 0.7).length;
    const avg = total ? state.scores.reduce((a, b) => a + b, 0) / total : 0;

    return {
        total_windows: total,
        deceptive_windows: deceptive,
        average_deception_probability: avg,
        session_assessment: total
            ? (avg > 0.7 ? "Likely Deceptive" : "Likely Truthful")
            : "No session data captured",
    };
}

async function checkHealth() {
    try {
        const health = await api("/health");
        el.health.textContent = "API Online";
        el.health.className = "pill pill-ok";

        if (typeof health.hardware_connected === "boolean") {
            state.hardwareConnected = health.hardware_connected;
        } else if (typeof health.connected === "boolean") {
            // Support older health payloads that use "connected".
            state.hardwareConnected = health.connected;
        }

        if (typeof health.session_active === "boolean") {
            state.sessionActive = health.session_active;
        }

        // Some deployments expose hardware and session details separately.
        if (typeof health.hardware_connected !== "boolean" && typeof health.connected !== "boolean") {
            try {
                const hardware = await api("/hardware/status");
                if (typeof hardware.connected === "boolean") {
                    state.hardwareConnected = hardware.connected;
                }
            } catch (error) {
                // Ignore when hardware route is not available (for hosted serverless APIs).
            }
        }

        if (typeof health.session_active !== "boolean") {
            try {
                const session = await api("/session/status");
                if (typeof session.session_active === "boolean") {
                    state.sessionActive = session.session_active;
                }
            } catch (error) {
                // Ignore when session status route is unavailable.
            }
        }

        updateConnectionStatus();
    } catch (error) {
        el.health.textContent = "API Offline";
        el.health.className = "pill pill-bad";
        state.hardwareConnected = false;
        state.sessionActive = false;
        updateConnectionStatus();
    }
}

async function startSession() {
    let hardwareMessage = "";
    try {
        const hardware = await api("/hardware/connect", { method: "POST" });
        if (hardware && (hardware.status === "connected" || hardware.status === "already_connected")) {
            hardwareMessage = `Hardware: ${hardware.status.replace("_", " ")}`;
            state.dataSource = "openbci";
            state.hardwareConnected = true;
        }
    } catch (error) {
        hardwareMessage = "Hardware unavailable, using mock EEG data";
        state.dataSource = "mock";
        state.hardwareConnected = false;
    }

    if (!hardwareMessage) {
        state.dataSource = "mock";
    }

    await api("/session/start", { method: "POST" });
    state.active = true;
    state.sessionActive = true;
    state.scores = [];
    state.lastResult = null;
    state.transcript = [];
    state.lastAssignedRole = null;
    state.requestInFlight = false;
    el.reportBox.textContent = hardwareMessage
        ? `Session started. ${hardwareMessage}. Listening for conversation...`
        : "Session started. Listening for conversation...";
    el.statusText.textContent = state.dataSource === "openbci"
        ? "Conversation capture active (interviewee OpenBCI scoring)"
        : "Conversation capture active (scores paused until OpenBCI source is connected)";

    if (!state.micEnabled) {
        try {
            await enableMic();
        } catch (error) {
            el.micCaption.textContent = "Mic transcript: microphone permission denied or unavailable";
        }
    }

    updateButtons();
    updateConnectionStatus();
    startEegCapture();
    if (state.micEnabled && state.speechRecognition) {
        try {
            state.speechRecognition.start();
        } catch (error) {
            // Ignore duplicate starts when already listening.
        }
    }
    el.statusText.textContent = state.dataSource === "openbci"
        ? "Conversation capture active (interviewee OpenBCI scoring)"
        : "Conversation capture active (scores paused until OpenBCI source is connected)";
}

async function runSample() {
    el.statusText.textContent = "Run Sample is disabled. Rows are now added only from recorded conversation.";
}

async function endSession() {
    state.active = false;
    state.sessionActive = false;
    stopEegCapture();
    if (state.speechRecognition && state.micListening) {
        try {
            state.speechRecognition.stop();
        } catch (error) {
            // No-op if recognition is already stopped.
        }
    }
    let report;
    try {
        report = await api("/session/end", { method: "POST" });
    } catch (error) {
        report = buildLocalSessionReport();
        report.session_assessment = "Interview ended locally (summary unavailable from API)";
    }

    if ((!report || report.total_windows === 0) && state.scores.length > 0) {
        report = buildLocalSessionReport();
    }

    const sourceLabel = state.dataSource === "openbci" ? "OpenBCI headset" : "Mock/demo signal";

    state.requestInFlight = false;
    updateButtons();
    updateConnectionStatus();
    el.reportBox.innerHTML = [
        `Data source: ${sourceLabel}`,
        `Total windows: ${report.total_windows}`,
        `Deceptive windows: ${report.deceptive_windows}`,
        `Average probability: ${(report.average_deception_probability * 100).toFixed(1)}%`,
        `Assessment: ${report.session_assessment}`,
    ].join("<br>");
}

async function exportSession() {
    const exported = await api("/session/export", { method: "POST" });
    el.reportBox.innerHTML = [
        `Export status: ${exported.status}`,
        `Saved file: ${exported.file}`,
        `Entries: ${exported.entries}`,
    ].join("<br>");
}

el.startBtn.addEventListener("click", () => startSession().catch((e) => (el.statusText.textContent = e.message)));
el.sampleBtn.addEventListener("click", () => runSample().catch((e) => (el.statusText.textContent = e.message)));
el.endBtn.addEventListener("click", () => endSession().catch((e) => (el.statusText.textContent = e.message)));
el.micBtn.addEventListener("click", () => toggleMic().catch((e) => (el.statusText.textContent = e.message)));
el.exportBtn.addEventListener("click", () => exportSession().catch((e) => (el.statusText.textContent = e.message)));
window.addEventListener("beforeunload", () => {
    stopEegCapture();
    if (state.speechRecognition && state.micListening) {
        try {
            state.speechRecognition.stop();
        } catch (error) {
            // No-op on unload.
        }
    }
});

updateButtons();
updateMicUi();
renderTranscript();
updateConnectionStatus();
checkHealth();
setInterval(() => {
    checkHealth();
}, STATUS_REFRESH_INTERVAL_MS);
