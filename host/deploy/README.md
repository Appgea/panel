# Appgea Deploy

A browser tool for uploading finished videos to YouTube, Facebook, Instagram, TikTok and X in **your own logged-in Chrome**.
It has no model and no API key inside. The agent you already use does the thinking:
Claude Code on your subscription, or any harness that can run a shell command or an MCP server.

- **The extension** runs commands in Chrome through the DevTools protocol, so sites see real clicks and typing.
  Files go in straight from disk. While it controls a tab, Chrome shows an "is debugging this browser" bar.
- **`appgea_deploy.py`** is the relay between the agent and the extension, plus a CLI and an MCP server on top of it.
- **Account lock:** `upload` and `type` are refused on a tab until `verify` finds the expected account
  (`accounts.json` in this folder, copied from `accounts.example.json`) on the page, and no `_never` account. Any page load locks the tab again.
- **Publishing:** a click on the site's final button (per site: YouTube Publish/Save, TikTok Post, Instagram Share,
  Facebook Yayınla, X Post) is refused unless the call says `publish`, coordinate clicks included.
  The flag stops stray clicks, not the agent: when the user asked for the post, the agent passes `publish` once
  every field is filled and checked on a screenshot.
- **File size:** Instagram web refused a 2.4 GB / 16 Mbps cut ("could not be read by your browser"), and X dropped one
  silently. Upload ~5 Mbps copies (`h264_nvenc -b:v 5M`).

## Setup, once

1. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick this folder.
2. Copy `accounts.example.json` to `accounts.json` and put your own account names in it.
3. Log in to each platform once in that Chrome.

That's all. There is no key and no pairing code. The relay starts by itself on the first command.
It answers only the extension and programs on this PC; web pages are refused.

## Wiring a harness

- **Any shell:** `python appgea_deploy.py <command>`. See the command list below.
- **MCP** (Claude Code, Claude Desktop, Cursor, ...): the command is `python <abs path>/appgea_deploy.py mcp`.
  Claude Code: `claude mcp add appgea-deploy -- python "<abs path>/appgea_deploy.py" mcp`.
  Tools: `deploy_open`, `deploy_snapshot`, `deploy_screenshot`, `deploy_click`, `deploy_type`, `deploy_upload`,
  `deploy_key`, `deploy_scroll`, `deploy_mark`.

```
open <youtube|facebook|instagram|tiktok|x|url>   new window; prints {"tab": N}
snap <tab>                     the numbered interactive elements (hidden file inputs too)
shot <tab>                     screenshot to .state/shots/*.jpg; prints its path
click <tab> <id> [--publish]   type <tab> <id> <text|@file>   upload <tab> <id|0> <path>
key <tab> <Enter|Escape|Tab>   scroll <tab> <dy>   mark <tab> <id>   tabs   close <tab>
```

`upload ... 0` fills a native file picker that a click opened. Pickers never show, and `snap` says when one is waiting.

## The loop for an agent

`open` → `verify <tab> <platform>` → `snap` → act on the numbers → `snap` again after every change (numbers are reassigned on each snap).
Use `shot` when the list is not enough, for example to check upload progress or a crop screen. Uploads take minutes:
re-snap until the page moves on. When only the final button is left: screenshot, check every field, then `click ... --publish` if the user asked for posting; otherwise `mark` it and stop.

## Platform notes

The job's data lives in the episode's `deploy.json`: video, cover, title, text and the expected `account`.
Check the account the page shows first. On a mismatch, stop.

- **YouTube Studio:** Create → Upload videos → file input. Title (max 100) and Description are editable boxes.
  Thumbnail → "Upload file" takes the cover. "No, it's not made for kids". Next until Visibility.
  The final button is Save / Publish.
- **Facebook (Business Suite):** check the Page, top left. Create post → Add video. A long video is a post, not a reel.
  Leave Instagram unticked. The final button is Publish.
- **Instagram:** Create (+) → Post → "Select from computer". Crop: Original. Next, Next. Caption.
  Cover, if offered. The final button is Share. Business Suite has silently dropped an 18:33 Reel before; check after posting.
- **TikTok Studio:** the file input, which may be hidden. Wait for the upload. Caption box: clear it, then type.
  Edit cover → Upload cover. The final button is Post.
- **X:** check the handle. Media → video. Text. Wait for "<file>: Hazır". The final button is the composer's own `button "Gönderi yayınla"`; the left-bar link with the same name only opens a new composer (a post was lost that way).
