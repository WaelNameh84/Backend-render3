import { Router } from "express";
import { db, leaveTable, usersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "./auth";
import { createNotification } from "../lib/notify";

const router = Router();

function calcTotalDays(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  return Math.max(1, Math.ceil((e.getTime() - s.getTime()) / 86400000) + 1);
}

router.get("/", requireAuth, async (req: any, res) => {
  try {
    const { userId, status, from, to } = req.query as any;
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const targetUserId = me.role === "admin" && userId ? parseInt(userId) : req.userId;

    const baseLeaveSelect = db.select({
      id: leaveTable.id,
      userId: leaveTable.userId,
      userName: usersTable.name,
      type: leaveTable.type,
      startDate: leaveTable.startDate,
      endDate: leaveTable.endDate,
      totalDays: leaveTable.totalDays,
      reason: leaveTable.reason,
      status: leaveTable.status,
      reviewedBy: leaveTable.reviewedBy,
      reviewedAt: leaveTable.reviewedAt,
      createdAt: leaveTable.createdAt,
      documentPath: leaveTable.documentPath,
    }).from(leaveTable).leftJoin(usersTable, eq(leaveTable.userId, usersTable.id));

    const records = await (
      me.role === "admin" && !userId
        ? baseLeaveSelect.orderBy(desc(leaveTable.createdAt))
        : baseLeaveSelect.where(eq(leaveTable.userId, targetUserId)).orderBy(desc(leaveTable.createdAt))
    );

    let result = records;
    if (status) result = result.filter(r => r.status === status);
    // Overlap: leave overlaps the [from, to] range if startDate <= to AND endDate >= from
    if (from && to) result = result.filter(r => r.startDate <= to && r.endDate >= from);
    else if (from) result = result.filter(r => r.endDate >= from);
    else if (to) result = result.filter(r => r.startDate <= to);

    return res.json(result.map(r => ({
      ...r,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      createdAt: r.createdAt?.toISOString(),
    })));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", requireAuth, async (req: any, res) => {
  try {
    const schema = z.object({
      type: z.string().min(1).max(100),
      startDate: z.string(),
      endDate: z.string(),
      reason: z.string().optional(),
      documentPath: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const totalDays = calcTotalDays(body.startDate, body.endDate);
    const [record] = await db.insert(leaveTable).values({
      userId: req.userId,
      type: body.type,
      startDate: body.startDate,
      endDate: body.endDate,
      totalDays,
      reason: body.reason,
      documentPath: body.documentPath ?? null,
      status: "pending",
    }).returning();

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    createNotification({
      type: "LEAVE_REQUEST",
      title: `Leave request: ${user?.name ?? "Employee"}`,
      message: `${user?.name ?? "An employee"} requested ${body.type} leave from ${body.startDate} to ${body.endDate}.`,
      relatedId: record.id,
      relatedType: "leave",
    }).catch(console.error);
    return res.status(201).json({
      ...record,
      userName: user?.name ?? null,
      reviewedAt: null,
      createdAt: record.createdAt.toISOString(),
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
      id: leaveTable.id,
      userId: leaveTable.userId,
      userName: usersTable.name,
      type: leaveTable.type,
      startDate: leaveTable.startDate,
      endDate: leaveTable.endDate,
      totalDays: leaveTable.totalDays,
      reason: leaveTable.reason,
      status: leaveTable.status,
      reviewedBy: leaveTable.reviewedBy,
      reviewedAt: leaveTable.reviewedAt,
      createdAt: leaveTable.createdAt,
      documentPath: leaveTable.documentPath,
    }).from(leaveTable).leftJoin(usersTable, eq(leaveTable.userId, usersTable.id)).where(eq(leaveTable.id, id)).limit(1);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    const r = rows[0];
    if (me?.role !== "admin" && r.userId !== req.userId) return res.status(403).json({ error: "Forbidden" });
    return res.json({ ...r, reviewedAt: r.reviewedAt?.toISOString() ?? null, createdAt: r.createdAt?.toISOString() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch("/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const schema = z.object({
      status: z.enum(["approved", "rejected", "cancelled"]).optional(),
      reason: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const [existing] = await db.select().from(leaveTable).where(eq(leaveTable.id, id)).limit(1);
    if (!existing) return res.status(404).json({ error: "Leave request not found" });
    if (me.role !== "admin" && existing.userId !== req.userId) {
      return res.status(403).json({ error: "Not allowed" });
    }
    const updates: any = {};
    if (body.status) updates.status = body.status;
    if (body.reason) updates.reason = body.reason;
    if (body.status && me.role === "admin") {
      updates.reviewedBy = req.userId;
      updates.reviewedAt = new Date();
    }
    const [updated] = await db.update(leaveTable).set(updates).where(eq(leaveTable.id, id)).returning();
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, updated.userId)).limit(1);
    return res.json({
      ...updated,
      userName: user?.name ?? null,
      reviewedAt: updated.reviewedAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete("/:id", requireAuth, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const [existing] = await db.select().from(leaveTable).where(eq(leaveTable.id, id)).limit(1);
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (me.role !== "admin" && existing.userId !== req.userId) {
      return res.status(403).json({ error: "Not allowed" });
    }
    await db.delete(leaveTable).where(eq(leaveTable.id, id));
    return res.status(204).send();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
