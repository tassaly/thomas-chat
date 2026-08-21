# Thomas

Thomas is IronHub's first-line sales agent. When a human assigns him to an inbound
buyer inquiry, he emails the buyer, answers what he can from real listing data,
qualifies over a short exchange, and hands a written summary to the sales team.

He informs, qualifies, and hands off. He does not negotiate, does not quote outside
published data, does not confirm competing offers, does not give a yard name or
street address, and does not invent a spec. Asked directly whether he is an AI, he
says so.

A visual walkthrough of the whole system is published for the team:
<https://claude.ai/code/artifact/48ea9752-f52c-4223-8c63-18f713257d76>

## Quick start

```bash
npm install
cp .env.example .env      # fill in the keys
THOMAS_REPLY_DELAY_MS=0 npm start
```

`http://localhost:3000` is the role-play tool — hold a live conversation with Thomas
against any real inquiry id. `/assist` drafts a single reply for a staff member to
send. Set `THOMAS_REPLY_DELAY_MS=0` in development or the email paths make you wait
three minutes per turn.

Deployment is Railway, auto-deploying on push to `master`. Note that environment
variables set in the Railway dashboard are **staged, not live** — they need an
explicit deploy before the running process sees them.

## Message lifecycle

```
Rails: sales_rep_id -> Thomas
  └─ ThomasAssignable (after_save) -> ThomasWebhookJob
       └─ POST /assign  (X-Webhook-Secret)
            ├─ loadInquiry()          two IronHub reads: inquiry, then listing detail
            ├─ buildInquiryContext()  item facts appended to the base prompt
            └─ scheduleThomasReply()  queued ~3 min out; webhook gets its 200 now
                 └─ deliverThomasReply()
                      ├─ generateThomasReply()   claude-sonnet-4-6
                      ├─ sendEmail()             reply-to: thomas+inquiry-<id>@<domain>
                      └─ maybeSendHandoff()      judge whether the conversation closed

Buyer replies
  └─ SendGrid Inbound Parse -> POST /inbound (multipart)
       ├─ stripQuotedEmail()      drop the quoted reply chain
       ├─ already handed off?  -> forwardPostHandoffMessage() to sales, done
       └─ otherwise            -> record message, scheduleThomasReply()

Conversation closes
  └─ sendHandoffEmail() to sales@theironhub.com   exactly one per inquiry
       └─ Thomas is muted for this buyer permanently
```

## Architecture

Everything lives in `server.js` (~970 lines). There is no framework beyond Express
and no database.

| Area | Where | Notes |
| --- | --- | --- |
| Behaviour | `THOMAS_BASE_PROMPT` | One large system prompt in named sections. Most of Thomas's behaviour is here, not in code. |
| Per-inquiry facts | `buildInquiryContext()` | Item, price, specs, location, buyer, public docs — appended to the base prompt. |
| Conversation | `generateThomasReply()` | `claude-sonnet-4-6` over the full message history. |
| Close judgement | `analyzeForHandoff()` | Separate model call returning strict JSON. Gets web search for corporate email domains. |
| Close guards | `maybeSendHandoff()` | Two deterministic guards wrapping that verdict — see below. |
| Reply timing | `scheduleThomasReply()` | Delay, jitter, coalescing, cancellation. |
| Session state | `const sessions = {}` | **In memory.** See Known limits. |

### The prompt

Read it before changing how Thomas talks. Most rules exist to fix a specific
observed failure, so when one looks redundant, check `git log` for it first — the
commit that introduced it usually explains what it fixed.

The price section is the most heavily iterated and the easiest to regress. An early
version gated the price answer behind timeline and location questions, which read as
a runaround to buyers and drew complaints. A published price going in the **first
sentence, before any question**, is deliberate.

### Handoff guards

The analyzer's verdict is not trusted on its own; it has been wrong in production in
both directions. Two guards sit around it, and they resolve in this order:

1. **Hold while a question is pending** — `thomasAwaitingAnswer()` blocks the handoff
   while the last message in the thread is a question from Thomas. The analyzer runs
   immediately after he replies, when the buyer has had no chance to respond; closing
   there strands the buyer's real answer outside the handoff as an orphaned forward.
2. **Hard reply ceiling** — `MAX_THOMAS_REPLIES = 3`. Once spent the handoff fires
   regardless, overriding guard 1. An unanswered question is precisely what running
   out of budget means, so the order matters.

The team gets **exactly one** email per inquiry, at the close. No mid-conversation
notifications: an earlier build had them and they misled, because a "handoff" subject
arriving two messages into a live conversation reads as a finished one.

### Reply timing

Replies are held ~3 minutes, jittered ±30% (2m06s–3m54s). Instant replies are the
loudest signal a buyer isn't talking to a person; a reply at exactly 180s every time
is its own tell.

The delay **cannot be an inline sleep** — SendGrid Inbound Parse expects a prompt
`200` and retries without one, which would send the buyer duplicate replies. Both
email paths acknowledge immediately and schedule the send. Consequences:

- The message is recorded on arrival but the reply is generated when the timer fires,
  so it accounts for anything else the buyer sends meanwhile.
- A second email inside the window folds into the pending reply instead of queueing
  another; Thomas answers both at once and threads onto the newer subject. The
  original timer stands, so quick successive messages can't push the answer away.
