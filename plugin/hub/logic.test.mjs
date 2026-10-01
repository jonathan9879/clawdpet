import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  sanitize, wrap, fitsScreen, joinOptions, parseVerdict, newState, applyEvent, computeScreen, decide, MODE,
  PROMPT_COLS, PROMPT_LINES,
} from './logic.mjs';

const perm = (key, request_id = 'abcde', tool_name = 'Bash', description = 'List files', input_preview = '{"command":"ls"}') =>
  ({ type: 'perm', key, request_id, tool_name, description, input_preview });

function stateWithPrompt() {
  const s = newState();
  applyEvent(s, { type: 'register', key: '%1', pane: '%1', cwd: '/Users/me/flat' });
  applyEvent(s, perm('%1'));
  return s;
}

const shownFor = (state, token = 'h:1') => ({ ...computeScreen(state), token });

test('sanitize output is printable ASCII without pipes, capped, and idempotent', () => {
  fc.assert(fc.property(fc.string({ unit: 'binary' }), fc.integer({ min: 1, max: 400 }), (s, max) => {
    const { text } = sanitize(s, max);
    assert.ok(text.length <= max);
    assert.match(text, /^[\x20-\x7e]*$/);
    assert.ok(!text.includes('|'));
    assert.equal(sanitize(text, max).text, text);
  }));
});

test('sanitize flags any text it had to alter so the device offers deny only', () => {
  const cases = [
    ['plain ascii', 'ls -la', false],
    ['accent folded', 'café', true],
    ['pipe replaced', 'a | b', true],
    ['emoji replaced', 'ok 👍', true],
    ['truncated', 'x'.repeat(400), true],
  ];
  for (const [, input, changed] of cases) assert.equal(sanitize(input).changed, changed, input);
});

test('wrap never loses characters and respects the column width', () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z]{1,40}( [a-z]{1,40}){0,30}$/), (s) => {
    const lines = wrap(s, PROMPT_COLS);
    for (const l of lines) assert.ok(l.length <= PROMPT_COLS);
    assert.equal(lines.join('').replace(/ /g, ''), s.replace(/ /g, ''));
  }));
});

test('fitsScreen is true only when every character is on screen', () => {
  assert.equal(fitsScreen('short command'), true);
  assert.equal(fitsScreen('word '.repeat(80).trim()), false);
  assert.equal(fitsScreen('x'.repeat(PROMPT_COLS * PROMPT_LINES)), true);
  assert.equal(fitsScreen('x'.repeat(PROMPT_COLS * PROMPT_LINES + 1)), false);
});

test('options keep at most four entries and round-trip through the separator', () => {
  fc.assert(fc.property(fc.array(fc.stringMatching(/^[A-Za-z0-9 ]{1,30}$/), { minLength: 1, maxLength: 8 }), (opts) => {
    const parts = joinOptions(opts).split('|');
    assert.equal(parts.length, Math.min(4, opts.length));
    parts.forEach((p, i) => assert.equal(p, sanitize(opts[i], 37).text));
  }));
});

test('parseVerdict splits the token from the action at the last colon', () => {
  assert.deepEqual(parseVerdict('a1b2:7:allow'), { token: 'a1b2:7', action: 'allow' });
  for (const bad of ['', 'allow', ':allow', 'a1b2:7:', null, 42]) assert.equal(parseVerdict(bad), null);
});

test('a pending prompt fully visible on screen is shown as approvable', () => {
  const screen = computeScreen(stateWithPrompt());
  assert.equal(screen.mode, MODE.prompt);
  assert.equal(screen.title, 'Bash');
  assert.equal(screen.body, 'List files : {"command":"ls"}');
  assert.equal(screen.full, true);
});

test('a prompt that does not fit is shown deny-only', () => {
  const s = newState();
  applyEvent(s, { type: 'register', key: '%1', pane: '%1', cwd: '/x' });
  applyEvent(s, perm('%1', 'abcde', 'Bash', 'Run', `{"command":"${'echo hi && '.repeat(40)}rm -rf ~"}`));
  assert.equal(computeScreen(s).full, false);
});

