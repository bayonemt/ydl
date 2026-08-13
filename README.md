# ydl — Video Downloader Console Snippet

A simple browser console snippet that detects the current social media page, finds the video URL, and gives you a floating UI to **download** or **copy** the link — no extensions, no installs.

## Supported platforms

| Platform | Method | Notes |
|---|---|---|
| **Instagram** | Authenticated API `/api/v1/media/{id}/info/` | Requires being logged in |
| **TikTok** | Script tag JSON + internal API | Prefers watermark-free URL |
| **Reddit** | `.json` API + `shreddit-player` | Auto-merges separate video + audio streams |
| **X / Twitter** | GraphQL `TweetResultByRestId` | Requires being logged in |
| **Pinterest** | `PinResource/get/` API | Works on regional subdomains (br.pinterest.com, etc.) |

## Usage

1. Open any supported page with a video (individual post/reel/tweet, not the feed)
2. Open DevTools → **Console** (`F12` or `Ctrl+Shift+J`)
3. Paste the entire contents of `vdl.js` and press **Enter**
4. A floating panel appears — click **⬇ Download** or **📋 Copy URL**

> Run the snippet again while the panel is open to close it (toggle).

## Notes

- **Login required** for Instagram, X/Twitter, and some Reddit communities
- **Reddit** downloads two separate CMAF streams (video + audio) and merges them in-memory using a pure-JS MP4 muxer — no FFmpeg needed
- The snippet makes all requests using the browser's own session cookies (`credentials: 'include'`), so it works as long as you're logged in normally
- **YouTube is not supported** — their CDN requires server-side signature transforms that cannot be performed from a browser console snippet

## Bookmarklet

To avoid pasting every time, wrap the code in a bookmarklet:

1. Minify `vdl.js` (e.g. with [toptal.com/developers/javascript-minifier](https://www.toptal.com/developers/javascript-minifier))
2. Prefix it with `javascript:`
3. Save it as a browser bookmark
4. Click the bookmark on any supported page

## License

MIT
