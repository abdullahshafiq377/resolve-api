import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasExtractableText } from './articleText';

// The publish gate for FINDINGS A3. These cases are the ones that decide whether
// an article can go live, so they are pinned here: "empty" must stay narrow
// enough that a legitimate custom-block article is never refused, and wide enough
// that a body which embeds to zero chunks never reaches readers.
describe('hasExtractableText', () => {
  test('an empty doc has no text', () => {
    assert.equal(hasExtractableText({ type: 'doc', content: [] }), false);
  });

  test('a doc of empty paragraphs has no text — the shape a fresh editor saves', () => {
    assert.equal(
      hasExtractableText({ type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] }),
      false,
    );
  });

  test('a missing or malformed body has no text', () => {
    assert.equal(hasExtractableText(null), false);
    assert.equal(hasExtractableText(undefined), false);
    assert.equal(hasExtractableText({}), false);
  });

  test('whitespace is not prose', () => {
    assert.equal(
      hasExtractableText({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }],
      }),
      false,
    );
  });

  test('a gate marker alone is not prose', () => {
    assert.equal(hasExtractableText({ type: 'doc', content: [{ type: 'gate' }] }), false);
  });

  test('a paragraph with words has text', () => {
    assert.equal(
      hasExtractableText({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rupee steadies.' }] }],
      }),
      true,
    );
  });

  test('a custom block carries its own text — key points only is still an article', () => {
    assert.equal(
      hasExtractableText({
        type: 'doc',
        content: [
          { type: 'keyPoints', attrs: { items: [{ title: 'Remittances', description: 'Up 12%' }] } },
        ],
      }),
      true,
    );
  });

  test('an image caption counts, an image without one does not', () => {
    assert.equal(
      hasExtractableText({ type: 'doc', content: [{ type: 'image', attrs: { src: 'x.jpg' } }] }),
      false,
    );
    assert.equal(
      hasExtractableText({
        type: 'doc',
        content: [{ type: 'image', attrs: { src: 'x.jpg', alt: 'Queue at a bank' } }],
      }),
      true,
    );
  });
});
