export type Attachment = {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  base64: string
}

/** Metadata-only version for persistence and display (no base64 payload). */
export type AttachmentMeta = {
  filename: string
  mimeType: string
  sizeBytes: number
}

export const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB per file
export const MAX_TOTAL_SIZE = 20 * 1024 * 1024 // 20 MB total

export const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]

export const SUPPORTED_TEXT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "application/json",
  "application/xml",
  "text/x-python",
  "text/javascript",
  "text/typescript",
  "application/javascript",
  "application/typescript",
]

export const ACCEPTED_MIME_TYPES = [
  ...SUPPORTED_IMAGE_TYPES,
  ...SUPPORTED_TEXT_TYPES,
]

export function isImageAttachment(a: { mimeType: string }): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(a.mimeType)
}

/** Read a File into an Attachment. Rejects if too large or unsupported type. */
export function readFileAsAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_FILE_SIZE) {
      reject(new Error(`File "${file.name}" exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit`))
      return
    }

    // Determine mime type — fall back to text/plain for code-like extensions
    let mimeType = file.type
    if (!mimeType || !ACCEPTED_MIME_TYPES.includes(mimeType)) {
      const ext = file.name.split(".").pop()?.toLowerCase()
      const textExts = [
        "txt", "md", "csv", "html", "css", "json", "xml",
        "py", "js", "ts", "jsx", "tsx", "rs", "go", "rb",
        "java", "c", "cpp", "h", "hpp", "sh", "bash", "zsh",
        "yaml", "yml", "toml", "ini", "cfg", "conf", "log",
        "sql", "graphql", "prisma", "env", "gitignore",
        "dockerfile", "makefile",
      ]
      if (ext && textExts.includes(ext)) {
        mimeType = "text/plain"
      } else if (!mimeType) {
        reject(new Error(`Unsupported file type: ${file.name}`))
        return
      }
    }

    const reader = new FileReader()
    reader.onload = () => {
      const arrayBuffer = reader.result as ArrayBuffer
      const bytes = new Uint8Array(arrayBuffer)
      let binary = ""
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      const base64 = btoa(binary)
      resolve({
        id: crypto.randomUUID(),
        filename: file.name,
        mimeType,
        sizeBytes: file.size,
        base64,
      })
    }
    reader.onerror = () => reject(new Error(`Failed to read "${file.name}"`))
    reader.readAsArrayBuffer(file)
  })
}
