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
import { buildReport } from "./score";
import type { CallSummary } from "@/lib/claude";

/**
 * Mirrors how app/api/vapi/webhook assembles concerns: Claude's judgement plus the
 * deterministic backstops. Measuring the model alone would misreport the system — the
 * backstops exist precisely because the model isn't reliable on its own for these.
 */
function applyProductionBackstops(transcript: string, extracted: CallSummary): CallSummary {
  const keywordMatches = scanForConcernKeywords(transcript, DEFAULT_CONCERN_KEYWORDS);
  const noResponse = !hasParentResponse(transcript) ? ["Parent didn't respond — call ended without a conversation"] : [];
  return { ...extracted, concerns: Array.from(new Set([...extracted.concerns, ...keywordMatches, ...noResponse])) };
}

async function main() {
  console.log(`Running ${EVAL_CASES.length} cases against ${process.env.ANTHROPIC_MODEL || "claude-sonnet-5"}…\n`);

  const outputs = [];
  for (const testCase of EVAL_CASES) {
    process.stdout.write(`  ${testCase.id}… `);
    try {
      outputs.push(applyProductionBackstops(testCase.transcript, await summarizeCall(testCase.transcript)));
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

  // Recall is the number that must never silently regress.
  if (report.concernRecall < 1) {
    console.log("\nFAIL: a concern that should have been reported was missed.");
    process.exit(1);
  }
}

main();
