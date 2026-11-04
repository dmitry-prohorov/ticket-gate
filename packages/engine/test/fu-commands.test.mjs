// INFRA-47: the follow-up check messages name the configured fu command, never a literal one.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkFollowUps } from '../fu.mjs';

const fm = (id, body) => ({
  name: `${id}.md`,
  text: `---\nid: ${id}\n${body}---\nsummary.\n`,
});

test('INFRA-47 FC-1 the three check messages name the configured fu command', () => {
  const errors = checkFollowUps({
    files: [
      fm('FU20', 'status: done\n'),
      fm('FU21', 'status: open\nowner: x\n'),
      {
        name: 'FU21.md',
        text: '---\nid: FU21\nstatus: open\nowner: y\n---\ns.\n',
      },
    ],
    readme: '# r\n',
    pointer: '# p\n\n- [ ] **FU1** x\n',
    dir: 'fu-dir',
    pointerPath: 'POINTER.md',
    fuCmd: 'make fu',
  });
  const joined = errors.join('\n');
  assert.match(joined, /done with no "fixed-in:".*`make fu close` sets it/);
  assert.match(joined, /duplicates FU21: take the id `make fu next` prints/);
  assert.match(
    joined,
    /POINTER\.md holds a follow-up row.*`make fu next` gives the id/,
  );
  assert.doesNotMatch(joined, /ticket-gate fu|pnpm fu/);
});
