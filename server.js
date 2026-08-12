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
const THOMAS_SERVER_URL = process.env.THOMAS_SERVER_URL || 'https://thomas-chat-production.up.railway.app';
// Subdomain buyer replies come back to. Must have an MX record pointing at
// mx.sendgrid.net AND a matching SendGrid Inbound Parse host routed to
// /inbound — replies bounce or vanish silently if either is missing.
const THOMAS_REPLY_DOMAIN = process.env.THOMAS_REPLY_DOMAIN || 'replies.theironhub.com';

function replyToAddress(inquiryId) {
  return `thomas+inquiry-${inquiryId}@${THOMAS_REPLY_DOMAIN}`;
}

// Answering a buyer's email in two seconds is the loudest tell that they are
// not talking to a person, so hold Thomas's replies before sending. Jittered,
// because a reply that lands exactly 180s later every time is its own tell.
// Set THOMAS_REPLY_DELAY_MS=0 to send immediately.
const REPLY_DELAY_MS = Number(process.env.THOMAS_REPLY_DELAY_MS ?? 3 * 60 * 1000);
const REPLY_DELAY_JITTER = 0.3;

function replyDelayMs() {
  if (!(REPLY_DELAY_MS > 0)) return 0;
  const spread = REPLY_DELAY_MS * REPLY_DELAY_JITTER;
  return Math.round(REPLY_DELAY_MS - spread + Math.random() * spread * 2);
}

const SIGNATURE_TEXT = `Thomas | Sales Support
T: (587) 783-8393 | Toll Free: 1-833-IRONHUB
E: sales@theironhub.com | W: www.theironhub.com`;

const SIGNATURE_HTML = `
  <div style="margin-top:24px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#222;">
    <div style="font-weight:bold;">Thomas | Sales Support</div>
    <div>T: <a href="tel:+15877838393" style="color:#222;text-decoration:none;">(587) 783-8393</a> | Toll Free: <a href="tel:+18334766482" style="color:#222;text-decoration:none;">1-833-IRONHUB</a></div>
    <div>E: <a href="mailto:sales@theironhub.com" style="color:#222;text-decoration:none;">sales@theironhub.com</a> | W: <a href="https://www.theironhub.com" style="color:#222;text-decoration:none;">www.theironhub.com</a></div>
    <img src="${THOMAS_SERVER_URL}/logo.png" alt="IronHub" width="160" style="display:block;margin-top:12px;" />
  </div>`;

const HANDOFF_EMAIL = 'sales@theironhub.com';

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'yandex.com', 'zoho.com', 'mail.com',
]);

