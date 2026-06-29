import { Router } from "express";
import { db, locationsTable, attendanceTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireAdmin } from "./auth";

const router = Router();

router.get("/", requireAuth, async (_req, res) => {
  try {
    const locations = await db.select().from(locationsTable).orderBy(locationsTable.name);
    return res.json(locations);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/", requireAdmin, async (req: any, res) => {
  try {
    const schema = z.object({
      name: z.string().min(1),
      address: z.string().min(1),
      lat: z.number().optional(),
      lng: z.number().optional(),
    });
    const body = schema.parse(req.body);
    const [location] = await db.insert(locationsTable).values({
      name: body.name,
      address: body.address,
      lat: body.lat,
      lng: body.lng,
      createdBy: req.userId,
    }).returning();
    return res.status(201).json(location);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.patch("/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const schema = z.object({
      name: z.string().optional(),
      address: z.string().optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
    });
    const body = schema.parse(req.body);
    const updates: any = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.address !== undefined) updates.address = body.address;
    if (body.lat !== undefined) updates.lat = body.lat;
    if (body.lng !== undefined) updates.lng = body.lng;
    const [updated] = await db.update(locationsTable).set(updates).where(eq(locationsTable.id, id)).returning();
    if (!updated) return res.status(404).json({ error: "Location not found" });
    return res.json(updated);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete("/:id", requireAdmin, async (req: any, res) => {
  try {
    const id = parseInt(req.params.id);
    const [exists] = await db.select({ id: locationsTable.id }).from(locationsTable).where(eq(locationsTable.id, id)).limit(1);
    if (!exists) return res.status(404).json({ error: "Location not found" });
    await db.update(attendanceTable).set({ locationId: null }).where(eq(attendanceTable.locationId, id));
    await db.delete(locationsTable).where(eq(locationsTable.id, id));
    return res.status(204).send();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
