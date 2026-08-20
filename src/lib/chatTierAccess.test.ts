// The tier boundary for AI Chat, as tests rather than as a manual click-through.
//
// Why these exist: the Claude migration listed "tier gating enforced server-side"
// and "retrieval never returns above-tier chunks" as must-not-regress invariants,
// and both were only ever checked by hand. A super-admin session cannot check them
// at all — it clears every gate by definition — so the interesting cases are the
// ones a human tester is least able to reach.
//
// These cover the pure decision functions. What they deliberately do NOT cover is
// the wiring in controllers/chat.ts that calls them; that still needs a pass on a
// real free/core account.

import test from 'node:test';
import assert from 'node:assert/strict';
import { clipBodyForTier, findGateIndex, stripGateNodes } from './articleGate';
import { allowedTiersFor } from '../services/articleEmbeddings';
import {
  resolveModelKey,
  providerModelFor,
  isSupportedImageMimeType,
  searchBudgetRemaining,
  createNarrationFilter,
} from './anthropic';
import { tierAtLeast, type PlanTier } from '../middleware/auth';

const TIERS: PlanTier[] = ['free', 'core', 'premium'];

// A body with public prose, a gate, then members-only prose.
function gatedBody() {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'PUBLIC-ONE' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'PUBLIC-TWO' }] },
      { type: 'gate' },
      { type: 'paragraph', content: [{ type: 'text', text: 'SECRET-ONE' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'SECRET-TWO' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'SECRET-THREE' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'SECRET-FOUR' }] },
    ],
  };
}

test('model resolution is server-authoritative', async (t) => {
  await t.test('each tier gets its own ceiling when it asks for nothing', () => {
    assert.equal(resolveModelKey(undefined, 'free'), 'velo');
    assert.equal(resolveModelKey(undefined, 'core'), 'core');
    assert.equal(resolveModelKey(undefined, 'premium'), 'max');
  });

  await t.test('a request above the tier ceiling is clamped, not honoured', () => {
    assert.equal(resolveModelKey('max', 'free'), 'velo');
    assert.equal(resolveModelKey('core', 'free'), 'velo');
    assert.equal(resolveModelKey('max', 'core'), 'core');
  });

  await t.test('a request at or below the ceiling is honoured', () => {
    assert.equal(resolveModelKey('velo', 'premium'), 'velo');
    assert.equal(resolveModelKey('core', 'premium'), 'core');
    assert.equal(resolveModelKey('velo', 'core'), 'velo');
  });

  await t.test('junk from the client falls back to the ceiling rather than throwing', () => {
    for (const junk of ['', 'gpt-4', 'claude-opus-4-8', 'MAX', '../max', '__proto__']) {
      assert.equal(resolveModelKey(junk, 'free'), 'velo', `junk: ${junk}`);
    }
  });

  await t.test('every key maps to a non-empty provider id', () => {
    for (const key of ['velo', 'core', 'max'] as const) {
      assert.ok(providerModelFor(key).length > 0);
    }
  });
});

test('retrieval tier filter never widens', async (t) => {
  await t.test('a tier may read its own tier and below, never above', () => {
    assert.deepEqual(allowedTiersFor('free'), ['free']);
    assert.deepEqual(allowedTiersFor('core'), ['free', 'core']);
    assert.deepEqual(allowedTiersFor('premium'), ['free', 'core', 'premium']);
  });

  await t.test('the filter agrees with tierAtLeast for every pair', () => {
    for (const reader of TIERS) {
      const allowed = allowedTiersFor(reader);
      for (const chunk of TIERS) {
        assert.equal(
          allowed.includes(chunk),
          tierAtLeast(reader, chunk),
          `${reader} reading ${chunk}`,
        );
      }
    }
  });
});

test('clipBodyForTier is the paywall', async (t) => {
  const secret = /SECRET-(ONE|TWO|THREE|FOUR)/;

  await t.test('a free reader gets no gated prose in the body', () => {
    const { body, locked } = clipBodyForTier(gatedBody(), 'premium', 'free');
    assert.equal(locked, true);
    assert.doesNotMatch(JSON.stringify(body), secret);
    assert.match(JSON.stringify(body), /PUBLIC-ONE/);
  });

  await t.test('a core reader is still locked out of premium prose', () => {
    const { body, locked } = clipBodyForTier(gatedBody(), 'premium', 'core');
    assert.equal(locked, true);
    assert.doesNotMatch(JSON.stringify(body), secret);
  });

  await t.test('an entitled reader gets everything', () => {
    const { body, locked, teaser } = clipBodyForTier(gatedBody(), 'premium', 'premium');
    assert.equal(locked, false);
    assert.equal(teaser, null);
    assert.match(JSON.stringify(body), /SECRET-FOUR/);
  });

  await t.test('the teaser is bounded and never reaches the last gated node', () => {
    const { teaser } = clipBodyForTier(gatedBody(), 'premium', 'free');
    const asText = JSON.stringify(teaser);
    assert.match(asText, /SECRET-ONE/);
    // Three teaser nodes max — the fourth must stay behind the gate.
    assert.doesNotMatch(asText, /SECRET-FOUR/);
  });

  await t.test('a gateTier the reader lacks, with NO gate node, yields an empty body', () => {
    // The fail-closed case: an editor set a gateTier but never placed the marker.
    // Returning the whole body here would silently un-gate the article.
    const ungated = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SECRET-ONE' }] }] };
    const { body, locked } = clipBodyForTier(ungated, 'premium', 'free');
    assert.equal(locked, true);
    assert.doesNotMatch(JSON.stringify(body), secret);
  });

  await t.test('an ungated article is readable by everyone', () => {
    for (const tier of TIERS) {
      const { locked } = clipBodyForTier(gatedBody(), null, tier);
      assert.equal(locked, false, `tier ${tier}`);
    }
  });

  await t.test('the gate marker itself is never echoed back', () => {
    // Telling a locked reader exactly where the cut falls is its own small leak.
    for (const tier of TIERS) {
      const { body } = clipBodyForTier(gatedBody(), 'premium', tier);
      assert.equal(findGateIndex(body), -1, `tier ${tier}`);
    }
    assert.equal(findGateIndex(stripGateNodes(gatedBody())), -1);
  });
});

