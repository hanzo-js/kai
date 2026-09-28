/** Whether a value is a JSON object: not null, not an array. */
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A body's JSON, the text itself when it is not JSON, or undefined when empty. */
export function parse(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
