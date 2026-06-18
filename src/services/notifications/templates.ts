// Minimal editorial email templates for the three high-signal upvoter emails.
// All user-controlled values are HTML-escaped. Plaintext variants accompany each.

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailTemplateVars {
  requestTitle: string;
  // Absolute URL back to the request (or the linked article for published).
  ctaUrl: string;
  // Optional supporting line (e.g. the not-pursued reason).
  detail?: string;
}

export type EmailTemplateKey =
  | 'request_published'
  | 'request_rejected'
  | 'request_not_pursued'
  // Comments. `requestTitle` carries the relevant title (parent / comment subject),
  // `detail` carries supporting text (excerpt / reason / ban window), `ctaUrl` the link.
  | 'comment_reply'
  | 'comment_mention'
  | 'comment_removed'
  | 'comment_warning'
  | 'comment_banned'
  | 'comment_ban_lifted'
  | 'report_submitted';

interface RenderedEmail {
  html: string;
  text: string;
}

function shell(headline: string, paragraphHtml: string, ctaLabel: string, ctaUrl: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#faf9f7;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;">
    <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;">
      <tr><td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e7e3dc;">
          <tr><td style="padding:32px 36px;">
            <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#b45309;margin-bottom:16px;">Resolve — Research requests</div>
            <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;">${headline}</h1>
            ${paragraphHtml}
            <p style="margin:28px 0 0;">
              <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#b45309;color:#ffffff;text-decoration:none;padding:12px 22px;font-size:14px;letter-spacing:0.02em;">${ctaLabel}</a>
            </p>
          </td></tr>
        </table>
        <div style="font-size:12px;color:#8a8378;margin-top:18px;">You're receiving this because you upvoted this research request on Resolve.</div>
      </td></tr>
    </table>
  </body>
</html>`;
}

const RENDERERS: Record<
  'request_published' | 'request_rejected' | 'request_not_pursued',
  (vars: EmailTemplateVars) => RenderedEmail
> = {
  request_published: (vars) => {
    const title = escapeHtml(vars.requestTitle);
    return {
      html: shell(
        'The story you upvoted has been published',
        `<p style="font-size:16px;line-height:1.6;margin:0;">A research request you supported is now a published story:</p>
         <p style="font-size:17px;line-height:1.5;margin:12px 0 0;font-style:italic;">“${title}”</p>`,
        'Read the story',
        vars.ctaUrl,
      ),
      text: `The story you upvoted has been published.\n\n"${vars.requestTitle}"\n\nRead it: ${vars.ctaUrl}\n\nYou're receiving this because you upvoted this research request on Resolve.`,
    };
  },
  request_rejected: (vars) => {
    const title = escapeHtml(vars.requestTitle);
    return {
      html: shell(
        'A research request you upvoted was not approved',
        `<p style="font-size:16px;line-height:1.6;margin:0;">The editorial team reviewed and did not approve:</p>
         <p style="font-size:17px;line-height:1.5;margin:12px 0 0;font-style:italic;">“${title}”</p>`,
        'Browse research requests',
        vars.ctaUrl,
      ),
      text: `A research request you upvoted was not approved.\n\n"${vars.requestTitle}"\n\nBrowse more: ${vars.ctaUrl}\n\nYou're receiving this because you upvoted this research request on Resolve.`,
    };
  },
  request_not_pursued: (vars) => {
    const title = escapeHtml(vars.requestTitle);
    const reason = vars.detail
      ? `<p style="font-size:15px;line-height:1.6;margin:16px 0 0;border-left:3px solid #b45309;padding-left:14px;color:#444;">${escapeHtml(vars.detail)}</p>`
      : '';
    return {
      html: shell(
        'An update on a research request you upvoted',
        `<p style="font-size:16px;line-height:1.6;margin:0;">The editorial team has decided not to pursue:</p>
         <p style="font-size:17px;line-height:1.5;margin:12px 0 0;font-style:italic;">“${title}”</p>${reason}`,
        'View the request',
        vars.ctaUrl,
      ),
      text: `An update on a research request you upvoted.\n\nThe editorial team has decided not to pursue:\n"${vars.requestTitle}"\n${vars.detail ? `\nWhy: ${vars.detail}\n` : ''}\nView it: ${vars.ctaUrl}\n\nYou're receiving this because you upvoted this research request on Resolve.`,
    };
  },
};

