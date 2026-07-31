import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileTerm, matchesTerm, normalizeForMatch, type CompiledTerm } from './blocklist';
import type { BlockedKeywordMatchMode } from '../../models/BlockedKeyword';

// These exercise the matcher directly rather than `isBlocked`, which needs Mongo.
// The terms below are the ones actually seeded by
// `npm run comments:seed-blocked-keywords` — see src/scripts/seedBlockedKeywords.ts.
const SEEDED_TERMS = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'cunt',
  'gandu',
  'harami',
  'kutta',
  'madarchod',
  'behenchod',
  'kus',
  'kuni',
];

function compile(term: string, mode: BlockedKeywordMatchMode = 'word'): CompiledTerm {
  const compiled = compileTerm(term, mode);
  assert.ok(compiled, `expected \`${term}\` to compile`);
  return compiled;
}

function blocks(text: string, term: string, mode: BlockedKeywordMatchMode = 'word'): boolean {
  return matchesTerm(normalizeForMatch(text), compile(term, mode));
}

// Whole seeded list, the way isBlocked runs it.
function blockedByList(text: string): boolean {
  const haystack = normalizeForMatch(text);
  return SEEDED_TERMS.map((t) => compile(t)).some((c) => matchesTerm(haystack, c));
}

describe('normalizeForMatch', () => {
  it('lowercases and strips combining diacritics', () => {
    assert.equal(normalizeForMatch('FÜCK'), 'fuck');
  });

  it('preserves symbols for the pattern to interpret', () => {
    assert.equal(normalizeForMatch('f*ck'), 'f*ck');
  });

  it('no longer mangles digits in ordinary text', () => {
    // The old global leet pass rewrote 0->o and 1->l, so `1984` became `l984`.
    assert.equal(normalizeForMatch('1984'), '1984');
    assert.equal(normalizeForMatch('R2D2 cost $100'), 'r2d2 cost $100');
  });
});

describe('cases that already worked (no regressions)', () => {
  const cases: [string, string][] = [
    ['fuck', 'plain term'],
    ['f.uck', 'separator'],
    ['f*u*c*k', 'separator between every letter'],
    ['fück', 'diacritic'],
    ['FUCK', 'uppercase'],
    ['what the fuck is this', 'inside a sentence'],
  ];
  for (const [input, label] of cases) {
    it(`holds ${JSON.stringify(input)} — ${label}`, () => {
      assert.equal(blocks(input, 'fuck'), true);
    });
  }
});

describe('cases that previously published (the reported bug)', () => {
  const cases: [string, string][] = [
    ['f*ck', 'censor character replacing a letter'],
    ['f***', 'censor characters replacing every letter but one'],
    ['f**k', 'censor characters in the middle'],
    ['f*c*k', 'mixed: first star replaces `u`, second separates `c` and `k`'],
    ['fuuuck', 'repeated-letter stretching'],
    ['fuuuuuuuck', 'longer stretch'],
    ['f u c k', 'whitespace as separator'],
    ['f#ck', 'a different censor character'],
    ['f$ck', 'symbol that is also a leet letter'],
  ];
  for (const [input, label] of cases) {
    it(`now holds ${JSON.stringify(input)} — ${label}`, () => {
      assert.equal(blocks(input, 'fuck'), true);
    });
  }

  it('holds the censored form inside a sentence', () => {
    assert.equal(blocks('this article is f***ing terrible', 'fuck'), true);
  });
});

describe('leet substitutions applied per letter', () => {
  it('holds sh1t and $hit', () => {
    assert.equal(blocks('sh1t', 'shit'), true);
    assert.equal(blocks('$hit', 'shit'), true);
  });

  it('holds b!tch', () => {
    assert.equal(blocks('b!tch', 'bitch'), true);
  });

  it('holds a leet Roman-Urdu term', () => {
    assert.equal(blocks('g@ndu', 'gandu'), true);
    assert.equal(blocks('kutt@', 'kutta'), true);
  });
});

