import nodemailer from "nodemailer";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT ?? "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function send(to: string, subject: string, html: string) {
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "noreply@attendx.app";
  const transport = createTransport();

  if (!transport) {
    console.log(`[Mailer] SMTP not configured — would have sent to <${to}>:`);
    console.log(`  Subject: ${subject}`);
    return;
  }

  await transport.sendMail({ from, to, subject, html });
}

/**
 * Reads the current admin notification emails directly from the database.
 * Always reflects the latest value saved in the Admin Profile settings.
 */
export async function getAdminEmails(): Promise<string[]> {
  try {
    const admins = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.role, "admin"));
    return admins.map(a => a.email).filter(Boolean) as string[];
  } catch (err) {
    console.error("[Mailer] Could not fetch admin emails:", err);
    return [];
  }
}

/**
 * Returns the primary admin email (first admin in the DB).
 * Used by settings API to show which address is active for notifications.
 */
export async function getPrimaryAdminEmail(): Promise<string | null> {
  const emails = await getAdminEmails();
  return emails[0] ?? null;
}

/**
 * Sends a new-user pending-approval notification to all current admin emails.
 * The recipient list is always fetched live from the database — updating the
 * Admin Email in Settings immediately affects where future notifications go.
 */
export async function sendNewUserNotificationToAdmin(
  user: { name: string; email: string; role: string },
  appUrl: string
) {
  const adminEmails = await getAdminEmails();
  if (adminEmails.length === 0) {
    console.log("[Mailer] No admin emails found — skipping admin notification.");
    return;
  }

  const subject = `[AttendX] New Account Pending Approval — ${user.name}`;
  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;">
      <h2 style="color:#1d4ed8;">New Sign-up Awaiting Approval</h2>
      <p>A new user has registered and is waiting for your approval:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px;color:#555;"><strong>Name</strong></td><td style="padding:8px;">${user.name}</td></tr>
        <tr style="background:#f9fafb;"><td style="padding:8px;color:#555;"><strong>Email</strong></td><td style="padding:8px;">${user.email}</td></tr>
        <tr><td style="padding:8px;color:#555;"><strong>Role</strong></td><td style="padding:8px;">${user.role}</td></tr>
      </table>
      <p>Please log in to your Admin Dashboard to approve or reject this request:</p>
      <a href="${appUrl}/dashboard" style="display:inline-block;padding:10px 20px;background:#1d4ed8;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Open Admin Dashboard</a>
      <p style="margin-top:24px;color:#888;font-size:12px;">AttendX — Employee Attendance System</p>
    </div>
  `;

  for (const adminEmail of adminEmails) {
    await send(adminEmail, subject, html);
  }
}

export async function sendApprovalNotificationToUser(user: { name: string; email: string }, appUrl: string) {
  const subject = `[AttendX] Your Account Has Been Approved!`;
  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;">
      <h2 style="color:#16a34a;">Your Account Has Been Approved</h2>
      <p>Hi ${user.name},</p>
      <p>Great news! Your AttendX account has been approved. You can now log in and start using the system.</p>
      <a href="${appUrl}/login" style="display:inline-block;padding:10px 20px;background:#16a34a;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Log In Now</a>
      <p style="margin-top:24px;color:#888;font-size:12px;">AttendX — Employee Attendance System</p>
    </div>
  `;
  await send(user.email, subject, html);
}

export async function sendRejectionNotificationToUser(user: { name: string; email: string }) {
  const subject = `[AttendX] Account Registration Update`;
  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:auto;">
      <h2 style="color:#dc2626;">Account Request Not Approved</h2>
      <p>Hi ${user.name},</p>
      <p>We're sorry to inform you that your account registration request for AttendX has not been approved at this time.</p>
      <p>Please contact your administrator if you believe this is a mistake.</p>
      <p style="margin-top:24px;color:#888;font-size:12px;">AttendX — Employee Attendance System</p>
    </div>
  `;
  await send(user.email, subject, html);
}
