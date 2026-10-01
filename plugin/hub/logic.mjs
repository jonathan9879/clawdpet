// Pure decision logic for the hub: what the device shows and what a button
// verdict means. No I/O here, so every rule is testable without hardware.

// Firmware text area for permission prompts: 29 columns, 11 lines.
export const PROMPT_COLS = 29;
export const PROMPT_LINES = 11;
// Hard cap on any string sent to the device.
export const MAX_FIELD = 320;

// Longest suggested reply the choice list shows without truncation.
export const REPLY_MAX = 37;

export const MODE = { idle: 0, busy: 1, waiting: 2, done: 3, prompt: 4, choice: 5, menu: 6 };

// The device font is ASCII only and the option list is '|' separated.
// Returns the cleaned text and whether anything had to change, because a
// changed prompt is not safe to approve from the device.
export function sanitize(input, max = MAX_FIELD) {
  const raw = String(input ?? '');
  let out = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\|/g, '/')
    .replace(/ {2,}/g, ' ')
    .trim();
  let truncated = false;
  if (out.length > max) {
    out = out.slice(0, max);
    truncated = true;
  }
  const changed = truncated || out !== raw.replace(/\s+/g, ' ').trim();
  return { text: out, changed, truncated };
}

// Mirrors the firmware's word wrap so the hub knows whether a prompt is
// fully visible before it offers "hold A to allow".
export function wrap(s, width, maxLines = Infinity) {
  const lines = [];
  let cur = '';
  const words = s.split(' ');
  for (let w of words) {
    if (lines.length >= maxLines) break;
    while (w.length > width) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (cur.length + (cur ? 1 : 0) + w.length > width) { lines.push(cur); cur = ''; }
    cur += (cur ? ' ' : '') + w;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines);
}

export function fitsScreen(s, width = PROMPT_COLS, maxLines = PROMPT_LINES) {
  const all = wrap(s, width);
  return all.length <= maxLines && all.join(' ').replace(/ /g, '') === s.replace(/ /g, '');
}

export function joinOptions(options) {
  return options.slice(0, 4).map((o) => sanitize(o, 37).text).join('|');
}

// A verdict is "<token>:<action>" where token itself is "<hubId>:<seq>".
export function parseVerdict(s) {
  if (typeof s !== 'string') return null;
  const i = s.lastIndexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  return { token: s.slice(0, i), action: s.slice(i + 1) };
}

export function newState() {
  return { sessions: [], activeKey: null, menuOpen: false, repliesOpen: false };
}

function find(state, key) {
  return state.sessions.find((s) => s.key === key);
}

function ensure(state, key, fields = {}) {
  let s = find(state, key);
  if (!s) {
    s = { key, pane: null, label: 'session', phase: 'idle', tool: '', pending: null, hasChannel: false };
    state.sessions.push(s);
    if (!state.activeKey) state.activeKey = key;
  }
  Object.assign(s, fields);
  return s;
}

function remove(state, key) {
  state.sessions = state.sessions.filter((s) => s.key !== key);
  if (state.activeKey === key) state.activeKey = state.sessions[0]?.key ?? null;
}

