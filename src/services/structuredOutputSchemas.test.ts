import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BRIEF_RESPONSE_SCHEMA } from './resolveBriefGeneration';
import { SCHEMA_BY_FORMAT } from './aiSummaryGeneration';

// Structured outputs enforce their own rules on the schema, and a violation is an
// HTTP 400 at request time — not a type error and not something a typecheck can
// see. On the Brief that surfaces as a segment whose generationStatus is 'failed'
// with an opaque API message, which is exactly the kind of failure that sits in
// the admin table for a week before anyone reads it.
//
// The rules asserted here were verified against the live API (claude-sonnet-5)
// before the schemas were written: every object needs `additionalProperties:
// false`; a property left out of `required` really is optional; and the size and
// length keywords are dropped rather than honoured, so anything they would have
// enforced has to be enforced after parsing instead.
const DROPPED_KEYWORDS = [
  'minimum',
  'maximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'pattern',
];

type Node = Record<string, unknown>;

// Every object node reachable from the root, including through array `items`.
function objectNodes(node: unknown, path = '$', found: { path: string; node: Node }[] = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return found;
  const current = node as Node;
  if (current.type === 'object') found.push({ path, node: current });

  const properties = current.properties as Node | undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      objectNodes(value, `${path}.${key}`, found);
    }
  }
  if (current.items) objectNodes(current.items, `${path}[]`, found);
  return found;
}

function keywordsIn(node: unknown, path = '$', found: { path: string; keyword: string }[] = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return found;
  const current = node as Node;
  for (const keyword of DROPPED_KEYWORDS) {
    if (keyword in current) found.push({ path, keyword });
  }
  const properties = current.properties as Node | undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      keywordsIn(value, `${path}.${key}`, found);
    }
  }
  if (current.items) keywordsIn(current.items, `${path}[]`, found);
  return found;
}

const SCHEMAS: [string, Node][] = [
  ['brief', BRIEF_RESPONSE_SCHEMA as Node],
  ['summary:bullets', SCHEMA_BY_FORMAT.bullets as Node],
  ['summary:paragraph', SCHEMA_BY_FORMAT.paragraph as Node],
];

describe('structured-output schemas', () => {
  for (const [name, schema] of SCHEMAS) {
    it(`${name}: every object sets additionalProperties: false`, () => {
      for (const { path, node } of objectNodes(schema)) {
        assert.equal(
          node.additionalProperties,
          false,
          `${name} ${path} must set additionalProperties: false — the API rejects the request otherwise`,
        );
      }
    });

    it(`${name}: declares no keyword the API silently drops`, () => {
      const offenders = keywordsIn(schema);
      assert.deepEqual(
        offenders,
        [],
        `${name} uses ${offenders.map((o) => `${o.keyword} at ${o.path}`).join(', ')} — these are dropped, so the rule must be enforced after parsing instead`,
      );
    });

    it(`${name}: every required name is a declared property`, () => {
      for (const { path, node } of objectNodes(schema)) {
        const properties = Object.keys((node.properties as Node) ?? {});
        for (const name of (node.required as string[]) ?? []) {
          assert.ok(
            properties.includes(name),
            `${path} requires "${name}" but never declares it`,
          );
        }
      }
    });
  }

  // The parsing in generateDraft reads exactly these and nothing else; a schema
  // that stops producing them fails the draft rather than storing a partial one.
  it('brief: the fields generateDraft treats as mandatory are required', () => {
    assert.deepEqual(BRIEF_RESPONSE_SCHEMA.required, ['title', 'summary', 'stories']);
  });

  // Deliberately optional, and verified as genuinely optional against the live
  // API. If a future edit adds them to `required`, the model is forced to invent
  // a URL and an editorial note on every brief.
  it('brief: url and editorialNote stay optional', () => {
    const properties = BRIEF_RESPONSE_SCHEMA.properties as Node;
    const stories = properties.stories as Node;
    const story = stories.items as Node;
    assert.ok('url' in (story.properties as Node));
    assert.ok(!((story.required as string[]) ?? []).includes('url'));
    assert.ok('editorialNote' in properties);
    assert.ok(!(BRIEF_RESPONSE_SCHEMA.required as string[]).includes('editorialNote'));
  });

  // AiSummaryFormat is a two-value union; a third format added without a schema
  // would fall through to `schema: undefined` and quietly lose the constraint.
  it('summary: every format has a schema', () => {
    assert.deepEqual(Object.keys(SCHEMA_BY_FORMAT).sort(), ['bullets', 'paragraph']);
  });
});
