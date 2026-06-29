import { Router } from "express";
import { db, userSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireAdmin } from "./auth";
import {
  getAppName, saveAppName, getAppLogo, saveAppLogo,
  getWorkStartTime, saveWorkStartTime, getLateGraceMinutes, saveLateGraceMinutes,
} from "../lib/gemini-config";
import { getPrimaryAdminEmail } from "../lib/mailer";

const router = Router();

router.get("/app", async (_req, res) => {
  try {
    const [adminEmail, appName, appLogo, workStartTime, lateGraceMinutes] = await Promise.all([
      getPrimaryAdminEmail(),
      getAppName(),
      getAppLogo(),
      getWorkStartTime(),
      getLateGraceMinutes(),
    ]);
    return res.json({ appName, appLogo, adminEmail, workStartTime, lateGraceMinutes });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch("/app", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = z.object({
      appName: z.string().min(1).max(100).optional(),
      appLogo: z.string().optional(),
      workStartTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      lateGraceMinutes: z.number().int().min(0).max(120).optional(),
    }).parse(req.body);

    await Promise.all([
      body.appName !== undefined ? saveAppName(body.appName.trim()) : Promise.resolve(),
      body.appLogo !== undefined ? saveAppLogo(body.appLogo) : Promise.resolve(),
      body.workStartTime !== undefined ? saveWorkStartTime(body.workStartTime) : Promise.resolve(),
      body.lateGraceMinutes !== undefined ? saveLateGraceMinutes(body.lateGraceMinutes) : Promise.resolve(),
    ]);

    const [adminEmail, appName, appLogo, workStartTime, lateGraceMinutes] = await Promise.all([
      getPrimaryAdminEmail(),
      getAppName(),
      getAppLogo(),
      getWorkStartTime(),
      getLateGraceMinutes(),
    ]);
    return res.json({ appName, appLogo, adminEmail, workStartTime, lateGraceMinutes });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get("/", requireAuth, async (req: any, res) => {
  try {
    const existing = await db.select().from(userSettingsTable).where(eq(userSettingsTable.userId, req.userId)).limit(1);
    if (existing.length === 0) {
      const [created] = await db.insert(userSettingsTable).values({ userId: req.userId }).returning();
      return res.json(created);
    }
    return res.json(existing[0]);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch("/", requireAuth, async (req: any, res) => {
  try {
    const schema = z.object({
      theme: z.enum(["light", "dark", "system", "ocean", "forest", "rose", "sunset", "purple", "gold", "ruby", "slate"]).optional(),
      fontSize: z.enum(["small", "medium", "large"]).optional(),
      language: z.enum(["ar", "en", "sv"]).optional(),
    });
    const body = schema.parse(req.body);
    await db.insert(userSettingsTable).values({ userId: req.userId, ...body }).onConflictDoUpdate({
      target: userSettingsTable.userId,
      set: body,
    });
    const [settings] = await db.select().from(userSettingsTable).where(eq(userSettingsTable.userId, req.userId)).limit(1);
    return res.json(settings);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/* ─── AI Key — stored in DB (persists across deployments) ─── */

router.get("/my-ai-key", requireAuth, async (req: any, res) => {
  try {
    const [row] = await db.select({ aiKey: userSettingsTable.aiKey })
      .from(userSettingsTable)
      .where(eq(userSettingsTable.userId, req.userId))
      .limit(1);
    const key = row?.aiKey ?? "";
    return res.json({
      hasKey: !!key,
      maskedKey: key ? key.slice(0, 8) + "••••••••" + key.slice(-4) : null,
      key,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/my-ai-key", requireAuth, async (req: any, res) => {
  try {
    const { key } = z.object({ key: z.string() }).parse(req.body);
    await db.insert(userSettingsTable)
      .values({ userId: req.userId, aiKey: key || null })
      .onConflictDoUpdate({
        target: userSettingsTable.userId,
        set: { aiKey: key || null },
      });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
