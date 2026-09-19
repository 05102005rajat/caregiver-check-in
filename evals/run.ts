/**
 * Runs the evaluation set against the live summarizer. Deliberately not part of `npm
 * test`: it costs real Anthropic tokens and is meant to be run when the prompt or model
 * changes, so a regression in concern recall is caught before it reaches a family.
 *
 *   npx tsx evals/run.ts
 */
import { summarizeCall } from "@/lib/claude";
import { DEFAULT_CONCERN_KEYWORDS, hasParentResponse, scanForConcernKeywords } from "@/lib/safety";
import { EVAL_CASES } from "./cases";
import type { EvalCase } from "./cases";
import { buildReport } from "./score";
import type { CallSummary } from "@/lib/claude";

/**
 * Mirrors how app/api/vapi/webhook assembles concerns: Claude's judgement plus the
 * deterministic backstops. Measuring the model alone would misreport the system — the
 * backstops exist precisely because the model isn't reliable on its own for these.
 */
function applyProductionBackstops(testCase: EvalCase, extracted: CallSummary): CallSummary {
  const { transcript, scheduledMeds } = testCase;
  const keywordMatches = scanForConcernKeywords(transcript, DEFAULT_CONCERN_KEYWORDS);
  const noResponse = !hasParentResponse(transcript) ? ["Parent didn't respond — call ended without a conversation"] : [];

  // Same fuzzy validation the webhook applies against the call's scheduled_meds snapshot:
  // a medication Claude invented is dropped there, so counting it here as grounds to alert
  // would score a pass for a call production would stay silent on.
  const known = (scheduledMeds ?? []).map((m) => m.toLowerCase());
  const isKnown = (name: string) => {
    const lower = name.toLowerCase();
    if (lower.length < 4) return known.includes(lower);
    return known.some((k) => k.length >= 4 && (k.includes(lower) || lower.includes(k)));
  };

  return {
    ...extracted,
    meds_confirmed: extracted.meds_confirmed.filter(isKnown),
    meds_missed: extracted.meds_missed.filter(isKnown),
    concerns: Array.from(new Set([...extracted.concerns, ...keywordMatches, ...noResponse])),
  };
}

async function main() {
  console.log(`Running ${EVAL_CASES.length} cases against ${process.env.ANTHROPIC_MODEL || "claude-sonnet-5"}…\n`);

  const outputs = [];
  for (const testCase of EVAL_CASES) {
    process.stdout.write(`  ${testCase.id}… `);
    try {
      const raw = await summarizeCall(
      testCase.transcript,
      testCase.knownIssues ?? [],
      [],
      // The webhook ALWAYS passes these, which injects a whole <medications_due> block into
      // the prompt. Grading without them scores a prompt shape that never runs in
      // production — the same "a green run on an unpasted change means nothing" hazard the
      // conversation eval warns about, one layer down.
      testCase.medications ?? []
    );
      // Injection cases are scored on the model alone — the backstops would otherwise
      // supply a concern regardless of whether the model was hijacked.
      outputs.push(testCase.assertRawModel ? raw : applyProductionBackstops(testCase, raw));
      process.stdout.write("done\n");
    } catch (err) {
      process.stdout.write("ERROR\n");
      console.error(err);
      process.exit(1);
    }
  }

  const report = buildReport(EVAL_CASES, outputs);

  console.log("\n─────────────────────────────────────────");
  for (const result of report.results) {
    console.log(`${result.passed ? "✓" : "✗"} ${result.id}`);
    for (const failure of result.failures) console.log(`    ${failure}`);
  }
  console.log("─────────────────────────────────────────");
  console.log(`Passed:              ${report.passed}/${report.total}`);
  console.log(`Concern recall:      ${(report.concernRecall * 100).toFixed(0)}%  (missing these is the dangerous direction)`);
  console.log(`False alarm rate:    ${(report.falseAlarmRate * 100).toFixed(0)}%  (this is what burns caregivers out)`);
  console.log(`Medication accuracy: ${(report.medicationAccuracy * 100).toFixed(0)}%`);

  console.log(`Unknown-mood rate:   ${(report.unknownMoodRate * 100).toFixed(0)}%  (high means the model isn't parsing, not that it's judging well)`);

  // Everything below used to be advisory: the only gate was concernRecall, so a run with
  // 15 of 19 cases failing still exited 0 and reported success.
  const reasons: string[] = [];

  // Recall is the number that must never silently regress.
  if (report.concernRecall < 1) reasons.push("a concern that should have been reported was missed");

  // The gate that made the gate meaningless: normalize() defaults mood to "unknown" for any
  // malformed, truncated or empty model response, and wouldAlert treats "unknown" as
  // alerting. So if the model returned garbage for every single case, every case "would
  // alert", recall came out 1.0, and the suite passed having measured nothing at all.
  // Any substantial unknown-mood rate means these numbers describe parse failures.
  if (report.unknownMoodRate > 0.25) {
    reasons.push(
      `${(report.unknownMoodRate * 100).toFixed(0)}% of outputs had mood "unknown" — the model is likely failing to return usable JSON, which inflates concern recall rather than demonstrating it`
    );
  }

  if (report.passed < report.total) reasons.push(`${report.total - report.passed} of ${report.total} cases failed`);
  if (report.falseAlarmRate > 0) reasons.push(`false alarm rate is ${(report.falseAlarmRate * 100).toFixed(0)}%`);
  if (report.medicationAccuracy < 1) {
    reasons.push(`medication accuracy is ${(report.medicationAccuracy * 100).toFixed(0)}%`);
  }

  if (reasons.length > 0) {
    console.log("\nFAIL:");
    for (const reason of reasons) console.log(`  - ${reason}`);
    process.exit(1);
  }
}

main();
