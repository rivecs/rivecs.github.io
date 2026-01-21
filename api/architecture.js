// api/architecture.js
// Serverless function: POST /api/architecture
//
// What this endpoint does:
// - Accepts a directory tree / high-level description
// - Calls OpenAI via the Responses API (server-side, key stays secret)
// - Returns a strict, schema-shaped JSON object for the UI
//
// Works on Vercel (Node runtime). For other hosts, adapt the handler signature.

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Same-origin by default. If you’re hosting frontend + api separately, set CORS intentionally.
  res.end(JSON.stringify(data));
}

function pickJsonText(responseJson) {
  // Responses API returns an "output" array with message content items.
  // We want the first output_text chunk we can find.
  const out = Array.isArray(responseJson?.output) ? responseJson.output : [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") return c.text;
    }
  }
  // Fallback: sometimes you may also see response.output_text in SDK land.
  if (typeof responseJson?.output_text === "string") return responseJson.output_text;
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Method not allowed" });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) return send(res, 500, { error: "Missing OPENAI_API_KEY env var" });

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return send(res, 400, { error: e.message || "Invalid request body" });
  }

  const type = String(body.type || "tree");
  const content = String(body.content || "").trim();

  if (!content) return send(res, 400, { error: "content is required" });
  if (content.length > 9000) return send(res, 413, { error: "content too large" });

  const system = [
    "You are a senior software architect reviewing a codebase snapshot.",
    "",
    "Input represents a project structure or high-level description.",
    "Do NOT speculate beyond the provided input.",
    "Do NOT suggest rewrites or trendy tools.",
    "",
    "Return:",
    "- A concise architecture summary (max 3 sentences)",
    "- Detected architectural patterns (list)",
    "- 1–3 concrete strengths",
    "- Exactly ONE primary architectural risk",
    "- Exactly ONE realistic improvement",
    "",
    "Be neutral, precise, and practical.",
  ].join("\n");

  const user = [
    `Input type: ${type}`,
    "",
    "=== INPUT START ===",
    content,
    "=== INPUT END ===",
  ].join("\n");

  // Structured Outputs schema (Responses API uses text.format).
  // Ref: OpenAI Structured Outputs guide.
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "patterns", "strengths", "risk", "improvement"],
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 700 },
      patterns: {
        type: "array",
        minItems: 0,
        maxItems: 10,
        items: { type: "string", minLength: 1, maxLength: 80 },
      },
      strengths: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: { type: "string", minLength: 1, maxLength: 140 },
      },
      risk: { type: "string", minLength: 1, maxLength: 220 },
      improvement: { type: "string", minLength: 1, maxLength: 220 },
    },
  };

  const payload = {
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "architecture_snapshot",
        strict: true,
        schema,
      },
    },
    // Keep it tight. This is a snapshot, not a novel.
    max_output_tokens: 450,
    temperature: 0.2,
    // Optional: don't store by default. Flip this if you want audit trails.
    store: false,
  };

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    const j = await r.json().catch(() => null);

    if (!r.ok) {
      const msg = j?.error?.message || j?.message || `OpenAI request failed (${r.status})`;
      return send(res, 502, { error: msg });
    }

    const txt = pickJsonText(j);
    if (!txt) return send(res, 502, { error: "OpenAI response missing output_text" });

    let parsed;
    try {
      parsed = JSON.parse(txt);
    } catch {
      return send(res, 502, { error: "OpenAI returned non-JSON output" });
    }

    // Basic shape safety (don’t trust anything blindly).
    if (!parsed || typeof parsed !== "object") {
      return send(res, 502, { error: "OpenAI output invalid" });
    }

    return send(res, 200, {
      summary: parsed.summary || "",
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
      risk: parsed.risk || "",
      improvement: parsed.improvement || "",
    });
  } catch (e) {
    return send(res, 500, { error: e.message || "Server error" });
  }
};
