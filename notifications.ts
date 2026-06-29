import { Router } from "express";
import { db, notificationsTable } from "@workspace/db";
import { eq, desc, and, ne } from "drizzle-orm";
import { requireAdmin } from "./auth";

const router = Router();

router.get("/", requireAdmin, async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(notificationsTable)
      .where(ne(notificationsTable.status, "archived"))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(100);
    return res.json(rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/count", requireAdmin, async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.status, "unread"));
    return res.json({ count: rows.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body as { status: "read" | "archived" };
    if (!["read", "archived"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const [updated] = await db
      .update(notificationsTable)
      .set({ status })
      .where(eq(notificationsTable.id, id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Not found" });
    return res.json(updated);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/mark-all-read", requireAdmin, async (_req, res) => {
  try {
    await db
      .update(notificationsTable)
      .set({ status: "read" })
      .where(eq(notificationsTable.status, "unread"));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/clear-all", requireAdmin, async (_req, res) => {
  try {
    await db
      .update(notificationsTable)
      .set({ status: "archived" })
      .where(ne(notificationsTable.status, "archived"));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(notificationsTable).where(eq(notificationsTable.id, id));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
