import { readFileSync, readdirSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import formats from 'ajv-formats';
import type { IntegrationEvent } from '../contracts/events.generated.js';
export type { IntegrationEvent };
export interface Operation {
  operationId: string;
  'x-backend-path': string;
  'x-auth': 'public' | 'bearer' | 'internal';
  'x-roles': string[];
  'x-implementation': string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema: object;
  }>;
  requestBody?: { content: { 'application/json': { schema: object } } };
  responses: Record<
    string,
    { content?: { 'application/json': { schema: object } } }
  >;
}
export interface ApiDocument {
  openapi: string;
  'x-service': string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, object> };
}
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
(formats as unknown as (instance: Ajv) => void)(ajv);
export const document = (service: string): ApiDocument =>
  JSON.parse(readFileSync(`contracts/openapi/${service}.json`, 'utf8'));
export function validator(schema: object, doc?: ApiDocument): ValidateFunction {
  return ajv.compile(doc ? { ...schema, components: doc.components } : schema);
}
const events = new Map<string, ValidateFunction>();
for (const name of readdirSync('contracts/events').filter((n) =>
  n.endsWith('.json'),
)) {
  const schema = JSON.parse(readFileSync(`contracts/events/${name}`, 'utf8'));
  events.set(schema.properties.eventName.const, validator(schema));
}
export function validateEvent(
  input: unknown,
): asserts input is IntegrationEvent {
  const name = (input as { eventName?: string } | null)?.eventName;
  const check = name ? events.get(name) : undefined;
  if (!check || !check(input))
    throw new PermanentMessageError('INVALID_EVENT_SCHEMA');
}
export class PermanentMessageError extends Error {}
