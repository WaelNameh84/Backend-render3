import { Router } from "express";
import { db, messagesTable, usersTable } from "@workspace/db";
import { eq, and, or, desc, isNull } from "drizzle-orm";
import { requireAuth } from "./auth";
import { z } from "zod";

const router = Router();

router.get("/unread-count", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const rows = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          or(
            eq(messagesTable.receiverId, userId),
            eq(messagesTable.isBroadcast, true)
          ),
          eq(messagesTable.isRead, false)
        )
      );
    return res.json({ count: rows.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/inbox", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const rows = await db
      .select({
        id: messagesTable.id,
        senderId: messagesTable.senderId,
        receiverId: messagesTable.receiverId,
        subject: messagesTable.subject,
        body: messagesTable.body,
        isRead: messagesTable.isRead,
        isBroadcast: messagesTable.isBroadcast,
        parentId: messagesTable.parentId,
        createdAt: messagesTable.createdAt,
        senderName: usersTable.name,
      })
      .from(messagesTable)
      .leftJoin(usersTable, eq(messagesTable.senderId, usersTable.id))
      .where(
        and(
          or(
            eq(messagesTable.receiverId, userId),
            eq(messagesTable.isBroadcast, true)
          ),
          isNull(messagesTable.parentId)
        )
      )
      .orderBy(desc(messagesTable.createdAt))
      .limit(100);
    return res.json(rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/sent", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const rows = await db
      .select({
        id: messagesTable.id,
        senderId: messagesTable.senderId,
        receiverId: messagesTable.receiverId,
        subject: messagesTable.subject,
        body: messagesTable.body,
        isRead: messagesTable.isRead,
        isBroadcast: messagesTable.isBroadcast,
        parentId: messagesTable.parentId,
        createdAt: messagesTable.createdAt,
        receiverName: usersTable.name,
      })
      .from(messagesTable)
      .leftJoin(usersTable, eq(messagesTable.receiverId, usersTable.id))
      .where(
        and(
          eq(messagesTable.senderId, userId),
          isNull(messagesTable.parentId)
        )
      )
      .orderBy(desc(messagesTable.createdAt))
      .limit(100);
    return res.json(rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/:id/thread", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const parentId = parseInt(req.params.id);

    const [parent] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, parentId))
      .limit(1);

    if (!parent) return res.status(404).json({ error: "Not found" });

    const isParticipant =
      parent.senderId === userId ||
      parent.receiverId === userId ||
      parent.isBroadcast;

    if (!isParticipant) return res.status(403).json({ error: "Forbidden" });

    const replies = await db
      .select({
        id: messagesTable.id,
        senderId: messagesTable.senderId,
        receiverId: messagesTable.receiverId,
        subject: messagesTable.subject,
        body: messagesTable.body,
        isRead: messagesTable.isRead,
        isBroadcast: messagesTable.isBroadcast,
        parentId: messagesTable.parentId,
        createdAt: messagesTable.createdAt,
        senderName: usersTable.name,
      })
      .from(messagesTable)
      .leftJoin(usersTable, eq(messagesTable.senderId, usersTable.id))
      .where(eq(messagesTable.parentId, parentId))
      .orderBy(messagesTable.createdAt);

    return res.json({ parent, replies });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

const sendSchema = z.object({
  receiverId: z.number().optional(),
  subject: z.string().min(1).max(255),
  body: z.string().min(1),
  isBroadcast: z.boolean().optional().default(false),
  parentId: z.number().optional(),
});

router.post("/", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

    const { receiverId, subject, body, isBroadcast, parentId } = parsed.data;

    if (!isBroadcast && !receiverId) {
      return res.status(400).json({ error: "receiverId required for non-broadcast messages" });
    }

    const [msg] = await db
      .insert(messagesTable)
      .values({
        senderId: userId,
        receiverId: isBroadcast ? null : receiverId,
        subject,
        body,
        isBroadcast: isBroadcast ?? false,
        parentId: parentId ?? null,
      })
      .returning();

    return res.status(201).json(msg);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch("/:id/read", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const id = parseInt(req.params.id);

    const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, id)).limit(1);
    if (!msg) return res.status(404).json({ error: "Not found" });

    const canRead = msg.receiverId === userId || msg.isBroadcast || msg.senderId === userId;
    if (!canRead) return res.status(403).json({ error: "Forbidden" });

    await db.update(messagesTable).set({ isRead: true }).where(eq(messagesTable.id, id));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", requireAuth, async (req: any, res) => {
  try {
    const userId = req.userId;
    const id = parseInt(req.params.id);

    const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, id)).limit(1);
    if (!msg) return res.status(404).json({ error: "Not found" });

    if (msg.senderId !== userId && msg.receiverId !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await db.delete(messagesTable).where(eq(messagesTable.id, id));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
