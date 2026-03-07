import { getSession } from "./session/utils.js";

export default function handler(req, res) {
  const session = getSession();
  res.status(200).json({
    status: "healthy",
    service: "lie-detector-backend",
    hardware_connected: false,
    session_active: !!session.active,
  });
}
