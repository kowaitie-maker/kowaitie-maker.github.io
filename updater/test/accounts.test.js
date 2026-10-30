import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccountInput } from '../lib/accounts.js';

test('parses the two accounts the user asked for', () => {
  assert.deepEqual(parseAccountInput('https://www.tiktok.com/@yousefali82__'), { platform: 'tiktok', username: 'yousefali82__' });
  assert.deepEqual(
    parseAccountInput('https://www.instagram.com/mohamed.ouf.xx?cplk=MTFsdTJvY2t3dHFjMg=='),
    { platform: 'instagram', username: 'mohamed.ouf.xx' },
  );
});

test('accepts common link shapes', () => {
  const cases = [
    ['tiktok.com/@Some.User', 'tiktok', 'some.user'],
    ['https://m.tiktok.com/@abc_123?lang=ar', 'tiktok', 'abc_123'],
    ['https://www.tiktok.com/@abc_123/video/7430000000000000000', 'tiktok', 'abc_123'],
    ['شوف هذا https://www.tiktok.com/@abc_123 حلو', 'tiktok', 'abc_123'],
    ['instagram.com/name.x/', 'instagram', 'name.x'],
    ['https://instagram.com/name_x/reels/', 'instagram', 'name_x'],
    ['https://www.instagram.com/name_x/?igsh=abc123', 'instagram', 'name_x'],
    ['tiktok:@abc_123', 'tiktok', 'abc_123'],
    ['ig: name.x', 'instagram', 'name.x'],
  ];
  for (const [input, platform, username] of cases) {
    assert.deepEqual(parseAccountInput(input), { platform, username }, input);
  }
});

test('bare names need a platform', () => {
  assert.equal(parseAccountInput('@someone').needsPlatform, true);
  assert.deepEqual(parseAccountInput('@someone', 'instagram'), { platform: 'instagram', username: 'someone' });
});

test('rejects links that are not profiles', () => {
  assert.match(parseAccountInput('https://www.instagram.com/p/C1abcDEF/').error, /منشور/);
  assert.match(parseAccountInput('https://vm.tiktok.com/ZMabc123/').error, /مختصر/);
  assert.match(parseAccountInput('https://youtube.com/@x').error, /المدعومة/);
  assert.ok(parseAccountInput('').error);
  assert.ok(parseAccountInput('bad name!', 'tiktok').error);
});
