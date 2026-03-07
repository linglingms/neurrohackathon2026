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

    el.transcriptLog.innerHTML = state.transcript
        .map(
            (entry) =>
                `<div class="transcript-entry">` +
                `<span class="speaker speaker-${entry.speaker.toLowerCase()}">${entry.speaker}:</span> ` +
                `<span class="transcript-line">${entry.text}</span>` +
                `</div>`
        )
        .join("");

    el.transcriptLog.scrollTop = el.transcriptLog.scrollHeight;
}

function addTranscriptLine(speaker, text) {
    state.transcript.push({ speaker, text });
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
    await api("/session/start", { method: "POST" });
    state.active = true;
    state.scores = [];
    state.lastResult = null;
    state.transcript = [];
    el.reportBox.textContent = "Session started. Run one or more samples.";
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
    addTranscriptLine("Interviewer", "Please describe your previous role and responsibilities.");
    addTranscriptLine("Interviewee", `Answer received. Current stress score marker: ${scorePct}%.`);
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
