import { parseCommand, type Command } from "@/lib/domain";
import { required } from "../config";
export async function command(
  text: string,
  listings: { id: string; name: string }[],
): Promise<Command> {
  const result = parseCommand(text, listings);
  if (result.intent !== "UNKNOWN" || !process.env.OPENAI_API_KEY) return result;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + required("OPENAI_API_KEY"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "Extract an intent only; never execute actions. Return JSON with intent BLOCK, INBOX, NAVIGATE or UNKNOWN. BLOCK requires listingId, from, to (ISO dates; to is exclusive). NAVIGATE requires page in calendar,inbox,cleaning,properties,automation,insights,settings,activity. INBOX optionally has platform and status. Only use listed listing IDs. Unknown or ambiguous dates must be UNKNOWN. Today: " +
            new Date().toISOString().slice(0, 10),
        },
        { role: "user", content: JSON.stringify({ text, listings }) },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 180,
    }),
    signal: AbortSignal.timeout(4500),
  });
  if (!response.ok) return { intent: "UNKNOWN" };
  const body = await response.json();
  try {
    const data = JSON.parse(body.choices?.[0]?.message?.content || "{}");
    if (
      data.intent === "BLOCK" &&
      listings.some((l) => l.id === data.listingId) &&
      /^\d{4}-\d{2}-\d{2}$/.test(data.from) &&
      /^\d{4}-\d{2}-\d{2}$/.test(data.to) &&
      data.to > data.from
    )
      return {
        intent: "BLOCK",
        listingId: data.listingId,
        from: data.from,
        to: data.to,
      };
    if (
      data.intent === "NAVIGATE" &&
      [
        "calendar",
        "inbox",
        "cleaning",
        "properties",
        "automation",
        "insights",
        "settings",
        "activity",
      ].includes(data.page)
    )
      return { intent: "NAVIGATE", page: data.page };
    if (data.intent === "INBOX") return { intent: "INBOX" };
    return { intent: "UNKNOWN" };
  } catch {
    return { intent: "UNKNOWN" };
  }
}
