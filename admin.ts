import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "./auth";
import { sendApprovalNotificationToUser, sendRejectionNotificationToUser } from "../lib/mailer";

const router = Router();

function appUrl(): string {
  return process.env.REPLIT_APP_URL ?? process.env.APP_URL ?? "https://attendx88.onrender.com";
}

router.get("/pending-users", requireAdmin, async (_req, res) => {
  try {
    const pending = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
        department: usersTable.department,
        position: usersTable.position,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.isApproved, false));
    console.log(`[Admin] GET /pending-users → found ${pending.length} pending user(s):`, pending.map(u => ({ id: u.id, email: u.email })));
    return res.json(pending);
  } catch (err: any) {
    console.error("[Admin] GET /pending-users error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/approve/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [user] = await db
      .update(usersTable)
      .set({ isApproved: true })
      .where(eq(usersTable.id, id))
      .returning();
    if (!user) return res.status(404).json({ error: "User not found" });
    sendApprovalNotificationToUser({ name: user.name, email: user.email }, appUrl()).catch(console.error);
    const { passwordHash, ...safe } = user;
    return res.json(safe);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/reject/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    sendRejectionNotificationToUser({ name: user.name, email: user.email }).catch(console.error);
    await db.delete(usersTable).where(eq(usersTable.id, id));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
