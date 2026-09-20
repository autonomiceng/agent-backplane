const API = "http://server:3000/api/v1/workspaces/";

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function sourceLink(value, label) {
  if (value === null) return "";
  let url;
  try { url = new URL(value); } catch { throw new Error("source_url_invalid"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("source_url_invalid");
  return `<a href="${escapeHtml(url.href)}" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function render(row) {
  const points = Array.isArray(row.key_points) ? row.key_points : [];
  const metadata = row.analysis_metadata && typeof row.analysis_metadata === "object" ? row.analysis_metadata : {};
  const links = [sourceLink(row.video_url, "Video"), sourceLink(row.transcript_url, "Transcript")].filter(Boolean).join(" · ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(row.title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1rem;color:#17202a}header{border-bottom:1px solid #ccd1d1}small{color:#566573}li{margin:.45rem 0}a{color:#145a9c}</style></head><body><header><small>${row.fictional ? "Fixture" : "Real source"} · collected ${escapeHtml(metadata.collectionDate ?? "unknown")}</small><h1>${escapeHtml(row.title)}</h1><p>${escapeHtml((row.speakers ?? []).join(", "))}</p><p>${links}</p></header><main><h2>Digest</h2><p>${escapeHtml(row.digest_text)}</p><h2>Main points</h2><ul>${points.map(point => `<li>${escapeHtml(point)}</li>`).join("")}</ul></main><footer><small>Digest by ${escapeHtml(metadata.attribution ?? "Backplane analyst Principal")}. Vendor and speaker claims are summarized, not independently verified.</small></footer></body></html>`;
}

export default {
  async fetch(request, props) {
    const input = await request.json();
    if (!input || typeof input.sourceId !== "string" || !input.sourceId) return Response.json({ error: "source_id_required" }, { status: 422 });
    const headers = { authorization: `Bearer ${props.token}`, "x-backplane-run": props.runId, "content-type": "application/json" };
    const statement = "SELECT s.source_id,s.title,s.speakers,s.video_url,s.transcript_url,s.fictional,d.digest_text,d.key_points,d.analysis_metadata,d.completed_at FROM talk_sources s JOIN talk_digests d USING (source_id) WHERE s.source_id=$1 AND s.analysis_state='complete'";
    const response = await fetch(`${API}${props.workspaceId}/sql`, { method: "POST", headers, body: JSON.stringify({ statement, params: [input.sourceId] }) });
    if (!response.ok) return Response.json({ error: "workspace_read_failed", status: response.status }, { status: 502 });
    const result = await response.json(), row = result.rows?.[0];
    if (!row) return Response.json({ error: "digest_not_found" }, { status: 404 });
    return Response.json({ html: render(row), metadata: { sourceId: row.source_id, completedAt: row.completed_at, invocationRunId: props.runId } });
  },
};