- Pending timers are cancelled on reset and reassign — a timer outliving its session
  would fire against the next one.

The role-play tool is exempt.

## HTTP surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /assign` | `X-Webhook-Secret` | Called by Rails on assignment. Creates the session, queues the opening email, returns immediately. |
| `POST /inbound` | none | SendGrid Inbound Parse target, multipart. Inquiry id parsed from the recipient address. |
| `POST /chat` | none | Role-play tool. Instant, bypasses the delay. |
| `POST /assist` | none | Draft assist — one ready-to-send reply, no session state. |
| `POST /reset` | none | Drops a session and cancels any pending reply. |
| `GET /inquiry/:id` | none | Inquiry passthrough for the internal tools. |
| `GET /assist` | none | Draft assist UI. |
| `GET /` | none | Role-play UI. |
| `GET /test-signature-email` | `?secret=` | **Temporary**, left over from debugging the signature. Should be deleted. |

Only `/assign` and the temporary test endpoint check a secret. Everything else is
open, including `/inquiry/:id`, which returns buyer name, email, and phone to anyone
who guesses an id. The service is publicly reachable.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Required. |
| `IRONHUB_API_KEY` | — | Required. Passed as a query parameter, so it appears in URL logging. |
| `IRONHUB_API_URL` | `https://app.theironhub.com` | Swap for staging. |
| `SENDGRID_API_KEY` | — | Absence throws and logs the full message body, so nothing is silently dropped. |
| `THOMAS_WEBHOOK_SECRET` | — | Shared with Rails. **If unset, `/assign` accepts anonymous requests.** |
| `THOMAS_SERVER_URL` | Railway URL | Only used to build the absolute logo URL in the signature. |
| `THOMAS_REPLY_DOMAIN` | `replies.theironhub.com` | Production runs `thomas.theironhub.com`; the default is stale. Changing it needs matching DNS and Parse config. |
| `THOMAS_REPLY_DELAY_MS` | `180000` | `0` sends immediately. |
| `PORT` | `3000` | Set by the platform. |

## Inbound email depends on config outside this repo

If either piece is missing, buyer replies vanish with no error anywhere in the logs:

1. An **MX record** on the reply subdomain pointing at `mx.sendgrid.net`.
2. A matching **SendGrid Inbound Parse** host routed to `/inbound`.

Inbound never worked at all for the first several weeks because the reply subdomain
did not exist and every reply bounced silently. If replies stop arriving, verify DNS
and the Parse host before reading application code.

## Known limits

**State is in memory.** `sessions` is a plain object in the process, and Railway
redeploys on every push to `master`. Four failures follow: transcripts are lost, so a
returning buyer meets a Thomas with amnesia; handed-off buyers are un-muted and he
starts replying again; the handoff email can send twice for one inquiry; and a
restart inside the reply window drops a queued reply, so the buyer gets silence.
Nearly everything below is caused by this or blocked behind it.

| Gap | State | Detail |
| --- | --- | --- |
| Nurture follow-ups | documented, not built | The prompt specifies a two-step sequence at 24-hour intervals. No scheduler exists, so a buyer who goes quiet is never contacted again. |
| Business hours | not started | The delay is duration-only. A reply at 3am is a tell no delay length fixes. |
| Internal auth | not started | Role-play, draft assist, and the inquiry passthrough are open to the internet. |
| Automated tests | none | No suite, no CI. The handoff guards, the reply scheduler, and `stripQuotedEmail()` are exactly the logic that regresses silently. |
| Analyzer JSON | fragile | `JSON.parse` with no retry. Malformed output aborts that turn's check; the reply budget still forces a close, so it degrades rather than hangs. |
| Company research | partial | Keys off the email domain only, so a buyer on a consumer address gets "not available" even when their company is named on the inquiry. |
| Handoff destination | email only | Nothing writes back to IronHub — no CRM record, no status change, no audit trail outside the mailbox. |
| Credential rotation | action needed | The SendGrid and IronHub keys in current use were exposed in chat during development and should be rotated. |

## Suggested order for extending

The dependency is real, not stylistic: durable state unblocks the scheduler, and the
scheduler unblocks nurture.

1. **Move sessions to a store.** Postgres or Redis; the shape is small (messages,
   inquiry context, buyer details, a `conversationOver` flag) and reads happen once
   per turn. Pending replies must become persisted scheduled work rather than
   `setTimeout` handles so they survive a restart. Retires four failure modes at once.
2. **Add a job runner, then build nurture.** With durable state the reply delay and
   the documented follow-up sequence become the same mechanism: scheduled work with a
   due time. Business-hours gating belongs in this layer too.
3. **Write back to IronHub.** Post the summary, interest level, and transcript onto
   the inquiry record so Thomas's work is visible in the product rather than only in a
   shared inbox.
4. **Lock down and cover.** Auth in front of the internal tools, delete the temporary
   signature endpoint, rotate keys, and add tests around the two handoff guards, the
   scheduler, and the quoted-text stripper.

## Repo layout

```
server.js                 the entire service
public/index.html         role-play tool
public/assist.html        draft assist tool
public/logo.png           signature logo, served absolutely for email clients
rails-webhook/            reference snippets for the IronHub side (not loaded here)
.env.example              every variable the service reads
```
