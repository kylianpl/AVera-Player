# AVera Player

AVera Player is a web media player built from scratch using WebCodecs, WebAudio and LibAV.js.
The goal is a universal media player that can play as many formats as possible.

Supports any container LibAV.js can demux (mp4, mkv, webm, avi, mov, etc.) and any video codec
supported by WebCodecs (H.264, VP8/9, AV1, etc.). Audio is decoded via WebCodecs or LibAV.js
and played through WebAudio. Inspired by the WebCodecs spec's audio/video sample.

## Features

- **Streaming playback** via HTTP Range requests (no full download) — 1 MiB block-based read
- **WebCodecs** hardware decoding with LibAV.js software fallback
- **Three renderers** chosen dynamically: WebGPU → WebGL2 → WebGL → Canvas2D
- **Synchronized A/V** with WebAudio clock + drift correction
- **Seeking** with audio/video preroll and frame-accurate display
- **Worker-side lag monitoring** — FPS and frame time tracking in the render worker
- **Bilinear chroma upsampling** for YUV→RGB conversion (I420, NV12)
- **Packet queue** with byte budget (60 packets / 16 MiB max)
- **`queueMicrotask`-based pipeline pump** — no `setTimeout(fn, 0)` in hot paths
- Dynamic stream switching (video/audio track selection)

## Getting Started

```bash
git clone --recurse-submodules https://github.com/kylianpl/AVera-Player.git
cd AVera-Player
python server.py
```

Open `http://localhost:8888`.

## Contributing

Contributions welcome! Open issues and pull requests for features, bug fixes, or improvements.
Particularly welcome: seeking accuracy, more media format support, and splitting the monolithic
Worker into separate demuxer/decoder/renderer threads.
