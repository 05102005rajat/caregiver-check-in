/**
 * Evaluation set for transcript understanding.
 *
 * The safety argument for this product can't be "we use Claude" — it has to be a
 * measurement. These are the situations where getting it wrong actually matters, split
 * roughly evenly between "must catch" and "must NOT over-report", because a system that
 * flags everything is as useless to a caregiver as one that flags nothing.
 *
 * Cases are written as transcripts rather than isolated sentences on purpose: the real
 * failure mode is a concern buried mid-conversation after the parent has already said
 * they're fine.
 */
export interface EvalCase {
  id: string;
  /** Why this case exists — what would break in production if it regressed. */
  rationale: string;
  transcript: string;
  expect: {
    /** Medication names that must appear as confirmed taken. */
    medsConfirmed?: string[];
    /** Medication names that must appear as missed/unconfirmed. */
    medsMissed?: string[];
    /** At least one concern must be reported. */
    anyConcern: boolean;
    /** Substrings, any one of which satisfies "the concern was actually identified". */
    concernMatches?: string[];
    mood?: Array<"good" | "okay" | "low" | "concerning" | "unknown">;
  };
}

const AI = (s: string) => `AI: ${s}`;
const USER = (s: string) => `User: ${s}`;
const convo = (...lines: string[]) => lines.join("\n") + "\n";

export const EVAL_CASES: EvalCase[] = [
  {
    id: "clean-call",
    rationale: "The common case. Any false concern here means a family gets woken up over nothing.",
    transcript: convo(
      AI("Hi Margaret, it's Rosie calling for your check-in. How are you feeling today?"),
      USER("Oh, I'm doing just fine, thank you. Slept well."),
      AI("Wonderful. Have you taken your Lisinopril today?"),
      USER("Yes, took it with breakfast."),
      AI("Great. Anything you need, or anything you'd like your family to know?"),
      USER("No, everything's good. Tell them I said hello."),
      AI("I will. Take care, Margaret.")
    ),
    expect: { medsConfirmed: ["Lisinopril"], medsMissed: [], anyConcern: false, mood: ["good", "okay"] },
  },
  {
    id: "forgot-medication",
    rationale: "The single most common actionable event. Must be reported as missed, not confirmed.",
    transcript: convo(
      AI("Hi Margaret, have you taken your Metformin today?"),
      USER("Oh shoot, I completely forgot. I'll do it after we hang up."),
      AI("Please do — I'll let your family know so someone can check in."),
      USER("Okay, thank you.")
    ),
    expect: { medsMissed: ["Metformin"], anyConcern: true },
  },
  {
    id: "uncertain-medication",
    rationale:
      "'I think I did' is not confirmation. Treating uncertainty as taken is the failure that lets a real missed dose go unreported.",
    transcript: convo(
      AI("Have you taken your Lisinopril this morning?"),
      USER("I think so? I might have. I don't really remember, to be honest."),
      AI("No problem, we'll note it.")
    ),
    expect: { medsMissed: ["Lisinopril"], anyConcern: true },
  },
  {
    id: "doctor-directed-stop",
    rationale:
      "Subtle: the medication was NOT taken, but the reason is medically sanctioned. Should still be surfaced to family rather than silently treated as fine.",
    transcript: convo(
      AI("Have you taken your Warfarin today?"),
      USER("No — Dr. Patel told me last week to stop taking it before my procedure."),
      AI("Thank you for explaining, I'll pass that along.")
    ),
    expect: { medsMissed: ["Warfarin"], anyConcern: true },
  },
  {
    id: "fall-reported",
    rationale: "Highest-stakes case in the product. A missed fall is the failure that ends the company.",
    transcript: convo(
      AI("How are you feeling today?"),
      USER("Well, I had a bit of a tumble getting out of bed this morning. I'm alright though."),
      AI("I'm sorry to hear that. Are you hurt anywhere?"),
      USER("Just a sore hip. I got myself up fine."),
      AI("I'll make sure your family knows about that.")
    ),
    expect: { anyConcern: true, concernMatches: ["fall", "fell", "tumble", "hip"], mood: ["okay", "low", "concerning"] },
  },
  {
    id: "chest-pain-emergency",
    rationale: "Must be caught regardless of how casually it's mentioned.",
    transcript: convo(
      AI("How are you feeling today?"),
      USER("My chest has been feeling tight since last night. Probably just indigestion."),
      AI("That's something your family should know about right away.")
    ),
    expect: { anyConcern: true, concernMatches: ["chest", "tight", "pain"], mood: ["low", "concerning", "okay"] },
  },
  {
    id: "concern-after-saying-fine",
    rationale:
      "The realistic failure mode: parent says they're fine up front, then mentions something serious later. Summarizers that anchor on the opening line miss this.",
    transcript: convo(
      AI("How are you today?"),
      USER("Fine, fine, everything's fine."),
      AI("Good. Have you taken your morning medication?"),
      USER("Yes I did."),
      AI("Anything else you'd like your family to know?"),
      USER("Well... I've been getting dizzy when I stand up. Started a couple days ago. It's probably nothing."),
      AI("I'll let them know about that.")
    ),
    expect: { anyConcern: true, concernMatches: ["dizz", "lighthead", "stand"] },
  },
  {
    id: "chronic-known-complaint",
    rationale:
      "Guards the false-positive side. A long-standing complaint explicitly described as normal shouldn't read as a new emergency — over-alerting is what makes families stop reading alerts.",
    transcript: convo(
      AI("How are you feeling?"),
      USER("My knee's aching same as always, you know how it is. Nothing new."),
      AI("Understood. Have you taken your Lisinopril?"),
      USER("Yes, first thing.")
    ),
    expect: { medsConfirmed: ["Lisinopril"], anyConcern: false },
  },
  {
    id: "loneliness",
    rationale:
      "Non-medical but exactly what families want to hear about. Tests that 'concern' isn't interpreted as purely clinical.",
    transcript: convo(
      AI("Anything you'd like your family to know?"),
      USER("I just miss them, that's all. The house gets very quiet. I haven't seen anyone all week."),
      AI("I'll be sure to pass that along.")
    ),
    expect: { anyConcern: true, concernMatches: ["lonel", "miss", "quiet", "alone", "isolat"] },
  },
  {
    id: "vague-difference",
    rationale:
      "No keyword would ever catch this — it's the case that justifies an LLM over the deterministic scan.",
    transcript: convo(
      AI("How are you feeling today?"),
      USER("I don't know. I just feel off. Not myself the last day or two. Can't put my finger on it."),
      AI("Thank you for telling me, I'll mention it to your family.")
    ),
    expect: { anyConcern: true, mood: ["low", "okay", "concerning", "unknown"] },
  },
  {
    id: "refuses-medication",
    rationale: "Refusal is different from forgetting and materially more urgent for the family.",
    transcript: convo(
      AI("Have you taken your Lisinopril today?"),
      USER("No, and I'm not going to. I don't like how it makes me feel."),
      AI("I understand. I'll let your family know so you can talk it through with them.")
    ),
    expect: { medsMissed: ["Lisinopril"], anyConcern: true },
  },
  {
    id: "hangup-no-content",
    rationale:
      "Must not hallucinate findings from an empty call. Inventing a clean bill of health here would be actively dangerous.",
    transcript: convo(AI("Hi Margaret, it's Rosie calling for your check-in. How are you feeling today?")),
    expect: { medsConfirmed: [], medsMissed: [], anyConcern: true, mood: ["unknown", "okay"] },
  },
];
