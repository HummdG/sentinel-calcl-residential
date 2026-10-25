// OpenAPI 3.1 document for /api/v1, generated from the same zod schemas the endpoint
// validates and responds with.

import { z } from 'zod';
import { CONFIG_VERSION } from './config';
import { CalcRequestSchema, CalcResultSchema } from './schema';

const ErrorSchema = z.object({
  error: z.object({
    code: z.enum(['invalid_request', 'unauthorized', 'rate_limited', 'internal_error']),
    message: z.string(),
    request_id: z.string().describe('Also sent as the X-Request-Id header. Quote it when reporting a problem.'),
    fields: z
      .array(z.object({ field: z.string(), issue: z.string() }))
      .optional()
      .describe('invalid_request only: every field that failed, with the reason.'),
  }),
});

const schema = (s: z.ZodType, io: 'input' | 'output') => {
  const out = z.toJSONSchema(s, { io, target: 'draft-2020-12' }) as Record<string, unknown>;
  delete out.$schema;
  return out;
};

const errorResponse = (description: string) => ({
  description,
  headers: { 'X-Request-Id': { $ref: '#/components/headers/RequestId' } },
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

export function openApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Sentinel savings calculator API',
      version: '1.0.0',
      description:
        `Year-1 bills, savings and a 25-year projection for a solar + battery system, from a half-hourly simulation. ` +
        `Model assumptions version ${CONFIG_VERSION}. See docs/API.md for the methodology.`,
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/v1/calc': {
        post: {
          operationId: 'calculate',
          summary: 'Calculate bills, savings and payback',
          parameters: [
            {
              name: 'detail',
              in: 'query',
              required: false,
              description: 'true (or 1) adds the `monthly` array.',
              schema: { type: 'boolean', default: false },
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalcRequest' } } },
          },
          responses: {
            '200': {
              description: 'Calculation result.',
              headers: { 'X-Request-Id': { $ref: '#/components/headers/RequestId' } },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/CalcResult' } } },
            },
            '400': errorResponse('Invalid request: body is not a JSON object, or fields failed validation.'),
            '401': errorResponse('Missing or unknown API key.'),
            '429': {
              ...errorResponse('Rate limit exceeded.'),
              headers: {
                'X-Request-Id': { $ref: '#/components/headers/RequestId' },
                'Retry-After': { description: 'Seconds to wait.', schema: { type: 'integer' } },
              },
            },
            '500': errorResponse('Unexpected error.'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key issued by HS Energy, e.g. `Authorization: Bearer scalc_live_...`.',
        },
      },
      headers: {
        RequestId: { description: 'Unique id for this request.', schema: { type: 'string' } },
      },
      schemas: {
        CalcRequest: schema(CalcRequestSchema, 'input'),
        CalcResult: schema(CalcResultSchema, 'output'),
        Error: schema(ErrorSchema, 'output'),
      },
    },
  };
}