describe('inflected forms', () => {
  it('holds a closed set of trailing inflections', () => {
    assert.equal(blocks('fucking', 'fuck'), true);
    assert.equal(blocks('bitches', 'bitch'), true);
    assert.equal(blocks('shitty', 'shit'), true);
  });
});

describe('Scunthorpe — benign words containing a seeded term', () => {
  const benign: [string, string][] = [
    ['I grew up in Scunthorpe', 'cunt inside Scunthorpe'],
    ['we should discuss this properly', 'kus inside discuss'],
    ['shiitake mushrooms are great', 'shit inside shiitake'],
    ['the analysis was inconclusive', 'no term, control case'],
    ['Hitchcock directed it', 'bitch-adjacent, must not fire'],
    ['a classic bit character', 'ordinary prose'],
    ['took us so long to load', 'k-u-s across word gaps'],
    ['ask us straight away', 'k-u-s across word gaps again'],
  ];
  for (const [text, label] of benign) {
    it(`allows ${JSON.stringify(text)} — ${label}`, () => {
      assert.equal(blockedByList(text), false);
    });
  }
});

describe('punctuation must never match on its own', () => {
  const noise = ['...', '!!!', '****', '---', '?!?!', '****!!!', 'wait...', 'really?!'];
  for (const text of noise) {
    it(`allows ${JSON.stringify(text)}`, () => {
      assert.equal(blockedByList(text), false);
    });
  }
});

describe('short terms need more real letters', () => {
  it('holds k*s — one censored letter out of three', () => {
    assert.equal(blocks('k*s', 'kus'), true);
  });

  it('allows k** — too little of a 3-letter term is real', () => {
    assert.equal(blocks('k**', 'kus'), false);
  });

  it('does not treat whitespace as a separator for a 3-letter term', () => {
    assert.equal(blocks('k u s', 'kus'), false);
  });
});

describe('dropped-letter forms stay out of scope', () => {
  // Deliberate: these are covered by adding them to the list, not by fuzzy matching.
  it('allows fuk and phuck', () => {
    assert.equal(blocks('fuk', 'fuck'), false);
    assert.equal(blocks('phuck', 'fuck'), false);
  });

  it('holds them once they are on the list as their own terms', () => {
    assert.equal(blocks('fuk', 'fuk'), true);
    assert.equal(blocks('ph*ck', 'phuck'), true);
  });
});

describe('matchMode', () => {
  it('word mode does not match mid-word', () => {
    assert.equal(blocks('Scunthorpe', 'cunt', 'word'), false);
  });

  it('substring mode does, when a moderator opts in', () => {
    assert.equal(blocks('Scunthorpe', 'cunt', 'substring'), true);
  });
});

describe('multi-word terms', () => {
  it('requires real whitespace between the words', () => {
    assert.equal(blocks('son of a gun', 'son of a gun'), true);
    assert.equal(blocks('s0n of a gun', 'son of a gun'), true);
  });
});

describe('performance', () => {
  const comment = normalizeForMatch(
    'This is a fairly ordinary comment of the length people actually write, ' +
      'with a few clauses, some punctuation, and no profanity in it at all.',
  );

  function msPerComment(termCount: number): number {
    const terms = Array.from({ length: termCount - 1 }, (_, i) => compile(`badword${i}`));
    terms.push(compile('fuck'));
    const runs = 500;
    const started = process.hrtime.bigint();
    for (let i = 0; i < runs; i += 1) {
      terms.some((c) => matchesTerm(comment, c));
    }
    return Number(process.hrtime.bigint() - started) / 1e6 / runs;
  }

  // Smoke tests against pathological backtracking, not benchmarks. Matching is a
  // linear scan over compiled terms, so cost tracks list size. Measured locally:
  // ~0.05ms at the seeded 12 terms, ~2ms at 500.
  it('is negligible at the current list size', () => {
    const ms = msPerComment(12);
    assert.ok(ms < 1, `matching took ${ms.toFixed(3)}ms per comment at 12 terms`);
  });

  it('stays acceptable at 500 terms', () => {
    const ms = msPerComment(500);
    assert.ok(ms < 10, `matching took ${ms.toFixed(3)}ms per comment at 500 terms`);
  });
});
