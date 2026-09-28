import { KaiError } from "./errors.js";
import { record } from "./json.js";
import type {
  ChoiceCriteria,
  ChoiceQuestion,
  EntryType,
  NoulQuestion,
  Questions,
  ScoreCriteria,
  ScoreQuestion,
} from "./types.js";

const LABELS = "choice criteria must map labels to descriptions, or list the labels";
const LEVELS = "score criteria must list the levels, lowest first";

/**
 * A yes/no question; the answer's `noul` is P(true).
 *
 * @param instructions - The question, or a statement Kai judges true or false.
 * @param criteria - What true and false mean. Kai answers more reliably with them.
 */
export function noul(instructions: EntryType, criteria?: NoulQuestion["criteria"]): NoulQuestion {
  return criteria === undefined ? { type: "noul", instructions } : { type: "noul", instructions, criteria };
}

/**
 * One label of several; the answer's `choice` is typed as those labels.
 *
 * @param criteria - Labels mapped to descriptions (`null` for none), or a list of labels.
 */
export function choice<const T extends ChoiceCriteria>(instructions: EntryType, criteria: T): ChoiceQuestion<T> {
  if (!record(criteria) && !Array.isArray(criteria)) throw new KaiError(LABELS);
  return { type: "choice", instructions, criteria };
}

/**
 * A level of an ordered scale; the answer's `score` is the expected level.
 *
 * @param criteria - Each level's description, lowest first.
 */
export function score<const T extends ScoreCriteria>(instructions: EntryType, criteria: T): ScoreQuestion<T> {
  if (!Array.isArray(criteria)) throw new KaiError(LEVELS);
  return { type: "score", instructions, criteria };
}

/** Refuses what is wrong before it is sent: no questions, or criteria of the wrong shape. */
export function check(questions: Questions): void {
  const entries = record(questions) ? Object.entries(questions) : [];
  if (entries.length === 0) throw new KaiError("at least one question is required");
  for (const [name, question] of entries) {
    if (!record(question)) continue;
    const criteria: unknown = question.criteria;
    if (question.type === "score" && !Array.isArray(criteria)) throw new KaiError(`question "${name}": ${LEVELS}`);
    if (question.type === "choice" && !record(criteria) && !Array.isArray(criteria)) {
      throw new KaiError(`question "${name}": ${LABELS}`);
    }
  }
}
