import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";
import { NonRetryableError } from "@/agent/retry";
import type { AgentTool } from "@/agent/types";

/**
 * Email over SMTP.
 *
 * With SMTP_HOST unset, mail goes to an Ethereal test inbox (free, by Nodemailer): the message is
 * accepted but never delivered, and the tool returns a preview link. That keeps the demo safe —
 * an agent can't email real people unless real SMTP settings are configured.
 */
let transporter: Promise<Transporter> | null = null;

function getTransporter(): Promise<Transporter> {
  transporter ??= (async () => {
    if (process.env.SMTP_HOST) {
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_PORT === "465",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    }
    const test = await nodemailer.createTestAccount();
    return nodemailer.createTransport({
      host: test.smtp.host,
      port: test.smtp.port,
      secure: test.smtp.secure,
      auth: { user: test.user, pass: test.pass },
    });
  })();
  return transporter;
}

export const sendEmail: AgentTool<{ to: string; subject: string; body: string }> = {
  name: "send_email",
  description: "Send a plain-text email. Requires human approval.",
  inputSchema: z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(10_000),
  }),
  risky: true,
  async execute({ to, subject, body }) {
    const t = await getTransporter();
    const info = await t.sendMail({
      from: process.env.SMTP_FROM ?? "AgentFlow <agentflow@example.com>",
      to,
      subject,
      text: body,
    });
    const rejected = info.rejected ?? [];
    if (rejected.length > 0) throw new NonRetryableError(`Rejected recipients: ${rejected.join(", ")}`);
    const preview = nodemailer.getTestMessageUrl(info);
    return { sent: true, messageId: info.messageId, ...(preview ? { testInbox: true, previewUrl: preview } : {}) };
  },
};

export const emailTools = [sendEmail] as AgentTool[];
