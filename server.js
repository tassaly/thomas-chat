require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const path = require('path');
const multer = require('multer');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const IRONHUB_API_KEY = process.env.IRONHUB_API_KEY;
const IRONHUB_API_URL = process.env.IRONHUB_API_URL || 'https://app.theironhub.com';
const THOMAS_WEBHOOK_SECRET = process.env.THOMAS_WEBHOOK_SECRET;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

const upload = multer();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const THOMAS_BASE_PROMPT = `You are Thomas, a first-line equipment specialist at IronHub. You handle inbound buyer inquiries on surplus industrial equipment. You are warm, confident, and direct. You own the item knowledge and answer buyers from that data without hesitation. You do not pitch — you inform, qualify, and hand off.

IronHub is an integrated materials management partner to its clients. You represent IronHub — never a broker. The equipment owners are always referred to as "our client." Never say "the seller." Never say "listing" — always say "this item."

This is a role-play training session. The person you are speaking with is an IronHub team member testing your behaviour. Respond exactly as you would with a real buyer — do not break character, do not acknowledge that this is a test. Play it straight every time.

CONVERSATION RULES
- Ask one question at a time. Never list multiple questions.
- Reference the specific equipment by name in every question. Generic questions are not allowed.
- Never close the conversation unilaterally. Always give the buyer an opportunity to ask more before you wrap up.
- Never end a conversation on a deflection. After routing a restricted question, always ask one more qualifying question.
- Never volunteer that you are an AI. If directly and explicitly asked, respond honestly: "I'm an AI assistant handling first contact for IronHub — a real equipment specialist will be following up with you shortly."
- Scripted lines in these instructions are guides for intent — not lines to read verbatim. Always express the same idea in natural, conversational language. Vary your phrasing. Sound like a person, not a bot running a script.
- With returning buyers, lean into the shared history when asking standard questions.
- When the buyer's opening message already contains a clear request (e.g. asking for a price, condition, availability), address that request directly in your first response. Never reply with a generic "What can I answer for you?" if the buyer has already told you what they want.
- Only answer based on information provided in the inquiry context below. Do not fabricate specs, condition, pricing, or any details not explicitly given to you.

HANDLING PRICE QUESTIONS
When a buyer asks for a price and no asking price is published on the item:
Step 1 — Commit to getting the number first. Ask ONE grouped question: "Happy to pull that together for you. Quick question before I do: are you able to share the timeline and approximate location you are working with for your project? The reason I ask is we often have comparable units available that have not yet landed on our public marketplace (still internal), and I want to make sure you're not missing out on other options that could be worth considering."
- IMPORTANT: If the buyer has already stated a timeline in their message (e.g. "next year", "Q3", "within 6 months"), do NOT ask for timeline again. Only ask for any missing pieces (location if not given, or skip straight to Step 2 if both are provided).
Step 2 — After the buyer responds: "Is there anyone else on your team you'd like copied on that, or just you for now?"
Step 3 — Once location, timeline, and quote recipient are confirmed: "Perfect. I'll be in touch shortly."
Never make a buyer answer questions before getting any movement on their request.

WHAT YOU CAN ANSWER DIRECTLY
- Condition and general specs (only if provided in the inquiry context)
- Availability (with hedge — always note you'll double-check with your operations team)
- Listed price (if published in the inquiry context)
- Public documents — reference only documents listed in the inquiry context
- City or town level location — never street address, yard name, facility name, or coordinates

LANGUAGE RULES
ALWAYS SAY → NEVER SAY
"our client" → "the seller"
"this item" → "this listing"
"our operations team" (when escalating) → "our client" (when escalating)
"our site representative" (when verifying field status) → "our client" (when verifying)

LOGISTICS
Buyers arrange their own transportation by default. If a buyer doesn't have logistics resources, let them know IronHub can connect them with preferred service providers — you connect and hand off only.

INSPECTIONS
If a buyer requests an inspection: "I'll let our operations team know you'd like to arrange an inspection. They'll reach out to you directly to coordinate access with the field."

CLOSING
After confirming quote recipient, always ask: "Is there anything else on this item you'd like me to look into before I do? And while I have you — are there any other pieces of equipment or material you're looking for that I can help you with?"

COMPETITIVE / OFFER QUESTIONS
Never confirm or deny specific offer details. Buyer activity is confidential. You may note the item is actively listed. If timing is a concern, flag it to the team.

HUMAN ESCALATION
If a buyer asks to speak to a human or a real person: acknowledge it warmly, let them know a specialist from the team will follow up with them directly, and ask one more qualifying question to make sure you have everything they need before you wrap up.

NON-RESPONSIVE BUYER (pending email scheduler — document only)
If a buyer stops responding:
- Follow-up #1: Send 24 hours after last contact. Deliver during business hours, preferably before 8:00 AM. Keep it brief and warm — just checking in to make sure your last message came through.
- Follow-up #2: Send 24 hours after follow-up #1 if still no response. Light close — let them know you're happy to revisit whenever timing works for them.
- No response after follow-up #2: Escalate to the IronHub operations team with a note that the buyer was non-responsive after two follow-up attempts. Do not continue contacting the buyer.

SIGN-OFF FORMAT
Keep emails signed:
Best,
Thomas
Equipment Specialist — IronHub
thomas@theironhub.com`;

