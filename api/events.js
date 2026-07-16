const { createEvent, listEvents, readBody, sanitizeEvent, send, sendError } = require("./_aicoo");

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const events = await listEvents(req);
      return send(res, 200, { ok: true, events: events.map(sanitizeEvent) });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const event = await createEvent(req, body);
      return send(res, 201, { ok: true, event });
    }
    return send(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    return sendError(res, error);
  }
};