// Applies one event from a hook or channel. Returns nothing; mutates state.
// Phase events never touch a pending prompt: only a verdict, the matching
// PostToolUse, Stop, or the session going away clears one.
export function applyEvent(state, ev, now = Date.now()) {
  const key = ev.key;
  if (!key) return;
  switch (ev.type) {
    case 'register':
      ensure(state, key, { pane: ev.pane ?? null, cwd: ev.cwd, label: labelFrom(ev.cwd), hasChannel: true });
      return;
    case 'channel_closed': {
      const s = find(state, key);
      if (s) { s.pending = null; s.hasChannel = false; }
      return;
    }
    case 'session_start':
      ensure(state, key, { pane: ev.pane ?? null, cwd: ev.cwd, label: labelFrom(ev.cwd), phase: 'idle' });
      return;
    case 'session_end':
      remove(state, key);
      return;
    case 'prompt': {
      // the session you just typed into becomes the one the remote drives
      const s = ensure(state, key, { phase: 'busy', tool: '', replies: [] });
      state.activeKey = s.key;
      state.repliesOpen = false;
      return;
    }
    case 'replies': {
      // only replies shown in full are offered, so what is picked is what gets typed
      const replies = (ev.replies ?? [])
        .filter((r) => typeof r === 'string')
        .filter((r) => { const c = sanitize(r, REPLY_MAX); return c.text && !c.changed; })
        .slice(0, 4);
      ensure(state, key, { replies });
      return;
    }
    case 'pretool':
      ensure(state, key, { phase: 'busy', tool: ev.tool ?? '' });
      return;
    case 'posttool': {
      const s = ensure(state, key, { phase: 'busy' });
      if (s.pending && s.pending.tool === ev.tool) s.pending = null;
      return;
    }
    case 'notify':
      ensure(state, key, { phase: 'waiting' });
      return;
    case 'stop': {
      const s = ensure(state, key, { phase: 'done', tool: '', doneAt: now });
      s.pending = null;
      s.ask = null;
      return;
    }
    case 'ask': {
      const questions = (ev.questions ?? []).filter((q) => q?.options?.length);
      if (!ev.ask_id || !questions.length) return;
      const s = ensure(state, key, { phase: 'waiting' });
      s.ask = { ask_id: ev.ask_id, questions, idx: 0, answers: {} };
      return;
    }
    case 'ask_closed': {
      const s = find(state, key);
      if (s?.ask?.ask_id === ev.ask_id) s.ask = null;
      return;
    }
    case 'perm': {
      const s = ensure(state, key, { phase: 'waiting' });
      s.pending = {
        request_id: ev.request_id,
        tool: ev.tool_name ?? '',
        desc: ev.description ?? '',
        preview: ev.input_preview ?? '',
      };
      return;
    }
    default:
  }
}

export function labelFrom(cwd) {
  if (!cwd) return 'session';
  const parts = String(cwd).split('/').filter(Boolean);
  return parts[parts.length - 1] || '/';
}

// What the device should show now. `ref` says what a verdict on this screen
// acts on; it never leaves the hub.
export function computeScreen(state) {
  const n = state.sessions.length;
  const active = find(state, state.activeKey);
  const idx = active ? state.sessions.indexOf(active) : -1;

  if (state.menuOpen) {
    const opts = state.sessions.slice(0, 3).map((s) => {
      const mark = s.pending ? '! ' : s.key === state.activeKey ? '> ' : '- ';
      return mark + s.label;
    });
    opts.push('+ NEW SESSION');
    return { mode: MODE.menu, label: '', title: 'SESSIONS', body: '', opts: joinOptions(opts), full: false,
      ref: { kind: 'menu', keys: state.sessions.slice(0, 3).map((s) => s.key) } };
  }

  const withPending = active?.pending ? active : state.sessions.find((s) => s.pending);
  if (withPending) {
    const p = withPending.pending;
    const where = withPending === active ? '' : ` @${withPending.label}`;
    const title = sanitize(`${p.tool}${where}`, 29).text;
    const raw = [p.desc, p.preview].filter(Boolean).join(' : ');
    const body = sanitize(raw);
    const full = !body.changed && fitsScreen(body.text);
    return { mode: MODE.prompt, label: withPending.label, title, body: body.text, opts: '', full,
      ref: { kind: 'perm', key: withPending.key, request_id: p.request_id } };
  }

  const withAsk = active?.ask ? active : state.sessions.find((s) => s.ask);
  if (withAsk) {
    const a = withAsk.ask;
    const q = a.questions[a.idx];
    const count = a.questions.length > 1 ? ` (${a.idx + 1}/${a.questions.length})` : '';
    const where = withAsk === active ? '' : ` @${withAsk.label}`;
    const title = sanitize(`${q.question}${count}${where}`, 76).text;
    return { mode: MODE.choice, label: withAsk.label, title, body: '', full: false,
      opts: joinOptions(q.options.map((o) => o.label)),
      ref: { kind: 'choice', key: withAsk.key, ask_id: a.ask_id, idx: a.idx } };
  }

  if (state.repliesOpen && active?.replies?.length) {
    return { mode: MODE.choice, label: active.label, title: 'SEND A REPLY', body: '', full: false,
      opts: joinOptions(active.replies), ref: { kind: 'reply', key: active.key, replies: [...active.replies] } };
  }

  if (!active) {
    return { mode: MODE.idle, label: 'NO SESSION', title: '', body: '', opts: '', full: false, ref: { kind: 'pet' } };
  }
  const label = sanitize(`${idx + 1}/${n} ${active.label}`, 20).text;
  const mode = MODE[active.phase] ?? MODE.idle;
  const title = active.phase === 'busy' ? sanitize(active.tool || 'WORKING', 18).text.toUpperCase() : '';
  const n_r = active.replies?.length ?? 0;
  const footer = n_r ? `A REPLY(${n_r}) v SESSIONS ^ TALK` : '';
  return { mode, label, title, body: footer, opts: '', full: false, ref: { kind: 'pet', key: active.key } };
}