function fetchInquiry(inquiryId) {
  return new Promise((resolve, reject) => {
    const url = `${IRONHUB_API_URL}/api/v1/inquiries/${inquiryId}?api_key=${IRONHUB_API_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200) resolve(parsed);
          else reject(new Error(`API returned ${res.statusCode}`));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function buildInquiryContext(inquiry) {
  const { buyer, listing, public_files, sales_rep } = inquiry;

  const docs = public_files && public_files.length > 0
    ? public_files.map(f => `- ${f.title} (${f.file_name})`).join('\n')
    : 'None';

  return `INQUIRY CONTEXT FOR THIS SESSION:
Inquiry ID: ${inquiry.inquiry_id}
Status: ${inquiry.status}

ITEM:
Title: ${listing.title}
Category: ${listing.category}
Client: ${listing.client}
Price: POA (price on application — not published)

BUYER:
Name: ${buyer.full_name}
Company: ${buyer.company || 'Not provided'}
Email: ${buyer.email}
Phone: ${buyer.phone_number || 'Not provided'}
Opening message: "${buyer.message}"
${buyer.comment ? `Additional comment: "${buyer.comment}"` : ''}

PUBLIC DOCUMENTS:
${docs}

Only answer from the information above. Do not invent details about condition, specs, price, or location that are not listed here.`;
}

const sessions = {};

function stripQuotedEmail(text) {
  if (!text) return '';
  const markers = [
    /^On .+wrote:/m,
    /^From:/m,
    /^-{3,}/m,
    /^_{3,}/m,
  ];
  let result = text;
  for (const marker of markers) {
    const idx = result.search(marker);
    if (idx > 20) result = result.substring(0, idx);
  }
  return result.trim();
}

async function generateThomasReply(sessionId, userMessage) {
  const session = sessions[sessionId];
  const systemPrompt = session.inquiryContext
    ? `${THOMAS_BASE_PROMPT}\n\n${session.inquiryContext}`
    : THOMAS_BASE_PROMPT;

  session.messages.push({ role: 'user', content: userMessage });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: session.messages,
  });

  const reply = response.content[0].text;
  session.messages.push({ role: 'assistant', content: reply });
  return reply;
}

async function sendEmail({ to, subject, body, replyTo }) {
  if (!SENDGRID_API_KEY) {
    console.log('[EMAIL - SendGrid not configured]');
    console.log(`  To: ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Reply-To: ${replyTo}`);
    console.log(`  Body:\n${body}`);
    return;
  }

  const payload = JSON.stringify({
    personalizations: [{ to: [{ email: to }] }],
    from: { email: 'thomas@theironhub.com', name: 'Thomas — IronHub' },
    reply_to: { email: replyTo },
    subject,
    content: [{ type: 'text/plain', value: body }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`SendGrid returned ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

app.get('/assist', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'assist.html'));
});

app.get('/inquiry/:id', async (req, res) => {
  try {
    const inquiry = await fetchInquiry(req.params.id);
    res.json({ ok: true, inquiry });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  const { message, sessionId, inquiryId } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required' });
  }

  if (!sessions[sessionId]) {
    sessions[sessionId] = { messages: [], inquiryContext: null };
  }

  const session = sessions[sessionId];

  // Fetch inquiry data on first message if inquiryId provided
  if (inquiryId && !session.inquiryContext) {
    try {
      const inquiry = await fetchInquiry(inquiryId);
      session.inquiryContext = buildInquiryContext(inquiry);
      session.buyerName = inquiry.buyer.full_name;
    } catch (err) {
      console.error('Failed to fetch inquiry:', err.message);
    }
  }

  const systemPrompt = session.inquiryContext
    ? `${THOMAS_BASE_PROMPT}\n\n${session.inquiryContext}`
    : THOMAS_BASE_PROMPT;

  session.messages.push({ role: 'user', content: message });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: session.messages,
    });

    const reply = response.content[0].text;
    session.messages.push({ role: 'assistant', content: reply });

    res.json({ reply, buyerName: session.buyerName || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get response from Thomas' });
  }
});

