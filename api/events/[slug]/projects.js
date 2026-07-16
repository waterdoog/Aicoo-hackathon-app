const { createProject, listProjects, readBody, send, sendError } = require("../../_aicoo");

module.exports = async function handler(req, res) {
  const { slug } = req.query;
  try {
    if (req.method === "GET") {
      const projects = await listProjects(req, slug);
      return send(res, 200, { ok: true, projects });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const { project, updated } = await createProject(req, slug, body);
      return send(res, updated ? 200 : 201, { ok: true, project, updated });
    }
    return send(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    return sendError(res, error);
  }
};
