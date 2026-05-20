import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stripGeneratedAttachmentBlock,
  userAttachmentThumbnails,
} from '../src/lib/render.js';

test('userAttachmentThumbnails renders pasted image payloads as data URLs', () => {
  assert.deepEqual(
    userAttachmentThumbnails([
      {
        kind: 'image',
        name: 'pasted.png',
        mimeType: 'image/png',
        size: 123,
        dataBase64: 'abc123',
      },
    ]),
    [
      {
        name: 'pasted.png',
        mimeType: 'image/png',
        size: 123,
        src: 'data:image/png;base64,abc123',
      },
    ],
  );
});

test('userAttachmentThumbnails renders saved history attachments through files/raw', () => {
  assert.deepEqual(
    userAttachmentThumbnails([
      {
        rel: 'uploads/screen shot.png',
        mimeType: 'image/png',
        size: 456,
      },
    ], { agentId: 'agent 1' }),
    [
      {
        name: 'screen shot.png',
        mimeType: 'image/png',
        size: 456,
        src: '/api/agents/agent%201/files/raw?path=uploads%2Fscreen%20shot.png',
      },
    ],
  );
});

test('userAttachmentThumbnails ignores non-image attachments and images without a source', () => {
  assert.deepEqual(
    userAttachmentThumbnails([
      { rel: 'uploads/readme.txt', mimeType: 'text/plain', size: 1 },
      { name: 'lost.png', mimeType: 'image/png', size: 2 },
    ], { agentId: 'a1' }),
    [],
  );
});

test('stripGeneratedAttachmentBlock hides backend-only attachment text', () => {
  const text = [
    'Please inspect this.',
    '',
    'Attached files:',
    '- /tmp/work/uploads/pasted.png (image/png, 123 bytes)',
  ].join('\n');

  assert.equal(
    stripGeneratedAttachmentBlock(text, [{ rel: 'uploads/pasted.png', mimeType: 'image/png' }]),
    'Please inspect this.',
  );
});

test('stripGeneratedAttachmentBlock returns empty text for image-only sends', () => {
  const text = 'Attached files:\n- /tmp/work/uploads/pasted.png (image/png, 123 bytes)';

  assert.equal(
    stripGeneratedAttachmentBlock(text, [{ rel: 'uploads/pasted.png', mimeType: 'image/png' }]),
    '',
  );
});

test('stripGeneratedAttachmentBlock leaves user text alone when there are no attachments', () => {
  const text = 'Attached files:\n- this is something I typed';
  assert.equal(stripGeneratedAttachmentBlock(text, []), text);
});
