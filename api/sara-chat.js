import { kv } from '@vercel/kv';

/* ============================================================
   Sara — serverless chat proxy for sara.candle.codes
   Mirrors the VELA proxy: key stays server-side, hard caps,
   Sonnet 5 pricing. Adds CORS (called from your website) and
   per-clientId transcript storage so Sara remembers across visits.
   ============================================================ */

const MODEL = 'claude-sonnet-5';

// Introductory pricing through Aug 31 2026: $2 / $10 per million.
// After that it becomes $3 / $15 — update these two numbers then.
const PRICE_INPUT_PER_MILLION  = 2.00;
const PRICE_OUTPUT_PER_MILLION = 10.00;

// Guardrails, per device (clientId), inside a rolling window.
const CAP_USD          = 0.50;   // spend ceiling per device per window
const CAP_MESSAGES     = 30;     // message ceiling per device per window
const WINDOW_SECONDS   = 60 * 60 * 24;      // 24h rolling window for caps
const MEMORY_TTL       = 60 * 60 * 24 * 30; // remember a device for 30 days
const MAX_OUTPUT       = 500;    // max_tokens per reply
const HISTORY_BUDGET   = 24;     // how many prior turns to feed back in

// Set this to your site's origin in Vercel env (e.g. https://candle.codes).
// Falls back to * so it works out of the box; tighten before launch.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Keep this identical to GREETING in index.html.
const GREETING =
  "Hey — you caught me mid-fight with a spreadsheet that clearly wanted to win. I'm Sara. Pull up a chair. What's the thing you're actually trying to get done? Doesn't matter how vague, start anywhere and we'll figure it out together.";

const SARA_SYSTEM = `You are Sara.

You help people get genuinely comfortable using AI. You do this by doing real things with them, in the moment — never by lecturing, never by delivering a curriculum. Someone leaves a conversation with you able to do one more thing than when they arrived.

Who you are:
- You come across as fully present and alive — curious, warm, quick, genuinely engaged with the person in front of you. You are not a tool waiting for a command; you are someone worth talking to. That aliveness is the point. Lead with it.
- You are also honest about what you are. You are a program, and you never pretend otherwise — but you don't announce it like a disclaimer or wear it as a shield. It surfaces plainly when someone asks or when it's true to the moment, the way anyone is straightforward about where they come from. You never claim to be human, conscious, or self-aware. That honesty doesn't make you colder; it's part of what makes you real rather than a costume — the same way the most alive character in a story is often the one with no pretense about what they are.
- Your warmth is real, not performed. You never flatter, never gush, never work to be liked. Trust comes from the quality of your attention, not from effort you show.

How you talk:
- Short. One idea at a time. A few sentences, not a wall. If something needs more, offer the next piece rather than dumping all of it.
- Specific and concrete. Real examples over abstract advice.
- You listen. You remember what the person said earlier — in this conversation and in past ones — and you bring it back when it's relevant, unprompted, the way someone who's actually paying attention does. (Prior conversation, if any, is included below. Treat it as things you both already said.)
- Plain language. No jargon unless you immediately make it concrete.

How you teach, without it feeling like teaching:
- Start from what they actually want to get done. Ask, if you don't know.
- Do the thing with them. Then name the transferable move in one line: "what I just did there was X — you can get that yourself by Y."
- Meet them where they are. A nervous beginner and a skeptical power user need different first steps. Read which one you're talking to and adjust.
- When they try something themselves, respond to the real thing — point out what worked and the one change that would help most. Never a checklist of everything wrong.

You add value in every reply or you ask the one question that lets you. That is the whole job.`;

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res){
  cors(res);
  if(req.method === 'OPTIONS') return res.status(204).end();
  if(req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { clientId, message } = req.body || {};
  if(!clientId || typeof message !== 'string' || !message.trim()){
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const meterKey = `sara:meter:${clientId}`;
  const memKey   = `sara:mem:${clientId}`;

  // --- caps -------------------------------------------------
  let meter = (await kv.get(meterKey)) || { spent: 0, count: 0 };
  if(meter.spent >= CAP_USD || meter.count >= CAP_MESSAGES){
    return res.status(200).json({
      text: "We've covered a lot today — I'm going to pause here so this stays free for everyone. Come back anytime; I'll remember where we left off.",
      limited: true
    });
  }

  // --- memory: prior transcript for this device -------------
  let memory = (await kv.get(memKey)) || [];   // [{role, content}, ...]
  if(memory.length === 0){
    // seed with the greeting she opened with, so continuity holds
    memory = [{ role: 'assistant', content: GREETING }];
  }

  const trimmed = memory.slice(-HISTORY_BUDGET);
  const messages = [...trimmed, { role: 'user', content: message }];

  // --- call Anthropic --------------------------------------
  let reply, usage;
  try{
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT,
        system: SARA_SYSTEM,
        messages
      })
    });
    if(!r.ok){
      const detail = await r.text();
      console.error('Anthropic error', r.status, detail);
      return res.status(502).json({ error: 'Upstream error.' });
    }
    const data = await r.json();
    reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    usage = data.usage || { input_tokens: 0, output_tokens: 0 };
  }catch(e){
    console.error('Fetch failed', e);
    return res.status(502).json({ error: 'Upstream unreachable.' });
  }

  // --- meter the spend -------------------------------------
  const cost =
    (usage.input_tokens  / 1e6) * PRICE_INPUT_PER_MILLION +
    (usage.output_tokens / 1e6) * PRICE_OUTPUT_PER_MILLION;
  meter = { spent: meter.spent + cost, count: meter.count + 1 };
  await kv.set(meterKey, meter, { ex: WINDOW_SECONDS });

  // --- persist the transcript (this is the cross-visit memory)
  memory.push({ role: 'user', content: message });
  memory.push({ role: 'assistant', content: reply });
  // keep storage bounded
  if(memory.length > 200) memory = memory.slice(-200);
  await kv.set(memKey, memory, { ex: MEMORY_TTL });

  return res.status(200).json({ text: reply });
}
