import fs from "fs"
import http from "http"
import https from "https"
import path from "path"
import { log } from "./log"
import { sanhelper } from "./sanhelper"

const defaultApiBase = "https://steam-achievements-viewer.onrender.com/api"
const defaultOwnerSteamId = "76561198296469966"
const steam64Base = "76561197960265728"
const raMediaAppIdOffset = 900000000
const savJsonTimeoutMs = 120000
let queue: Promise<void> = Promise.resolve()
const warned = new Set<string>()
const steamIdPattern = /^\d{17}$/

type UploadTarget = {
    achievementApiName: string,
    ownerSteamId: string,
    appId: number
}

type UploadTicket = {
    media: {
        id: string
    },
    uploadUrl: string,
    headers: Record<string,string>
}

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

const envOwnerSteamId = (): string | null => {
    const value = process.env.SAV_OWNER_STEAM_ID || process.env.SAV_OWNER_STEAMID || process.env.SAV_STEAM_ID || defaultOwnerSteamId
    return steamIdPattern.test(value) ? value : null
}

const resolveRecentSteamOwner = async (): Promise<string | null> => {
    try {
        const loginUsersPath = path.join(sanhelper.steampath,"config","loginusers.vdf")
        if (!fs.existsSync(loginUsersPath))
            return null

        const VDF = await import("simple-vdf")
        const users = VDF.parse(fs.readFileSync(loginUsersPath,"utf8")).users || {}
        let fallback: string | null = null

        for (const steamId of Object.keys(users)) {
            if (!steamIdPattern.test(steamId))
                continue

            fallback = fallback || steamId
            const entry = users[steamId]
            const mostRecentKey = Object.keys(entry).find(key => key.toLowerCase() === "mostrecent")

            if (mostRecentKey && parseInt(entry[mostRecentKey]) === 1)
                return steamId
        }

        return fallback
    } catch (err) {
        warnOnce("sav-owner-resolve",`Unable to resolve SAV owner SteamID from Steam login data: ${(err as Error).message}`)
        return null
    }
}

const resolveOwnerSteamId = async (notify: Notify): Promise<string | null> => {
    if (!notify.ra && notify.steam3id)
        return addDecimalStrings(steam64Base,String(notify.steam3id))

    return envOwnerSteamId() || await resolveRecentSteamOwner()
}

const raAchievementApiName = (notify: Notify): string | null => {
    if (notify.raAchievementId && Number.isInteger(notify.raAchievementId) && notify.raAchievementId > 0)
        return `ra_${notify.raAchievementId}`

    return /^ra_\d+$/.test(notify.apiname) ? notify.apiname : null
}

const baseShouldUpload = (notify: Notify,filePath: string): boolean => {
    if (notify.istestnotification || notify.apiname === "PLAT_NOTIFICATION")
        return false

    return !!notify.appid
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

const requestJson = async <T>(method: "POST",endpoint: URL,body: object): Promise<T> => {
    const payload = Buffer.from(JSON.stringify(body))
    const transport = endpoint.protocol === "https:" ? https : http

    return await new Promise<T>((resolve,reject) => {
        const req = transport.request({
            method,
            protocol: endpoint.protocol,
            hostname: endpoint.hostname,
            port: endpoint.port,
            path: `${endpoint.pathname}${endpoint.search}`,
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Content-Length": payload.length
            }
        },res => {
            const chunks: Buffer[] = []
            res.on("data",chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
            res.on("end",() => {
                const responseBody = Buffer.concat(chunks).toString("utf8")

                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0,500)}`))
                    return
                }

                try {
                    resolve(JSON.parse(responseBody) as T)
                } catch (err) {
                    reject(err)
                }
            })
        })

        req.setTimeout(savJsonTimeoutMs,() => req.destroy(new Error(`JSON request timed out for ${endpoint.href}`)))
        req.on("error",reject)
        req.end(payload)
    })
}

const putFile = async (uploadUrl: string,headers: Record<string,string>,filePath: string,sizeBytes: number): Promise<void> => {
    const endpoint = new URL(uploadUrl)
    const transport = endpoint.protocol === "https:" ? https : http

    await new Promise<void>((resolve,reject) => {
        const req = transport.request({
            method: "PUT",
            protocol: endpoint.protocol,
            hostname: endpoint.hostname,
            port: endpoint.port,
            path: `${endpoint.pathname}${endpoint.search}`,
            headers: {
                ...headers,
                "Content-Length": sizeBytes
            }
        },res => {
            const chunks: Buffer[] = []
            res.on("data",chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
            res.on("end",() => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve()
                    return
                }

                reject(new Error(`R2 upload failed with HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0,500)}`))
            })
        })

        req.setTimeout(15 * 60 * 1000,() => req.destroy(new Error(`R2 upload timed out for "${path.basename(filePath)}"`)))
        req.on("error",reject)

        const stream = fs.createReadStream(filePath)
        stream.on("error",reject)
        stream.pipe(req)
    })
}

const resolveUploadTarget = async (notify: Notify): Promise<UploadTarget | null> => {
    const ownerSteamId = await resolveOwnerSteamId(notify)

    if (!ownerSteamId) {
        warnOnce("sav-owner-missing","Unable to upload achievement media to Steam Achievements Viewer: no SAV owner SteamID was found")
        return null
    }

    if (notify.ra) {
        const achievementApiName = raAchievementApiName(notify)
        if (!achievementApiName) {
            warnOnce("sav-ra-achievement-missing","Unable to upload RetroAchievements media to Steam Achievements Viewer: no RA AchievementID was found")
            return null
        }

        return {
            achievementApiName,
            ownerSteamId,
            appId: raMediaAppIdOffset + Number(notify.appid)
        }
    }

    if (!notify.steam3id)
        return null

    return {
        achievementApiName: notify.apiname,
        ownerSteamId,
        appId: notify.appid!
    }
}

const uploadFile = async (notify: Notify,type: "image" | "video",filePath: string): Promise<void> => {
    if (!baseShouldUpload(notify,filePath))
        return

    const stats = fs.statSync(filePath)
    if (!stats.isFile() || stats.size === 0)
        return

    const target = await resolveUploadTarget(notify)
    if (!target)
        return

    const contentType = contentTypeFor(filePath,type)
    const ticket = await requestJson<UploadTicket>("POST",new URL(`${apiBase()}/media/san/upload-url/${encodeURIComponent(target.achievementApiName)}`),{
        ownerSteamId: target.ownerSteamId,
        appId: target.appId,
        type,
        fileName: path.basename(filePath),
        contentType,
        sizeBytes: stats.size
    })

    await putFile(ticket.uploadUrl,{
        ...ticket.headers,
        "Content-Type": ticket.headers["Content-Type"] || contentType
    },filePath,stats.size)

    await requestJson("POST",new URL(`${apiBase()}/media/san/complete/${encodeURIComponent(ticket.media.id)}`),{
        ownerSteamId: target.ownerSteamId
    })

    log.write("INFO",`Uploaded ${type} for "${target.achievementApiName}" to Steam Achievements Viewer`)
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
