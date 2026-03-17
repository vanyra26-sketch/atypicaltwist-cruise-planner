/**
 * AtypicalTwist Cruise Planner — Reminder Worker
 *
 * Endpoints:
 *   POST   /set-reminder      { email, taskText, fireDate } → { id }
 *   DELETE /reminder/:id      cancels a reminder
 *
 * Cron:
 *   Daily at 09:00 UTC — scans KV for due reminders, sends via Resend
 *
 * Env vars (set via wrangler secret put):
 *   RESEND_API_KEY   — your Resend API key
 *
 * KV binding: REMINDERS  (see wrangler.toml)
 * KV key format: reminder:{uuid}
 * KV value: { email, taskText, fireDate, sent, createdAt }
 */

const ALLOWED_ORIGIN = 'https://planner.atypicaltwist.com';
const FROM_ADDRESS   = 'reminders@atypicaltwist.com';

// ── CORS headers ──────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(body, status = 200, origin = '') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ── Main fetch handler ────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);
    const path   = url.pathname;

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // POST /set-reminder
    if (request.method === 'POST' && path === '/set-reminder') {
      return handleSetReminder(request, env, origin);
    }

    // DELETE /reminder/:id
    if (request.method === 'DELETE' && path.startsWith('/reminder/')) {
      const id = decodeURIComponent(path.slice('/reminder/'.length));
      return handleDeleteReminder(id, env, origin);
    }

    return jsonResponse({ error: 'Not found' }, 404, origin);
  },

  // ── Cron: daily reminder scan ───────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDueReminders(env));
  },
};

// ── POST /set-reminder ────────────────────────────────────────────────────────
async function handleSetReminder(request, env, origin) {
  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400, origin);
  }

  const { email, taskText, fireDate } = body;

  if (!email || !taskText || !fireDate) {
    return jsonResponse({ error: 'Missing required fields: email, taskText, fireDate' }, 400, origin);
  }

  // Basic email format check
  if (!email.includes('@')) {
    return jsonResponse({ error: 'Invalid email address' }, 400, origin);
  }

  // Validate fireDate format (YYYY-MM-DD)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fireDate)) {
    return jsonResponse({ error: 'fireDate must be YYYY-MM-DD' }, 400, origin);
  }

  const id = 'reminder:' + crypto.randomUUID();
  const value = {
    email,
    taskText,
    fireDate,
    sent:      false,
    createdAt: new Date().toISOString(),
  };

  // Store with 365-day TTL so stale reminders self-clean
  await env.REMINDERS.put(id, JSON.stringify(value), { expirationTtl: 365 * 24 * 60 * 60 });

  return jsonResponse({ id }, 201, origin);
}

// ── DELETE /reminder/:id ──────────────────────────────────────────────────────
async function handleDeleteReminder(id, env, origin) {
  if (!id.startsWith('reminder:')) {
    return jsonResponse({ error: 'Invalid reminder id' }, 400, origin);
  }
  await env.REMINDERS.delete(id);
  return jsonResponse({ ok: true }, 200, origin);
}

// ── Cron: scan KV and send due reminders ─────────────────────────────────────
async function sendDueReminders(env) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // List all reminder keys (KV list returns up to 1000 by default)
  let cursor;
  do {
    const listResult = await env.REMINDERS.list({ prefix: 'reminder:', cursor });
    cursor = listResult.cursor;

    for (const key of listResult.keys) {
      const raw = await env.REMINDERS.get(key.name);
      if (!raw) continue;

      let reminder;
      try { reminder = JSON.parse(raw); } catch { continue; }

      // Skip already-sent or future reminders
      if (reminder.sent || reminder.fireDate > today) continue;

      // Send email
      const ok = await sendReminderEmail(env, reminder);
      if (ok) {
        // Mark sent (keep in KV for 7 more days then auto-expire)
        reminder.sent = true;
        await env.REMINDERS.put(key.name, JSON.stringify(reminder), { expirationTtl: 7 * 24 * 60 * 60 });
      }
    }
  } while (cursor);
}

// ── Send via Resend API ───────────────────────────────────────────────────────
async function sendReminderEmail(env, { email, taskText, fireDate }) {
  const html = buildEmailHtml(taskText, fireDate);

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    FROM_ADDRESS,
      to:      [email],
      subject: 'Cruise reminder: ' + taskText,
      html,
    }),
  });

  if (!res.ok) {
    console.error('Resend error', res.status, await res.text());
    return false;
  }
  return true;
}

// ── Email HTML template ───────────────────────────────────────────────────────
function buildEmailHtml(taskText, fireDate) {
  const [y, m, d] = fireDate.split('-');
  const dateStr = new Date(+y, +m - 1, +d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  // Escape for HTML
  const safeTask = taskText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Cruise reminder: ${safeTask}</title>
</head>
<body style="margin:0;padding:0;background:#0e1a2b;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0e1a2b;min-height:100vh;">
    <tr><td align="center" style="padding:48px 16px;">

      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#0e1a2b;border:1px solid rgba(154,122,63,0.25);">

        <!-- Header -->
        <tr>
          <td style="padding:36px 40px 24px;border-bottom:1px solid rgba(154,122,63,0.2);">
            <p style="margin:0;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#9a7a3f;">Atypical Twist</p>
            <p style="margin:4px 0 0;font-size:22px;font-style:italic;color:#e8dfc8;font-family:Georgia,serif;">Cruise Planner</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px;">
            <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#8a9ea8;">
              Reminder
            </p>
            <p style="margin:0 0 28px;font-size:13px;color:#8a9ea8;">
              ${dateStr}
            </p>

            <p style="margin:0 0 12px;font-size:14px;color:#8a9ea8;letter-spacing:0.04em;">
              Time to take action on:
            </p>

            <div style="padding:20px 24px;background:rgba(154,122,63,0.08);border-left:3px solid #9a7a3f;margin-bottom:32px;">
              <p style="margin:0;font-size:18px;color:#e8dfc8;line-height:1.5;font-family:Georgia,serif;font-style:italic;">
                ${safeTask}
              </p>
            </div>

            <p style="margin:0 0 28px;font-size:13px;color:#8a9ea8;line-height:1.7;">
              Head over to your cruise planner to check this off, update it, or
              adjust your plans for the voyage ahead.
            </p>

            <a href="https://planner.atypicaltwist.com"
               style="display:inline-block;padding:12px 28px;background:#9a7a3f;color:#0e1a2b;
                      font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;
                      text-decoration:none;">
              Open Planner
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px;border-top:1px solid rgba(154,122,63,0.15);">
            <p style="margin:0;font-size:10px;color:rgba(138,158,168,0.5);letter-spacing:0.1em;">
              You set this reminder on AtypicalTwist.com. To cancel future reminders,
              visit your planner. &mdash; AtypicalTwist, California SOT #2158353-50
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
