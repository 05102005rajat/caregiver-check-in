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
- meds_confirmed: array of med names they clearly confirmed already taking (or taking right now) during this call
- meds_missed: array of med names that were NOT clearly confirmed as taken — this includes explicitly skipping it, saying they'll take it later, deferring, making excuses, saying they can't find it, or refusing. Be inclusive here: if in doubt whether it was actually taken, count it as missed rather than confirmed.
- concerns: array of short strings for anything worth flagging (fall, pain, confusion, loneliness, aide problem, scam call, not eating)
- mood: one of [good, okay, low, concerning]
- appointments_acknowledged: array of appointment titles they remembered

Transcript:
`;

export function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in Claude's response");
  return text.slice(start, end + 1);
}

const MOODS: CallSummary["mood"][] = ["good", "okay", "low", "concerning"];

// Claude can truncate at max_tokens or drift from the requested shape; every field is
// defaulted so callers can trust the arrays/mood exist without their own validation.
export function normalize(raw: unknown): CallSummary {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

  return {
    summary: typeof obj.summary === "string" ? obj.summary : "",
    meds_confirmed: asStringArray(obj.meds_confirmed),
    meds_missed: asStringArray(obj.meds_missed),
    concerns: asStringArray(obj.concerns),
    mood: MOODS.includes(obj.mood as CallSummary["mood"]) ? (obj.mood as CallSummary["mood"]) : "okay",
    appointments_acknowledged: asStringArray(obj.appointments_acknowledged),
  };
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

  return normalize(JSON.parse(extractJson(text)));
}