// Comment-flavoured shell (different eyebrow + footer note).
function commentShell(
  headline: string,
  paragraphHtml: string,
  ctaLabel: string,
  ctaUrl: string,
  footer: string,
): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#faf9f7;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;">
    <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;">
      <tr><td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e7e3dc;">
          <tr><td style="padding:32px 36px;">
            <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#b45309;margin-bottom:16px;">Resolve — Comments</div>
            <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;">${headline}</h1>
            ${paragraphHtml}
            <p style="margin:28px 0 0;">
              <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#b45309;color:#ffffff;text-decoration:none;padding:12px 22px;font-size:14px;letter-spacing:0.02em;">${ctaLabel}</a>
            </p>
          </td></tr>
        </table>
        <div style="font-size:12px;color:#8a8378;margin-top:18px;">${escapeHtml(footer)}</div>
      </td></tr>
    </table>
  </body>
</html>`;
}

// Build a comment renderer from a headline, lead line, optional detail block, CTA, footer.
function commentRenderer(opts: {
  headline: string;
  lead: string;
  ctaLabel: string;
  footer: string;
  detailLabel?: string;
}) {
  return (vars: EmailTemplateVars): RenderedEmail => {
    const title = escapeHtml(vars.requestTitle);
    const detail = vars.detail
      ? `<p style="font-size:15px;line-height:1.6;margin:16px 0 0;border-left:3px solid #b45309;padding-left:14px;color:#444;">${escapeHtml(vars.detail)}</p>`
      : '';
    return {
      html: commentShell(
        opts.headline,
        `<p style="font-size:16px;line-height:1.6;margin:0;">${escapeHtml(opts.lead)}</p>
         <p style="font-size:17px;line-height:1.5;margin:12px 0 0;font-style:italic;">“${title}”</p>${detail}`,
        opts.ctaLabel,
        vars.ctaUrl,
        opts.footer,
      ),
      text: `${opts.headline}\n\n${opts.lead}\n"${vars.requestTitle}"\n${vars.detail ? `\n${opts.detailLabel ?? 'Details'}: ${vars.detail}\n` : ''}\n${opts.ctaLabel}: ${vars.ctaUrl}\n\n${opts.footer}`,
    };
  };
}

const COMMENT_RENDERERS: Record<
  Exclude<EmailTemplateKey, 'request_published' | 'request_rejected' | 'request_not_pursued'>,
  (vars: EmailTemplateVars) => RenderedEmail
> = {
  comment_reply: commentRenderer({
    headline: 'You have a new reply',
    lead: 'Someone replied to your comment on:',
    ctaLabel: 'View the reply',
    footer: "You're receiving this because someone replied to your comment on Resolve.",
  }),
  comment_mention: commentRenderer({
    headline: 'You were mentioned',
    lead: 'Someone mentioned you in a comment on:',
    ctaLabel: 'View the comment',
    footer: "You're receiving this because you were mentioned in a comment on Resolve.",
  }),
  comment_removed: commentRenderer({
    headline: 'Your comment was removed',
    lead: 'A moderator removed your comment on:',
    ctaLabel: 'Review the discussion',
    detailLabel: 'Reason',
    footer: "You're receiving this because a moderator actioned your comment on Resolve.",
  }),
  comment_warning: commentRenderer({
    headline: 'You received a warning',
    lead: 'A moderator issued a warning regarding your commenting on:',
    ctaLabel: 'View your account',
    detailLabel: 'Reason',
    footer: "You're receiving this because a moderator issued a warning on your Resolve account.",
  }),
  comment_banned: commentRenderer({
    headline: 'Your commenting has been restricted',
    lead: 'A moderator has restricted your ability to comment.',
    ctaLabel: 'View your account',
    detailLabel: 'Details',
    footer: "You're receiving this because your commenting on Resolve was restricted.",
  }),
  comment_ban_lifted: commentRenderer({
    headline: 'Your commenting restriction was lifted',
    lead: 'You can comment again on Resolve.',
    ctaLabel: 'Back to Resolve',
    footer: "You're receiving this because a commenting restriction on your Resolve account was lifted.",
  }),
  report_submitted: commentRenderer({
    headline: 'New comment report',
    lead: 'A comment was reported and needs review on:',
    ctaLabel: 'Open the moderation queue',
    detailLabel: 'Context',
    footer: "You're receiving this because you moderate comments on Resolve.",
  }),
};

export function renderEmail(key: EmailTemplateKey, vars: EmailTemplateVars): RenderedEmail {
  if (key in RENDERERS) return RENDERERS[key as keyof typeof RENDERERS](vars);
  return COMMENT_RENDERERS[key as keyof typeof COMMENT_RENDERERS](vars);
}
