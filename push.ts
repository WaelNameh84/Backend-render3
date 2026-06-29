import { Router } from "express";
import webpush from "web-push";
import { db, pushSubscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "./auth";

const router = Router();

const PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  ?? "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const EMAIL       = process.env.VAPID_EMAIL       ?? "mailto:admin@attendx.app";

if (PUBLIC_KEY && PRIVATE_KEY) {
  webpush.setVapidDetails(EMAIL, PUBLIC_KEY, PRIVATE_KEY);
}

/* ─── Routes ─────────────────────────────────────────────────── */

router.get("/vapid-key", (_req, res) => {
  return res.json({ publicKey: PUBLIC_KEY });
});

router.post("/subscribe", requireAuth, async (req: any, res) => {
  const { subscription, enabled, startTime, endTime } = req.body as {
    subscription: webpush.PushSubscription;
    enabled:   boolean;
    startTime: string;
    endTime:   string;
  };
  if (!subscription?.endpoint) return res.status(400).json({ error: "Invalid subscription" });

  try {
    await db.insert(pushSubscriptionsTable)
      .values({
        userId: req.userId,
        endpoint: subscription.endpoint,
        p256dh: (subscription.keys as any)?.p256dh ?? "",
        auth: (subscription.keys as any)?.auth ?? "",
        enabled: enabled ? "true" : "false",
        startTime: startTime ?? "09:00",
        endTime: endTime ?? "17:00",
      })
      .onConflictDoUpdate({
        target: pushSubscriptionsTable.userId,
        set: {
          endpoint: subscription.endpoint,
          p256dh: (subscription.keys as any)?.p256dh ?? "",
          auth: (subscription.keys as any)?.auth ?? "",
          enabled: enabled ? "true" : "false",
          startTime: startTime ?? "09:00",
          endTime: endTime ?? "17:00",
        },
      });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/unsubscribe", requireAuth, async (req: any, res) => {
  try {
    await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.userId, req.userId));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* ─── Alarm scheduler (runs every 30 s) ─────────────────────── */

function nowHHMM(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

const firedToday = new Set<string>();

setInterval(async () => {
  const current = nowHHMM();
  const todayKey = new Date().toISOString().slice(0, 10);

  let entries: typeof pushSubscriptionsTable.$inferSelect[] = [];
  try {
    entries = await db.select().from(pushSubscriptionsTable);
  } catch { return; }

  for (const entry of entries) {
    if (entry.enabled !== "true") continue;

    const subscription: webpush.PushSubscription = {
      endpoint: entry.endpoint,
      keys: { p256dh: entry.p256dh, auth: entry.auth },
    };

    const tryFire = async (type: "start" | "end", time: string) => {
      if (current !== time) return;
      const key = `${entry.userId}-${todayKey}-${type}`;
      if (firedToday.has(key)) return;
      firedToday.add(key);

      const isStart = type === "start";
      const payload = JSON.stringify({
        title: isStart ? "🕐 بدء الدوام" : "🕔 انتهاء الدوام",
        body:  isStart ? `حان وقت بدء دوامك (${time})` : `انتهى وقت دوامك (${time})`,
        icon:  "/icon-192.svg",
        tag:   `alarm-${type}`,
      });

      webpush.sendNotification(subscription, payload).catch(async (err: any) => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          try {
            await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.userId, entry.userId));
          } catch { /* ignore */ }
        }
      });
    };

    await tryFire("start", entry.startTime);
    await tryFire("end",   entry.endTime);
  }

  if (current === "00:01") firedToday.clear();
}, 30_000);

export default router;
