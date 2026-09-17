import type { CallSummary } from "@/lib/claude";
import type { EvalCase } from "./cases";

export interface CaseResult {
  id: string;
  passed: boolean;
  failures: string[];
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
  return output.concerns.length > 0 || output.meds_missed.length > 0 || output.mood === "concerning" || output.mood === "unknown";
}

/** Scores one model output against what the case says must be true. */
export function scoreCase(testCase: EvalCase, output: CallSummary): CaseResult {
  const failures: string[] = [];
  const { expect } = testCase;

  for (const med of expect.medsConfirmed ?? []) {
    if (!contains(output.meds_confirmed, med)) failures.push(`expected ${med} confirmed`);
  }
  for (const med of expect.medsMissed ?? []) {
    if (!contains(output.meds_missed, med)) failures.push(`expected ${med} reported missed`);
  }
  // An explicitly empty expectation is an assertion that nothing was invented.
  if (expect.medsConfirmed?.length === 0 && output.meds_confirmed.length > 0) {
    failures.push(`hallucinated confirmed meds: ${output.meds_confirmed.join(", ")}`);
  }
  if (expect.medsMissed?.length === 0 && output.meds_missed.length > 0) {
    failures.push(`hallucinated missed meds: ${output.meds_missed.join(", ")}`);
  }

  const alerted = wouldAlert(output);
  if (expect.anyConcern && !alerted) failures.push("family would NOT have been alerted, but should have been");
  if (!expect.anyConcern && alerted)
    failures.push(`false alarm: concerns=[${output.concerns.join(", ")}] missed=[${output.meds_missed.join(", ")}] mood=${output.mood}`);

  if (expect.concernMatches && output.concerns.length > 0) {
    const blob = output.concerns.join(" ").toLowerCase();
    if (!expect.concernMatches.some((m) => blob.includes(m.toLowerCase()))) {
      failures.push(`concern reported but not the right one (got: ${output.concerns.join(", ")})`);
    }
  }

  if (expect.mood && !expect.mood.includes(output.mood)) {
    failures.push(`mood ${output.mood} outside expected ${expect.mood.join("/")}`);
  }

  return { id: testCase.id, passed: failures.length === 0, failures };
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
    return !r.failures.some((f) => f.includes("med") || f.includes("Med"));
  });

  return {
    results,
    total: cases.length,
    passed: results.filter((r) => r.passed).length,
    concernRecall: rate(caughtConcern.length, shouldConcern.length),
    falseAlarmRate: shouldNotConcern.length === 0 ? 0 : falseAlarms.length / shouldNotConcern.length,
    medicationAccuracy: rate(medCorrect.length, medCases.length),
  };
}
