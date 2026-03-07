import { getSession, buildReport } from "./utils.js";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = getSession();
  const report = buildReport(session);
  if (!report) {
    return res.status(400).json({ error: "No session data" });
  }

  session.lastReport = report;
  return res.status(200).json(report);
}
