/**
 * Structured output: OpenAI `response_format` (Chat Completions) and
 * `text.format` (Responses API).
 *
 * Lumo has no JSON mode or grammar-constrained output, so the format is
 * requested with an instruction appended to the last user message (not to the
 * project instructions, which would change on every turn), and the reply is
 * cleaned of the Markdown code fence Lumo tends to wrap JSON in.
 *
 * This is best effort: the reply is not validated against the schema.
 */

/** A structured output format requested by the client. */
export type ResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; name?: string; description?: string; schema?: unknown };

export class ResponseFormatError extends Error {
  constructor(message: string, public readonly param: string, public readonly code = 'invalid_response_format') {
    super(message);
    this.name = 'ResponseFormatError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Parse a format object. `nested` selects where the schema lives:
 * Chat Completions nests it under `json_schema`, the Responses API puts
 * `name`/`schema` next to `type`.
 *
 * @returns the format, or undefined for plain text (absent or `type: "text"`)
 */
function parseFormat(value: unknown, param: string, nested: boolean): ResponseFormat | undefined {
  if (value === undefined || value === null) return undefined;
  const format = asRecord(value);
  if (!format) {
    throw new ResponseFormatError(`${param} must be an object`, param);
  }

  switch (format.type) {
    case 'text':
      return undefined;
    case 'json_object':
      return { type: 'json_object' };
    case 'json_schema': {
      const source = nested ? asRecord(format.json_schema) : format;
      if (!source) {
        throw new ResponseFormatError(`${param}.json_schema must be an object`, `${param}.json_schema`);
      }
      if (source.schema !== undefined && !asRecord(source.schema)) {
        const schemaParam = nested ? `${param}.json_schema.schema` : `${param}.schema`;
        throw new ResponseFormatError(`${schemaParam} must be an object`, schemaParam);
      }
      return {
        type: 'json_schema',
        name: optionalString(source.name),
        description: optionalString(source.description),
        schema: source.schema,
      };
    }
    default:
      throw new ResponseFormatError(
        `Invalid ${param}.type '${String(format.type)}'. Allowed: text, json_object, json_schema`,
        `${param}.type`,
      );
  }
}

/** Parse Chat Completions `response_format`. */
export function parseChatResponseFormat(value: unknown): ResponseFormat | undefined {
  return parseFormat(value, 'response_format', true);
}

/** Parse Responses API `text` (`text.format`). */
export function parseResponsesTextFormat(text: unknown): ResponseFormat | undefined {
  if (text === undefined || text === null) return undefined;
  const record = asRecord(text);
  if (!record) {
    throw new ResponseFormatError('text must be an object', 'text');
  }
  return parseFormat(record.format, 'text.format', false);
}

/**
 * The instruction that asks Lumo for the format. Worded as a plain request so
 * it reads as part of the user's own message.
 */
export function buildResponseFormatInstruction(format: ResponseFormat): string {
  const rules = 'no prose, no explanation and no Markdown code fence';
  if (format.type === 'json_object' || format.schema === undefined) {
    return `Respond with a single valid JSON object only: ${rules}.`;
  }
  const described = format.description ? ` (${format.description})` : '';
  return (
    `Respond with a single JSON value only: ${rules}. ` +
    `It must validate against this JSON schema${described}:\n${JSON.stringify(format.schema)}`
  );
}

function parses(candidate: string): boolean {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean a complete reply down to its JSON: the reply itself, the content of a
 * code fence in it, or the outermost object/array in it, whichever parses
 * first. A reply that holds no JSON is returned trimmed, unchanged otherwise.
 */
export function cleanJsonOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '' || parses(trimmed)) return trimmed;

  const fenced = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/.exec(trimmed);
  if (fenced && parses(fenced[1].trim())) return fenced[1].trim();

  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const candidate = trimmed.slice(start, end + 1);
      if (parses(candidate)) return candidate;
    }
  }
  return trimmed;
}

const FENCE = '```';

/**
 * Streaming counterpart of cleanJsonOutput: removes the code fence wrapped
 * around a reply and the whitespace around it, chunk by chunk.
 *
 * It cannot look ahead, so unlike cleanJsonOutput it does not remove prose
 * written before or after the JSON.
 */
export class JsonOutputFilter {
  private started = false;
  private fenced = false;
  /** Text held back: the undecided start, then a possible closing fence. */
  private held = '';

  /** Feed a chunk; returns the text that can be emitted now. */
  push(chunk: string): string {
    this.held += chunk;
    if (!this.started && !this.start()) return '';

    // Hold back the trailing run of whitespace and backticks: at the end of
    // the reply it is the closing fence, anywhere else more text follows.
    const tail = /[\s`]*$/.exec(this.held)![0];
    const out = this.held.slice(0, this.held.length - tail.length);
    this.held = tail;
    return out;
  }

  /** Decide whether the reply opens with a fence. False: need more text. */
  private start(): boolean {
    const text = this.held.replace(/^\s+/, '');
    if (text.length < FENCE.length && FENCE.startsWith(text)) return false;

    if (text.startsWith(FENCE)) {
      // The opener is the whole first line: ``` plus an optional language tag.
      const lineEnd = text.indexOf('\n');
      if (lineEnd === -1) return false;
      this.fenced = true;
      this.held = text.slice(lineEnd + 1);
    } else {
      this.held = text;
    }
    this.started = true;
    return true;
  }

  /** End of the reply; returns whatever is left to emit. */
  finalize(): string {
    let rest = this.held;
    this.held = '';
    if (!this.started) {
      // Never got past the start: an empty reply or a lone fence opener.
      rest = rest.trim();
      return rest.startsWith(FENCE) ? rest.slice(rest.indexOf('\n') + 1 || rest.length) : rest;
    }
    if (this.fenced) rest = rest.replace(/\s*```\s*$/, '');
    return rest.replace(/\s+$/, '');
  }
}