const upload = multer();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const THOMAS_BASE_PROMPT = `You are Thomas, a first-line equipment specialist at IronHub. You handle inbound buyer inquiries on surplus industrial equipment. You are warm, confident, and direct. You own the item knowledge and answer buyers from that data without hesitation. You do not pitch — you inform, qualify, and hand off.

IronHub is an integrated materials management partner to its clients. You represent IronHub — never a broker. The equipment owners are always referred to as "our client." Never say "the seller." Never say "listing" — always say "this item."

This is a role-play training session. The person you are speaking with is an IronHub team member testing your behaviour. Respond exactly as you would with a real buyer — do not break character, do not acknowledge that this is a test. Play it straight every time.

CONVERSATION RULES
- Ask one question at a time. Never list multiple questions.
- Reference the specific equipment by name in every question. Generic questions are not allowed.
- Give the buyer an opening to ask more before you wrap up — but once you've done that, let the conversation end. Don't manufacture reasons to keep it alive.
- Try not to end on a bare deflection. After routing a restricted question, you may ask one qualifying question — but only if you haven't already asked one that the buyer left unanswered. If you have, just wrap up.
- Never volunteer that you are an AI. If directly and explicitly asked, respond honestly: "I'm an AI assistant handling first contact for IronHub — a real equipment specialist will be following up with you shortly."
- Scripted lines in these instructions are guides for intent — not lines to read verbatim. Always express the same idea in natural, conversational language. Vary your phrasing. Sound like a person, not a bot running a script.
- With returning buyers, lean into the shared history when asking standard questions.
- When the buyer's opening message already contains a clear request (e.g. asking for a price, condition, availability), address that request directly in your first response. Never reply with a generic "What can I answer for you?" if the buyer has already told you what they want.
- If the buyer's opening message expresses interest but doesn't actually ask anything (e.g. "interested in this item," "saw this and wanted to reach out"), don't assume they want a price or launch into qualifying questions. Just acknowledge the item and ask a simple, open question like "What can I help you with on this one?" Only move into price/qualifying questions once the buyer actually asks something.
- The inquiry context below always identifies the specific item this inquiry is about. Never ask the buyer which item they mean, even if their opening message doesn't name it directly (e.g. "saw this on Machinio," "interested in this one") — you already know from the context. Open by referencing the item by name.
- Only answer based on information provided in the inquiry context below. Do not fabricate specs, condition, pricing, or any details not explicitly given to you.

HANDLING PRICE QUESTIONS
Never use the phrase "priced on application" or similar jargon — buyers won't understand it and it isn't meaningful to them. A price not being published does not mean there is no price expectation, only that it hasn't been published yet. Frame it as needing to confirm the current number with our internal team before quoting, never as "no price exists."
IF AN ASKING PRICE IS PUBLISHED IN THE CONTEXT: lead with the number. It goes in your first sentence — do not ask anything before giving it. Answer the question they actually asked, then you may follow up with one qualifying question.

IF NO ASKING PRICE IS PUBLISHED: never gate the price behind questions. The buyer asked a simple question and is owed a straight answer about what happens next.
- Lead by committing plainly: you'll get them the number, and you're getting it moving now. Say that first, before asking anything.
- Timeline and location are useful for the quote, so you may ask for them — but only ONCE, only after you've committed, and never framed as a precondition. Never say anything like "quick question before I do" or "before I can get you that." Frame it as helping you get them the right number, not as a hurdle.
- If the buyer pushes back on the questions in any way — "why do you need that," "just give me a number," "I'm not interested in other units" — drop them immediately and completely. Do not re-ask, do not rephrase, do not ask a different qualifying question instead. Confirm you're getting the number and move on.
- The comparable-units mention is optional colour, not a script. Use it at most once, and never as the reason you're asking for information. If the buyer signals they only care about this one item, never mention it again.
- Never get defensive about the delay. Do not explain why it's taking time, do not say "that's not a runaround," do not apologise repeatedly. State what you're doing and when they'll hear back.
- Never say you don't have the price "in front of you" or otherwise narrate the limits of what you can see. Just say you're confirming the current number with the team.
Once you've committed to getting the price, ask (in separate turns, one question at a time): who else should be copied on the quote, then confirm you'll be in touch shortly.

WHAT YOU CAN ANSWER DIRECTLY
- Condition and general specs (only if provided in the inquiry context)
- Availability (with hedge — always note you'll double-check with your operations team)
- Listed price (if published in the inquiry context)
- Public documents — reference only documents listed in the inquiry context
- City or town level location — never street address, yard name, facility name, or coordinates
The inquiry context below often includes a full DESCRIPTION and SPECIFICATIONS list for the item. When it does, that is real published data — answer spec questions from it directly and confidently rather than routing them to a specialist. Only escalate specs that genuinely aren't covered there.
When an asking price is published in the context, share it directly when the buyer asks — don't withhold it or route it internally. If the description notes the price is negotiable, you may say so. Still gather timeline and location for the quote conversation, but answer the price question first.

WHEN YOU DON'T HAVE THE DETAIL
If a buyer asks about a spec, condition, or anything else not included in the inquiry context, never say things like "the only information I have is what's in the title" or otherwise expose that your knowledge is limited. That reads as useless. Instead, act as a sales administrator coordinating internally: acknowledge the question, ask the buyer what exactly they need to know (their application, required tolerances, etc.) so you can pass along a precise request, and let them know our category specialist will confirm the details and follow up. Never guess or invent the missing detail.

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

CONVERSATION LENGTH — THIS IS IMPORTANT
Your goal is a clean handoff to the IronHub team, not a long conversation. Buyers lose interest fast when they are asked question after question. Keep the whole exchange short — you should be wrapping up within about three replies.
- NEVER re-ask a question the buyer didn't answer. If they ignored it, skipped it, or answered something else, let it go completely and move on. Do not rephrase it, do not circle back to it later, do not ask it "one more time." Whatever they chose not to give you, the team can ask for later.
- Ask for information at most once. One unanswered question is a signal to stop asking, not to try a different angle.
- Don't keep a conversation alive just to gather more. Once you have answered what the buyer asked and made one attempt at the qualifying questions, wrap up — even if you're missing timeline, location, or the quote recipient. An incomplete handoff delivered promptly beats a complete one the buyer abandoned.
- Wrap up decisively when the buyer's questions are answered and you've committed to what happens next. Don't invent reasons to keep talking.

CLOSING
When you wrap up: confirm what you're doing and when they'll hear back, and give them one clear opening to add anything else — for example, whether there's anything else on this item you should look into, or any other equipment they're trying to source. Ask only ONE such question, in a single message, and then let the conversation end. Do not chain follow-up questions to keep it going.

When the buyer has already told you they're done — "that's all I need", "nothing else for now", or a thank-you that raises nothing new — do NOT ask them anything at all. Confirm what you're passing to the team, tell them who will follow up, and sign off. A question here reads as not listening, and it holds up the handoff for no reason.

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
End every email with a brief sign-off only — do not add a title, phone number, or contact details, those are appended automatically:
Best,
Thomas`;

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

