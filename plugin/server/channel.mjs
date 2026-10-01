// Channel MCP server, one per Claude Code session. Registers the session
// with the hub, relays permission prompts to the device and verdicts back,
// and offers suggested replies. stdout belongs to MCP; logs go to stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { connectPersistent } from '../hub/client.mjs';
import { sessionKey } from '../hub/paths.mjs';

const log = (...a) => console.error('[clawdpet]', ...a);
const key = sessionKey();

const mcp = new Server(
  { name: 'clawdpet', version: '0.2.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'The clawdpet channel connects this session to a handheld Claude pet with buttons. ' +
      'It relays tool approval prompts to the device and shows AskUserQuestion questions there. ' +
      'When you need a decision from the user, prefer AskUserQuestion with 2 to 4 short options ' +
      '(under 35 characters each) over asking in prose. ' +
      'At the end of a turn where the user will most likely answer with one of a few short replies ' +
      '(for example after a question in prose, or "want me to also run the tests?"), call suggest_replies ' +
      'with 2 to 4 replies written as the user would type them, each under 35 characters. Do not call it ' +
      'when there is no natural next reply. A reply the user picks arrives as their next message.',
  },
);

const SuggestReplies = z.object({
  replies: z.array(z.string().min(1).max(35)).min(1).max(4),
});

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'suggest_replies',
    description:
      'Offer 1 to 4 short replies (under 35 characters, written as the user would type them) on the user\'s ' +
      'handheld device. The one they pick is sent as their next message. Call at most once, at the end of a turn.',
    inputSchema: {
      type: 'object',
      properties: {
        replies: { type: 'array', items: { type: 'string', maxLength: 35 }, minItems: 1, maxItems: 4 },
      },
      required: ['replies'],
    },
  }],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'suggest_replies') throw new Error(`unknown tool: ${req.params.name}`);
  const parsed = SuggestReplies.safeParse(req.params.arguments);
  if (!parsed.success) {
    return { isError: true, content: [{ type: 'text', text: 'replies must be 1 to 4 strings of at most 35 characters' }] };
  }
  if (!key) return { content: [{ type: 'text', text: 'no device linked to this session; nothing shown' }] };
  hub.send({ type: 'replies', key, replies: parsed.data.replies });
  return { content: [{ type: 'text', text: 'shown on the device' }] };
});

const PermissionRequest = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

// Outside tmux the session is not tracked, so it never connects to the hub.
const hub = key
  ? connectPersistent({
    log,
    onOpen: () => hub.send({ type: 'register', key, pane: key, cwd: process.cwd() }),
    onMessage: async (msg) => {
      if (msg.type !== 'verdict') return;
      if (!/^[a-km-z]{5}$/.test(msg.request_id) || !['allow', 'deny'].includes(msg.behavior)) return;
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: msg.request_id, behavior: msg.behavior },
      });
    },
  })
  : { send() {} };

mcp.setNotificationHandler(PermissionRequest, async ({ params }) => {
  hub.send({ type: 'perm', key, ...params });
});

await mcp.connect(new StdioServerTransport());