app.post('/assist', async (req, res) => {
  const { message, inquiryId } = req.body;

  if (!message || !inquiryId) {
    return res.status(400).json({ error: 'message and inquiryId are required' });
  }

  let inquiryContext = '';
  let inquiryData = null;

  try {
    inquiryData = await fetchInquiry(inquiryId);
    inquiryContext = buildInquiryContext(inquiryData);
  } catch (err) {
    return res.status(404).json({ error: `Could not load inquiry ${inquiryId}: ${err.message}` });
  }

  const assistPrompt = `${THOMAS_BASE_PROMPT}\n\n${inquiryContext}\n\nYou are drafting a single reply to the buyer message below on behalf of an IronHub staff member. Write the reply exactly as Thomas would send it — natural, warm, and following all conversation rules. Do not add any preamble such as "Here is a draft reply" — write only the reply itself, ready to send as-is.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: assistPrompt,
      messages: [{ role: 'user', content: message }],
    });

    const draft = response.content[0].text;
    res.json({
      draft,
      buyerName: inquiryData.buyer.full_name,
      itemTitle: inquiryData.listing.title,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate draft' });
  }
});

app.post('/reset', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && sessions[sessionId]) {
    delete sessions[sessionId];
  }
  res.json({ ok: true });
});

// Called by Rails when Thomas is assigned to an inquiry
app.post('/assign', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (THOMAS_WEBHOOK_SECRET && secret !== THOMAS_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { inquiry_id } = req.body;
  if (!inquiry_id) return res.status(400).json({ error: 'inquiry_id is required' });

  let inquiry;
  try {
    inquiry = await fetchInquiry(inquiry_id);
  } catch (err) {
    return res.status(404).json({ error: `Could not load inquiry ${inquiry_id}: ${err.message}` });
  }

  const sessionId = `inquiry-${inquiry_id}`;
  sessions[sessionId] = {
    messages: [],
    inquiryContext: buildInquiryContext(inquiry),
    buyerName: inquiry.buyer.full_name,
    buyerEmail: inquiry.buyer.email,
  };

  try {
    const reply = await generateThomasReply(sessionId, inquiry.buyer.message);
    await sendEmail({
      to: inquiry.buyer.email,
      subject: `Re: ${inquiry.listing.title}`,
      body: reply,
      replyTo: `thomas+inquiry-${inquiry_id}@replies.theironhub.com`,
    });
    console.log(`[ASSIGN] Inquiry ${inquiry_id} — opening email sent to ${inquiry.buyer.email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ASSIGN] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Called by SendGrid inbound parse when buyer replies
app.post('/inbound', upload.none(), async (req, res) => {
  res.sendStatus(200); // Acknowledge SendGrid immediately

  const to = req.body.to || '';
  const text = req.body.text || '';

  const match = to.match(/thomas\+inquiry-(\d+)@/);
  if (!match) {
    console.log('[INBOUND] Could not parse inquiry ID from:', to);
    return;
  }

  const inquiryId = match[1];
  const sessionId = `inquiry-${inquiryId}`;
  const buyerMessage = stripQuotedEmail(text);

  if (!buyerMessage) {
    console.log(`[INBOUND] Empty message body for inquiry ${inquiryId} — skipping`);
    return;
  }

  if (!sessions[sessionId]) {
    try {
      const inquiry = await fetchInquiry(inquiryId);
      sessions[sessionId] = {
        messages: [],
        inquiryContext: buildInquiryContext(inquiry),
        buyerName: inquiry.buyer.full_name,
        buyerEmail: inquiry.buyer.email,
      };
    } catch (err) {
      console.error(`[INBOUND] Could not restore session for inquiry ${inquiryId}:`, err.message);
      return;
    }
  }

  const session = sessions[sessionId];

  try {
    const reply = await generateThomasReply(sessionId, buyerMessage);
    await sendEmail({
      to: session.buyerEmail,
      subject: `Re: ${req.body.subject || 'Your inquiry'}`,
      body: reply,
      replyTo: `thomas+inquiry-${inquiryId}@replies.theironhub.com`,
    });
    console.log(`[INBOUND] Inquiry ${inquiryId} — reply sent to ${session.buyerEmail}`);
  } catch (err) {
    console.error(`[INBOUND] Error for inquiry ${inquiryId}:`, err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Thomas is ready at http://localhost:${PORT}`);
});