test('verdict routing follows the case table', () => {
  const cases = [
    { name: 'allow on the shown token reaches the channel', token: 'h:1', action: 'allow', effects: 1, cleared: true },
    { name: 'deny on the shown token reaches the channel', token: 'h:1', action: 'deny', effects: 1, cleared: true },
    { name: 'a stale token is dropped', token: 'h:0', action: 'allow', effects: 0, cleared: false },
    { name: 'a token from another hub is dropped', token: 'other:1', action: 'allow', effects: 0, cleared: false },
    { name: 'an unknown action is dropped', token: 'h:1', action: 'opt0', effects: 0, cleared: false },
  ];
  for (const c of cases) {
    const s = stateWithPrompt();
    const fx = decide(s, shownFor(s), { token: c.token, action: c.action });
    assert.equal(fx.length, c.effects, c.name);
    if (c.effects) assert.deepEqual(fx[0], { type: 'verdict', key: '%1', request_id: 'abcde', behavior: c.action }, c.name);
    assert.equal(s.sessions[0].pending === null, c.cleared, c.name);
  }
});

test('a duplicate verdict after the prompt was answered does nothing', () => {
  const s = stateWithPrompt();
  const shown = shownFor(s);
  assert.equal(decide(s, shown, { token: 'h:1', action: 'allow' }).length, 1);
  assert.equal(decide(s, shown, { token: 'h:1', action: 'allow' }).length, 0);
});

test('allow is refused for a prompt shown deny-only', () => {
  const s = newState();
  applyEvent(s, { type: 'register', key: '%1', pane: '%1', cwd: '/x' });
  applyEvent(s, perm('%1', 'abcde', 'Bash', 'Run', 'x'.repeat(500)));
  const shown = shownFor(s);
  assert.equal(shown.full, false);
  assert.deepEqual(decide(s, shown, { token: 'h:1', action: 'allow' }), []);
  assert.equal(decide(s, shown, { token: 'h:1', action: 'deny' })[0].behavior, 'deny');
});

test('a verdict after the prompt was replaced by a newer one does not approve the newer one', () => {
  const s = stateWithPrompt();
  const oldShown = shownFor(s, 'h:1');
  applyEvent(s, { type: 'posttool', key: '%1', tool: 'Bash' });
  applyEvent(s, perm('%1', 'fghij'));
  assert.deepEqual(decide(s, oldShown, { token: 'h:1', action: 'allow' }), []);
  assert.equal(s.sessions[0].pending.request_id, 'fghij');
});

test('phase events never clear a pending prompt', () => {
  for (const type of ['prompt', 'pretool', 'notify']) {
    const s = stateWithPrompt();
    applyEvent(s, { type, key: '%1', tool: 'Read' });
    assert.equal(s.sessions[0].pending?.request_id, 'abcde', type);
  }
});

test('the prompt clears on the matching PostToolUse, Stop, or a closed channel', () => {
  const cases = [
    [{ type: 'posttool', key: '%1', tool: 'Bash' }, true],
    [{ type: 'posttool', key: '%1', tool: 'Read' }, false],
    [{ type: 'stop', key: '%1' }, true],
    [{ type: 'channel_closed', key: '%1' }, true],
  ];
  for (const [ev, cleared] of cases) {
    const s = stateWithPrompt();
    applyEvent(s, ev);
    assert.equal(s.sessions[0].pending === null, cleared, JSON.stringify(ev));
  }
});

test('a background session prompt is shown with its session name', () => {
  const s = newState();
  applyEvent(s, { type: 'register', key: '%1', pane: '%1', cwd: '/a/front' });
  applyEvent(s, { type: 'register', key: '%2', pane: '%2', cwd: '/a/back' });
  applyEvent(s, perm('%2'));
  const screen = computeScreen(s);
  assert.equal(screen.title, 'Bash @back');
  assert.equal(screen.ref.key, '%2');
});

test('pet screens follow the active session phase', () => {
  const cases = [
    [{ type: 'prompt' }, MODE.busy],
    [{ type: 'pretool', tool: 'Edit' }, MODE.busy],
    [{ type: 'notify' }, MODE.waiting],
    [{ type: 'stop' }, MODE.done],
  ];
  for (const [ev, mode] of cases) {
    const s = newState();
    applyEvent(s, { type: 'register', key: '%1', pane: '%1', cwd: '/a/flat' });
    applyEvent(s, { ...ev, key: '%1' });
    const screen = computeScreen(s);
    assert.equal(screen.mode, mode, ev.type);
    assert.equal(screen.label, '1/1 flat');
  }
});

