// One-time Spotify sign-in for the frame (PKCE, no client secret). You sign in yourself in your own browser;
// this only catches the redirect on http://127.0.0.1:8888/callback, swaps the code for a refresh token and stores
// it on the frame (kv "spotify"). Needs in .env: FRAME_URL, FRAME_ADMIN_TOKEN, SPOTIFY_CLIENT_ID
// (from your app at developer.spotify.com, with that exact redirect URI added), and optionally SPOTIFY_DEVICE
// (the Connect speaker to play on by default, e.g. your Echo Dot's name as Spotify shows it).

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';

const { FRAME_URL, FRAME_ADMIN_TOKEN, SPOTIFY_CLIENT_ID, SPOTIFY_DEVICE } = process.env;
if (!FRAME_URL || !FRAME_ADMIN_TOKEN) { console.error('Set FRAME_URL and FRAME_ADMIN_TOKEN in .env'); process.exit(1); }
if (!SPOTIFY_CLIENT_ID) {
  console.error('Set SPOTIFY_CLIENT_ID in .env: create a free app at https://developer.spotify.com/dashboard\n'
    + '(Web API; redirect URI http://127.0.0.1:8888/callback), then copy its Client ID.');
  process.exit(1);
}

const REDIRECT = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read '
  + 'playlist-read-private playlist-read-collaborative user-read-recently-played';
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(12));

const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
  client_id: SPOTIFY_CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES,
  code_challenge_method: 'S256', code_challenge: challenge, state,
});

const server = createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const done = (msg, ok) => {
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(`<body style="font:20px -apple-system;padding:60px">${msg}</body>`);
    console.log(msg.replace(/<[^>]+>/g, ''));
    server.close();
    if (!ok) process.exitCode = 1;
  };
  if (u.searchParams.get('state') !== state) return done('State mismatch, try again.', false);
  if (u.searchParams.get('error')) return done('Spotify said: ' + u.searchParams.get('error'), false);
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: u.searchParams.get('code'), redirect_uri: REDIRECT, client_id: SPOTIFY_CLIENT_ID, code_verifier: verifier }),
    });
    const t = await r.json();
    if (!t.refresh_token) throw new Error(JSON.stringify(t));
    const me = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + t.access_token } }).then((x) => x.json());
    const put = await fetch(FRAME_URL + '/api/kv/spotify', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + FRAME_ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: SPOTIFY_CLIENT_ID, refreshToken: t.refresh_token, device: SPOTIFY_DEVICE || 'Echo Dot', userId: me.id }),
    });
    if (!put.ok) throw new Error('frame said HTTP ' + put.status);
    done(`Connected${me.display_name ? ' as ' + me.display_name : ''}. The frame picks it up within 2 minutes. You can close this tab.`, true);
  } catch (e) {
    done('Sign-in failed: ' + e.message, false);
  }
});

server.listen(8888, '127.0.0.1', () => {
  console.log('Opening Spotify sign-in in your browser…\nIf it does not open, visit:\n' + authUrl);
  execFile('open', [authUrl], () => {});
});
