/**
 * Unit tests for structured output (response_format / text.format).
 */

import { describe, it, expect } from 'vitest';
import {
  ResponseFormatError,
  parseChatResponseFormat,
  parseResponsesTextFormat,
  buildResponseFormatInstruction,
  cleanJsonOutput,
  JsonOutputFilter,
} from '../../src/api/response-format.js';

const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };

/** Run text through the filter split into the given chunks. */
function filterChunks(chunks: string[]): string {
  const filter = new JsonOutputFilter();
  let out = '';
  for (const chunk of chunks) out += filter.push(chunk);
  return out + filter.finalize();
}

describe('parseChatResponseFormat', () => {
  it('returns undefined when absent or text', () => {
    expect(parseChatResponseFormat(undefined)).toBeUndefined();
    expect(parseChatResponseFormat(null)).toBeUndefined();
    expect(parseChatResponseFormat({ type: 'text' })).toBeUndefined();
  });

  it('parses json_object', () => {
    expect(parseChatResponseFormat({ type: 'json_object' })).toEqual({ type: 'json_object' });
  });

  it('parses json_schema nested under json_schema', () => {
    const format = parseChatResponseFormat({
      type: 'json_schema',
      json_schema: { name: 'weather', description: 'A city', strict: true, schema },
    });
    expect(format).toEqual({ type: 'json_schema', name: 'weather', description: 'A city', schema });
  });

  it('rejects invalid formats with the offending param', () => {
    const cases: Array<[unknown, string]> = [
      ['json', 'response_format'],
      [{ type: 'xml' }, 'response_format.type'],
      [{ type: 'json_schema' }, 'response_format.json_schema'],
      [{ type: 'json_schema', json_schema: { schema: 'nope' } }, 'response_format.json_schema.schema'],
    ];
    for (const [value, param] of cases) {
      let caught: unknown;
      try {
        parseChatResponseFormat(value);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(value)).toBeInstanceOf(ResponseFormatError);
      expect((caught as ResponseFormatError).param).toBe(param);
    }
  });
});

describe('parseResponsesTextFormat', () => {
  it('returns undefined when absent or text', () => {
    expect(parseResponsesTextFormat(undefined)).toBeUndefined();
    expect(parseResponsesTextFormat({})).toBeUndefined();
    expect(parseResponsesTextFormat({ format: { type: 'text' } })).toBeUndefined();
  });

  it('parses the flat json_schema shape', () => {
    const format = parseResponsesTextFormat({ format: { type: 'json_schema', name: 'weather', strict: true, schema } });
    expect(format).toEqual({ type: 'json_schema', name: 'weather', description: undefined, schema });
  });

  it('rejects an unknown type', () => {
    expect(() => parseResponsesTextFormat({ format: { type: 'yaml' } })).toThrow(ResponseFormatError);
    expect(() => parseResponsesTextFormat('json')).toThrow(ResponseFormatError);
  });
});

describe('buildResponseFormatInstruction', () => {
  it('asks for a JSON object', () => {
    expect(buildResponseFormatInstruction({ type: 'json_object' })).toMatch(/single valid JSON object only/);
  });

  it('includes the schema and its description', () => {
    const text = buildResponseFormatInstruction({ type: 'json_schema', description: 'A city', schema });
    expect(text).toContain(JSON.stringify(schema));
    expect(text).toContain('(A city)');
    expect(text).toMatch(/no Markdown code fence/);
  });

  it('falls back to a JSON object when json_schema carries no schema', () => {
    expect(buildResponseFormatInstruction({ type: 'json_schema' })).toMatch(/single valid JSON object only/);
  });
});

describe('cleanJsonOutput', () => {
  it('returns plain JSON trimmed', () => {
    expect(cleanJsonOutput('  {"a":1}\n')).toBe('{"a":1}');
    expect(cleanJsonOutput('[1,2]')).toBe('[1,2]');
  });

  it('unwraps a code fence, with or without a language tag', () => {
    expect(cleanJsonOutput('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(cleanJsonOutput('```\n{"a":1}\n```\n')).toBe('{"a":1}');
  });

  it('extracts JSON surrounded by prose', () => {
    expect(cleanJsonOutput('Here you go:\n```json\n{"a":1}\n```\nHope that helps.')).toBe('{"a":1}');
    expect(cleanJsonOutput('Sure: {"a":{"b":[1,2]}} Done.')).toBe('{"a":{"b":[1,2]}}');
  });

  it('keeps backticks that are part of a JSON string', () => {
    const json = JSON.stringify({ code: '```js\nlet a;\n```' });
    expect(cleanJsonOutput('```json\n' + json + '\n```')).toBe(json);
  });

  it('returns non-JSON text trimmed', () => {
    expect(cleanJsonOutput(' I cannot do that. ')).toBe('I cannot do that.');
    expect(cleanJsonOutput('')).toBe('');
  });
});

describe('JsonOutputFilter', () => {
  it('passes plain JSON through, trimmed', () => {
    expect(filterChunks(['\n{"a":', '1}', '\n'])).toBe('{"a":1}');
  });

  it('strips a surrounding code fence', () => {
    expect(filterChunks(['```json\n{"a":1}\n```'])).toBe('{"a":1}');
    expect(filterChunks(['```\n{"a":1}\n```\n'])).toBe('{"a":1}');
  });

  it('gives the same result for every chunk split', () => {
    const json = JSON.stringify({ text: 'a `tick` and\nmore', list: [1, 2, { deep: true }] }, null, 2);
    for (const reply of [json, '```json\n' + json + '\n```', '\n```\n' + json + '\n```\n\n', '  ' + json + '  ']) {
      for (let a = 0; a <= reply.length; a++) {
        for (let b = a; b <= Math.min(reply.length, a + 6); b++) {
          const out = filterChunks([reply.slice(0, a), reply.slice(a, b), reply.slice(b)]);
          expect(out, `split at ${a},${b}`).toBe(json);
        }
      }
    }
  });

  it('emits text as it arrives instead of buffering the whole reply', () => {
    const filter = new JsonOutputFilter();
    expect(filter.push('```json\n{"a":')).toBe('{"a":');
    expect(filter.push('1}\n``')).toBe('1}');
    expect(filter.push('`')).toBe('');
    expect(filter.finalize()).toBe('');
  });

  it('handles empty and fence-only replies', () => {
    expect(filterChunks([])).toBe('');
    expect(filterChunks(['  \n'])).toBe('');
    expect(filterChunks(['```json'])).toBe('');
  });

  it('leaves non-JSON text intact', () => {
    expect(filterChunks(['I cannot ', 'do that.'])).toBe('I cannot do that.');
  });
});
