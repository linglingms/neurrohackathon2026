import { getSession, buildReport } from "./utils.js";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = getSession();
  const report = session.lastReport || buildReport(session);
  if (!report) {
    return res.status(400).json({ error: "No session data to export" });
  }

  return res.status(200).json({
    status: "exported",
    file: `vercel-memory/session_${Date.now()}.json`,
    entries: session.results.length,
    payload: { report, results: session.results },
  });
}
