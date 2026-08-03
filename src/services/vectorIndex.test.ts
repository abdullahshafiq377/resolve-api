// A guard against the Phase 2 cutover half-landing.
//
// The vector index name and the document path it is built on have three
// consumers: the retrieval query (searchChunks), the gate-notice probe
// (probeLockedHits), and the index-creation script. The Voyage cutover changes
// both values at once. Updating only some of the sites does not throw — Atlas
// happily runs a $vectorSearch against an index that does not match the path,
// and returns nothing. Retrieval would look healthy while the members-only
// upsell quietly stopped firing.
//
// So this asserts the constants are the ONLY way those values enter a query.
// It is a source-text check rather than a behavioural one because the failure it
// guards against is a literal reappearing, which no unit test on the current
// behaviour would catch. See FINDINGS AI2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VECTOR_INDEX, VECTOR_PATH, isIndexAlreadyExistsError } from './articleEmbeddings';
import { EMBED_DIM } from '../lib/voyage';

// The interim names the dual-index cutover used. The Gemini generation they
// replaced is gone (W4 step 6), and the plain names were reclaimed during the
// 3 August 2026 reseed — so a reappearance of these means a half-reverted rename.
const INTERIM_INDEX = 'article_chunks_vector_v2';
const INTERIM_PATH = 'embeddingV2';

const SRC = join(__dirname, '..');

// Every file that puts a path or index name into an Atlas vector search.
const CONSUMERS = [
  'services/articleEmbeddings.ts',
  'scripts/createVectorIndex.ts',
];

function source(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

// Strip block and line comments so prose about the old value (or a documented
// example index definition) is not mistaken for live code.
function code(relative: string): string {
  return source(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the vector index name and path have exactly one definition', async (t) => {
  await t.test('both constants are non-empty', () => {
    assert.ok(VECTOR_INDEX.length > 0);
    assert.ok(VECTOR_PATH.length > 0);
  });

  await t.test('no consumer hardcodes the path as a literal', () => {
    for (const file of CONSUMERS) {
      const body = code(file);
      assert.doesNotMatch(
        body,
        new RegExp(`path:\\s*['"\`]${VECTOR_PATH}['"\`]`),
        `${file} hardcodes the vector path — import VECTOR_PATH instead`,
      );
    }
  });

  await t.test('no consumer hardcodes the index name as a literal', () => {
    for (const file of CONSUMERS) {
      // articleEmbeddings.ts is where the constant is declared, so one
      // occurrence of the literal is expected there and nowhere else.
      const body = code(file).replace(`export const VECTOR_INDEX = '${VECTOR_INDEX}';`, '');
      assert.doesNotMatch(
        body,
        new RegExp(`index:\\s*['"\`]${VECTOR_INDEX}['"\`]`),
        `${file} hardcodes the index name — import VECTOR_INDEX instead`,
      );
    }
  });

  await t.test('no half-reverted rename', () => {
    // Pointing at one generation's index and the other's path returns nothing
    // rather than erroring, so retrieval would look healthy while answering from
    // an empty result set. That is the failure mode this file exists for.
    assert.notEqual(VECTOR_INDEX, INTERIM_INDEX);
    assert.notEqual(VECTOR_PATH, INTERIM_PATH);
    for (const file of [...CONSUMERS, 'models/ArticleChunk.ts']) {
      assert.doesNotMatch(
        code(file),
        new RegExp(`(^|[^\\w])${INTERIM_PATH}\\s*[:.]`, 'm'),
        `${file} still references the interim '${INTERIM_PATH}' field`,
      );
    }
  });

  await t.test('the Gemini client is gone and nothing imports it', () => {
    // The teardown deletes lib/gemini.ts outright. An import surviving it would
    // not fail the build only if the file came back — this asserts both halves.
    assert.equal(
      existsSync(join(SRC, 'lib/gemini.ts')),
      false,
      'lib/gemini.ts is back — Voyage is meant to be the only generation',
    );
    for (const file of [...CONSUMERS, 'services/articleEmbeddings.ts']) {
      assert.doesNotMatch(code(file), /from '.*lib\/gemini'/, `${file} still imports lib/gemini`);
    }
  });

  await t.test('the query embedder is the one that produced the index', () => {
    // With only one generation left, the thing worth asserting is no longer
    // "which provider" but that the query path and the stored vectors share a
    // provider and therefore a dimension. A mismatch is a hard Atlas failure.
    const body = code('services/articleEmbeddings.ts');
    const queryCall = body.match(/const \[queryVector\] = await (\w+)\(/);
    assert.ok(queryCall, 'could not find the query embedding call');
    assert.equal(queryCall[1], 'embed');
    assert.match(body, /import \{ embed \} from '\.\.\/lib\/voyage'/);
    assert.equal(EMBED_DIM, 1024);
  });

  await t.test('every $vectorSearch stage in the service uses both constants', () => {
    const body = code('services/articleEmbeddings.ts');
    const stages = body.match(/\$vectorSearch:\s*\{[\s\S]*?\n {6}\}/g) ?? [];
    // Two today: searchChunks and probeLockedHits. If a third is added, it must
    // be added to this expectation deliberately — that is the point.
    assert.equal(stages.length, 2, 'unexpected number of $vectorSearch stages');
    for (const stage of stages) {
      assert.match(stage, /index: VECTOR_INDEX/);
      assert.match(stage, /path: VECTOR_PATH/);
    }
  });
});

test('isIndexAlreadyExistsError', async (t) => {
  await t.test('matches the wording Atlas actually returns', () => {
    // Verbatim from a real failed re-run against the live cluster. This exact
    // string went unmatched for months, so the script threw instead of patching
    // the index in place and the gate filter was never added (FINDINGS AI7).
    assert.equal(
      isIndexAlreadyExistsError(
        'An index named "article_chunks_vector" is already defined for collection articlechunks. ' +
          'Index names must be unique for a source collection and all its views.',
      ),
      true,
    );
  });

  await t.test('matches the other phrasings drivers and servers use', () => {
    for (const msg of [
      'Index already exists with a different name',
      'Duplicate Index',
      'IndexAlreadyExists',
    ]) {
      assert.equal(isIndexAlreadyExistsError(msg), true, msg);
    }
  });

  await t.test('does not swallow unrelated failures', () => {
    // Treating these as "already exists" would silently skip index creation and
    // report success, which is worse than the original bug.
    for (const msg of [
      'not authorized on resolve to execute command',
      'Search index commands are only supported with Atlas',
      'PlanExecutor error during aggregation',
      '',
    ]) {
      assert.equal(isIndexAlreadyExistsError(msg), false, msg);
    }
  });
});
