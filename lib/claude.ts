import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface CallSummary {
  summary: string;
  meds_confirmed: string[];
  meds_missed: string[];
  concerns: string[];
  mood: "good" | "okay" | "low" | "concerning";
  appointments_acknowledged: string[];
}

const PROMPT_PREFIX = `You are analyzing a check-in call transcript with an elderly person.
Return ONLY a JSON object (no markdown fences, no commentary) with these fields:
- summary: 2-3 sentences for family, plain language, no medical jargon
- meds_confirmed: array of med names they confirmed taking
- meds_missed: array of med names they said they skipped
- concerns: array of short strings for anything worth flagging (fall, pain, confusion, loneliness, aide problem, scam call, not eating)
- mood: one of [good, okay, low, concerning]
- appointments_acknowledged: array of appointment titles they remembered

Transcript:
`;

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in Claude's response");
  return text.slice(start, end + 1);
}

export async function summarizeCall(transcript: string): Promise<CallSummary> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: PROMPT_PREFIX + transcript }],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return JSON.parse(extractJson(text)) as CallSummary;
}