export function sameScreen(a, b) {
  if (!a || !b) return false;
  return a.mode === b.mode && a.label === b.label && a.title === b.title && a.body === b.body &&
    a.opts === b.opts && a.full === b.full;
}

// Decides what a verdict does. Returns a list of effects for the hub to run.
// A verdict whose token is not the one currently on screen does nothing.
export function decide(state, shown, verdict) {
  if (!shown || !verdict || verdict.token !== shown.token) return [];
  const { action } = verdict;
  const ref = shown.ref;

  if (ref.kind === 'perm' && (action === 'allow' || action === 'deny')) {
    const s = find(state, ref.key);
    if (!s || !s.pending || s.pending.request_id !== ref.request_id) return [];
    if (action === 'allow' && !shown.full) return [];
    s.pending = null;
    return [{ type: 'verdict', key: ref.key, request_id: ref.request_id, behavior: action }];
  }

  if (ref.kind === 'choice') {
    const s = find(state, ref.key);
    const a = s?.ask;
    if (!a || a.ask_id !== ref.ask_id || a.idx !== ref.idx) return [];
    if (action === 'cancel') {
      s.ask = null;
      return [{ type: 'ask_reply', ask_id: ref.ask_id, answers: null }];
    }
    const m = /^opt(\d)$/.exec(action);
    const q = a.questions[a.idx];
    const opt = m && q.options.slice(0, 4)[Number(m[1])];
    if (!opt) return [];
    // answers carry the exact original label, never the sanitized display text
    a.answers[q.question] = opt.label;
    a.idx += 1;
    if (a.idx < a.questions.length) return [];
    s.ask = null;
    return [{ type: 'ask_reply', ask_id: ref.ask_id, answers: a.answers }];
  }

  if (ref.kind === 'pet') {
    const active = find(state, state.activeKey);
    if (action === 'menu') { state.menuOpen = true; return []; }
    if (action === 'replies' && active?.replies?.length) { state.repliesOpen = true; return []; }
    // voice starts recording; voice_up (a held button released) stops and sends
    if ((action === 'voice' || action === 'voice_up') && active?.pane) return [{ type: 'voice', pane: active.pane }];
    return [];
  }

  if (ref.kind === 'reply') {
    state.repliesOpen = false;
    const s = find(state, ref.key);
    if (action === 'cancel' || !s) return [];
    const m = /^opt(\d)$/.exec(action);
    const text = m && ref.replies[Number(m[1])];
    if (!text || !s.pane) return [];
    s.replies = [];
    return [{ type: 'type', pane: s.pane, text }];
  }

  if (ref.kind === 'menu') {
    if (action === 'back') { state.menuOpen = false; return []; }
    const m = /^menu(\d)$/.exec(action);
    if (!m) return [];
    const i = Number(m[1]);
    state.menuOpen = false;
    if (i < ref.keys.length) {
      const s = find(state, ref.keys[i]);
      if (!s) return [];
      state.activeKey = s.key;
      return s.pane ? [{ type: 'focus', pane: s.pane }] : [];
    }
    if (i === ref.keys.length) {
      const cwd = find(state, state.activeKey)?.cwd;
      return [{ type: 'new_session', cwd }];
    }
  }
  return [];
}
