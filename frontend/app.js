const host = window.location.hostname || "localhost";
const params = new URLSearchParams(window.location.search);
const apiOverride = params.get("api");
const isLocalStatic = window.location.port === "8080" || host === "localhost" || host === "127.0.0.1";
const API_BASE_URL = apiOverride || (isLocalStatic ? `http://${host}:5050/api` : `${window.location.origin}/api`);

const state = {
    active: false,
    scores: [],
    lastResult: null,
    transcript: [],
};

const el = {
    health: document.getElementById("health-pill"),
    startBtn: document.getElementById("start-btn"),
    sampleBtn: document.getElementById("sample-btn"),
    endBtn: document.getElementById("end-btn"),
    exportBtn: document.getElementById("export-btn"),
    scoreValue: document.getElementById("score-value"),
    scoreBar: document.getElementById("score-bar"),
    statusText: document.getElementById("status-text"),
    windowsValue: document.getElementById("windows-value"),
    avgValue: document.getElementById("avg-value"),
    confidenceValue: document.getElementById("confidence-value"),
    reportBox: document.getElementById("report-box"),
    transcriptLog: document.getElementById("transcript-log"),
};

function renderTranscript() {
    if (!state.transcript.length) {
        el.transcriptLog.innerHTML = '<div class="transcript-empty">Transcript will appear after the interview starts.</div>';
        return;
    }

    const headerCells = ["Role", "Node 1", "Node 2", "Node 3", "Node 4", "Node 5", "Node 6", "Node 7", "Node 8", "Overall Confidence"];
    const headerHtml = headerCells.map((label) => `<th>${label}</th>`).join("");

    const rowsHtml = state.transcript
        .map((entry) => {
            const nodeCells = entry.nodes
                .map((value) => `<td class="node-cell">${formatPercentCell(value)}</td>`)
                .join("");

            return [
                "<tr>",
                `<td><span class="speaker speaker-${entry.speaker.toLowerCase()}">${entry.speaker}</span></td>`,
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
    renderTranscript();
}

function updateButtons() {
    el.startBtn.disabled = state.active;
    el.sampleBtn.disabled = !state.active;
    el.endBtn.disabled = !state.active;
    el.exportBtn.disabled = state.active;
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

async function checkHealth() {
    try {
        await api("/health");
        el.health.textContent = "API Online";
        el.health.className = "pill pill-ok";
    } catch (error) {
        el.health.textContent = "API Offline";
        el.health.className = "pill pill-bad";
    }
}

async function startSession() {
    let hardwareMessage = "";
    try {
        const hardware = await api("/hardware/connect", { method: "POST" });
        if (hardware && (hardware.status === "connected" || hardware.status === "already_connected")) {
            hardwareMessage = `Hardware: ${hardware.status.replace("_", " ")}`;
        }
    } catch (error) {
        hardwareMessage = "Hardware unavailable, using mock EEG data";
    }

    await api("/session/start", { method: "POST" });
    state.active = true;
    state.scores = [];
    state.lastResult = null;
    state.transcript = [];
    el.reportBox.textContent = hardwareMessage
        ? `Session started. ${hardwareMessage}. Run one or more samples.`
        : "Session started. Run one or more samples.";
    el.statusText.textContent = "Collecting baseline...";
    addTranscriptLine("Interviewer", "Interview has started. Please introduce yourself.");
    addTranscriptLine("Interviewee", "Hello, I am ready to begin the interview.");
    updateButtons();
}

async function runSample() {
    const result = await api("/session/process", {
        method: "POST",
        body: JSON.stringify({}),
    });
    state.lastResult = result;
    state.scores.push(result.deception_probability || 0);
    const scorePct = Math.round((result.deception_probability || 0) * 100);
    const metrics = {
        nodes: buildNodeStressPercentages(result),
        confidence: toPercent(result.confidence || 0),
    };
    addTranscriptLine("Interviewer", "Please describe your previous role and responsibilities.", metrics);
    addTranscriptLine("Interviewee", `Answer received. Current stress score marker: ${scorePct}%.`, metrics);
    updateSummary(result);
}

async function endSession() {
    const report = await api("/session/end", { method: "POST" });
    state.active = false;
    updateButtons();
    addTranscriptLine("Interviewer", "Thank you. This concludes the interview.");
    addTranscriptLine("Interviewee", "Thank you for your time.");
    el.reportBox.innerHTML = [
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
el.exportBtn.addEventListener("click", () => exportSession().catch((e) => (el.statusText.textContent = e.message)));

updateButtons();
renderTranscript();
checkHealth();
