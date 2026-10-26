// Cloudflare Email Worker: forwards every email received on your inbound domain to Keyless.
// Secrets (Worker settings > Variables): KEYLESS_WEBHOOK_URL, KEYLESS_SECRET.
// See docs/inbound-email.md. Uses only the documented Email Workers runtime API.
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const res = await fetch(env.KEYLESS_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'message/rfc822',
        'X-Inbound-Secret': env.KEYLESS_SECRET,
        // The envelope recipient: routes the email even when the To header shows another address.
        'X-Envelope-To': message.to,
      },
      body: raw,
    });
    // A non-2xx answer makes the sending server retry later instead of losing the email.
    if (!res.ok) throw new Error(`Keyless webhook returned ${res.status}`);
  },
};
