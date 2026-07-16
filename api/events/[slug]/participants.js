const { createParticipant, listParticipants, readBody, send, sendError } = require("../../_aicoo");

module.exports = async function handler(req, res) {
  const { slug } = req.query;
  try {
    if (req.method === "GET") {
      const participants = await listParticipants(req, slug);
      return send(res, 200, { ok: true, participants });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const { participant, updated } = await createParticipant(req, slug, body);
      return send(res, updated ? 200 : 201, { ok: true, participant, updated });
    }
    return send(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    return sendError(res, error);
  }
};
