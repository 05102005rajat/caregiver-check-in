import type { CallSummary } from "@/lib/claude";

/**
 * What may be said about a call — decided once, for both the stored row and the text.
 *
 * This exists because the same defect recurred four times in one evening. Rosie hit her own
 * "I don't have your details" line, ended the call, and the extractor read her apology and
 * the person's reaction to being hung up on as evidence about the parent. The family was
 * texted that their mother "seemed confused or disconnected". The first fix dropped the
 * model's concerns, summary and medications — and left `mood`. The second fix caught `mood`
 * — and left the keyword scan, the requests and the urgent flag. Each fix was a
 * `rosieAborted ? … : …` at one more call site in a 600-line route handler that no test
 * touches, and each one's commit message claimed the class was closed.
 *
 * So the decision moves here, once, where it is pure and can be tested exhaustively. The
 * route asks this what it is allowed to report and renders the answer. Adding a new field
 * to the alert means adding it to `ReportableFacts`, which means deciding, in one visible
 * place, whether it survives an aborted call.
 *
 * The rule: when the call never became a conversation, NOTHING inferred from the transcript
 * describes the parent, because the transcript is Rosie apologising to someone who answered
 * the phone. The call is still reported — a check-in that silently never happened is the one
 * failure this product must not have — but reported as our fault, in our words.
 */

/**
 * Why the call never became a conversation. Both reasons get identical treatment — nothing
 * inferred from the transcript survives — and differ only in what the family is told, because
 * "our software broke" and "an answering machine picked up" call for different responses from
 * them. Adding a third reason means adding it here, and the type makes the callers follow.
 */
export type NotAConversation = "assistant-abort" | "voicemail";

export const VOICEMAIL_CONCERN = "The check-in did not happen — the call reached an answering machine";

export const VOICEMAIL_SUMMARY =
  "The check-in did not happen: the call reached an answering machine rather than a person, so nothing was asked or answered. Nothing here reflects how they are.";

/** Stored and rendered wherever a concern is. Names our fault as ours. */
export const SYSTEM_FAULT_CONCERN =
  "The check-in did not happen — the call ended on a fault at our end, before any conversation";

export const SYSTEM_FAULT_SUMMARY =
  "The check-in did not happen: the call ended on a fault at our end before any conversation took place. Nothing here reflects how they are.";

/** The model's output, after the route's own name-filtering. */
export interface ExtractionFacts {
  summary: string;
  concerns: string[];
  requests: string[];
  medsConfirmed: string[];
  medsMissed: string[];
  missedReasons: Record<string, string>;
  appointmentsAcknowledged: string[];
  mood: CallSummary["mood"];
  urgent: boolean;
}

export interface ReportInput {
  extracted: ExtractionFacts;
  /** Word-boundary keyword hits over the raw transcript — Rosie's turns included. */
  keywordMatches: string[];
  /** Structural backstop from lib/safety.hasParentResponse. */
  noResponse: string[];
  /**
   * Set when the call never became a conversation — see NotAConversation. null for a real
   * one. A boolean was not enough the moment a second reason appeared.
   */
  notAConversation: NotAConversation | null;
}

export interface ReportableFacts {
  notAConversation: NotAConversation | null;
  summary: string;
  /** Narrative findings, already merged with the keyword and no-response backstops. */
  concerns: string[];
  keywordMatches: string[];
  requests: string[];
  medsConfirmed: string[];
  medsMissed: string[];
  missedReasons: Record<string, string>;
  appointmentsAcknowledged: string[];
  mood: CallSummary["mood"];
  urgent: boolean;
}

export function reportableFacts({ extracted, keywordMatches, noResponse, notAConversation }: ReportInput): ReportableFacts {
  if (notAConversation) {
    return {
      notAConversation,
      summary: notAConversation === "voicemail" ? VOICEMAIL_SUMMARY : SYSTEM_FAULT_SUMMARY,
      concerns: [notAConversation === "voicemail" ? VOICEMAIL_CONCERN : SYSTEM_FAULT_CONCERN],
      // Every one of these is an inference from a conversation that did not take place:
      //   keywordMatches — scanned over Rosie's apology and the person reacting to being cut
      //     off. "pain" matched there would arrive as "Also heard on the call: pain",
      //     directly under a line saying the call did not happen.
      //   requests      — "asked for: a visit on Sunday", extracted from an apology.
      //   meds          — she never asked, so "not taken" is a verdict on a question nobody
      //     was given the chance to answer, and the weekly summary counts stored misses.
      //   mood          — rendered under the parent's name, counted as "sounded low on N days".
      //   urgent        — a 911-shaped claim about a call that never happened.
      keywordMatches: [],
      requests: [],
      medsConfirmed: [],
      medsMissed: [],
      missedReasons: {},
      appointmentsAcknowledged: [],
      mood: "unknown",
      urgent: false,
    };
  }

  return {
    notAConversation: null,
    summary: extracted.summary,
    concerns: Array.from(new Set([...extracted.concerns, ...keywordMatches, ...noResponse])),
    keywordMatches,
    requests: extracted.requests,
    medsConfirmed: extracted.medsConfirmed,
    medsMissed: extracted.medsMissed,
    missedReasons: extracted.missedReasons,
    appointmentsAcknowledged: extracted.appointmentsAcknowledged,
    mood: extracted.mood,
    urgent: extracted.urgent,
  };
}
