import { execFile } from 'node:child_process';
import { FetchError } from '../errors.js';

function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        reject(err);
      } else resolve(String(stdout));
    });
  });
}

/**
 * Optional helper around the yt-dlp program (https://github.com/yt-dlp/yt-dlp).
 * Returns null when yt-dlp is not installed.
 */
export async function createYtdlp(bin = process.env.YTDLP_PATH || 'yt-dlp') {
  try {
    const version = (await run(bin, ['--version'], 15000)).trim();
    return {
      version,
      async playlist(url, limit = 20) {
        let out;
        try {
          out = await run(bin, ['-J', '--flat-playlist', '--playlist-end', String(limit), '--no-warnings', '--ignore-config', url], 120000);
        } catch (err) {
          const msg = (err.stderr || err.message || '').split('\n').filter(Boolean).pop() || 'failed';
          const kind = /private/i.test(msg) ? 'private' : /does not exist|not found|404/i.test(msg) ? 'not_found' : /429|too many/i.test(msg) ? 'rate_limited' : 'blocked';
          throw new FetchError(kind, msg.slice(0, 200), 'yt-dlp');
        }
        try {
          return JSON.parse(out);
        } catch {
          throw new FetchError('parse', 'yt-dlp printed invalid JSON', 'yt-dlp');
        }
      },
    };
  } catch {
    return null;
  }
}
