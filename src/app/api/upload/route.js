import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { sanitizeObject } from "@/lib/api/validation";
import { pinata } from "@/lib/pinata";

export const dynamic = "force-dynamic";

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "upload", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const image = form.get("thumbnail");

    if (!file) {
      auditLog({ event: "upload_failed", route: "upload", method: "POST", status: 400, reason: "missing_file" });
      return NextResponse.json({ error: "No document file provided" }, { status: 400 });
    }

    const results = {};

    // 1️⃣ Upload the main file
    const uploadedFile = await pinata.upload.public.file(file);
    const fileUrl = await pinata.gateways.public.convert(uploadedFile.cid);
    results.fileUrl = fileUrl;

    // 2️⃣ Upload thumbnail (if provided)
    if (image) {
      const fileThumb = await pinata.upload.public.file(image);
      const imgUrl = await pinata.gateways.public.convert(fileThumb.cid);
      results.imgUrl = imgUrl;
    }

    // 3️⃣ Prepare the rest of the form data as JSON
    const otherFields = {};
    for (const [key, value] of form.entries()) {
      if (key !== "file" && key !== "thumbnail") {
        otherFields[key] = value;
      }
    }
    const sanitizedFields = sanitizeObject(otherFields, {
      title: 160,
      description: 5000,
      usageRights: 1000,
    });

    // Include file URLs inside the metadata
    const metadataJSON = {
      ...sanitizedFields,
      file: results.fileUrl,
      image: results.imgUrl || null,
      timestamp: new Date().toISOString(),
    };
    auditLog({ event: "upload_metadata_prepared", route: "upload", method: "POST", status: 200 });

    // 4️⃣ Upload metadata JSON to Pinata
    const uploadedJson = await pinata.upload.public.json(metadataJSON);
    const jsonUrl = await pinata.gateways.public.convert(uploadedJson.cid);
    results.metadataUrl = jsonUrl;

    auditLog({ event: "upload_complete", route: "upload", method: "POST", status: 200 });

    // 5️⃣ Return the JSON file URL
    return NextResponse.json({
      success: true,
      fileUrl: results.fileUrl,
      image: results.imgUrl || "",
      metadata: results.metadataUrl,
    });
  } catch (err) {
    auditLog({ event: "upload_failed", route: "upload", method: "POST", status: 500, reason: err.message });
    return NextResponse.json(
      { error: err.message || "Upload failed" },
      { status: 500 }
    );
  }
    }
  );
}
