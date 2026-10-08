// Run after npm run routines:build; importing the compiled UI does not mount it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { routineHealth } from '../.routines-build/ui.mjs';
import { screenTexts } from '../web/screen-texts.mjs';

test('secondary notice failures remain visible and actionable after accepted email', () => {
  for (const locale of ['pt-BR', 'en', 'es']) {
    for (const status of ['failed', 'uncertain']) {
      const health = routineHealth({ config: { execution: { status: 'completed',
        content: { status: 'complete' }, delivery: { status: 'accepted', channel: 'email',
          notification: { channel: 'whatsapp', status, error: 'private diagnostic' } },
      } } }, screenTexts('routines', locale));
      assert.equal(health.needsReview, true);
      assert.match(health.label, /email/);
      assert.match(health.label, /whatsapp/);
      assert.doesNotMatch(health.label, /private diagnostic/);
      const withoutNotice = routineHealth({ config: { execution: { status: 'completed',
        content: { status: 'complete' }, delivery: { status: 'accepted', channel: 'email' },
      } } }, screenTexts('routines', locale));
      assert.equal(withoutNotice.needsReview, false);
    }
  }
});
