import { timingSafeEqual } from "node:crypto";
import { analyzeEmail, firstReplyDraft, inboundSchema } from "./core";
const MAX_BYTES = 500_000;
export async function handleIngestion(
  request: Request,
  config: {
    token?: string | undefined;
    liveEnabled: boolean;
    save?: (
      email: unknown,
      analysis: unknown,
      draft: unknown,
    ) => Promise<{ data: unknown; error: { message?: string } | null }>;
  },
) {
  if (!config.token || config.token.length < 32)
    return Response.json({ code: "NOT_CONFIGURED" }, { status: 503 });
  const bearer = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${config.token}`;
  const a = Buffer.from(bearer),
    b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ code: "INVALID_INPUT" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.length;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      return Response.json({ code: "TOO_LARGE" }, { status: 413 });
    }
    chunks.push(part.value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(merged));
  } catch {
    return Response.json({ code: "INVALID_INPUT" }, { status: 400 });
  }
  const parsed = inboundSchema.safeParse(input);
  if (!parsed.success) return Response.json({ code: "INVALID_INPUT" }, { status: 400 });
  const dryRun = new URL(request.url).searchParams.get("dryRun") !== "false";
  // No PII reflected into HTTP responses; dry-run performs no DB/AI/network operations.
  if (dryRun) {
    const analysis = analyzeEmail(parsed.data);
    return Response.json({
      dryRun: true,
      classification: analysis.classification,
      needsReview: true,
      priority: analysis.priority,
      draftStatus: "DRAFT",
      sendAllowed: false,
    });
  }
  if (!config.liveEnabled || !config.save)
    return Response.json({ code: "B2B_LIVE_MAIL_BLOCKED" }, { status: 503 });
  const analysis = analyzeEmail(parsed.data);
  const result = await config.save(parsed.data, analysis, firstReplyDraft(analysis, parsed.data));
  if (result.error)
    return Response.json(
      {
        code: result.error.message?.includes("B2B_RATE_LIMIT")
          ? "RATE_LIMIT"
          : "PERSISTENCE_FAILED",
      },
      { status: result.error.message?.includes("B2B_RATE_LIMIT") ? 429 : 503 },
    );
  return Response.json({ accepted: true, result: result.data }, { status: 200 });
}
