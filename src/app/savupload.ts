import fs from "fs"
import http from "http"
import https from "https"
import path from "path"
import { log } from "./log"

const defaultApiBase = "http://localhost:3000/api"
const steam64Base = "76561197960265728"
let queue: Promise<void> = Promise.resolve()
const warned = new Set<string>()

const warnOnce = (key: string,msg: string) => {
    if (warned.has(key))
        return

    warned.add(key)
    log.write("WARN",msg)
}

const addDecimalStrings = (left: string,right: string): string => {
    let carry = 0
    let result = ""
    let i = left.length - 1
    let j = right.length - 1

    while (i >= 0 || j >= 0 || carry > 0) {
        const sum = (i >= 0 ? Number(left[i--]) : 0) + (j >= 0 ? Number(right[j--]) : 0) + carry
        result = `${sum % 10}${result}`
        carry = Math.floor(sum / 10)
    }

    return result
}

const apiBase = (): string => (process.env.SAV_API_BASE || process.env.SAV_API_URL || defaultApiBase).replace(/\/+$/,"")

const shouldUpload = (notify: Notify,filePath: string): boolean => {
    if (notify.ra || notify.istestnotification || notify.apiname === "PLAT_NOTIFICATION")
        return false

    return !!notify.appid
        && !!notify.steam3id
        && !!notify.apiname
        && fs.existsSync(filePath)
}

const contentTypeFor = (filePath: string,type: "image" | "video"): string => {
    const ext = path.extname(filePath).toLowerCase()
    const map: Record<string,string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime"
    }

    return map[ext] || (type === "image" ? "image/png" : "video/mp4")
}

const fieldPart = (boundary: string,name: string,value: string | number): Buffer => Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="${name}"`,
    "",
    `${value}`,
    ""
].join("\r\n"))

const fileHeader = (boundary: string,name: string,filePath: string,contentType: string): Buffer => Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="${name}"; filename="${path.basename(filePath).replace(/"/g,"_")}"`,
    `Content-Type: ${contentType}`,
    "",
    ""
].join("\r\n"))

const uploadFile = async (notify: Notify,type: "image" | "video",filePath: string): Promise<void> => {
    if (!shouldUpload(notify,filePath))
        return

    const stats = fs.statSync(filePath)
    if (!stats.isFile() || stats.size === 0)
        return

    const boundary = `----san-sav-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const endpoint = new URL(`${apiBase()}/media/san/achievement/${encodeURIComponent(notify.apiname)}`)
    const ownerSteamId = addDecimalStrings(steam64Base,String(notify.steam3id))
    const fields = [
        fieldPart(boundary,"ownerSteamId",ownerSteamId),
        fieldPart(boundary,"steam3Id",notify.steam3id),
        fieldPart(boundary,"appId",notify.appid!)
    ]
    const header = fileHeader(boundary,type,filePath,contentTypeFor(filePath,type))
    const trailer = Buffer.from(`\r\n--${boundary}--\r\n`)
    const contentLength = fields.reduce((sum,part) => sum + part.length,0) + header.length + stats.size + trailer.length
    const transport = endpoint.protocol === "https:" ? https : http

    await new Promise<void>((resolve,reject) => {
        const req = transport.request({
            method: "POST",
            protocol: endpoint.protocol,
            hostname: endpoint.hostname,
            port: endpoint.port,
            path: `${endpoint.pathname}${endpoint.search}`,
            headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": contentLength
            }
        },res => {
            const chunks: Buffer[] = []
            res.on("data",chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
            res.on("end",() => {
                const body = Buffer.concat(chunks).toString("utf8")
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    log.write("INFO",`Uploaded ${type} for "${notify.apiname}" to Steam Achievements Viewer`)
                    resolve()
                    return
                }

                reject(new Error(`SAV upload failed with HTTP ${res.statusCode}: ${body.slice(0,500)}`))
            })
        })

        req.on("error",reject)
        fields.forEach(part => req.write(part))
        req.write(header)

        const stream = fs.createReadStream(filePath)
        stream.on("error",reject)
        stream.on("end",() => req.end(trailer))
        stream.pipe(req,{ end: false })
    })
}

export const savupload = {
    upload: (notify: Notify,type: "image" | "video",filePath: string) => {
        queue = queue
            .then(async () => await uploadFile(notify,type,filePath))
            .catch(err => {
                const code = (err as NodeJS.ErrnoException).code || "unknown"
                warnOnce(`sav-upload-${code}`,`Unable to upload achievement media to Steam Achievements Viewer: ${(err as Error).message}`)
            })
    }
}
