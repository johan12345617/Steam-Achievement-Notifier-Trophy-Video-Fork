import { app } from "electron"
import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import OBSWebSocket, { EventSubscription } from "obs-websocket-js"
import { log } from "./log"

interface ObsWebSocketConfig {
    auth_required?: boolean
    server_enabled?: boolean
    server_password?: string
    server_port?: number
}

const obsConfigPath = path.join(process.env.APPDATA || "","obs-studio","plugin_config","obs-websocket","config.json")
const obsCandidatePaths = [
    "C:/Program Files/obs-studio/bin/64bit/obs64.exe",
    "C:/Program Files (x86)/obs-studio/bin/64bit/obs64.exe",
    path.join(process.env.LOCALAPPDATA || "","Programs","obs-studio","bin","64bit","obs64.exe")
]

let obs: OBSWebSocket | null = null
let warmupPromise: Promise<boolean> | null = null
let captureQueue: Promise<void> = Promise.resolve()
const warned = new Set<string>()

const warnOnce = (key: string,msg: string) => {
    if (warned.has(key))
        return

    warned.add(key)
    log.write("WARN",msg)
}

const sleep = async (ms: number) => await new Promise(resolve => setTimeout(resolve,ms))

const replaySaveDelayMs = (notify: Notify): number => {
    const displayTimeMs = Math.round(((notify.customisation?.displaytime || 0) * 1000) + 1000)
    return Math.max(10000,displayTimeMs)
}

const sanitisePathPart = (value: string | null | undefined,fallback: string): string => {
    const cleaned = (value || fallback)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g," ")
        .replace(/\s+/g," ")
        .trim()
        .replace(/[. ]+$/g,"")

    return cleaned || fallback
}

const readObsConfig = (): ObsWebSocketConfig | null => {
    try {
        return fs.existsSync(obsConfigPath) ? JSON.parse(fs.readFileSync(obsConfigPath,"utf8")) as ObsWebSocketConfig : null
    } catch (err) {
        log.write("ERROR",`Unable to read OBS websocket config from "${obsConfigPath}": ${err}`)
        return null
    }
}

const launchObs = (): boolean => {
    const obsPath = obsCandidatePaths.find(candidate => fs.existsSync(candidate))
    if (!obsPath)
        return false

    try {
        spawn(obsPath,["--minimize-to-tray","--startreplaybuffer"],{
            detached: true,
            stdio: "ignore"
        }).unref()
        log.write("INFO",`Started OBS from "${obsPath}"`)
        return true
    } catch (err) {
        log.write("ERROR",`Unable to start OBS from "${obsPath}": ${err}`)
        return false
    }
}

const connectObs = async (): Promise<OBSWebSocket | null> => {
    if (obs)
        return obs

    const config = readObsConfig()

    if (!config) {
        warnOnce("obs-config-missing",`OBS websocket config not found at "${obsConfigPath}"`)
        return null
    }

    if (!config.server_enabled) {
        warnOnce("obs-websocket-disabled",`OBS websocket server is disabled. Enable it in OBS via Tools > WebSocket Server Settings to save trophy videos automatically.`)
        return null
    }

    const address = `ws://127.0.0.1:${config.server_port || 4455}`
    const password = config.auth_required ? config.server_password || "" : undefined

    const connect = async () => {
        const client = new OBSWebSocket()
        client.on("ConnectionClosed",() => {
            obs = null
            log.write("WARN","OBS websocket connection closed")
        })

        await client.connect(address,password,{
            eventSubscriptions: EventSubscription.Outputs
        })

        obs = client
        log.write("INFO",`Connected to OBS websocket on ${address}`)
        return client
    }

    try {
        return await connect()
    } catch (err) {
        log.write("WARN",`Unable to connect to OBS websocket on ${address}: ${err}`)

        if (!launchObs()) {
            warnOnce("obs-connect-failed",`OBS is not reachable on ${address}. Ensure OBS is installed and running, or enable its websocket server.`)
            return null
        }

        await sleep(8000)

        try {
            return await connect()
        } catch (retryErr) {
            warnOnce("obs-connect-retry-failed",`OBS websocket is still unavailable after launching OBS: ${retryErr}`)
            return null
        }
    }
}

const ensureReplayBufferReady = async (): Promise<boolean> => {
    if (warmupPromise)
        return warmupPromise

    warmupPromise = (async () => {
        const client = await connectObs()
        if (!client)
            return false

        try {
            const { outputActive } = await client.call("GetReplayBufferStatus") as { outputActive?: boolean }
            if (!outputActive) {
                await client.call("StartReplayBuffer")
                log.write("INFO","Started OBS replay buffer")
                await sleep(1000)
            }

            return true
        } catch (err) {
            log.write("ERROR",`Unable to prepare OBS replay buffer: ${err}`)
            return false
        } finally {
            warmupPromise = null
        }
    })()

    return warmupPromise
}

