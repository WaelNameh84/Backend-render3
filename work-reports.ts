import { Router } from "express";
import { db, workReportsTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { createHash, randomUUID } from "crypto";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { requireAuth } from "./auth";
import { createNotification } from "../lib/notify";
import { uploadBase64Image, isObjectStorageEnabled } from "../lib/objectStorage";

const router = Router();

/* ─── Cloudinary signed upload helper ──────────────────────── */

function cloudinaryEnabled(): boolean {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

async function uploadToCloudinary(base64Data: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
  const apiKey    = process.env.CLOUDINARY_API_KEY!;
  const apiSecret = process.env.CLOUDINARY_API_SECRET!;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const folder    = "work_reports";

  const paramStr  = `folder=${folder}&timestamp=${timestamp}`;
  const signature = createHash("sha1")
    .update(paramStr + apiSecret)
    .digest("hex");

  const formData = new FormData();
  formData.append("file",      `data:image/jpeg;base64,${base64Data}`);
  formData.append("api_key",   apiKey);
  formData.append("timestamp", timestamp);
  formData.append("folder",    folder);
  formData.append("signature", signature);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: "POST", body: formData }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cloudinary upload failed: ${err}`);
  }

  const json = await res.json() as any;
  return json.secure_url as string;
}

/* ─── Database fallback — embeds image as base64 data URL ─────
   Works on any host (Render, Railway, etc.) with no extra services.
   Images are stored directly in the DB row and always persist.      */

function saveAsDataUrl(base64Data: string): string {
  return `data:image/jpeg;base64,${base64Data}`;
}

/* ─── Upload dispatcher (priority: Cloudinary > Object Storage > DB) ─── */

async function uploadImage(base64Data: string): Promise<string> {
  if (cloudinaryEnabled()) {
    return uploadToCloudinary(base64Data);
  }
  if (isObjectStorageEnabled()) {
    return uploadBase64Image(base64Data, "work_reports");
  }
  return saveAsDataUrl(base64Data);
}

/* ─── Routes ─────────────────────────────────────────────── */

/**
 * POST /api/work-reports
 * Body: { imageData: string (base64, no prefix), note?: string }
 */
router.post("/", requireAuth, async (req: any, res) => {
  try {
    const { imageData, note } = req.body as { imageData: string; note?: string };
    if (!imageData) return res.status(400).json({ error: "imageData is required" });

    const imageUrl = await uploadImage(imageData);

    const [report] = await db
      .insert(workReportsTable)
      .values({ userId: req.userId, imageUrl, note: note?.trim() || null })
      .returning();

    const [me] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    await createNotification({
      type: "SYSTEM_ALERT",
      title: "📷 توثيق عمل جديد",
      message: `رفع الموظف ${me?.name ?? req.userId} تقرير توثيق جديد${note ? `: ${note.slice(0, 80)}` : ""}`,
      relatedId: report.id,
      relatedType: "work_report",
    });

    return res.status(201).json({
      ...report,
      createdAt: report.createdAt instanceof Date ? report.createdAt.toISOString() : report.createdAt,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/work-reports
 * Admin sees all; employee sees own only
 */
router.get("/", requireAuth, async (req: any, res) => {
  try {
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const isAdmin = me?.role === "admin";

    const rows = await db
      .select({
        id:           workReportsTable.id,
        userId:       workReportsTable.userId,
        employeeName: usersTable.name,
        imageUrl:     workReportsTable.imageUrl,
        note:         workReportsTable.note,
        createdAt:    workReportsTable.createdAt,
      })
      .from(workReportsTable)
      .innerJoin(usersTable, eq(workReportsTable.userId, usersTable.id))
      .orderBy(desc(workReportsTable.createdAt));

    const filtered = isAdmin ? rows : rows.filter((r: any) => r.userId === req.userId);

    return res.json(
      filtered.map((r: any) => ({
        ...r,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      }))
    );
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/work-reports/:id  (admin or report owner)
 */
router.get("/:id", requireAuth, async (req: any, res) => {
  try {
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const rows = await db
      .select({
        id:           workReportsTable.id,
        userId:       workReportsTable.userId,
        employeeName: usersTable.name,
        imageUrl:     workReportsTable.imageUrl,
        note:         workReportsTable.note,
        createdAt:    workReportsTable.createdAt,
      })
      .from(workReportsTable)
      .innerJoin(usersTable, eq(workReportsTable.userId, usersTable.id))
      .where(eq(workReportsTable.id, id))
      .limit(1);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    const r = rows[0];
    if (me?.role !== "admin" && r.userId !== req.userId) return res.status(403).json({ error: "Access denied" });
    return res.json({ ...r, createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/work-reports/mine  (employee deletes ALL own reports)
 */
router.delete("/mine", requireAuth, async (req: any, res) => {
  try {
    await db.delete(workReportsTable).where(eq(workReportsTable.userId, req.userId));
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/work-reports/:id  (admin or report owner)
 */
router.delete("/:id", requireAuth, async (req: any, res) => {
  try {
    const [me] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const id = parseInt(req.params.id);
    const [report] = await db.select().from(workReportsTable).where(eq(workReportsTable.id, id)).limit(1);
    if (!report) return res.status(404).json({ error: "Not found" });
    if (me?.role !== "admin" && report.userId !== req.userId) return res.status(403).json({ error: "Access denied" });
    await db.delete(workReportsTable).where(eq(workReportsTable.id, id));
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
