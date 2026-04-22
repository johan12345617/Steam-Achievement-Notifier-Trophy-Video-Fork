<p align="center">
<img width="75%" src="./img/santextlogo.svg">
</p>

# Steam Achievement Notifier Trophy Video Fork

This repository is a custom fork of **Steam Achievement Notifier** focused on one extra goal:

- save an OBS replay clip automatically when a Steam achievement unlocks
- I tried steam and game bar recorded but that apps doesnt record the SAN notification , so thats why use obs
- The obs replay buffer has a hit on the gpu so if u have a weak gpu maybe can impact performance of the game
- open OBS only while a tracked game is active, then close it again when the game is released

The original project is here:

- [SteamAchievementNotifier/SteamAchievementNotifier](https://github.com/SteamAchievementNotifier/SteamAchievementNotifier)

This fork is not the official upstream project. It builds on top of it.

## What This Fork Adds

- OBS Replay Buffer integration on achievement unlock
- automatic saving of replay clips into per-game folders
- filenames based on the achievement name
- optional capture of the SAN stream notification inside OBS recordings
- small stream-window quality-of-life fixes for this workflow

Saved clips go to:

`%USERPROFILE%\Videos\trophies-videos\<game name - appid>\<achievement name>.mp4`

Example:

`C:\Users\<you>\Videos\trophies-videos\God of War - 1593500\Off The Record.mp4`

## Current Behavior

When a supported Steam achievement unlocks, this fork:

1. waits long enough for the trophy popup to appear on screen
2. asks OBS to save the Replay Buffer
3. moves the newest replay into the `trophies-videos` folder structure

Test notifications are also supported and are saved under:

`%USERPROFILE%\Videos\trophies-videos\Steam Achievement Notifier - test`

## Requirements

- Windows
- OBS Studio installed
- OBS WebSocket server enabled
- OBS Replay Buffer enabled
- a Replay Buffer length set in OBS
- a scene that captures what you want to save
- for clean automatic OBS shutdown without crash/safe-mode popups: install the [Shutdown Plugin](https://github.com/noris-plugins-for-obs/shutdown-plugin/releases/tag/0.3.0)

If you want the popup itself inside the video, use SAN's `Stream Notifications` window as an OBS source.

## Recommended OBS Setup

For full-screen desktop capture:

- add a `Display Capture` source
- enable `Replay Buffer`
- set your preferred replay length and quality
- if you want SAN to close OBS cleanly when the game ends, install the `obs31` shutdown-plugin build for OBS 31.1+ / OBS 32 and make sure OBS loads `shutdown-plugin.dll`

For capturing the SAN popup in the saved video:

- enable `Stream Notifications` in SAN
- add that SAN window as an OBS `Window Capture` source
- place it above `Display Capture`
- add a `Chroma Key` filter in OBS

This fork currently uses a green chroma-key background for the stream-notification window.

## Important Notes

- this fork can start OBS automatically when SAN detects a tracked game
- this fork can stop Replay Buffer and close OBS again when the game is released
- without the shutdown plugin, OBS may still need a fallback shutdown path that can show an unclean-close popup
- replay clips currently target Steam achievements, not RetroAchievements
- this fork is tailored around OBS-based capture, not Steam Game Recording

## Installation

Use this fork the same way you would use the upstream app, but with OBS configured first.

Basic flow:

1. Install and set up OBS.
2. Enable OBS WebSocket.
3. Enable Replay Buffer.
4. Install the OBS Shutdown Plugin if you want clean automatic OBS exit.
5. Start SAN.
6. Launch a tracked game.
7. Unlock an achievement.
8. Check `%USERPROFILE%\Videos\trophies-videos`.

## Shutdown Plugin

This fork supports the OBS shutdown plugin so it can ask OBS to exit cleanly after the tracked game closes.

- Plugin project: [noris-plugins-for-obs/shutdown-plugin](https://github.com/noris-plugins-for-obs/shutdown-plugin)
- For OBS `32.1.1`, use the `obs31` Windows build from the plugin release page
- If the plugin is missing, SAN falls back to a Windows-side shutdown path

When the plugin is loaded correctly, SAN should log that it requested OBS shutdown through `shutdown-plugin` instead of using the fallback path.

## Upstream Project

The upstream project still contains the main app, original documentation, wiki, and credits:

- [Original Repository](https://github.com/SteamAchievementNotifier/SteamAchievementNotifier)
- [Original Wiki](https://github.com/SteamAchievementNotifier/SteamAchievementNotifier/wiki)

If you want the base notification app without this trophy-video behavior, use the original project instead.

## Credits

This fork is based on the work of the original **Steam Achievement Notifier** project and its contributors.

Upstream credits and dependencies are documented here:

- [Original README](https://github.com/SteamAchievementNotifier/SteamAchievementNotifier)
