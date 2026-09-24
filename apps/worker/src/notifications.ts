import { config } from "./config";
import { pool } from "./db";

/**
 * Best-effort lifecycle notifications emitted by the worker.
 *
 * Each call writes the in-app notification and an outbox email event inside one
 * transaction (the outbox table is the source of truth; the outbox worker does
 * the actual SMTP delivery). Failures are logged but never fail the media
 * pipeline: notification problems must not move an asset out of the privacy
 * state the pipeline already committed.
 */
export async function recordWorkerAudit(input: {
  actorId?: string | null;
  action: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'media', $3, $4::jsonb)`,
      [input.actorId ?? null, input.action, input.resourceId ?? null, JSON.stringify(input.metadata ?? {})]
    );
  } catch (error) {
    console.error({ action: input.action, resourceId: input.resourceId, error }, "failed to write media audit log");
  }
}

async function notifyUsers(
  userIds: string[],
  input: { type: string; title: string; body: string; link: string }
): Promise<void> {
  if (userIds.length === 0) return;
  const link = `${config.APP_ORIGIN}${input.link}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO notifications(user_id, type, title, body, link)
       SELECT id, $2, $3, $4, $5 FROM unnest($1::uuid[]) AS id`,
      [userIds, input.type, input.title, input.body, input.link]
    );
    await client.query(
      `INSERT INTO outbox_events(event_type, aggregate_type, aggregate_id, payload)
       SELECT 'email.notification', 'user', u.id,
              jsonb_build_object('to', u.email, 'subject', $2, 'text', $4, 'html', $5)
       FROM users u WHERE u.id = ANY($1::uuid[]) AND u.email IS NOT NULL`,
      [userIds, input.title, input.title, `${input.body}\n\n${link}`, `<p>${input.body}</p><p><a href="${link}">${link}</a></p>`]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error({ type: input.type, error }, "failed to create media notifications");
  } finally {
    client.release();
  }
}

export async function notifyMediaOwner(
  ownerId: string,
  input: { type: string; title: string; body: string; link?: string }
): Promise<void> {
  await notifyUsers([ownerId], { ...input, link: input.link ?? "/me/contributions" });
}

export async function notifyModerators(
  input: { type: string; title: string; body: string; link?: string }
): Promise<void> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE role IN ('moderator', 'admin') AND status = 'active'"
  );
  await notifyUsers(result.rows.map((row) => row.id), { ...input, link: input.link ?? "/moderation" });
}
