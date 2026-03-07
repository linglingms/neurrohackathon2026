import { getSession, buildReport } from "./utils.js";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = getSession();
  const report = buildReport(session);
  session.active = false;
  if (!report) {
    return res.status(200).json({
      session_started_at: session.startedAt,
      session_ended_at: new Date().toISOString(),
      total_windows: 0,
      deceptive_windows: 0,
      average_deception_probability: 0,
      session_assessment: "No session data captured",
    });
  }

  session.lastReport = report;
  return res.status(200).json(report);
}
