import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'
import { withApiHardening } from '@/lib/api/hardening'
import { sanitizeObject } from '@/lib/api/validation'
import { pinata } from '@/lib/pinata'
import { validatePinataResponse, validateGatewayUrl, retryWithBackoff } from '@/lib/api/storage'

export const dynamic = 'force-dynamic'

// --- Validation Constants ---
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 // 10MB
const MAX_THUMBNAIL_SIZE_BYTES = 5 * 1024 * 1024 // 5MB

// Common educational document MIME types
const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/msword', // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.ms-excel', // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-powerpoint', // .ppt
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
]

// Allowed thumbnail image types
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'upload', rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      try {
        const form = await request.formData()
        const file = form.get('file')
        const image = form.get('thumbnail')

        // 1️⃣ Validate Required Fields
        if (!file) {
          auditLog({
            event: 'upload_failed',
            route: 'upload',
            method: 'POST',
            status: 400,
            reason: 'missing_file',
          })
          return NextResponse.json(
            { error: 'No document file provided.' },
            { status: 400 }
          )
        }

        // 2️⃣ Validate Main File (Size & Type)
        if (file.size > MAX_FILE_SIZE_BYTES) {
          const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
          auditLog({
            event: 'upload_failed',
            route: 'upload',
            method: 'POST',
            status: 413,
            reason: 'file_too_large',
          })
          return NextResponse.json(
            {
              error: `File size (${sizeMB}MB) exceeds the 10MB limit.`,
            },
            { status: 413 }
          )
        }

        if (!ALLOWED_FILE_TYPES.includes(file.type)) {
          auditLog({
            event: 'upload_failed',
            route: 'upload',
            method: 'POST',
            status: 415,
            reason: 'unsupported_file_type',
          })
          return NextResponse.json(
            {
              error: `Unsupported file type: ${file.type || 'unknown'}. Allowed types include PDF, Word, Excel, PPT, TXT, and ZIP.`,
            },
            { status: 415 }
          )
        }

        // 3️⃣ Validate Thumbnail (Size & Type) - If provided
        if (image) {
          if (image.size > MAX_THUMBNAIL_SIZE_BYTES) {
            const sizeMB = (image.size / (1024 * 1024)).toFixed(2)
            auditLog({
              event: 'upload_failed',
              route: 'upload',
              method: 'POST',
              status: 413,
              reason: 'thumbnail_too_large',
            })
            return NextResponse.json(
              {
                error: `Thumbnail size (${sizeMB}MB) exceeds the 5MB limit.`,
              },
              { status: 413 }
            )
          }

          if (!ALLOWED_IMAGE_TYPES.includes(image.type)) {
            auditLog({
              event: 'upload_failed',
              route: 'upload',
              method: 'POST',
              status: 415,
              reason: 'unsupported_thumbnail_type',
            })
            return NextResponse.json(
              {
                error: `Unsupported thumbnail type: ${image.type || 'unknown'}. Allowed types are JPG, PNG, and WEBP.`,
              },
              { status: 415 }
            )
          }
        }

        const results = {}

        // 4️⃣ Upload the main file
        try {
          const uploadedFile = await retryWithBackoff(
            () => pinata.upload.public.file(file),
            3,
            1000,
            (err, attempt) => {
              console.warn(`[Storage] Document upload attempt ${attempt} failed: ${err.message}`);
            }
          )
          validatePinataResponse(uploadedFile, 'document')
          
          const fileUrl = await retryWithBackoff(
            () => pinata.gateways.public.convert(uploadedFile.cid),
            3,
            1000,
            (err, attempt) => {
              console.warn(`[Storage] Document gateway conversion attempt ${attempt} failed: ${err.message}`);
            }
          )
          validateGatewayUrl(fileUrl, 'document')
          results.fileUrl = fileUrl
        } catch (err) {
          auditLog({
            event: 'upload_failed',
            route: 'upload',
            method: 'POST',
            status: 500,
            reason: `document_upload_failure: ${err.message}`,
          })
          return NextResponse.json(
            { error: `Failed to upload document to storage: ${err.message}` },
            { status: 500 }
          )
        }

        // 5️⃣ Upload thumbnail (if provided)
        if (image) {
          try {
            const fileThumb = await retryWithBackoff(
              () => pinata.upload.public.file(image),
              3,
              1000,
              (err, attempt) => {
                console.warn(`[Storage] Thumbnail upload attempt ${attempt} failed: ${err.message}`);
              }
            )
            validatePinataResponse(fileThumb, 'thumbnail')

            const imgUrl = await retryWithBackoff(
              () => pinata.gateways.public.convert(fileThumb.cid),
              3,
              1000,
              (err, attempt) => {
                console.warn(`[Storage] Thumbnail gateway conversion attempt ${attempt} failed: ${err.message}`);
              }
            )
            validateGatewayUrl(imgUrl, 'thumbnail')
            results.imgUrl = imgUrl
          } catch (err) {
            auditLog({
              event: 'upload_failed',
              route: 'upload',
              method: 'POST',
              status: 500,
              reason: `thumbnail_upload_failure: ${err.message}`,
            })
            return NextResponse.json(
              { error: `Failed to upload thumbnail to storage: ${err.message}` },
              { status: 500 }
            )
          }
        }

        // 6️⃣ Prepare the rest of the form data as JSON
        const otherFields = {}
        for (const [key, value] of form.entries()) {
          if (key !== 'file' && key !== 'thumbnail') {
            otherFields[key] = value
          }
        }
        const sanitizedFields = sanitizeObject(otherFields, {
          title: 160,
          description: 5000,
          usageRights: 1000,
        })

        // Include file URLs inside the metadata
        const metadataJSON = {
          ...sanitizedFields,
          file: results.fileUrl,
          image: results.imgUrl || null,
          timestamp: new Date().toISOString(),
        }
        auditLog({
          event: 'upload_metadata_prepared',
          route: 'upload',
          method: 'POST',
          status: 200,
        })

        // 7️⃣ Upload metadata JSON to Pinata
        try {
          const uploadedJson = await retryWithBackoff(
            () => pinata.upload.public.json(metadataJSON),
            3,
            1000,
            (err, attempt) => {
              console.warn(`[Storage] Metadata upload attempt ${attempt} failed: ${err.message}`);
            }
          )
          validatePinataResponse(uploadedJson, 'metadata')

          const jsonUrl = await retryWithBackoff(
            () => pinata.gateways.public.convert(uploadedJson.cid),
            3,
            1000,
            (err, attempt) => {
              console.warn(`[Storage] Metadata gateway conversion attempt ${attempt} failed: ${err.message}`);
            }
          )
          validateGatewayUrl(jsonUrl, 'metadata')
          results.metadataUrl = jsonUrl
        } catch (err) {
          auditLog({
            event: 'upload_failed',
            route: 'upload',
            method: 'POST',
            status: 500,
            reason: `metadata_upload_failure: ${err.message}`,
          })
          return NextResponse.json(
            { error: `Failed to publish metadata to storage: ${err.message}` },
            { status: 500 }
          )
        }

        auditLog({
          event: 'upload_complete',
          route: 'upload',
          method: 'POST',
          status: 200,
        })

        // 8️⃣ Return the JSON file URL
        return NextResponse.json({
          success: true,
          fileUrl: results.fileUrl,
          image: results.imgUrl || '',
          metadata: results.metadataUrl,
        })
      } catch (err) {
        auditLog({
          event: 'upload_failed',
          route: 'upload',
          method: 'POST',
          status: 500,
          reason: err.message,
        })
        return NextResponse.json(
          { error: err.message || 'Upload failed' },
          { status: 500 }
        )
      }
    }
  )
}