test('the sessions menu switches, opens a new session, or closes', () => {
  const s = newState();
  applyEvent(s, { type: 'register', key: '%1', pane: '%1', cwd: '/a/one' });
  applyEvent(s, { type: 'register', key: '%2', pane: '%2', cwd: '/a/two' });
  assert.deepEqual(decide(s, shownFor(s), { token: 'h:1', action: 'menu' }), []);
  assert.equal(s.menuOpen, true);
  const menu = shownFor(s, 'h:2');
  assert.equal(menu.opts, '> one|- two|+ NEW SESSION');
  assert.deepEqual(decide(s, menu, { token: 'h:2', action: 'menu1' }), [{ type: 'focus', pane: '%2' }]);
  assert.equal(s.activeKey, '%2');
  assert.equal(s.menuOpen, false);

  decide(s, shownFor(s, 'h:3'), { token: 'h:3', action: 'menu' });
  const fx = decide(s, shownFor(s, 'h:4'), { token: 'h:4', action: 'menu2' });
  assert.deepEqual(fx, [{ type: 'new_session', cwd: '/a/two' }]);
});

test('voice goes to the active pane only', () => {
  const s = newState();
  applyEvent(s, { type: 'register', key: '%7', pane: '%7', cwd: '/a' });
  assert.deepEqual(decide(s, shownFor(s), { token: 'h:1', action: 'voice' }), [{ type: 'voice', pane: '%7' }]);
  const noPane = newState();
  applyEvent(noPane, { type: 'session_start', key: 'sess-1', cwd: '/a' });
  assert.deepEqual(decide(noPane, shownFor(noPane), { token: 'h:1', action: 'voice' }), []);
});

const color = { question: 'Which color?', header: 'Color', multiSelect: false,
  options: [{ label: 'Red', description: '' }, { label: 'Blue (café)', description: '' }] };
const size = { question: 'Which size?', header: 'Size', multiSelect: false,
  options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }] };

function stateWithAsk(questions = [color]) {
  const s = newState();
  applyEvent(s, { type: 'register', key: '%1', pane: '%1', cwd: '/a/flat' });
  applyEvent(s, { type: 'ask', key: '%1', ask_id: 'q1', questions });
  return s;
}

test('a question is shown as a choice list with its options', () => {
  const screen = computeScreen(stateWithAsk());
  assert.equal(screen.mode, MODE.choice);
  assert.equal(screen.title, 'Which color?');
  assert.equal(screen.opts, 'Red|Blue (cafe)');
});

test('picking an option answers with the exact original label', () => {
  const s = stateWithAsk();
  const fx = decide(s, shownFor(s), { token: 'h:1', action: 'opt1' });
  assert.deepEqual(fx, [{ type: 'ask_reply', ask_id: 'q1', answers: { 'Which color?': 'Blue (café)' } }]);
  assert.equal(s.sessions[0].ask, null);
});

test('several questions are asked one at a time and answered together', () => {
  const s = stateWithAsk([color, size]);
  assert.deepEqual(decide(s, shownFor(s, 'h:1'), { token: 'h:1', action: 'opt0' }), []);
  const second = shownFor(s, 'h:2');
  assert.equal(second.title, 'Which size? (2/2)');
  const fx = decide(s, second, { token: 'h:2', action: 'opt2' });
  assert.deepEqual(fx[0].answers, { 'Which color?': 'Red', 'Which size?': 'L' });
});

test('question verdicts that do not match the shown question do nothing', () => {
  const cases = [
    ['an option past the list', 'opt3'],
    ['a malformed action', 'optx'],
    ['an approval verb', 'allow'],
  ];
  for (const [name, action] of cases) {
    const s = stateWithAsk();
    assert.deepEqual(decide(s, shownFor(s), { token: 'h:1', action }), [], name);
    assert.ok(s.sessions[0].ask, name);
  }
});