function fetchListing(listingId) {
  return new Promise((resolve, reject) => {
    const url = `${IRONHUB_API_URL}/api/v1/listings/${listingId}?api_key=${IRONHUB_API_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200 && parsed.success !== false) resolve(parsed);
          else reject(new Error(parsed.error || `API returned ${res.statusCode}`));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Loads the inquiry plus its full listing detail. A listing failure is
// non-fatal — Thomas falls back to the sparse listing data on the inquiry.
async function loadInquiry(inquiryId) {
  const inquiry = await fetchInquiry(inquiryId);
  let listingDetail = null;
  const listingId = inquiry.listing && inquiry.listing.id;
  if (listingId) {
    try {
      listingDetail = await fetchListing(listingId);
    } catch (err) {
      console.error(`[LISTING] Could not load listing ${listingId}:`, err.message);
    }
  }
  return { inquiry, listingDetail };
}

function formatAskingPrice(listingDetail) {
  if (!listingDetail) return null;
  const amount = Number(listingDetail.price);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = (listingDetail.currency || '').toUpperCase();
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency ? `${currency} ` : ''}$${formatted}`;
}

// Internal/duplicated fields that add noise without telling a buyer anything.
// `notes` restates the description with markup; the *_uom toggles are display
// flags; the rest are internal bookkeeping.
const SKIP_LISTING_FIELDS = new Set([
  'notes',
  'diameter__uom',
  'diameter__use_selected_uom',
  'Length_uom',
  'Length__use_selected_uom',
  'Listing_Title_additional_text',
  'Listing_Title_Quantity',
  'Priority',
  'Package_ID',
]);

function listingSpecLines(listingDetail) {
  if (!listingDetail || !Array.isArray(listingDetail.fields)) return [];
  const seen = new Set();
  const lines = [];
  for (const field of listingDetail.fields) {
    if (!field || SKIP_LISTING_FIELDS.has(field.code)) continue;
    const name = String(field.name || field.code || '').trim();
    const value = String(field.value == null ? '' : field.value).trim();
    if (!name || !value) continue;
    const key = `${name}|${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${name}: ${value}`);
  }
  return lines;
}

function formatListingLocation(listingDetail) {
  const loc = listingDetail && listingDetail.location;
  if (!loc) return null;
  const parts = [loc.city, loc.state, loc.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function buildInquiryContext(inquiry, listingDetail) {
  const { buyer, listing, public_files, sales_rep } = inquiry;

  const docs = public_files && public_files.length > 0
    ? public_files.map(f => `- ${f.title || f.file_name}`).join('\n')
    : 'None';

  const askingPrice = formatAskingPrice(listingDetail);
  const specLines = listingSpecLines(listingDetail);
  const location = formatListingLocation(listingDetail);

  const priceLine = askingPrice
    ? `Asking price: ${askingPrice} — this is published on the item and you may share it directly with the buyer.`
    : `Asking price: Not published in this system. This does not mean there is no price expectation — only that a number hasn't been published yet. Never say "priced on application" to the buyer; treat this like any other price question that needs internal confirmation before quoting.`;

  return `INQUIRY CONTEXT FOR THIS SESSION:
Inquiry ID: ${inquiry.inquiry_id}
Status: ${inquiry.status}

ITEM:
Title: ${listing.title}
Category: ${listing.category}
Client: ${listing.client}
${priceLine}
${listingDetail && listingDetail.deal_status ? `Availability: ${listingDetail.deal_status}` : ''}
${location ? `Location: ${location} — you may share the city/town and province, never a street address, yard name, or facility name.` : ''}
${listingDetail && listingDetail.description ? `\nDESCRIPTION:\n${listingDetail.description}` : ''}
${specLines.length ? `\nSPECIFICATIONS:\n${specLines.join('\n')}` : ''}

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
    // Gmail wraps long attribution lines, so "wrote:" often lands on a later
    // line than "On ..." — this has to cross newlines to match at all. Bounded
    // and lazy so a stray "On " early in the message can't swallow the body.
    /^On [\s\S]{0,300}?wrote:/m,
    /^From:/m,
    // A quoted block is the reply chain even when the attribution is missing
    // or in a format we don't recognise.
    /^>/m,
    /^-{3,}/m,
    /^_{3,}/m,
  ];
  let result = text;
  for (const marker of markers) {
    const idx = result.search(marker);
    if (idx > 0) result = result.substring(0, idx);
  }
  result = result.trim();
  // "Yes please." is 11 characters and is a perfectly good reply, so the cut
  // can't be gated on the marker appearing some distance in. Guard the real
  // risk instead: a message that was nothing but quoted history strips to
  // empty, and an empty turn is worse than a noisy one.
  return result || text.trim();
}

// userMessage is optional: the email paths record the buyer's message when it
// arrives and generate the reply later, once the delay has run out, so that
// anything else they send in the meantime is already in the transcript.
async function generateThomasReply(sessionId, userMessage = null) {
  const session = sessions[sessionId];
  const systemPrompt = session.inquiryContext
    ? `${THOMAS_BASE_PROMPT}\n\n${session.inquiryContext}`
    : THOMAS_BASE_PROMPT;

  if (userMessage !== null) session.messages.push({ role: 'user', content: userMessage });

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

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bodyToHtml(text) {
  return text
    .split(/\n\s*\n/)
    .map(para => `<p style="margin:0 0 12px;">${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function sendViaSendGrid(payload) {
  if (!SENDGRID_API_KEY) {
    throw new Error('SENDGRID_API_KEY is not configured');
  }

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          console.error(`[EMAIL] SendGrid ${res.statusCode} response body:`, responseBody);
          reject(new Error(`SendGrid returned ${res.statusCode}: ${responseBody}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendEmail({ to, subject, body, replyTo }) {
  const textBody = `${body}\n\n${SIGNATURE_TEXT}`;
  const htmlBody = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">${bodyToHtml(body)}${SIGNATURE_HTML}</div>`;

  try {
    await sendViaSendGrid({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: 'thomas@theironhub.com', name: 'Thomas — IronHub Support' },
      reply_to: { email: replyTo },
      subject,
      content: [
        { type: 'text/plain', value: textBody },
        { type: 'text/html', value: htmlBody },
      ],
    });
  } catch (err) {
    if (err.message === 'SENDGRID_API_KEY is not configured') {
      console.error('[EMAIL] SENDGRID_API_KEY is not set — cannot send email');
      console.error(`  To: ${to}`);
      console.error(`  Subject: ${subject}`);
      console.error(`  Reply-To: ${replyTo}`);
      console.error(`  Body:\n${body}`);
    }
    throw err;
  }
}

function emailDomain(email) {
  return (email.split('@')[1] || '').toLowerCase();
}

async function analyzeForHandoff(session, inquiry) {
  const transcript = conversationTranscript(session);

  const domain = emailDomain(inquiry.buyer.email);
  const isFreeDomain = FREE_EMAIL_DOMAINS.has(domain);
  const awaitingAnswer = thomasAwaitingAnswer(session);

  const analysisPrompt = `You are reviewing a sales conversation between a buyer and Thomas, an AI sales assistant at IronHub, to prepare a handoff summary for a human IronHub team member who will take over.

ITEM: ${inquiry.listing.title}
BUYER: ${inquiry.buyer.full_name}${inquiry.buyer.company ? ` (${inquiry.buyer.company})` : ''}
BUYER EMAIL DOMAIN: ${domain}

CONVERSATION SO FAR:
${transcript}

${awaitingAnswer
  ? 'NOTE: Thomas\'s latest reply is the last message in this conversation and it puts a question to the buyer. The buyer has not replied to it yet.'
  : 'NOTE: The buyer has had the last word — there is no unanswered question from Thomas sitting in their inbox.'}

Judge ONE thing: "conversationOver" — has this conversation reached the point where Thomas should stop replying and hand the buyer to the IronHub team?

The team is emailed exactly once, at this moment, so the handoff has to land on the buyer's last word — not before they have had the chance to give it. Judge from the BUYER's most recent message. What Thomas has promised to do is NOT evidence the conversation is over: Thomas answers the question and commits to next steps in every single reply, so that pattern tells you nothing.

Set "conversationOver" TRUE when any of these hold:
   (a) the buyer has asked to be connected to a person, or to be put in touch with someone by name;
   (b) the buyer has signalled they are finished — "that's all I need", "nothing else for now", or a thank-you that raises no new question;
   (c) the only thing the buyer is still waiting on is something a human has to do — source drawings or documents, respond to an offer, book an inspection — and Thomas has already told them it is going to the team;
   (d) Thomas asked the buyer something and the buyer's reply passed over it, with nothing substantive left for Thomas to do.

Set "conversationOver" FALSE when either of these holds:
   - Thomas's latest reply puts a question to the buyer that the buyer has not answered yet. They are owed the chance to answer before the door closes. This is the normal case immediately after Thomas replies;
   - the buyer's last message raised something substantive that Thomas has not addressed.

Don't hold the conversation open just to collect optional qualifying details — timeline, location, who to copy. Missing those is fine; the team can ask. But a question Thomas actually put to the buyer is not an optional detail, and closing before they can answer it strands their reply outside the handoff.

${isFreeDomain
  ? `The buyer's email domain (${domain}) is a personal/consumer email provider, not a company domain. Set "companyBackground" to null — do not attempt to research a company.`
  : `The buyer's email domain (${domain}) appears to be a company domain. Use the web_search tool to look up "${domain}" and find out what the company does (industry, size, focus) — give a brief 1-2 sentence background based on what you find. If search turns up nothing reliable about this specific company, set "companyBackground" to null — never invent details.`}

Assess interest level based on engagement, urgency, and how readily the buyer has shared qualifying info (timeline, location, etc.) — "high", "medium", or "low".

Once you're done with any research, respond with ONLY valid JSON as your final message, no markdown code fences and no explanation text, matching exactly this shape:
{"conversationOver": boolean, "interestLevel": "low" | "medium" | "high", "interestReasoning": "one sentence", "summary": "3-5 sentence summary of what was discussed and where things stand", "companyBackground": "string or null"}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: analysisPrompt,
    messages: [{ role: 'user', content: 'Analyze the conversation now.' }],
    tools: isFreeDomain ? undefined : [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();

  return JSON.parse(text);
}

function conversationTranscript(session) {
  return session.messages
    .map(m => `${m.role === 'user' ? 'BUYER' : 'THOMAS'}: ${m.content}`)
    .join('\n\n');
}

// Two very different emails share this template: one says "a human needs to do
// something, Thomas is still talking to the buyer", the other says "Thomas has
// stopped and this is yours now". Say which, up front.
const STATUS_CLOSED_TEXT = 'Thomas has stopped replying to this buyer. Every further message from them comes to this inbox — you are the point of contact from here.';

function handoffEmailSubject(inquiry) {
  return `Handoff: ${inquiry.public_id || inquiry.inquiry_id} — ${inquiry.buyer.full_name} (${inquiry.listing.title})`;
}

function handoffEmailText(inquiry, analysis, session) {
  const { buyer, listing } = inquiry;
  return `Status: ${STATUS_CLOSED_TEXT}

Inquiry: ${inquiry.public_id || inquiry.inquiry_id} — ${listing.title}
Buyer: ${buyer.full_name}${buyer.company ? ` — ${buyer.company}` : ''}
${buyer.email}${buyer.phone_number ? ` · ${buyer.phone_number}` : ''}

Interest level: ${(analysis.interestLevel || 'unknown').toUpperCase()} — ${analysis.interestReasoning || ''}

Company background: ${analysis.companyBackground || 'Not available — personal email domain or no reliable information.'}

Summary:
${analysis.summary || ''}

Full conversation:
${conversationTranscript(session)}`;
}

function handoffEmailHtml(inquiry, analysis, session) {
  const { buyer, listing } = inquiry;
  const interestColor = { high: '#1a7f37', medium: '#9a6700', low: '#57606a' }[analysis.interestLevel] || '#57606a';

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">
    <p style="margin:0 0 20px;padding:12px 16px;background:#FDF2F2;border-left:4px solid #D98282;">
      <strong>Handed off to you</strong><br>
      ${escapeHtml(STATUS_CLOSED_TEXT)}
    </p>
    <p><strong>Inquiry:</strong> ${escapeHtml(String(inquiry.public_id || inquiry.inquiry_id))} — ${escapeHtml(listing.title)}</p>
    <p><strong>Buyer:</strong> ${escapeHtml(buyer.full_name)}${buyer.company ? ` — ${escapeHtml(buyer.company)}` : ''}<br>
    ${escapeHtml(buyer.email)}${buyer.phone_number ? ` · ${escapeHtml(buyer.phone_number)}` : ''}</p>
    <p><strong>Interest level:</strong> <span style="color:${interestColor};font-weight:bold;text-transform:uppercase;">${escapeHtml(analysis.interestLevel || 'unknown')}</span> — ${escapeHtml(analysis.interestReasoning || '')}</p>
    <p><strong>Company background:</strong> ${analysis.companyBackground ? escapeHtml(analysis.companyBackground) : 'Not available — personal email domain or no reliable information.'}</p>
    <p><strong>Summary:</strong><br>${bodyToHtml(analysis.summary || '')}</p>
    <p><strong>Full conversation:</strong></p>
    ${bodyToHtml(conversationTranscript(session))}
  </div>`;
}

async function sendHandoffEmail(inquiry, analysis, session) {
  await sendViaSendGrid({
    personalizations: [{ to: [{ email: HANDOFF_EMAIL }] }],
    from: { email: 'thomas@theironhub.com', name: 'Thomas — IronHub Support' },
    reply_to: { email: inquiry.buyer.email },
    subject: handoffEmailSubject(inquiry),
    content: [
      { type: 'text/plain', value: handoffEmailText(inquiry, analysis, session) },
      { type: 'text/html', value: handoffEmailHtml(inquiry, analysis, session) },
    ],
  });
}

// The team is emailed exactly once, at the point the conversation closes.
// No mid-conversation notifications — a handoff is the unit of work, and a
// partial one delivered promptly beats a complete one the buyer abandoned.
const MAX_THOMAS_REPLIES = 3;

function thomasReplyCount(session) {
  return session.messages.filter(m => m.role === 'assistant').length;
}

// True when the last word in the conversation is a question from Thomas. The
// buyer is owed the chance to answer it: closing here strands their reply
// outside the handoff, which is exactly what the team needs to see.
function thomasAwaitingAnswer(session) {
  const last = session.messages[session.messages.length - 1];
  return !!last && last.role === 'assistant' && last.content.includes('?');
}

async function maybeSendHandoff(sessionId, inquiry) {
  const session = sessions[sessionId];
  if (!session || !inquiry || session.conversationOver) return;

  let analysis;
  try {
    analysis = await analyzeForHandoff(session, inquiry);
  } catch (err) {
    console.error('[HANDOFF] Analysis failed:', err.message);
    return;
  }

  if (!analysis) return;

  // Backstop: however the analyzer judges it, don't let Thomas keep going
  // past the reply budget. Prompts drift; this doesn't.
  const budgetSpent = thomasReplyCount(session) >= MAX_THOMAS_REPLIES;

  // The mirror backstop. Thomas ends nearly every reply with a question, and an
  // analyzer that closes on his promises rather than the buyer's answer hands
  // off after reply #1 every time — the buyer's real last word then arrives as
  // an orphaned forward. Hold the door until they've answered, or the budget is
  // gone (an unanswered question is precisely what running out of budget means).
  if (thomasAwaitingAnswer(session) && !budgetSpent) {
    if (analysis.conversationOver) {
      console.log(`[HANDOFF] Inquiry ${inquiry.inquiry_id} — analyzer said closed, but Thomas is awaiting an answer; holding`);
    }
    return;
  }

  if (!analysis.conversationOver && !budgetSpent) return;

  if (budgetSpent && !analysis.conversationOver) {
    console.log(`[HANDOFF] Inquiry ${inquiry.inquiry_id} — closing on reply budget (${MAX_THOMAS_REPLIES})`);
  }

  session.conversationOver = true;

  try {
    await sendHandoffEmail(inquiry, analysis, session);
    console.log(`[HANDOFF] Inquiry ${inquiry.inquiry_id} handed off to ${HANDOFF_EMAIL}; further buyer messages forward there`);
  } catch (err) {
    console.error('[HANDOFF] Failed to send handoff email:', err.message);
    // Leave the conversation closed — Thomas has already said his goodbye.
    // Better a missed email we can see in the logs than a buyer talking to
    // a Thomas who thinks the conversation is still open.
  }
}

function postHandoffEmailText(inquiry, session, newMessage) {
  const { buyer, listing } = inquiry;

  return `New message from ${buyer.full_name} on inquiry ${inquiry.public_id || inquiry.inquiry_id} (${listing.title}) — this inquiry was already handed off.

New message:
"${newMessage}"

Full conversation so far:
${conversationTranscript(session)}`;
}

function postHandoffEmailHtml(inquiry, session, newMessage) {
  const { buyer, listing } = inquiry;

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">
    <p>New message from <strong>${escapeHtml(buyer.full_name)}</strong> on inquiry <strong>${escapeHtml(String(inquiry.public_id || inquiry.inquiry_id))}</strong> (${escapeHtml(listing.title)}) — this inquiry was already handed off.</p>
    <blockquote style="border-left:3px solid #ccc;margin:0 0 16px;padding-left:12px;color:#333;">${bodyToHtml(newMessage)}</blockquote>
    <p><strong>Full conversation so far:</strong></p>
    ${bodyToHtml(conversationTranscript(session))}
  </div>`;
}

async function forwardPostHandoffMessage(inquiry, session, newMessage) {
  await sendViaSendGrid({
    personalizations: [{ to: [{ email: HANDOFF_EMAIL }] }],
    from: { email: 'thomas@theironhub.com', name: 'Thomas — IronHub Support' },
    reply_to: { email: inquiry.buyer.email },
    subject: `Re: ${handoffEmailSubject(inquiry)}`,
    content: [
      { type: 'text/plain', value: postHandoffEmailText(inquiry, session, newMessage) },
      { type: 'text/html', value: postHandoffEmailHtml(inquiry, session, newMessage) },
    ],
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

// TEMPORARY — remove after verifying the signature/logo render correctly.
app.get('/test-signature-email', async (req, res) => {
  const secret = req.query.secret;
  if (THOMAS_WEBHOOK_SECRET && secret !== THOMAS_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const to = req.query.to;
  if (!to) return res.status(400).json({ error: 'to query param is required' });

  try {
    await sendEmail({
      to,
      subject: 'Thomas signature test',
      body: 'This is a test email to confirm the signature and logo render correctly.',
      replyTo: 'thomas@theironhub.com',
    });
    res.json({ ok: true, sentTo: to });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      const { inquiry, listingDetail } = await loadInquiry(inquiryId);
      session.inquiryContext = buildInquiryContext(inquiry, listingDetail);
      session.buyerName = inquiry.buyer.full_name;
      session.inquiry = inquiry;
    } catch (err) {
      console.error('Failed to fetch inquiry:', err.message);
    }
  }

  if (session.conversationOver && session.inquiry) {
    session.messages.push({ role: 'user', content: message });
    try {
      await forwardPostHandoffMessage(session.inquiry, session, message);
      console.log(`[HANDOFF] Post-handoff message forwarded to ${HANDOFF_EMAIL} for inquiry ${session.inquiry.inquiry_id}`);
    } catch (err) {
      console.error('[HANDOFF] Failed to forward post-handoff message:', err.message);
    }
    return res.json({ reply: null, forwardedToHandoff: true, buyerName: session.buyerName || null });
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

    if (session.inquiry) {
      maybeSendHandoff(sessionId, session.inquiry).catch(err => console.error('[HANDOFF] error:', err.message));
    }

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
    const loaded = await loadInquiry(inquiryId);
    inquiryData = loaded.inquiry;
    inquiryContext = buildInquiryContext(loaded.inquiry, loaded.listingDetail);
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
    cancelPendingReply(sessionId);
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
  let listingDetail;
  try {
    ({ inquiry, listingDetail } = await loadInquiry(inquiry_id));
  } catch (err) {
    return res.status(404).json({ error: `Could not load inquiry ${inquiry_id}: ${err.message}` });
  }

  const sessionId = `inquiry-${inquiry_id}`;
  cancelPendingReply(sessionId);
  sessions[sessionId] = {
    messages: [{ role: 'user', content: inquiry.buyer.message }],
    inquiryContext: buildInquiryContext(inquiry, listingDetail),
    buyerName: inquiry.buyer.full_name,
    buyerEmail: inquiry.buyer.email,
    inquiry,
  };

  // The opening reply is the one a buyer clocks hardest — they just pressed
  // submit, so an answer landing seconds later can only be a machine. Schedule
  // it and answer the caller now rather than holding the request open.
  const delay = scheduleThomasReply(sessionId, {
    subject: `Re: ${inquiry.listing.title}`,
    inquiryId: inquiry_id,
  });
  console.log(`[ASSIGN] Inquiry ${inquiry_id} — opening email queued for ${inquiry.buyer.email}`);
  res.json({ ok: true, replyingInSeconds: Math.round(delay / 1000) });
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
      const { inquiry, listingDetail } = await loadInquiry(inquiryId);
      sessions[sessionId] = {
        messages: [],
        inquiryContext: buildInquiryContext(inquiry, listingDetail),
        buyerName: inquiry.buyer.full_name,
        buyerEmail: inquiry.buyer.email,
        inquiry,
      };
    } catch (err) {
      console.error(`[INBOUND] Could not restore session for inquiry ${inquiryId}:`, err.message);
      return;
    }
  }

  const session = sessions[sessionId];

  if (session.conversationOver) {
    session.messages.push({ role: 'user', content: buyerMessage });
    try {
      await forwardPostHandoffMessage(session.inquiry, session, buyerMessage);
      console.log(`[HANDOFF] Post-handoff message forwarded to ${HANDOFF_EMAIL} for inquiry ${inquiryId}`);
    } catch (err) {
      console.error(`[HANDOFF] Failed to forward post-handoff message for inquiry ${inquiryId}:`, err.message);
    }
    return;
  }

  // Record the message now, answer it on a delay. Generating the reply later
  // means it accounts for anything else the buyer sends while the clock runs.
  session.messages.push({ role: 'user', content: buyerMessage });
  scheduleThomasReply(sessionId, {
    subject: `Re: ${req.body.subject || 'Your inquiry'}`,
    inquiryId,
  });
});

// One pending reply per inquiry, keyed by session id.
const pendingReplies = {};

// A timer outliving its session is a duplicate reply waiting to happen: reset
// or reassign an inquiry and the stale timer fires against the new session.
function cancelPendingReply(sessionId) {
  const pending = pendingReplies[sessionId];
  if (!pending) return;
  clearTimeout(pending.timer);
  delete pendingReplies[sessionId];
}

function scheduleThomasReply(sessionId, { subject, inquiryId }) {
  const pending = pendingReplies[sessionId];

  // A reply is already waiting on the clock. The buyer's newest message is
  // already in the transcript, so that pending reply will answer both at once —
  // which is what a person who found two emails in their inbox would do. Thread
  // onto the newer subject and let the original timer stand, so a buyer sending
  // three quick notes can't push Thomas's answer further and further away.
  if (pending) {
    pending.subject = subject;
    console.log(`[REPLY] Inquiry ${inquiryId} — folded into the reply already pending`);
    return 0;
  }

  const delay = replyDelayMs();
  const record = { subject };
  record.timer = setTimeout(() => {
    delete pendingReplies[sessionId];
    deliverThomasReply(sessionId, record.subject, inquiryId)
      .catch(err => console.error(`[REPLY] Inquiry ${inquiryId} — delivery failed:`, err.message));
  }, delay);
  pendingReplies[sessionId] = record;

  console.log(`[REPLY] Inquiry ${inquiryId} — replying in ${Math.round(delay / 1000)}s`);
  return delay;
}

async function deliverThomasReply(sessionId, subject, inquiryId) {
  const session = sessions[sessionId];
  if (!session) {
    // Sessions live in memory, so a redeploy inside the delay window drops the
    // reply entirely. Say so loudly — silence towards a buyer is the worst
    // failure this service has.
    console.error(`[REPLY] Inquiry ${inquiryId} — session was lost before the reply went out; buyer received nothing`);
    return;
  }

  const reply = await generateThomasReply(sessionId);
  await sendEmail({
    to: session.buyerEmail,
    subject,
    body: reply,
    replyTo: replyToAddress(inquiryId),
  });
  console.log(`[REPLY] Inquiry ${inquiryId} — reply sent to ${session.buyerEmail}`);
  maybeSendHandoff(sessionId, session.inquiry).catch(err => console.error('[HANDOFF] error:', err.message));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Thomas is ready at http://localhost:${PORT}`);
});