test('image attachments are restricted to what the provider accepts', async (t) => {
  await t.test('accepts the four supported types', () => {
    for (const ok of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      assert.equal(isSupportedImageMimeType(ok), true, ok);
    }
  });

  await t.test('rejects everything else, including plausible near-misses', () => {
    // image/heic matters most: it is what an iPhone actually uploads, and the old
    // `image/*` check waved it through into a provider 400.
    for (const bad of ['image/heic', 'image/heif', 'image/svg+xml', 'image/bmp', 'image/tiff', 'application/pdf', 'image/', 'text/plain', 'IMAGE/PNG']) {
      assert.equal(isSupportedImageMimeType(bad), false, bad);
    }
  });
});

// F-141: `max_uses` is a per-REQUEST cap, but a paused turn is resumed by re-sending,
// so the full figure on every resume gave each continuation a fresh budget — 20 searches
// against a documented 5. streamChat now carries the spend across continuations; these
// pin the arithmetic it does. (The default is 5 unless WEB_SEARCH_MAX_USES overrides it,
// so the assertions are written relative to the budget at zero spend.)
test('the web-search budget is spent across a turn, not refreshed per request', async (t) => {
  const full = searchBudgetRemaining(0);

  await t.test('an unspent turn gets the whole budget', () => {
    assert.ok(full >= 1);
  });

  await t.test('each search taken comes off the budget', () => {
    for (let used = 0; used <= full; used += 1) {
      assert.equal(searchBudgetRemaining(used), full - used);
    }
  });

  await t.test('an exhausted budget floors at zero and never goes negative', () => {
    assert.equal(searchBudgetRemaining(full), 0);
    // The old bug's signature: a continuation asking for the full figure again.
    assert.equal(searchBudgetRemaining(full + 10), 0);
  });
});

// F-006: retrieval planning arrives as its own short assistant text block, sitting
// between the tool calls — "Let me wait a moment and retry with a single focused
// search." was scored a clean answer by the harness but read as narration to the
// user. The filter recognises it by shape rather than by wording: short, and
// followed by a tool call. These pin that shape, including the cases where holding
// text back must NOT swallow it.
test('the narration filter drops tool hand-off lines and keeps everything else', async (t) => {
  const NARRATION = 'Let me wait a moment and retry with a single focused search.';

  await t.test('a short block followed by a search is never emitted', () => {
    const f = createNarrationFilter();
    assert.equal(f.onTextBlockStart(), '');
    assert.equal(f.onText(NARRATION), '');
    f.onToolUse();
    assert.equal(f.flush(), '');
  });

  await t.test('a short block that ends the turn is emitted in full', () => {
    const f = createNarrationFilter();
    f.onTextBlockStart();
    assert.equal(f.onText('No, that is not the case.'), '');
    assert.equal(f.flush(), 'No, that is not the case.');
  });

  await t.test('a long block passes the threshold and then streams live', () => {
    const f = createNarrationFilter(20);
    f.onTextBlockStart();
    assert.equal(f.onText('The border is in an'), '');
    // Crossing the threshold releases everything held so far in one piece…
    assert.equal(f.onText(' open conflict cycle.'), 'The border is in an open conflict cycle.');
    // …and every delta after it goes straight through, unbuffered.
    assert.equal(f.onText(' It began in February.'), ' It began in February.');
    assert.equal(f.flush(), '');
  });

  await t.test('a long block is still emitted even if a search follows it', () => {
    // Emitted text cannot be recalled, so the threshold is the whole commitment:
    // past it, the block is treated as the answer whatever comes next.
    const f = createNarrationFilter(10);
    f.onTextBlockStart();
    assert.equal(f.onText('Inflation is reaccelerating.'), 'Inflation is reaccelerating.');
    f.onToolUse();
    assert.equal(f.flush(), '');
  });

  await t.test('two text blocks in a row both survive — only a tool call drops one', () => {
    const f = createNarrationFilter();
    f.onTextBlockStart();
    f.onText('First half.');
    assert.equal(f.onTextBlockStart(), 'First half.');
    f.onText('Second half.');
    assert.equal(f.flush(), 'Second half.');
  });

  await t.test('held text survives a pause_turn continuation before being judged', () => {
    // The filter outlives the request loop precisely so a block that ends a paused
    // message can still be dropped by a tool call in the message that resumes it.
    const f = createNarrationFilter();
    f.onTextBlockStart();
    f.onText(NARRATION);
    // …request boundary here; no flush() is called…
    f.onToolUse();
    assert.equal(f.flush(), '');
  });
});