const getLastReplayPath = async (client: OBSWebSocket): Promise<string | null> => {
    try {
        const { savedReplayPath } = await client.call("GetLastReplayBufferReplay") as { savedReplayPath?: string }
        return savedReplayPath || null
    } catch {
        return null
    }
}

const waitForReplayPath = async (client: OBSWebSocket,previousPath: string | null): Promise<string> => {
    return await new Promise<string>((resolve,reject) => {
        const timer = setTimeout(() => {
            cleanup()
            reject(new Error("Timed out waiting for OBS replay save"))
        },15000)

        const cleanup = () => {
            clearTimeout(timer)
            client.off("ReplayBufferSaved",handler)
        }

        const handler = ({ savedReplayPath }: { savedReplayPath: string }) => {
            if (!savedReplayPath || savedReplayPath === previousPath)
                return

            cleanup()
            resolve(savedReplayPath)
        }

        client.on("ReplayBufferSaved",handler)
    })
}

const ensureUniquePath = (targetPath: string): string => {
    if (!fs.existsSync(targetPath))
        return targetPath

    const parsed = path.parse(targetPath)
    let suffix = 2

    while (true) {
        const candidate = path.join(parsed.dir,`${parsed.name} (${suffix})${parsed.ext}`)
        if (!fs.existsSync(candidate))
            return candidate

        suffix++
    }
}

const moveReplayFile = async (sourcePath: string,targetPath: string) => {
    const finalTargetPath = ensureUniquePath(targetPath)
    fs.mkdirSync(path.dirname(finalTargetPath),{ recursive: true })

    let lastErr: unknown = null

    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            fs.renameSync(sourcePath,finalTargetPath)
            log.write("INFO",`Moved trophy replay to "${finalTargetPath}"`)
            return
        } catch (err) {
            lastErr = err
            await sleep(400 * attempt)
        }
    }

    try {
        fs.copyFileSync(sourcePath,finalTargetPath)
        fs.rmSync(sourcePath,{ force: true })
        log.write("INFO",`Copied trophy replay to "${finalTargetPath}" after rename retries failed`)
        return
    } catch (err) {
        lastErr = err
    }

    throw lastErr instanceof Error ? lastErr : new Error(`${lastErr}`)
}

const targetReplayPath = (notify: Notify,sourcePath: string): string => {
    const root = path.join(app.getPath("videos"),"trophies-videos")
    const gameFolder = notify.istestnotification
        ? "Steam Achievement Notifier - test"
        : `${sanitisePathPart(notify.gamename,"Unknown Game")} - ${notify.appid}`
    const fileStem = sanitisePathPart(
        notify.istestnotification
            ? (notify.englishname || `${notify.type.toUpperCase()} TEST NOTIFICATION`)
            : (notify.englishname || notify.name || notify.apiname || "Achievement"),
        "Achievement"
    )
    const extension = path.extname(sourcePath) || ".mp4"

    return path.join(root,gameFolder,`${fileStem}${extension}`)
}

const shouldCapture = (notify: Notify): boolean => {
    if (notify.ra)
        return false

    if (notify.istestnotification)
        return ["main","semi","rare","plat"].includes(notify.type)

    return !!notify.appid
        && !!notify.gamename
        && !!notify.englishname
        && ["main","semi","rare"].includes(notify.type)
}

const captureReplay = async (notify: Notify) => {
    if (!shouldCapture(notify))
        return

    const ready = await ensureReplayBufferReady()
    if (!ready)
        return

    const client = await connectObs()
    if (!client)
        return

    const delayMs = replaySaveDelayMs(notify)
    log.write("INFO",`Waiting ${Math.round(delayMs / 1000)}s before saving replay for "${notify.englishname || notify.name || notify.apiname}"`)
    await sleep(delayMs)

    const previousPath = await getLastReplayPath(client)
    await client.call("SaveReplayBuffer")
    const replayPath = await waitForReplayPath(client,previousPath)

    if (!fs.existsSync(replayPath))
        throw new Error(`OBS reported replay path "${replayPath}", but the file does not exist`)

    await moveReplayFile(replayPath,targetReplayPath(notify,replayPath))
}

export const trophyvideo = {
    prewarm: () => {
        void ensureReplayBufferReady()
    },
    capture: async (notify: Notify) => {
        captureQueue = captureQueue
            .then(async () => await captureReplay(notify))
            .catch(err => log.write("ERROR",`Unable to save trophy replay for "${notify.englishname || notify.name}": ${err}`))

        await captureQueue
    }
}
