export async function onRequest(context) {
  const { request, env } = context;

  // 同域调用其实不需要 CORS，但加上更稳（未来可能 api.duanlian.xyz 调用）
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // GET /api/messages  -> 最新10条
  if (request.method === "GET") {
    const { results } = await env.DB
      .prepare("SELECT id, text, created_at FROM messages ORDER BY created_at DESC LIMIT 10")
      .all();

    return new Response(JSON.stringify({ ok: true, data: results }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // POST /api/messages -> 写入1条
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const text = (body?.text || "").trim();

    // 最小校验：1~50字
    if (!text || text.length > 50) {
      return new Response(JSON.stringify({ ok: false, error: "Text must be 1-50 chars" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const createdAt = Date.now();

    await env.DB
      .prepare("INSERT INTO messages (text, created_at) VALUES (?, ?)")
      .bind(text, createdAt)
      .run();

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
