import { config } from "./config";
import { pool } from "./db";

/**
 * Worker 侧用户通知：与 API 的 notifyUser 同一模式，
 * 在同一事务内写入站内通知和邮件 outbox，保证“业务成功但通知丢失”不会发生。
 */
export async function notifyUser(
  input: {
    userId: string;
    type: string;
    title: string;
    body: string;
    link?: string | null;
  }
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO notifications(user_id, type, title, body, link)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.userId, input.type, input.title, input.body, input.link ?? null]
    );
    const user = await client.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [input.userId]);
    const email = user.rows[0]?.email;
    if (email) {
      const link = input.link ? `${config.APP_ORIGIN}${input.link}` : config.APP_ORIGIN;
      await client.query(
        `INSERT INTO outbox_events(event_type, aggregate_type, aggregate_id, payload)
         VALUES ('email.notification', 'user', $1, $2::jsonb)`,
        [
          input.userId,
          JSON.stringify({
            to: email,
            subject: input.title,
            text: `${input.body}\n\n${link}`,
            html: `<p>${escapeHtml(input.body)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`
          })
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
