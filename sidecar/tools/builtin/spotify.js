/* sidecar/tools/builtin/spotify.js — the JUKEBOX capability: control & query the user's Spotify.

   Tools (all ride the OAuth access token from sidecar/spotify/store.js, which auto-refreshes):
     READ  : spotify_search · spotify_now_playing · spotify_playlists
     CONTROL (consent-gated, execute scope): spotify_play · spotify_pause · spotify_next ·
             spotify_previous · spotify_queue

   Playback control needs Spotify Premium AND an active device (open Spotify on a phone/desktop/web player
   once). When either is missing, Spotify's own 403/404 is surfaced verbatim so the agent can tell the user
   exactly what to do. If Spotify isn't connected, every tool returns a clear "connect it in TOOLSETS" error.

   makeSpotifyTools({ store, fetchImpl? }) -> { tools[], register(reg), _internals }
   See test/spotify.tools.test.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).spotify = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const API = 'https://api.spotify.com/v1';

  function artistsOf(item) { return ((item && item.artists) || []).map(a => a.name).filter(Boolean).join(', '); }
  function trackLine(t, i) {
    if (!t) return '';
    const who = artistsOf(t); const album = t.album && t.album.name;
    return (i != null ? (i + 1) + '. ' : '') + t.name + (who ? ' — ' + who : '') + (album ? ' [' + album + ']' : '') + (t.uri ? '  (' + t.uri + ')' : '');
  }

  function makeSpotifyTools(deps) {
    deps = deps || {};
    const store = deps.store;
    if (!store) throw new Error('spotify.js requires { store }');
    const doFetch = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('spotify.js requires global fetch (Node 18+) or deps.fetchImpl');

    // One call against the Spotify Web API with the live access token. Returns parsed JSON ({} for 204),
    // and turns Spotify's error shapes into actionable messages.
    async function api(method, pathQ, body) {
      const token = await store.getAccessToken();   // throws "not connected" / "reconnect" cleanly
      const res = await doFetch(API + pathQ, {
        method,
        headers: Object.assign({ 'Authorization': 'Bearer ' + token }, body != null ? { 'Content-Type': 'application/json' } : {}),
        body: body != null ? JSON.stringify(body) : undefined
      });
      if (res.status === 204) return {};
      let json = null; try { json = await res.json(); } catch (_) {}
      if (res.status >= 200 && res.status < 300) return json || {};
      const err = json && json.error;
      const msg = (err && (err.message || err.reason)) || ('HTTP ' + res.status);
      if (res.status === 401) throw new Error('Spotify auth failed — try reconnecting in TOOLSETS. (' + msg + ')');
      if (res.status === 403) throw new Error('Spotify refused this (often: needs Spotify Premium): ' + msg);
      if (res.status === 404 && /player/.test(pathQ)) throw new Error('No active Spotify device — open Spotify on any device, start playing once, then retry. (' + msg + ')');
      if (res.status === 429) throw new Error('Spotify rate-limited the request — wait a moment and retry.');
      throw new Error('Spotify error ' + res.status + ': ' + msg);
    }

    async function resolveTrackUri(query) {
      const data = await api('GET', '/search?type=track&limit=1&q=' + encodeURIComponent(query));
      const t = data && data.tracks && data.tracks.items && data.tracks.items[0];
      if (!t) throw new Error('no track found for "' + query + '"');
      return { uri: t.uri, label: trackLine(t) };
    }

    // ---------------- READ ----------------
    const searchTool = {
      name: 'spotify_search', capability: 'jukebox', impact: 'media-control', scope: 'read', requiresConsent: false, timeoutMs: 20000,
      description: 'Search Spotify for tracks (or artists/albums/playlists). Returns names + Spotify URIs you can pass to spotify_play / spotify_queue.',
      schema: { type: 'object', required: ['query'], properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['track', 'artist', 'album', 'playlist'] },
        limit: { type: 'number' }
      } },
      run: async (args) => {
        const type = args.type || 'track';
        const limit = Math.max(1, Math.min(20, Number(args.limit) || 8));
        const data = await api('GET', '/search?type=' + type + '&limit=' + limit + '&q=' + encodeURIComponent(args.query));
        const items = (data[type + 's'] && data[type + 's'].items) || [];
        if (!items.length) return { content: 'No ' + type + ' results for "' + args.query + '".', summary: '0 results' };
        const lines = items.map((it, i) => type === 'track'
          ? trackLine(it, i)
          : (i + 1) + '. ' + it.name + (it.uri ? '  (' + it.uri + ')' : '') + (type === 'artist' && it.followers ? ' — ' + it.followers.total + ' followers' : ''));
        return { content: lines.join('\n'), summary: items.length + ' ' + type + '(s)' };
      }
    };

    const nowPlayingTool = {
      name: 'spotify_now_playing', capability: 'jukebox', impact: 'media-control', scope: 'read', requiresConsent: false, timeoutMs: 15000,
      description: 'Show what is currently playing on the user\'s Spotify (track, artist, whether paused, progress).',
      schema: { type: 'object', properties: {} },
      run: async () => {
        const data = await api('GET', '/me/player/currently-playing');
        if (!data || !data.item) return { content: 'Nothing is playing right now.', summary: 'idle' };
        const t = data.item;
        const pct = (data.progress_ms != null && t.duration_ms) ? ' (' + Math.round(100 * data.progress_ms / t.duration_ms) + '%)' : '';
        const stateLbl = data.is_playing ? '▶ playing' : '⏸ paused';
        return { content: stateLbl + ': ' + trackLine(t) + pct, summary: data.is_playing ? 'playing' : 'paused' };
      }
    };

    const playlistsTool = {
      name: 'spotify_playlists', capability: 'jukebox', impact: 'media-control', scope: 'read', requiresConsent: false, timeoutMs: 15000,
      description: 'List the user\'s Spotify playlists (name + URI). Pass a URI to spotify_play to play one.',
      schema: { type: 'object', properties: { limit: { type: 'number' } } },
      run: async (args) => {
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
        const data = await api('GET', '/me/playlists?limit=' + limit);
        const items = (data && data.items) || [];
        if (!items.length) return { content: 'No playlists found.', summary: '0 playlists' };
        const lines = items.map((p, i) => (i + 1) + '. ' + p.name + (p.tracks ? ' (' + p.tracks.total + ' tracks)' : '') + '  (' + p.uri + ')');
        return { content: lines.join('\n'), summary: items.length + ' playlist(s)' };
      }
    };

    // ---------------- CONTROL (consent-gated) ----------------
    const dev = (args) => (args && args.deviceId) ? ('?device_id=' + encodeURIComponent(args.deviceId)) : '';

    const playTool = {
      name: 'spotify_play', capability: 'jukebox', impact: 'media-control', scope: 'execute', requiresConsent: true, timeoutMs: 20000,
      description: 'Start or resume playback. Pass "uri" (a spotify: track/album/playlist/artist URI) OR "query" ' +
        '(a search phrase — the top track is played). With neither, resumes the current track. Needs Premium + an active device.',
      schema: { type: 'object', properties: { uri: { type: 'string' }, query: { type: 'string' }, deviceId: { type: 'string' } } },
      run: async (args) => {
        let uri = args.uri && String(args.uri).trim();
        let label = uri;
        if (!uri && args.query) { const r = await resolveTrackUri(args.query); uri = r.uri; label = r.label; }
        let body;
        if (uri) body = /^spotify:track:/.test(uri) ? { uris: [uri] } : { context_uri: uri };
        await api('PUT', '/me/player/play' + dev(args), body || {});
        return { content: uri ? ('Playing ' + (label || uri)) : 'Resumed playback.', summary: uri ? 'play' : 'resume' };
      }
    };

    const pauseTool = {
      name: 'spotify_pause', capability: 'jukebox', impact: 'media-control', scope: 'execute', requiresConsent: true, timeoutMs: 15000,
      description: 'Pause Spotify playback.',
      schema: { type: 'object', properties: { deviceId: { type: 'string' } } },
      run: async (args) => { await api('PUT', '/me/player/pause' + dev(args)); return { content: 'Paused.', summary: 'pause' }; }
    };

    const nextTool = {
      name: 'spotify_next', capability: 'jukebox', impact: 'media-control', scope: 'execute', requiresConsent: true, timeoutMs: 15000,
      description: 'Skip to the next track.',
      schema: { type: 'object', properties: { deviceId: { type: 'string' } } },
      run: async (args) => { await api('POST', '/me/player/next' + dev(args)); return { content: 'Skipped to next track.', summary: 'next' }; }
    };

    const prevTool = {
      name: 'spotify_previous', capability: 'jukebox', impact: 'media-control', scope: 'execute', requiresConsent: true, timeoutMs: 15000,
      description: 'Go back to the previous track.',
      schema: { type: 'object', properties: { deviceId: { type: 'string' } } },
      run: async (args) => { await api('POST', '/me/player/previous' + dev(args)); return { content: 'Went to previous track.', summary: 'previous' }; }
    };

    const queueTool = {
      name: 'spotify_queue', capability: 'jukebox', impact: 'media-control', scope: 'execute', requiresConsent: true, timeoutMs: 20000,
      description: 'Add a track to the playback queue. Pass "uri" (spotify:track:…) OR "query" (search phrase — top track queued).',
      schema: { type: 'object', properties: { uri: { type: 'string' }, query: { type: 'string' }, deviceId: { type: 'string' } } },
      run: async (args) => {
        let uri = args.uri && String(args.uri).trim(); let label = uri;
        if (!uri && args.query) { const r = await resolveTrackUri(args.query); uri = r.uri; label = r.label; }
        if (!uri) throw new Error('spotify_queue needs a "uri" or "query"');
        await api('POST', '/me/player/queue?uri=' + encodeURIComponent(uri) + (args.deviceId ? '&device_id=' + encodeURIComponent(args.deviceId) : ''));
        return { content: 'Queued ' + (label || uri), summary: 'queued' };
      }
    };

    const tools = [searchTool, nowPlayingTool, playlistsTool, playTool, pauseTool, nextTool, prevTool, queueTool];
    return {
      tools,
      _internals: { trackLine, artistsOf, resolveTrackUri },
      register(reg) { tools.forEach(t => reg.register(t)); return reg; }
    };
  }

  return { makeSpotifyTools };
});
