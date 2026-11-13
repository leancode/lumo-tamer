/**
 * Integration tests for structured output (response_format / text.format).
 *
 * The `jsonOutput` mock scenario answers like Lumo often does, with JSON inside
 * a Markdown code fence, and reports whether the format instruction reached it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, parseSSEEvents, type TestServer } from '../helpers/test-server.js';

const schema = { type: 'object', properties: { mocked: { type: 'boolean' } }, required: ['mocked'] };
const expected = { mocked: true, sawFormatInstruction: true };

describe('structured output', () => {
  let ts: TestServer;
  beforeAll(async () => { ts = await createTestServer('jsonOutput'); });
  afterAll(async () => { await ts.close(); });

  function post(path: string, body: object) {
    return fetch(`${ts.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const messages = [{ role: 'user', content: 'Give me the data' }];

  describe('/v1/chat/completions', () => {
    it('returns bare JSON for json_schema', async () => {
      const res = await post('/v1/chat/completions', {
        messages,
        response_format: { type: 'json_schema', json_schema: { name: 'data', strict: true, schema } },
      });
      expect(res.status).toBe(200);
      const content = (await res.json()).choices[0].message.content;
      expect(content.startsWith('{')).toBe(true);
      expect(JSON.parse(content)).toEqual(expected);
    });

    it('returns bare JSON for json_object', async () => {
      const res = await post('/v1/chat/completions', { messages, response_format: { type: 'json_object' } });
      expect(JSON.parse((await res.json()).choices[0].message.content)).toEqual(expected);
    });

    it('streams bare JSON', async () => {
      const res = await post('/v1/chat/completions', { messages, stream: true, response_format: { type: 'json_object' } });
      expect(res.status).toBe(200);
      const content = parseSSEEvents(await res.text())
        .map((e) => (e.data as any)?.choices?.[0]?.delta?.content ?? '')
        .join('');
      expect(content).not.toContain('`');
      expect(JSON.parse(content)).toEqual(expected);
    });

    it('leaves the reply alone without response_format', async () => {
      const res = await post('/v1/chat/completions', { messages });
      const content = (await res.json()).choices[0].message.content;
      expect(content).toContain('```json');
      expect(content).toContain('"sawFormatInstruction":false');
    });

    it('treats type text as no format', async () => {
      const res = await post('/v1/chat/completions', { messages, response_format: { type: 'text' } });
      expect((await res.json()).choices[0].message.content).toContain('"sawFormatInstruction":false');
    });

    it('rejects an invalid response_format with a 400', async () => {
      const res = await post('/v1/chat/completions', { messages, response_format: { type: 'xml' } });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.code).toBe('invalid_response_format');
      expect(body.error.param).toBe('response_format.type');
    });
  });

  describe('/v1/responses', () => {
    const text = { format: { type: 'json_schema', name: 'data', strict: true, schema } };

    it('returns bare JSON and echoes text.format', async () => {
      const res = await post('/v1/responses', { input: 'Give me the data', text });
      expect(res.status).toBe(200);
      const body = await res.json();
      const message = body.output.find((item: any) => item.type === 'message');
      expect(JSON.parse(message.content[0].text)).toEqual(expected);
      expect(body.text.format).toEqual(text.format);
    });

    it('streams bare JSON', async () => {
      const res = await post('/v1/responses', { input: 'Give me the data', stream: true, text });
      const events = parseSSEEvents(await res.text());
      const deltas = events
        .filter((e) => (e.data as any)?.type === 'response.output_text.delta')
        .map((e) => (e.data as any).delta)
        .join('');
      const done = events.find((e) => (e.data as any)?.type === 'response.output_text.done');
      expect(JSON.parse(deltas)).toEqual(expected);
      expect((done?.data as any).text).toBe(deltas);
    });

    it('keeps the default text format in the response when none is requested', async () => {
      const res = await post('/v1/responses', { input: 'Give me the data' });
      expect((await res.json()).text.format).toEqual({ type: 'text' });
    });

    it('rejects an invalid text.format with a 400', async () => {
      const res = await post('/v1/responses', { input: 'Give me the data', text: { format: { type: 'yaml' } } });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_response_format');
      expect(body.error.param).toBe('text.format.type');
    });
  });
});
