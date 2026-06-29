import { Router } from "express";
import { db, bonusesTable, usersTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireAdmin } from "./auth";
import { createNotification } from "../lib/notify";

const router = Router();

router.get("/", requireAuth, async (req: any, res) => {
  try {
    const { userId, period } = req.query as any;
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const targetUserId = me.role === "admin" && userId ? parseInt(userId) : req.userId;

    const rows = await db.select({
      id: bonusesTable.id,
      userId: bonusesTable.userId,
      userName: usersTable.name,
      type: bonusesTable.type,
      amount: bonusesTable.amount,
      reason: bonusesTable.reason,
      period: bonusesTable.period,
      createdBy: bonusesTable.createdBy,
      createdAt: bonusesTable.createdAt,
    })
      .from(bonusesTable)
      .leftJoin(usersTable, eq(bonusesTable.userId, usersTable.id))
      .where(me.role === "admin" && !userId ? undefined : eq(bonusesTable.userId, targetUserId))
      .orderBy(desc(bonusesTable.createdAt));

    let result = rows;
    if (period) result = result.filter(r => r.period === period);

    return res.json(result.map(r => ({
      ...r,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    })));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", requireAdmin, async (req: any, res) => {
  try {
    const schema = z.object({
      userId: z.number().int(),
      type: z.enum(["bonus", "deduction"]),
      amount: z.number().positive(),
      reason: z.string().optional(),
      period: z.string().optional(),
    });
    const body = schema.parse(req.body);

    const [record] = await db.insert(bonusesTable).values({
      userId: body.userId,
      type: body.type,
      amount: body.amount,
      reason: body.reason ?? null,
      period: body.period ?? null,
      createdBy: req.userId,
    }).returning();

    const [employee] = await db.select().from(usersTable).where(eq(usersTable.id, body.userId)).limit(1);
    const typeAr = body.type === "bonus" ? "مكافأة" : "خصم";
    createNotification({
      type: "SYSTEM_ALERT",
      title: `${typeAr} جديد${body.type === "bonus" ? "ة" : ""} — ${employee?.name ?? ""}`,
      message: `تم إضافة ${typeAr} بمبلغ ${body.amount} للموظف ${employee?.name ?? ""}. السبب: ${body.reason ?? "—"}`,
      relatedId: record.id,
      relatedType: "bonus",
    }).catch(console.error);

    return res.status(201).json({
      ...record,
      createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get("/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const rows = await db.select({
      id: bonusesTable.id,
      userId: bonusesTable.userId,
      userName: usersTable.name,
      type: bonusesTable.type,
      amount: bonusesTable.amount,
      reason: bonusesTable.reason,
      period: bonusesTable.period,
      createdBy: bonusesTable.createdBy,
      createdAt: bonusesTable.createdAt,
    }).from(bonusesTable).leftJoin(usersTable, eq(bonusesTable.userId, usersTable.id)).where(eq(bonusesTable.id, id)).limit(1);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    const r = rows[0];
    if (me?.role !== "admin" && r.userId !== req.userId) return res.status(403).json({ error: "Forbidden" });
    return res.json({ ...r, createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(bonusesTable).where(eq(bonusesTable.id, id));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/summary/:userId", requireAuth, async (req: any, res) => {
  try {
    const targetId = parseInt(req.params.userId);
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    if (me.role !== "admin" && targetId !== req.userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { period } = req.query as any;
    let rows = await db.select().from(bonusesTable)
      .where(eq(bonusesTable.userId, targetId));

    if (period) rows = rows.filter(r => r.period === period);

    const totalBonus = rows.filter(r => r.type === "bonus").reduce((s, r) => s + r.amount, 0);
    const totalDeduction = rows.filter(r => r.type === "deduction").reduce((s, r) => s + r.amount, 0);

    return res.json({ totalBonus, totalDeduction, net: totalBonus - totalDeduction, count: rows.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
