#!/usr/bin/env node
// Applies a follow/unfollow request (the title of a GitHub issue opened by the
// repository owner) to accounts.json. The title comes in through the
// ISSUE_TITLE environment variable, never through the shell.
//   follow https://www.tiktok.com/@name
//   unfollow instagram:@name
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLATFORMS, parseAccountInput } from './lib/accounts.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function applyRequest(title, file) {
  const m = String(title || '').trim().match(/^(follow|unfollow)\s+(.+)$/i);
  if (!m) return { changed: false, message: 'صيغة الطلب غير مفهومة. استخدم: follow <رابط الحساب> أو unfollow <رابط الحساب>' };
  const action = m[1].toLowerCase();
  const parsed = parseAccountInput(m[2]);
  if (parsed.error) return { changed: false, message: parsed.error };
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  config.accounts ||= [];
  const label = `${PLATFORMS[parsed.platform].name} @${parsed.username}`;
  const index = config.accounts.findIndex((a) => a.platform === parsed.platform && String(a.username).toLowerCase() === parsed.username);
  if (action === 'follow') {
    if (index >= 0) return { changed: false, message: `${label} موجود في القائمة مسبقاً.` };
    config.accounts.push({ platform: parsed.platform, username: parsed.username });
  } else {
    if (index < 0) return { changed: false, message: `${label} ليس في قائمة المتابعة.` };
    config.accounts.splice(index, 1);
  }
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return {
    changed: true,
    message: action === 'follow'
      ? `✅ تمت متابعة ${label}. ستظهر منشوراته الجديدة في الصفحة خلال دقائق.`
      : `✅ أُلغيت متابعة ${label}.`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = path.join(here, '..', 'accounts.json');
  const { changed, message } = await applyRequest(process.env.ISSUE_TITLE, file);
  console.log(message);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nmessage<<RADAR_EOF\n${message}\nRADAR_EOF\n`);
  }
}
