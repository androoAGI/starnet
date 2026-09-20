'use strict';

// Local MCP adapter over Google's stable APIs. No hosted intermediary, preview
// enrollment, arbitrary URL, or bearer in a query string. The existing connector
// manager owns permissions, refresh, reconnect, cancellation and tool projection.
const ENDPOINTS = Object.freeze({
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
  'google-drive': 'https://www.googleapis.com/drive/v3',
  'google-calendar': 'https://www.googleapis.com/calendar/v3',
  'google-docs': 'https://docs.googleapis.com/v1/documents',
  'google-sheets': 'https://sheets.googleapis.com/v4/spreadsheets',
  'google-files': 'https://www.googleapis.com/drive/v3#selected-files'
});
const STR = { type: 'string' };
function tool(name, description, properties, required, readOnly) {
  return { name, description, inputSchema: { type: 'object', properties, required: required || [], additionalProperties: false },
    annotations: { readOnlyHint: !!readOnly, destructiveHint: !readOnly, openWorldHint: true } };
}
const TOOLS = {
  gmail: [
    tool('search_messages', 'Search Gmail using Gmail search syntax. Returns message IDs; use read_message for contents.', { query: STR, pageToken: STR, maxResults: { type: 'integer', minimum: 1, maximum: 100 } }, [], true),
    tool('read_message', 'Read a Gmail message, including its MIME headers and base64url-encoded body parts.', { messageId: STR }, ['messageId'], true),
    tool('read_thread', 'Read the messages in a Gmail thread.', { threadId: STR }, ['threadId'], true),
    tool('read_attachment', 'Read a Gmail attachment as base64url data (bounded to 8 MiB).', { messageId: STR, attachmentId: STR }, ['messageId', 'attachmentId'], true),
    tool('create_draft', 'Save an email draft. Does not send. raw is a base64url-encoded RFC 2822 MIME message.', { raw: STR, threadId: STR }, ['raw']),
    tool('send_draft', 'SEND an existing draft to its recipients. This is an external message; obtain the user’s authorization before sending.', { draftId: STR }, ['draftId'])
  ],
  'google-drive': [
    tool('list_files', 'Search Drive with a Drive query; follows pageToken for pagination.', { query: STR, pageToken: STR, pageSize: { type: 'integer', minimum: 1, maximum: 100 } }, [], true),
    tool('get_file', 'Get Drive file metadata.', { fileId: STR }, ['fileId'], true),
    tool('export_file', 'Export a Google Workspace file as text/plain, text/csv, or text/html. Binary exports are not supported by this tool.', { fileId: STR, mimeType: { type: 'string', enum: ['text/plain', 'text/csv', 'text/html'] } }, ['fileId', 'mimeType'], true),
    tool('create_file', 'Create Drive file metadata, including folders. File access follows the permissions granted to StarNet.', { metadata: { type: 'object' } }, ['metadata']),
    tool('update_file', 'Update metadata for a Drive file accessible to StarNet, including name or description.', { fileId: STR, metadata: { type: 'object' } }, ['fileId', 'metadata'])
  ],
  'google-calendar': [
    tool('list_calendars', 'List the signed-in account’s calendars.', { pageToken: STR }, [], true),
    tool('list_events', 'Read calendar events. Dates are RFC3339; calendarId defaults to primary.', { calendarId: STR, timeMin: STR, timeMax: STR, pageToken: STR, query: STR }, [], true),
    tool('get_event', 'Read one calendar event.', { calendarId: STR, eventId: STR }, ['eventId'], true),
    tool('free_busy', 'Read free/busy availability for calendar IDs between two RFC3339 timestamps.', { timeMin: STR, timeMax: STR, calendarIds: { type: 'array', items: STR, minItems: 1, maxItems: 50 } }, ['timeMin', 'timeMax', 'calendarIds'], true)
  ],
  'google-docs': [
    tool('get_document', 'Read a Google document and its structured content.', { documentId: STR }, ['documentId'], true),
    tool('create_document', 'Create a Google document with a title.', { title: STR }, ['title']),
    tool('batch_update', 'Edit a Google document using Docs API batchUpdate requests. Use writeControl to avoid overwriting concurrent edits.', { documentId: STR, requests: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 100 }, writeControl: { type: 'object' } }, ['documentId', 'requests'])
  ],
  'google-sheets': [
    tool('get_spreadsheet', 'Read spreadsheet metadata, sheets and named ranges.', { spreadsheetId: STR }, ['spreadsheetId'], true),
    tool('read_values', 'Read cells from an A1 range.', { spreadsheetId: STR, range: STR }, ['spreadsheetId', 'range'], true),
    tool('create_spreadsheet', 'Create a spreadsheet with a title.', { title: STR }, ['title']),
    tool('write_values', 'Write cell values to an A1 range. Uses RAW values by default; USER_ENTERED evaluates formulas.', { spreadsheetId: STR, range: STR, values: { type: 'array', items: { type: 'array' }, maxItems: 10000 }, valueInputOption: { type: 'string', enum: ['RAW', 'USER_ENTERED'] } }, ['spreadsheetId', 'range', 'values']),
    tool('batch_update', 'Edit spreadsheet structure and formatting with Sheets API batchUpdate requests.', { spreadsheetId: STR, requests: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 100 } }, ['spreadsheetId', 'requests'])
  ]
};
// One per-file grant serves Drive metadata, Docs and Sheets; duplicate method
// names are qualified so tool routing cannot silently select the wrong API.
TOOLS['google-files'] = [
  ...TOOLS['google-drive'].filter(t => ['list_files', 'get_file', 'export_file'].includes(t.name)).map(t => ({ ...t, description: t.description + ' Only files granted to StarNet are accessible.' })),
  ...TOOLS['google-docs'].map(t => ({ ...t, name: 'docs_' + t.name })),
  ...TOOLS['google-sheets'].map(t => ({ ...t, name: 'sheets_' + t.name }))
];
function productForUrl(url) { return Object.keys(ENDPOINTS).find(id => ENDPOINTS[id] === url) || null; }
function segment(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f]/.test(value) || value === '.' || value === '..') throw new Error('Invalid Google resource identifier');
  return encodeURIComponent(value);
}
function validate(def, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  for (const k of Object.keys(args)) {
    const schema = def.inputSchema.properties[k], v = args[k];
    if (!schema) throw new Error('Unknown argument: ' + k);
    const good = schema.type === 'array' ? Array.isArray(v) : schema.type === 'integer' ? Number.isInteger(v) : schema.type === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === schema.type;
    if (!good || (schema.enum && !schema.enum.includes(v)) || (schema.minimum != null && v < schema.minimum) || (schema.maximum != null && v > schema.maximum) || (schema.minItems != null && v.length < schema.minItems) || (schema.maxItems != null && v.length > schema.maxItems)) throw new Error('Invalid argument: ' + k);
    if (typeof v === 'string' && v.length > 1024 * 1024) throw new Error('Argument is too large');
  }
  for (const k of def.inputSchema.required) if (!(k in args)) throw new Error('Missing argument: ' + k);
}
function requestFor(product, name, a) {
  if (product === 'google-files') {
    if (name.startsWith('docs_')) return requestFor('google-docs', name.slice(5), a);
    if (name.startsWith('sheets_')) return requestFor('google-sheets', name.slice(7), a);
    return requestFor('google-drive', name, a);
  }
  const base = ENDPOINTS[product];
  const get = (path, query) => ({ url: base + path, query, method: 'GET' });
  const write = (path, body, method = 'POST', query) => ({ url: base + path, body, method, query });
  if (product === 'gmail') {
    if (name === 'search_messages') return get('/messages', { q: a.query, maxResults: a.maxResults || 25, pageToken: a.pageToken });
    if (name === 'read_message') return get('/messages/' + segment(a.messageId), { format: 'full' });
    if (name === 'read_thread') return get('/threads/' + segment(a.threadId), { format: 'full' });
    if (name === 'read_attachment') return get('/messages/' + segment(a.messageId) + '/attachments/' + segment(a.attachmentId));
    if (name === 'create_draft') {
      if (!/^[A-Za-z0-9_-]+={0,2}$/.test(a.raw)) throw new Error('raw must be a base64url MIME message');
      return write('/drafts', { message: { raw: a.raw, ...(a.threadId ? { threadId: a.threadId } : {}) } });
    }
    if (name === 'send_draft') return write('/drafts/send', { id: a.draftId });
  }
  if (product === 'google-drive') {
    if (name === 'list_files') return get('/files', { q: a.query, pageToken: a.pageToken, pageSize: a.pageSize || 25, fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)' });
    if (name === 'get_file') return get('/files/' + segment(a.fileId), { fields: 'id,name,mimeType,description,modifiedTime,webViewLink,parents,size' });
    if (name === 'export_file') return { ...get('/files/' + segment(a.fileId) + '/export', { mimeType: a.mimeType }), text: true };
    if (name === 'create_file') return write('/files', a.metadata);
    if (name === 'update_file') return write('/files/' + segment(a.fileId), a.metadata, 'PATCH');
  }
  if (product === 'google-calendar') {
    if (name === 'list_calendars') return get('/users/me/calendarList', { pageToken: a.pageToken, maxResults: 100 });
    if (name === 'list_events') return get('/calendars/' + segment(a.calendarId || 'primary') + '/events', { timeMin: a.timeMin, timeMax: a.timeMax, pageToken: a.pageToken, q: a.query, maxResults: 100, singleEvents: true, orderBy: 'startTime' });
    if (name === 'get_event') return get('/calendars/' + segment(a.calendarId || 'primary') + '/events/' + segment(a.eventId));
    if (name === 'free_busy') return write('/freeBusy', { timeMin: a.timeMin, timeMax: a.timeMax, items: a.calendarIds.map(id => ({ id })) });
  }
  if (product === 'google-docs') {
    if (name === 'get_document') return get('/' + segment(a.documentId));
    if (name === 'create_document') return write('', { title: a.title });
    if (name === 'batch_update') return write('/' + segment(a.documentId) + ':batchUpdate', { requests: a.requests, ...(a.writeControl ? { writeControl: a.writeControl } : {}) });
  }
  if (product === 'google-sheets') {
    const sheet = a.spreadsheetId ? '/' + segment(a.spreadsheetId) : '';
    if (name === 'get_spreadsheet') return get(sheet, { includeGridData: false });
    if (name === 'read_values') return get(sheet + '/values/' + segment(a.range));
    if (name === 'create_spreadsheet') return write('', { properties: { title: a.title } });
    if (name === 'write_values') return write(sheet + '/values/' + segment(a.range), { range: a.range, values: a.values }, 'PUT', { valueInputOption: a.valueInputOption || 'RAW' });
    if (name === 'batch_update') return write(sheet + ':batchUpdate', { requests: a.requests });
  }
  throw new Error('Unknown Google tool');
}

function makeGoogleTransport({ url, token, fetchImpl = fetch, timeoutMs = 30000 }) {
  const product = productForUrl(url);
  if (!product) throw new Error('Unknown Google connector');
  let receive = () => {}, closed = false;
  const controllers = new Set();
  async function request(spec) {
    if (!token) throw new Error('connector HTTP 401 — sign in to Google');
    const target = new URL(spec.url);
    for (const [k, v] of Object.entries(spec.query || {})) if (v !== undefined && v !== '') target.searchParams.set(k, String(v));
    const ctrl = new AbortController(); controllers.add(ctrl);
    let timer;
    try {
      return await Promise.race([new Promise((_, reject) => { timer = setTimeout(() => { ctrl.abort(); reject(new Error('Google request timed out')); }, timeoutMs); }), (async () => {
        const body = spec.body ? JSON.stringify(spec.body) : undefined;
        if (body && Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Google request exceeds 2 MiB; split the edit');
        let r;
        try { r = await fetchImpl(target.href, { method: spec.method || 'GET', headers: { Authorization: 'Bearer ' + token, Accept: spec.text ? 'text/plain' : 'application/json', 'Content-Type': 'application/json' }, body, redirect: 'error', signal: ctrl.signal }); }
        catch (_) { throw new Error('Google request failed or was cancelled'); }
        if (!r.ok) { try { await r.body?.cancel(); } catch (_) { ctrl.abort(); } throw new Error('connector HTTP ' + r.status + (r.status === 403 ? ' — Google denied access; check the permissions granted to StarNet' : '')); }
        const reader = r.body?.getReader(); let text = '';
        if (reader) {
          const chunks = []; let size = 0;
          try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Google response exceeds 8 MiB; narrow the request'); } chunks.push(Buffer.from(value)); } }
          finally { reader.releaseLock(); }
          text = Buffer.concat(chunks).toString('utf8');
        } else { text = await r.text(); if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Google response exceeds 8 MiB'); }
        if (spec.text) return text;
        try { return text ? JSON.parse(text) : {}; } catch (_) { throw new Error('Google returned invalid JSON'); }
      })()]);
    } finally { clearTimeout(timer); controllers.delete(ctrl); }
  }
  async function send(msg) {
    if (msg.id == null) return;
    try {
      if (closed) throw new Error('Google connector closed');
      let result;
      if (msg.method === 'initialize') {
        // Prove the account/service responds before publishing connected status.
        const probe = product === 'gmail' ? { url: url + '/profile' } : product === 'google-calendar' ? { url: url + '/users/me/calendarList', query: { maxResults: 1 } }
          : { url: ENDPOINTS['google-drive'] + '/files', query: { pageSize: 1, fields: 'files(id)' } };
        await request(probe);
        result = { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'StarNet Google API connector', version: '1' } };
      } else if (msg.method === 'tools/list') result = { tools: TOOLS[product] };
      else if (msg.method === 'tools/call') {
        const def = TOOLS[product].find(t => t.name === msg.params?.name);
        if (!def) throw new Error('Unknown Google tool');
        const args = msg.params.arguments || {}; validate(def, args);
        const value = await request(requestFor(product, def.name, args));
        result = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError: false };
      } else if (msg.method === 'ping') result = {};
      else throw new Error('Unsupported Google MCP method');
      if (!closed) receive({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      // These are local validation/transport errors with sanitized API status,
      // not remote JSON-RPC prose. Rejection preserves the manager's 401 recovery.
      throw e;
    }
  }
  return { send, onMessage(cb) { receive = cb; }, close() { closed = true; for (const ctrl of controllers) ctrl.abort(); controllers.clear(); } };
}
module.exports = { ENDPOINTS, TOOLS, productForUrl, makeGoogleTransport, requestFor, validate };
