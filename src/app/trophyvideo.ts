import { app } from "electron"
import fs from "fs"
import path from "path"
import { spawn, spawnSync } from "child_process"
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
const obsLaunchTimeoutMs = 30000
const obsLaunchPollMs = 1000
const obsShutdownGraceMs = 5000
const obsShutdownTimeoutMs = 10000

let obs: OBSWebSocket | null = null
let warmupPromise: Promise<boolean> | null = null
let captureQueue: Promise<void> = Promise.resolve()
let lifecycleQueue: Promise<void> = Promise.resolve()
let launchedObsPid: number | null = null
let replayBufferStartedByFork = false
let trackingActive = false
let gameDetected = false
let shutdownTimer: NodeJS.Timeout | null = null
let shutdownPluginAvailable: boolean | null = null
let shutdownPluginVendor: string | null = null
let managedObsSession = false
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

const getObsProcessIds = (): number[] => {
    try {
        const result = spawnSync("tasklist",["/FI","IMAGENAME eq obs64.exe","/FO","CSV","/NH"],{
            encoding: "utf8",
            windowsHide: true
        })

        if (result.status !== 0 || !result.stdout.trim())
            return []

        return result.stdout
            .trim()
            .split(/\r?\n/)
            .filter(line => line && !line.startsWith("INFO:"))
            .map(line => line.split('","')[1]?.replace(/"/g,""))
            .map(value => parseInt(value || "",10))
            .filter(pid => !Number.isNaN(pid))
    } catch {
        return []
    }
}

const killObsProcesses = (pids?: number[]) => {
    const args = pids?.length
        ? pids.flatMap(pid => ["/PID",`${pid}`])
        : ["/IM","obs64.exe"]

    try {
        spawnSync("taskkill",[...args,"/T","/F"],{
            encoding: "utf8",
            windowsHide: true
        })
    } catch (err) {
        log.write("WARN",`Unable to terminate stale OBS processes: ${err}`)
    }
}

const isObsProcessRunning = (pid: number): boolean => getObsProcessIds().includes(pid)

const launchObs = (): boolean => {
    const obsPath = obsCandidatePaths.find(candidate => fs.existsSync(candidate))
    if (!obsPath)
        return false

    try {
        const child = spawn(obsPath,["--minimize-to-tray","--startreplaybuffer"],{
            cwd: path.dirname(obsPath),
            detached: true,
            stdio: "ignore",
            windowsHide: true
        })

        launchedObsPid = child.pid || null
        child.unref()
        log.write("INFO",`Started OBS from "${obsPath}" with working directory "${path.dirname(obsPath)}"`)
        return true
    } catch (err) {
        log.write("ERROR",`Unable to start OBS from "${obsPath}": ${err}`)
        return false
    }
}

const connectObs = async (launchIfMissing = true): Promise<OBSWebSocket | null> => {
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
        shutdownPluginAvailable = null
        shutdownPluginVendor = null
        if (launchIfMissing)
            managedObsSession = true
        log.write("INFO",`Connected to OBS websocket on ${address}`)
        return client
    }

    try {
        return await connect()
    } catch (err) {
        log.write("WARN",`Unable to connect to OBS websocket on ${address}: ${err}`)

        if (!launchIfMissing) {
            warnOnce("obs-connect-failed",`OBS is not reachable on ${address}. Ensure OBS is installed and running, or enable its websocket server.`)
            return null
        }

        const staleObsPids = getObsProcessIds()

        if (staleObsPids.length) {
            log.write("WARN",`OBS is running without a reachable websocket. Restarting stale OBS process${staleObsPids.length === 1 ? "" : "es"}: ${staleObsPids.join(", ")}`)
            killObsProcesses(staleObsPids)
            await sleep(1500)
        }

        if (!launchObs()) {
            warnOnce("obs-connect-failed",`OBS is not reachable on ${address}. Ensure OBS is installed and running, or enable its websocket server.`)
            return null
        }

        const start = Date.now()

        while ((Date.now() - start) < obsLaunchTimeoutMs) {
            await sleep(obsLaunchPollMs)

            try {
                return await connect()
            } catch {
                // Keep polling until OBS finishes startup or timeout is reached.
            }
        }

        warnOnce("obs-connect-retry-failed",`OBS websocket is still unavailable after launching OBS after waiting ${Math.round(obsLaunchTimeoutMs / 1000)} seconds.`)
        return null
    }
}

const disconnectObs = async () => {
    if (!obs)
        return

    const client = obs
    obs = null

    try {
        await client.disconnect()
    } catch (err) {
        log.write("WARN",`Unable to disconnect OBS websocket cleanly: ${err}`)
    }
}

const waitForObsProcessExit = async (pid: number,timeoutMs: number): Promise<boolean> => {
    const start = Date.now()

    while ((Date.now() - start) < timeoutMs) {
        await sleep(500)

        if (!isObsProcessRunning(pid))
            return true
    }

    return !isObsProcessRunning(pid)
}

const shutdownObsViaPlugin = async (client: OBSWebSocket,pid: number): Promise<boolean> => {
    try {
        if (shutdownPluginAvailable === false) {
            log.write("INFO","obs-shutdown-plugin not available in OBS; using fallback shutdown path")
            return false
        }

        const vendorNames = shutdownPluginVendor ? [shutdownPluginVendor] : ["shutdown-plugin","obs-shutdown-plugin"]
        let lastErr: unknown = null

        for (const vendorName of vendorNames) {
            try {
                await client.call("CallVendorRequest",{
                    vendorName,
                    requestType: "shutdown",
                    requestData: {
                        reason: "Requested by Steam Achievement Notifier trophy video helper",
                        support_url: "https://github.com/norihiro/obs-shutdown-plugin/issues",
                        force: true
                    }
                })

                shutdownPluginAvailable = true
                shutdownPluginVendor = vendorName
                log.write("INFO",`Requested OBS shutdown via ${vendorName} for process ${pid}`)
                break
            } catch (err) {
                lastErr = err
            }
        }

        if (!shutdownPluginAvailable || !shutdownPluginVendor)
            throw lastErr instanceof Error ? lastErr : new Error(`${lastErr}`)

        if (await waitForObsProcessExit(pid,obsShutdownTimeoutMs)) {
            log.write("INFO",`Closed OBS process ${pid} via ${shutdownPluginVendor}`)
            obs = null
            return true
        }

        log.write("WARN",`${shutdownPluginVendor} did not close OBS process ${pid} within ${Math.round(obsShutdownTimeoutMs / 1000)} seconds`)
    } catch (err) {
        shutdownPluginAvailable = false
        shutdownPluginVendor = null
        log.write("WARN",`Unable to shut down OBS via obs-shutdown-plugin: ${err}`)
        log.write("INFO","obs-shutdown-plugin not available in OBS; using fallback shutdown path")
    }

    return false
}

const stopLaunchedObs = async () => {
    if (!managedObsSession)
        return

    const pid = launchedObsPid
    launchedObsPid = null

    const client = obs || await connectObs(false)

    if (!pid) {
        if (client) {
            try {
                await client.call("CallVendorRequest",{
                    vendorName: shutdownPluginVendor || "shutdown-plugin",
                    requestType: "shutdown",
                    requestData: {
                        reason: "Requested by Steam Achievement Notifier trophy video helper",
                        support_url: "https://github.com/norihiro/obs-shutdown-plugin/issues",
                        force: true
                    }
                })
                log.write("INFO","Requested OBS shutdown for managed session without tracked PID")
            } catch (err) {
                log.write("WARN",`Unable to shut down OBS for managed session without tracked PID: ${err}`)
            }
        }

        managedObsSession = false
        return
    }

    try {
        if (client && await shutdownObsViaPlugin(client,pid))
        {
            managedObsSession = false
            return
        }

        spawn("taskkill",["/PID",`${pid}`,"/T"],{
            detached: true,
            stdio: "ignore",
            windowsHide: true
        }).unref()
        log.write("INFO",`Requested clean shutdown for OBS process ${pid} launched by trophy video helper`)

        if (await waitForObsProcessExit(pid,obsShutdownTimeoutMs)) {
            log.write("INFO",`Closed OBS process ${pid} launched by trophy video helper`)
            managedObsSession = false
            return
        }

        log.write("WARN",`OBS process ${pid} did not close cleanly within ${Math.round(obsShutdownTimeoutMs / 1000)} seconds; forcing shutdown`)
        killObsProcesses([pid])
        managedObsSession = false
    } catch (err) {
        log.write("WARN",`Unable to close OBS process ${pid}: ${err}`)
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
                replayBufferStartedByFork = true
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

const stopManagedReplayBuffer = async () => {
    const client = await connectObs(false)

    if (client && replayBufferStartedByFork) {
        try {
            const { outputActive } = await client.call("GetReplayBufferStatus") as { outputActive?: boolean }
            if (outputActive) {
                await client.call("StopReplayBuffer")
                log.write("INFO","Stopped OBS replay buffer started by trophy video helper")
            }
        } catch (err) {
            log.write("WARN",`Unable to stop OBS replay buffer cleanly: ${err}`)
        }
    }

    replayBufferStartedByFork = false
}

const stopManagedObs = async () => {
    await captureQueue.catch(() => undefined)
    await stopManagedReplayBuffer()
    await stopLaunchedObs()
    await disconnectObs()
}

const clearShutdownTimer = () => {
    if (!shutdownTimer)
        return

    clearTimeout(shutdownTimer)
    shutdownTimer = null
}

const refreshLifecycle = async () => {
    clearShutdownTimer()

    if (trackingActive || gameDetected) {
        await ensureReplayBufferReady()
        return
    }

    shutdownTimer = setTimeout(() => {
        shutdownTimer = null
        lifecycleQueue = lifecycleQueue
            .then(async () => {
                if (trackingActive || gameDetected)
                    return

                await stopManagedObs()
            })
            .catch(err => log.write("ERROR",`Unable to shut down OBS after grace period: ${err}`))
    },obsShutdownGraceMs)
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
    prewarm: () => undefined,
    setTrackingActive: async (value: boolean) => {
        trackingActive = value

        lifecycleQueue = lifecycleQueue
            .then(async () => await refreshLifecycle())
            .catch(err => log.write("ERROR",`Unable to update OBS tracking lifecycle: ${err}`))

        await lifecycleQueue
    },
    setGameDetected: async (value: boolean) => {
        gameDetected = value

        lifecycleQueue = lifecycleQueue
            .then(async () => await refreshLifecycle())
            .catch(err => log.write("ERROR",`Unable to update OBS game-detection lifecycle: ${err}`))

        await lifecycleQueue
    },
    shutdown: async () => {
        trackingActive = false
        gameDetected = false
        clearShutdownTimer()

        lifecycleQueue = lifecycleQueue
            .then(async () => await stopManagedObs())
            .catch(err => log.write("ERROR",`Unable to shut down OBS lifecycle cleanly: ${err}`))

        await lifecycleQueue
    },
    capture: async (notify: Notify) => {
        captureQueue = captureQueue
            .then(async () => await captureReplay(notify))
            .catch(err => log.write("ERROR",`Unable to save trophy replay for "${notify.englishname || notify.name}": ${err}`))

        await captureQueue
    }
}