test('cancel sends the question back to the keyboard', () => {
  const s = stateWithAsk();
  assert.deepEqual(decide(s, shownFor(s), { token: 'h:1', action: 'cancel' }),
    [{ type: 'ask_reply', ask_id: 'q1', answers: null }]);
  assert.equal(s.sessions[0].ask, null);
});

test('a question ends when its hook goes away or the turn stops', () => {
  const cases = [
    [{ type: 'ask_closed', key: '%1', ask_id: 'q1' }, true],
    [{ type: 'ask_closed', key: '%1', ask_id: 'other' }, false],
    [{ type: 'stop', key: '%1' }, true],
    [{ type: 'pretool', key: '%1', tool: 'Read' }, false],
  ];
  for (const [ev, cleared] of cases) {
    const s = stateWithAsk();
    applyEvent(s, ev);
    assert.equal(s.sessions[0].ask === null, cleared, JSON.stringify(ev));
  }
});

test('a permission prompt takes priority over a question', () => {
  const s = stateWithAsk();
  applyEvent(s, perm('%1'));
  assert.equal(computeScreen(s).mode, MODE.prompt);
});

function stateWithReplies(replies = ['yes, run the tests', 'no thanks']) {
  const s = newState();
  applyEvent(s, { type: 'register', key: '%1', pane: '%1', cwd: '/a/flat' });
  applyEvent(s, { type: 'stop', key: '%1' });
  applyEvent(s, { type: 'replies', key: '%1', replies });
  return s;
}

test('waiting replies show as a footer hint on the pet screen', () => {
  const screen = computeScreen(stateWithReplies());
  assert.equal(screen.mode, MODE.done);
  assert.equal(screen.body, 'A REPLY(2) v SESSIONS ^ TALK');
  const none = newState();
  applyEvent(none, { type: 'register', key: '%1', pane: '%1', cwd: '/a' });
  assert.equal(computeScreen(none).body, '');
});

test('A opens the replies and picking one types its exact text into the pane', () => {
  const s = stateWithReplies();
  assert.deepEqual(decide(s, shownFor(s, 'h:1'), { token: 'h:1', action: 'replies' }), []);
  const list = shownFor(s, 'h:2');
  assert.equal(list.mode, MODE.choice);
  assert.equal(list.opts, 'yes, run the tests|no thanks');
  assert.deepEqual(decide(s, list, { token: 'h:2', action: 'opt0' }),
    [{ type: 'type', pane: '%1', text: 'yes, run the tests' }]);
  assert.deepEqual(s.sessions[0].replies, []);
  assert.equal(s.repliesOpen, false);
});

test('replies that would be altered or cut on screen are not offered', () => {
  const s = stateWithReplies(['ok', 'café', 'a | b', 'x'.repeat(38), 'fine']);
  assert.deepEqual(s.sessions[0].replies, ['ok', 'fine']);
});

test('a new prompt clears old replies and makes that session active', () => {
  const s = stateWithReplies();
  applyEvent(s, { type: 'register', key: '%2', pane: '%2', cwd: '/a/two' });
  applyEvent(s, { type: 'prompt', key: '%1' });
  assert.deepEqual(s.sessions[0].replies, []);
  applyEvent(s, { type: 'prompt', key: '%2' });
  assert.equal(s.activeKey, '%2');
});

test('A with no replies waiting does nothing, and B closes the reply list', () => {
  const empty = newState();
  applyEvent(empty, { type: 'register', key: '%1', pane: '%1', cwd: '/a' });
  decide(empty, shownFor(empty), { token: 'h:1', action: 'replies' });
  assert.equal(empty.repliesOpen, false);

  const s = stateWithReplies();
  decide(s, shownFor(s, 'h:1'), { token: 'h:1', action: 'replies' });
  assert.deepEqual(decide(s, shownFor(s, 'h:2'), { token: 'h:2', action: 'cancel' }), []);
  assert.equal(s.repliesOpen, false);
  assert.equal(s.sessions[0].replies.length, 2);
});

test('holding Up starts dictation and releasing it sends', () => {
  const s = newState();
  applyEvent(s, { type: 'register', key: '%7', pane: '%7', cwd: '/a' });
  for (const action of ['voice', 'voice_up']) {
    assert.deepEqual(decide(s, shownFor(s), { token: 'h:1', action }), [{ type: 'voice', pane: '%7' }], action);
  }
});
