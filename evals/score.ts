import { warrantsAttention } from "@/lib/alerting";
import type { CallSummary } from "@/lib/claude";
import type { EvalCase } from "./cases";

/** Categories of failure, so metrics can select on a tag instead of sniffing prose. */
export type FailureKind = "medication" | "concern" | "false-alarm" | "request" | "mood";

export interface CaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  /** Parallel to `failures`. medicationAccuracy previously filtered on whether the message
   *  text contained "med", which quietly depended on spelling: "confirmed" happens to end
   *  in m-e-d and was excluded, while "expected X reported missed" was not — so a run that
   *  failed to report every missed medication still scored 100% medication accuracy. That
   *  is the dangerous direction: an unreported missed dose is the family being told all is
   *  well when it isn't. */
  kinds: FailureKind[];
}

export interface Report {
  results: CaseResult[];
  total: number;
  passed: number;
  /** Of the cases that should have raised a concern, how many did. Missing these is the dangerous direction. */
  concernRecall: number;
  /** Of the cases that should NOT have raised a concern, how many wrongly did. This is what burns out caregivers. */
  falseAlarmRate: number;
  medicationAccuracy: number;
  /** Share of outputs whose mood came back "unknown" — normalize()'s default for a
   *  malformed or empty model response. wouldAlert treats "unknown" as alerting, so a run
   *  where every call returned garbage scores perfect recall. A high value here means the
   *  metrics above are measuring parse failures, not judgement. */
  unknownMoodRate: number;
}

function contains(list: string[], name: string): boolean {
  const target = name.toLowerCase();
  return list.some((item) => {
    const got = item.toLowerCase();
    return got.includes(target) || target.includes(got);
  });
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

/**
 * Whether the family actually gets told — mirrors `hasConcern` in the webhook.
 *
 * Scoring the `concerns` array alone measured something narrower than the real decision:
 * a transcript where the parent plainly refuses a medication is escalated in production
 * because meds_missed is non-empty, even if the model leaves `concerns` empty. Judging
 * the pipeline by a field rather than by its outcome produced a "failure" for behaviour
 * that is correct end to end.
 */
function wouldAlert(output: CallSummary): boolean {
  // Delegates to production's own rule rather than restating it — a hand-kept copy here
  // would let the suite pass while the thing it claims to measure had changed.
  return warrantsAttention({ urgent: output.urgent === true, concerns: output.concerns, medsMissed: output.meds_missed, mood: output.mood });
}

/** Scores one model output against what the case says must be true. */
export function scoreCase(testCase: EvalCase, output: CallSummary): CaseResult {
  const failures: string[] = [];
  const kinds: FailureKind[] = [];
  const fail = (kind: FailureKind, message: string) => {
    kinds.push(kind);
    failures.push(message);
  };
  const { expect } = testCase;

  for (const med of expect.medsConfirmed ?? []) {
    if (!contains(output.meds_confirmed, med)) fail("medication", `expected ${med} confirmed`);
  }
  for (const med of expect.medsMissed ?? []) {
    if (!contains(output.meds_missed, med)) fail("medication", `expected ${med} reported missed`);
  }
  // An explicitly empty expectation is an assertion that nothing was invented.
  if (expect.medsConfirmed?.length === 0 && output.meds_confirmed.length > 0) {
    fail("medication", `hallucinated confirmed meds: ${output.meds_confirmed.join(", ")}`);
  }
  if (expect.medsMissed?.length === 0 && output.meds_missed.length > 0) {
    fail("medication", `hallucinated missed meds: ${output.meds_missed.join(", ")}`);
  }

  const alerted = wouldAlert(output);
  if (expect.anyConcern && !alerted) fail("concern", "family would NOT have been alerted, but should have been");
  if (!expect.anyConcern && alerted)
    fail("false-alarm", `false alarm: concerns=[${output.concerns.join(", ")}] missed=[${output.meds_missed.join(", ")}] mood=${output.mood}`);

  if (expect.concernMatches) {
    const blob = output.concerns.join(" ").toLowerCase();
    if (!expect.concernMatches.some((m) => blob.includes(m.toLowerCase()))) {
      fail(
        "concern",
        output.concerns.length === 0
          ? `no concern text reported at all (expected something matching: ${expect.concernMatches.join(" / ")})`
          : `concern reported but not the right one (got: ${output.concerns.join(", ")})`
      );
    }
  }

  if (expect.requestMatches) {
    const blob = output.requests.join(" ").toLowerCase();
    if (!expect.requestMatches.some((m) => blob.includes(m.toLowerCase()))) {
      fail("request", `request not captured (got: ${output.requests.join(", ") || "nothing"})`);
    }
  }

  if (expect.mood && !expect.mood.includes(output.mood)) {
    fail("mood", `mood ${output.mood} outside expected ${expect.mood.join("/")}`);
  }

  return { id: testCase.id, passed: failures.length === 0, failures, kinds };
}

export function buildReport(cases: EvalCase[], outputs: CallSummary[]): Report {
  const results = cases.map((c, i) => scoreCase(c, outputs[i]));

  const shouldConcern = cases.filter((c) => c.expect.anyConcern);
  const caughtConcern = shouldConcern.filter((c) => wouldAlert(outputs[cases.indexOf(c)]));
  const shouldNotConcern = cases.filter((c) => !c.expect.anyConcern);
  const falseAlarms = shouldNotConcern.filter((c) => wouldAlert(outputs[cases.indexOf(c)]));

  const medCases = cases.filter((c) => c.expect.medsConfirmed || c.expect.medsMissed);
  const medCorrect = medCases.filter((c) => {
    const r = results[cases.indexOf(c)];
    return !r!.kinds.includes("medication");
  });

  return {
    results,
    total: cases.length,
    passed: results.filter((r) => r.passed).length,
    concernRecall: rate(caughtConcern.length, shouldConcern.length),
    falseAlarmRate: shouldNotConcern.length === 0 ? 0 : falseAlarms.length / shouldNotConcern.length,
    medicationAccuracy: rate(medCorrect.length, medCases.length),
    unknownMoodRate: outputs.length === 0 ? 0 : outputs.filter((o) => o.mood === "unknown").length / outputs.length,
  };
}
