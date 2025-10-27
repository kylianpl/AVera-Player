# AVera Player
AVera Player is a web media player built from scratch using WebCodecs, WebAudio and LibAV.js.
The goal of this project is a universal media player can play as much formats as possible.

Currently, the player can play any containers supported by LibAV.js (mp4, mkv, webm, avi, mov, etc.) and any video codecs supported by WebCodecs (H.264, VP8/9, AV1, etc.). Audio is decoded using either WebCodecs or LibAV.js and played using WebAudio.
A lot of the code is inspired by the audio video player sample from the WebCodecs specification.

## Features
- Download then play videos from a sample file (no streaming yet)
- Uses WebCodecs for hardware video/audio decoding (if available)
- Uses LibAV.js for software decoding fallback
- Synchronized audio and video playback with the WebAudio timer
- Seeking support (currently not very accurate)
- Basic playback controls (play, pause, seek)
- Displays video resolution and codec information

## Getting Started
1. Clone the repository with submodules:
   ```bash
   git clone --recurse-submodules https://github.com/kylianpl/AVera-Player.git
   ```
2. Start a local web server:
   ```bash
   cd AVera-Player
   python server.py
   ```

The player should now be accessible at `http://localhost:8888`.

## Contributing
Contributions are welcome! Please open issues and pull requests for any features, bug fixes, or improvements.
Especially needed are improvements to seeking accuracy and better handling of various media formats, so if you have experience in these areas, your help would be greatly appreciated.
