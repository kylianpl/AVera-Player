import { RingBuffer } from "./libs/ringbuf.js";
import * as LibAVJSWebCodecs from "./libav/libavjs-webcodecs-bridge.mjs";
import LibAV from "./libav/libav-6.8.8.0-player.mjs";
import {
  WebGLRenderer,
  WebGPURenderer,
  Canvas2DRenderer,
} from "./video-renderer.js";

class MediaWorker {
  constructor() {
    this.canvas = null;
    this.renderer = null;
    this.isPlaying = false;
    this.isSeeking = false;
    this.fileEnded = false;

    this.sharedArrayBuffer = null;
    this.ringbuffer = null;

    this.libav = null;
    this.formatContext = null;
    this.streams = null;
    this.videoStreamIndex = -1;
    this.audioStreamIndex = -1;
    this.packet = null;

    this.availableStreams = [];
    this.channelCount = 0;
    this.audioSampleRate = 0;
    this.videoTimeStart = null;
    this.pausedVideoTime = null;

    this.audioUseWebCodecs = false;
    this.videoUseWebCodecs = false;
    this.audioConfig = null;
    this.videoConfig = null;
    this.WCAudioDecoder = null;
    this.WCVideoDecoder = null;

    this.AudioDecoderCodecContext = null;
    this.AudioDecoderPacket = null;
    this.AudioDecoderFrame = null;
    this.VideoDecoderCodecContext = null;
    this.VideoDecoderPacket = null;
    this.VideoDecoderFrame = null;

    this.DATA_BUFFER_DURATION = 0.6;
    this.DATA_BUFFER_DECODE_TARGET_DURATION = 0.3;
    this.DECODER_QUEUE_SIZE_MAX = 5;
    this.FRAME_BUFFER_TARGET_SIZE = 5;
    this.PACKET_QUEUE_MIN_SIZE = 60;
    this.PACKET_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
    this.PACKET_QUEUE_BYTES_VIDEO = 0;
    this.PACKET_QUEUE_BYTES_AUDIO = 0;

    this.videoFrameBuffer = [];
    this.videoFillInProgress = false;
    this.audioFillInProgress = false;
    this.queueFillInProgress = false;

    this.videoPacketQueue = [];
    this.audioPacketQueue = [];
    this.PACKET_QUEUE_BYTES_AUDIO = 0;

    this.feedAudioDecoderTimeout = null;
    this.renderRafId = null;
    this.pipelinePumpScheduled = false;
    this.generation = 0;
    this.sourceName = null;
    this.sourceAbortController = null;
    this.sourceRangePromises = new Map();
    this.seekSerial = 0;
    this.audioPrerollTargetSeconds = null;
    this.lastAVDifference = 0;
    this.avDriftReportInterval = null;

    this.lagMonitor = {
      lastFrameTime: 0,
      frameTimes: [],
      totalLagEvents: 0,
      reportInterval: 3000,
      lastReportTime: 0,
      lagThresholdMs: 50,
    };


    // Set up message handler
    self.onmessage = this.handleMessage.bind(this);

    // Initialize LibAV
    this.initLibAV();
  }

  async initLibAV() {
    if (!this.libav) {
      this.libav = await LibAV.LibAV();
    }
  }

  // Handle messages from main thread
  async handleMessage(e) {
    switch (e.data.type) {
      case "init":
        await this.init(e.data);
        break;
      case "reinit":
        await this.reInit(e.data);
        break;
      case "start":
        this.startOutput();
        this.updateMediaTime(e.data.pausedVideoTime, e.data.videoTimeStart);
        break;
      case "stop":
        this.stopOutput();
        this.updateMediaTime(e.data.pausedVideoTime, e.data.videoTimeStart);
        break;
      case "updateMediaTime":
        this.updateMediaTime(e.data.pausedVideoTime, e.data.videoTimeStart);
        break;
      case "seek":
        await this.seek(e.data.seconds, e.data.videoTimeStart);
        break;
      case "changeStream":
        await this.changeStream(e.data.streamType, e.data.index);
        break;
      default:
        console.warn("Unknown message type:", e.data.type);
    }
  }

  // Initialize worker with canvas and video
  async init(data) {
    this.canvas = data.canvas;
    this.renderer = await this.createRenderer(this.canvas);
    await this.playerInit(data.video);
  }

  async createRenderer(canvas) {
    if (typeof WebGPURenderer !== "undefined" && navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          console.log("Using WebGPU renderer");
          return new WebGPURenderer(canvas);
        }
      } catch (e) {
        console.warn("WebGPU not available, falling back to WebGL:", e);
      }
    }
    if (canvas.getContext("webgl2")) {
      console.log("Using WebGL2 renderer");
      return new WebGLRenderer(canvas, "webgl2");
    }
    if (canvas.getContext("webgl")) {
      console.log("Using WebGL renderer");
      return new WebGLRenderer(canvas, "webgl");
    }
    console.log("Falling back to Canvas2D renderer");
    return new Canvas2DRenderer(canvas);
  }

  async reInit(data) {
    this.generation++;
    this.seekSerial++;
    this.cancelRenderLoop();
    this.isPlaying = false;
    self.postMessage({ type: "videoStatus", isPlaying: false });
    self.postMessage({ type: "buffering", buffering: true });
    await this.cleanupSource();
    await this.cleanupAudio();
    await this.cleanupVideo();
    this.isSeeking = false;
    this.audioStreamIndex = -1;
    this.videoStreamIndex = -1;

    this.availableStreams = [];
    this.channelCount = 0;
    this.audioSampleRate = 0;
    this.videoTimeStart = null;
    this.pausedVideoTime = null;

    this.videoFillInProgress = false;
    this.audioFillInProgress = false;
    this.queueFillInProgress = false;

    this.formatContext = null;
    this.fileEnded = false;
    this.clearPacketQueues();
    this.audioPrerollTargetSeconds = null;
    this.pausedVideoTime = 0;
    this.videoTimeStart = performance.now();
    this.renderer?.clear?.();

    await this.playerInit(data.video);
    if (data.autoplay && this.formatContext) {
      this.updateMediaTime(0, performance.now() + performance.timeOrigin);
      await this.showInitialFrame();
      this.startOutput();
    } else if (this.formatContext) {
      await this.showInitialFrame();
    }
  }

  async playerInit(videoURL) {
    const generation = ++this.generation;
    try {
      await this.initLibAV();
      await this.openSeekableSource(videoURL, generation);
      if (generation !== this.generation) return;
      [this.formatContext, this.streams] =
        await this.libav.ff_init_demuxer_file(this.sourceName);

      this.availableStreams = {
        video: [],
        audio: [],
        subtitle: [],
        other: [],
      };
      for (const streamInfo of this.streams) {
        if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_VIDEO) {
          var codecpar = await this.libav.ff_copyout_codecpar(
            streamInfo.codecpar,
          );
          if (this.videoStreamIndex == -1) {
            this.videoStreamIndex = streamInfo.index;
            this.canvas.width = codecpar.width;
            this.canvas.height = codecpar.height;
        
          }
          this.availableStreams.video.push({
            index: streamInfo.index,
            type: "video",
            codec: await this.libav.avcodec_get_name(streamInfo.codec_id),
            metadata: streamInfo.metadata,
            selected: this.videoStreamIndex == streamInfo.index,
            width: codecpar.width,
            height: codecpar.height,
          });
        } else if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_AUDIO) {
          var codecpar = await this.libav.ff_copyout_codecpar(
            streamInfo.codecpar,
          );
          if (this.audioStreamIndex == -1) {
            this.audioStreamIndex = streamInfo.index;
          }
          this.availableStreams.audio.push({
            index: streamInfo.index,
            type: "audio",
            codec: await this.libav.avcodec_get_name(streamInfo.codec_id),
            metadata: streamInfo.metadata,
            selected: this.audioStreamIndex == streamInfo.index,
            channelCount: codecpar.channels,
            sampleRate: codecpar.sample_rate,
          });
        } else if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_SUBTITLE) {
          this.availableStreams.subtitle.push({
            index: streamInfo.index,
            type: "subtitle",
            codec: await this.libav.avcodec_get_name(streamInfo.codec_id),
            metadata: streamInfo.metadata,
          });
        } else if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_ATTACHMENT) {
          this.availableStreams.other.push({
            index: streamInfo.index,
            type: "attachment",
            metadata: streamInfo.metadata,
          });
        } else if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_DATA) {
          this.availableStreams.other.push({
            index: streamInfo.index,
            type: "data",
            metadata: streamInfo.metadata,
          });
        } else if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_UNKNOWN) {
          this.availableStreams.other.push({
            index: streamInfo.index,
            type: "unknown",
            metadata: streamInfo.metadata,
          });
        }
      }

      // Notify main thread that initialization is complete
      const duration =
        (await this.libav.AVFormatContext_duration(this.formatContext)) /
        this.libav.AV_TIME_BASE;

      const metadata = await this.libav.ff_copyout_dict(
        await this.libav.AVFormatContext_metadata(this.formatContext),
      );
      const chapters = await this.libav.ff_get_demuxer_chapters(
        this.formatContext,
      );
      self.postMessage({
        type: "initFinished",
        availableStreams: this.availableStreams,
        duration: duration,
      });
      console.log(
        "%cFile information:",
        "font-weight: bold; font-size: x-large;",
      );
      console.log("Duration:\n", duration);
      console.log("Available streams:\n", this.availableStreams);
      console.log("Container Metadata:\n", metadata);
      console.log("Chapters:\n", chapters);

      // Audio
      if (this.audioStreamIndex != -1) {
        // Setup audio buffer
        await this.setupAudioDecoder();
      }
      // Video
      if (this.videoStreamIndex != -1) {
        await this.setupVideoDecoder();
      } else if (this.canvas) {
        this.canvas.width = 640;
        this.canvas.height = 360;
      }
    } catch (error) {
      console.error("Error initializing media:", error);
      self.postMessage({ type: "error", message: error.message });
    }
  }

  async openSeekableSource(videoURL, generation) {
    await this.cleanupSource();
    const url = new URL(videoURL, self.location.href).href;
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok) {
      throw new Error(`Failed to probe media: ${head.statusText}`);
    }

    const size = Number(head.headers.get("content-length"));
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error("Media server did not provide Content-Length");
    }

    const sourceName = `source-${generation}`;
    this.sourceName = sourceName;
    this.sourceAbortController = new AbortController();
    this.sourceRangePromises.clear();

    // Read in 1MB blocks to amortize HTTP round-trip overhead.
    // AVI demuxing triggers many tiny reads (8-byte headers); without this
    // each becomes a separate HTTP Range request (~200ms on localhost).
    const blockSize = 1024 * 1024;
    this.libav.onblockread = (filename, pos, length) => {
      if (!String(filename).endsWith(sourceName) || generation !== this.generation) return;
      const blockStart = Math.floor(pos / blockSize) * blockSize;
      const fetchLen = Math.min(blockSize, size - blockStart);
      this.fetchSourceRange(url, sourceName, blockStart, fetchLen, generation).catch((e) => {
        if (generation !== this.generation) return;
        console.error("Range fetch failed:", e);
        this.libav.ff_block_reader_dev_send(sourceName, pos, null, { errorCode: -1 });
      });
    };

    await this.libav.mkblockreaderdev(sourceName, size);
  }

  async fetchSourceRange(url, sourceName, pos, length, generation) {
    const end = pos + length - 1;
    const key = `${pos}:${length}`;
    if (this.sourceRangePromises.has(key)) {
      return this.sourceRangePromises.get(key);
    }

    const promise = (async () => {
      const response = await fetch(url, {
        headers: { Range: `bytes=${pos}-${end}` },
        signal: this.sourceAbortController?.signal,
      });
      if (generation !== this.generation) return;
      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status} for range ${pos}-${end}`);
      }
      let data = new Uint8Array(await response.arrayBuffer());
      if (response.status === 200) {
        data = data.subarray(pos, pos + length);
      }
      await this.libav.ff_block_reader_dev_send(sourceName, pos, data);
    })().finally(() => {
      this.sourceRangePromises.delete(key);
    });

    this.sourceRangePromises.set(key, promise);
    return promise;
  }

  async cleanupSource() {
    if (this.sourceAbortController) {
      this.sourceAbortController.abort();
      this.sourceAbortController = null;
    }
    this.sourceRangePromises.clear();
    if (this.libav && this.sourceName) {
      try {
        await this.libav.unlink(this.sourceName);
      } catch (e) {
        // It may already be gone after a failed init/reinit.
      }
      this.sourceName = null;
    }
  }

  streamTimestamp(seconds, streamIndex) {
    if (streamIndex === -1) return Math.floor(seconds * this.libav.AV_TIME_BASE);
    const stream = this.streams[streamIndex];
    return Math.max(
      0,
      Math.floor(seconds * stream.time_base_den / stream.time_base_num),
    );
  }

  packetTimeSeconds(packet) {
    if (!packet || packet.pts == null || packet.pts < 0) return null;
    return (packet.pts * packet.time_base_num) / packet.time_base_den;
  }

  frameTimeSeconds(frame) {
    if (frame instanceof VideoFrame || frame instanceof AudioData) {
      return frame.timestamp == null ? null : frame.timestamp / 1000000;
    }
    if (!frame || frame.pts == null || frame.pts < 0) return null;
    if (frame.time_base_num && frame.time_base_den) {
      return (frame.pts * frame.time_base_num) / frame.time_base_den;
    }
    return null;
  }

  frameDurationSeconds(frame) {
    if (frame instanceof AudioData) {
      return frame.duration != null
        ? frame.duration / 1000000
        : frame.numberOfFrames / frame.sampleRate;
    }
    if (frame && frame.nb_samples && frame.sample_rate) {
      return frame.nb_samples / frame.sample_rate;
    }
    return 0;
  }

  audioBufferSeconds() {
    if (!this.ringbuffer || !this.channelCount || !this.audioSampleRate) return 0;
    const usedBufferElements =
      this.ringbuffer.capacity() - this.ringbuffer.available_write();
    return usedBufferElements / (this.channelCount * this.audioSampleRate);
  }

  drainAudioRingBuffer() {
    if (this.ringbuffer) {
      this.ringbuffer.pop(new Float32Array(this.ringbuffer.available_read()));
    }
  }

  closeVideoFrames() {
    this.videoFrameBuffer.forEach((frame) => frame.close());
    this.videoFrameBuffer = [];
  }

  async resetDecodersForSeek() {
    if (this.WCVideoDecoder && this.WCVideoDecoder.state === "configured") {
      this.WCVideoDecoder.reset();
      if (this.videoConfig) this.WCVideoDecoder.configure(this.videoConfig);
    } else if (this.VideoDecoderCodecContext) {
      await this.libav.avcodec_flush_buffers(this.VideoDecoderCodecContext);
    }
    if (this.WCAudioDecoder && this.WCAudioDecoder.state === "configured") {
      this.WCAudioDecoder.reset();
      if (this.audioConfig) this.WCAudioDecoder.configure(this.audioConfig);
    } else if (this.AudioDecoderCodecContext) {
      await this.libav.avcodec_flush_buffers(this.AudioDecoderCodecContext);
    }
    if (this.feedAudioDecoderTimeout) {
      clearTimeout(this.feedAudioDecoderTimeout);
      this.feedAudioDecoderTimeout = null;
    }
    this.videoFillInProgress = false;
    this.audioFillInProgress = false;
    this.queueFillInProgress = false;
  }

  async resetPipelineForSeek() {
    this.cancelRenderLoop();
    await this.resetDecodersForSeek();
    this.clearPacketQueues();
    this.closeVideoFrames();
    this.drainAudioRingBuffer();
    this.fileEnded = false;
  }

  async refillUntilPacketsAvailable(queue, serial, timeoutMs = 1500) {
    const start = performance.now();
    while (queue.length === 0 && !this.fileEnded && serial === this.seekSerial) {
      await this.readDemuxPackets(256 * 1024);
      if (queue.length > 0 || this.fileEnded) break;
      if (performance.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 5));
    }
    return queue.length > 0;
  }

  async prerollVideoTo(targetSeconds, serial) {
    if (this.videoStreamIndex === -1) return targetSeconds;
    const targetUs = targetSeconds * 1000000;
    const start = performance.now();
    let previousFrame = null;

    while (serial === this.seekSerial && performance.now() - start < 2000) {
      while (this.videoFrameBuffer.length > 0) {
        const frame = this.videoFrameBuffer[0];
        if (frame.timestamp <= targetUs) {
          if (previousFrame) previousFrame.close();
          previousFrame = this.videoFrameBuffer.shift();
          continue;
        }

        const previousDelta = previousFrame
          ? Math.abs(previousFrame.timestamp - targetUs)
          : Number.POSITIVE_INFINITY;
        const nextDelta = Math.abs(frame.timestamp - targetUs);
        if (previousFrame && previousDelta <= nextDelta) {
          this.videoFrameBuffer.unshift(previousFrame);
          return previousFrame.timestamp / 1000000;
        }

        if (previousFrame) previousFrame.close();
        return frame.timestamp / 1000000;
      }

      await this.feedVideoDecoder();
      await new Promise((r) => setTimeout(r, 5));
      if (this.fileEnded) break;
    }

    if (previousFrame) {
      this.videoFrameBuffer.unshift(previousFrame);
      return previousFrame.timestamp / 1000000;
    }
    return targetSeconds;
  }

  async primeAudioBuffer(serial, targetSeconds = 0.45) {
    if (this.audioStreamIndex === -1 || !this.ringbuffer) return;
    const start = performance.now();
    while (
      serial === this.seekSerial &&
      !this.fileEnded &&
      this.audioBufferSeconds() < targetSeconds &&
      performance.now() - start < 2000
    ) {
      await this.feedAudioDecoder();
      if (this.audioBufferSeconds() >= targetSeconds) break;
      await this.refillUntilPacketsAvailable(this.audioPacketQueue, serial, 250);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async showInitialFrame() {
    if (this.videoStreamIndex === -1) return;
    const serial = this.seekSerial;
    await this.refillUntilPacketsAvailable(this.videoPacketQueue, serial, 1000);
    await this.feedVideoDecoder();
    const start = performance.now();
    while (this.videoFrameBuffer.length === 0 && performance.now() - start < 1000) {
      await this.feedVideoDecoder();
      await new Promise((r) => setTimeout(r, 5));
    }
    if (this.videoFrameBuffer.length > 0) {
      this.pausedVideoTime = this.videoFrameBuffer[0].timestamp / 1000;
      this.renderVideo();
    }
  }

  async seek(seconds, videoTimeStart) {
    const serial = ++this.seekSerial;
    self.postMessage({ type: "buffering", buffering: true });
    if (!this.formatContext) {
      console.warn("Format context not initialized");
      self.postMessage({ type: "buffering", buffering: false });
      return;
    }

    this.isSeeking = true;
    await this.resetPipelineForSeek();
    var seekStream =
      this.videoStreamIndex != -1
        ? this.videoStreamIndex
        : this.audioStreamIndex != -1
          ? this.audioStreamIndex
          : -1;
    const timestamp = this.streamTimestamp(seconds, seekStream);

    let ret = await this.libav.av_seek_frame(
      this.formatContext,
      seekStream,
      timestamp,
      0,
      this.libav.AVSEEK_FLAG_BACKWARD,
    );
    if (ret < 0) {
      // Some demuxers behave better with avformat_seek_file's bounded helper.
      ret = await this.libav.avformat_seek_file_max(
        this.formatContext,
        seekStream,
        timestamp,
        0,
        this.libav.AVSEEK_FLAG_BACKWARD,
      );
    }
    if (ret < 0) {
      console.error("Error seeking:", await this.libav.ff_error(ret));
      this.isSeeking = false;
      self.postMessage({ type: "buffering", buffering: false });
      return;
    }

    if (serial !== this.seekSerial) return;
    this.clearPacketQueues();
    this.closeVideoFrames();
    this.drainAudioRingBuffer();
    this.fileEnded = false;
    this.audioPrerollTargetSeconds = this.audioStreamIndex !== -1 ? seconds : null;

    this.pausedVideoTime = seconds * 1000;
    this.videoTimeStart = performance.now();
    this.isSeeking = false;

    var queue =
      this.audioStreamIndex != -1
        ? this.audioPacketQueue
        : this.videoPacketQueue; // audio is more accurate because of more data
    const hasPackets = await this.refillUntilPacketsAvailable(queue, serial);
    if (!hasPackets || serial !== this.seekSerial) {
      console.warn("No packets available after seek");
      self.postMessage({ type: "buffering", buffering: false });
      return;
    }
    let packet = queue[0];
    const time = this.packetTimeSeconds(packet) ?? seconds;

    console.log(
      "seeked to",
      time,
      "seconds (asked for",
      seconds,
      ")\ntimestamp from",
      this.audioStreamIndex != -1 ? "audio" : "video",
    );

    const displayTime = await this.prerollVideoTo(seconds, serial);
    if (serial !== this.seekSerial) return;
    console.log(
      "displaying seek frame at",
      displayTime,
      "seconds (delta",
      displayTime - seconds,
      ")",
    );
    this.pausedVideoTime = displayTime * 1000;
    this.videoTimeStart = performance.now();
    this.audioPrerollTargetSeconds = this.audioStreamIndex !== -1 ? displayTime : null;
    await this.primeAudioBuffer(serial);
    if (serial !== this.seekSerial) return;
    this.pausedVideoTime = displayTime * 1000;
    this.videoTimeStart = performance.now();
    this.schedulePipelinePump();
    self.postMessage({ type: "buffering", buffering: false });
    self.postMessage({ type: "offsetMediaTime", mediaTime: displayTime });
    this.scheduleRenderLoop();
  }

  async changeStream(streamType, streamIndex) {
    console.log(`Changing ${streamType} stream to index ${streamIndex}`);
    const serial = ++this.seekSerial;
    self.postMessage({ type: "buffering", buffering: true });
    this.isSeeking = true;
    this.cancelRenderLoop();

    // Flush the other decoder before seeking so no stale frames leak in
    if (streamType === "audio" && this.WCVideoDecoder) {
      await this.WCVideoDecoder.flush();
    } else if (streamType === "video") {
      if (this.WCAudioDecoder) {
        if (this.WCAudioDecoder.state == "configured")
          await this.WCAudioDecoder.flush();
      } else if (this.AudioDecoderCodecContext) {
        await this.libav.avcodec_flush_buffers(
          this.AudioDecoderCodecContext,
        );
      }
      if (this.feedAudioDecoderTimeout) {
        clearTimeout(this.feedAudioDecoderTimeout);
        this.feedAudioDecoderTimeout = null;
      }
    }

    const currentTime = this.currentVideoTime() / 1000;

    if (streamType === "audio") {
      this.audioStreamIndex = streamIndex;
      await this.cleanupAudio();
      await this.setupAudioDecoder();
    } else if (streamType === "video") {
      this.videoStreamIndex = streamIndex;
      await this.cleanupVideo();
      await this.setupVideoDecoder();
      if (this.canvas) {
        var codecpar = await this.libav.ff_copyout_codecpar(
          this.streams[this.videoStreamIndex].codecpar,
        );
        this.canvas.width = codecpar.width;
        this.canvas.height = codecpar.height;
      }
    } else {
      console.warn(`Unknown stream type: ${streamType}`);
      this.isSeeking = false;
      return;
    }

    // Update stream selection in availableStreams
    if (this.availableStreams[streamType]) {
      for (const stream of this.availableStreams[streamType]) {
        stream.selected = stream.index === streamIndex;
      }
    }

    // Reset fileEnded so refill can read new packets
    this.fileEnded = false;

    // Seek demuxer to current playback position
    let seekStream =
      this.videoStreamIndex != -1
        ? this.videoStreamIndex
        : this.audioStreamIndex;
    let seekRes = 0;
    if (seekStream != -1 && this.formatContext) {
      let timebase =
        this.streams[seekStream].time_base_den /
        this.streams[seekStream].time_base_num;
      let timestamp = currentTime * timebase;
      seekRes = await this.libav.avformat_seek_file_max(
        this.formatContext,
        seekStream,
        timestamp,
        0,
        0,
      );
      if (seekRes < 0) {
        console.error(
          "Error seeking during stream change:",
          await this.libav.ff_error(seekRes),
        );
      }
    }

    // Clear old data and refill from seeked position
    this.clearPacketQueues();
    this.videoFrameBuffer.forEach((frame) => frame.close());
    this.videoFrameBuffer = [];
    if (this.ringbuffer) {
      this.ringbuffer.pop(new Float32Array(this.ringbuffer.available_read()));
    }

    var queue =
      this.audioStreamIndex != -1
        ? this.audioPacketQueue
        : this.videoPacketQueue;
    const hasPackets = await this.refillUntilPacketsAvailable(queue, serial);
    if (!hasPackets || queue.length == 0) {
      console.warn("No packets available after stream change");
      this.isSeeking = false;
      self.postMessage({ type: "buffering", buffering: false });
      return;
    }

    // Read the actual timestamp of the first packet for audio sync
    let packet = queue[0];
    let seekedTime = currentTime;
    if (packet && packet.pts >= 0) {
      seekedTime =
        (packet.pts * packet.time_base_num) / packet.time_base_den;
    }

    this.pausedVideoTime = currentTime * 1000;
    if (this.isPlaying) {
      this.videoTimeStart = performance.now();
    }
    this.isSeeking = false;
    self.postMessage({ type: "buffering", buffering: false });
    self.postMessage({ type: "offsetMediaTime", mediaTime: seekedTime });

    // Restart decoder feeds
    if (this.isPlaying) {
      this.schedulePipelinePump();
    }
    this.scheduleRenderLoop();
  }

  async cleanupAudio() {
    if (this.WCAudioDecoder) {
      if (this.WCAudioDecoder.state == "configured")
        this.WCAudioDecoder.close();
      this.WCAudioDecoder = null;
    }
    this.audioUseWebCodecs = false;
    this.audioConfig = null;
    if (this.AudioDecoderCodecContext) {
      await this.libav.ff_free_decoder(
        this.AudioDecoderCodecContext,
        this.AudioDecoderPacket,
        this.AudioDecoderFrame,
      );
      this.AudioDecoderCodecContext = null;
      this.AudioDecoderPacket = null;
      this.AudioDecoderFrame = null;
    }
    if (this.feedAudioDecoderTimeout) {
      clearTimeout(this.feedAudioDecoderTimeout);
      this.feedAudioDecoderTimeout = null;
    }

    this.audioPacketQueue = [];

    if (this.ringbuffer) {
      this.ringbuffer.pop(new Float32Array(this.ringbuffer.available_read()));
    }
  }

  async setupAudioDecoder() {
    // Try to setup WebCodecs AudioDecoder, fallback to libav if not supported
    this.audioUseWebCodecs = false;
    var codecpar = await this.libav.ff_copyout_codecpar(
      this.streams[this.audioStreamIndex].codecpar,
    );
    this.audioSampleRate = codecpar.sample_rate;
    this.channelCount = codecpar.channels;

    let sampleCountIn500ms =
      this.DATA_BUFFER_DURATION * this.audioSampleRate * this.channelCount;
    this.sharedArrayBuffer = RingBuffer.getStorageForCapacity(
      sampleCountIn500ms,
      Float32Array,
    );
    this.ringbuffer = new RingBuffer(this.sharedArrayBuffer, Float32Array);

    const audioConfig = await LibAVJSWebCodecs.audioStreamToConfig(
      this.libav,
      this.streams[this.audioStreamIndex],
    );
    this.audioConfig = audioConfig;
    if ((await AudioDecoder.isConfigSupported(audioConfig)).supported) {
      this.audioUseWebCodecs = true;
      this.WCAudioDecoder = new AudioDecoder({
        output: this.bufferAudioSamples.bind(this),
        error: (e) => {
          if (e.name == "NotSupportedError") {
            console.warn(
              "Falling back to libav audio decoding due to NotSupportedError, should not happen normally.",
            );
            this.setupFallbackAudioDecoder();
          } else {
            console.error("AudioDecoder error:", e);
          }
        },
      });
      this.WCAudioDecoder.configure(audioConfig);
    } else {
      await this.setupFallbackAudioDecoder();
    }
    self.postMessage({
      type: "audioConfig",
      channelCount: this.channelCount,
      sampleRate: this.audioSampleRate,
      sharedArrayBuffer: this.sharedArrayBuffer,
    });
  }

  async setupFallbackAudioDecoder() {
    this.audioUseWebCodecs = false;
    this._audioDebugCount = 0;
    this._audioDecodeWarn = 0;
    if (this.WCAudioDecoder) {
      if (this.WCAudioDecoder.state == "configured")
        this.WCAudioDecoder.close();
      this.WCAudioDecoder = null;
    }
    const streamInfo = this.streams[this.audioStreamIndex];
    [
      ,
      this.AudioDecoderCodecContext,
      this.AudioDecoderPacket,
      this.AudioDecoderFrame,
    ] = await this.libav.ff_init_decoder(
      streamInfo.codec_id,
      streamInfo.codecpar,
    );
    console.log(
      `[audio] libav decoder init: codec=${streamInfo.codec_id} idx=${this.audioStreamIndex}`,
      `ch=${this.channelCount} sr=${this.audioSampleRate}`,
    );
  }

  async cleanupVideo() {
    if (this.WCVideoDecoder) {
      if (this.WCVideoDecoder.state == "configured")
        this.WCVideoDecoder.close();
      this.WCVideoDecoder = null;
    }
    if (this.VideoDecoderCodecContext) {
      await this.libav.ff_free_decoder(
        this.VideoDecoderCodecContext,
        this.VideoDecoderPacket,
        this.VideoDecoderFrame,
      );
      this.VideoDecoderCodecContext = null;
      this.VideoDecoderPacket = null;
      this.VideoDecoderFrame = null;
    }
    this.videoUseWebCodecs = false;
    this.videoConfig = null;
    this.videoPacketQueue = [];
    this.PACKET_QUEUE_BYTES_VIDEO = 0;
    this.videoFrameBuffer.forEach((frame) => frame.close());
    this.videoFrameBuffer = [];
  }

  async setupVideoDecoder() {
    this.videoUseWebCodecs = false;
    const videoConfig = await LibAVJSWebCodecs.videoStreamToConfig(
      this.libav,
      this.streams[this.videoStreamIndex],
    );
    this.videoConfig = videoConfig;
    let webCodecsSupported = false;
    try {
      webCodecsSupported = (await VideoDecoder.isConfigSupported(videoConfig)).supported;
    } catch (e) {
      console.warn("WebCodecs video config not supported, using LibAV.js fallback:", e);
    }
    if (webCodecsSupported) {
      this.videoUseWebCodecs = true;
      this.WCVideoDecoder = new VideoDecoder({
        output: this.bufferVideoFrame.bind(this),
        error: (e) => console.error("VideoDecoder error:", e),
      });
      this.WCVideoDecoder.configure(videoConfig);
    } else {
      await this.setupFallbackVideoDecoder();
    }
  }

  async setupFallbackVideoDecoder() {
    this.videoUseWebCodecs = false;
    if (this.WCVideoDecoder) {
      if (this.WCVideoDecoder.state == "configured") this.WCVideoDecoder.close();
      this.WCVideoDecoder = null;
    }
    [
      ,
      this.VideoDecoderCodecContext,
      this.VideoDecoderPacket,
      this.VideoDecoderFrame,
    ] = await this.libav.ff_init_decoder(
      this.streams[this.videoStreamIndex].codec_id,
      this.streams[this.videoStreamIndex].codecpar,
    );
    console.log("Using LibAV.js video decoder fallback");
  }

  clampByte(value) {
    return value < 0 ? 0 : value > 255 ? 255 : value;
  }

  frameTimestampUs(frame) {
    if (frame.pts == null || frame.pts < 0) return 0;
    const stream = this.streams[this.videoStreamIndex];
    const timeBaseNum = (frame.time_base_num && frame.time_base_den) ? frame.time_base_num : (stream?.time_base_num || 1);
    const timeBaseDen = (frame.time_base_num && frame.time_base_den) ? frame.time_base_den : (stream?.time_base_den || 1000000);
    return Math.round((frame.pts * timeBaseNum * 1000000) / timeBaseDen);
  }

  packetTimestampUs(packet) {
    const seconds = this.packetTimeSeconds(packet);
    return seconds == null ? 0 : Math.round(seconds * 1000000);
  }

  planeSample(frame, plane, x, y, fallbackStride) {
    if (frame.layout) {
      const layout = frame.layout[plane];
      return frame.data[layout.offset + y * layout.stride + x];
    }

    const data = frame.data[plane];
    if (Array.isArray(data[0])) return data[y][x];
    const stride = fallbackStride;
    return data[y * stride + x];
  }

  chromaSampleBilinear(frame, plane, cx, cy, chromaWidth, chromaHeight, fallbackStride) {
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(x0 + 1, chromaWidth - 1);
    const y1 = Math.min(y0 + 1, chromaHeight - 1);
    const fx = cx - x0;
    const fy = cy - y0;

    const s00 = this.planeSample(frame, plane, x0, y0, fallbackStride);
    const s10 = this.planeSample(frame, plane, x1, y0, fallbackStride);
    const s01 = this.planeSample(frame, plane, x0, y1, fallbackStride);
    const s11 = this.planeSample(frame, plane, x1, y1, fallbackStride);

    const top = (1 - fx) * s00 + fx * s10;
    const bot = (1 - fx) * s01 + fx * s11;
    return (1 - fy) * top + fy * bot;
  }

  async libavNv12FrameToRgbaVideoFrame(frame) {
    const width = frame.width;
    const height = frame.height;
    const rgba = new Uint8Array(width * height * 4);
    const chromaWidth = Math.ceil(width / 2);
    const chromaHeight = Math.ceil(height / 2);

    let lumaOffset = 0, lumaStride = width;
    let uvOffset = 0, uvStride = width * 2;
    if (frame.layout) {
      lumaOffset = frame.layout[0].offset;
      lumaStride = frame.layout[0].stride;
      uvOffset = frame.layout[1].offset;
      uvStride = frame.layout[1].stride;
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const yy = frame.data[lumaOffset + y * lumaStride + x];
        const cx = x * 0.5;
        const cy = y * 0.5;
        const ux0 = Math.floor(cx);
        const uy0 = Math.floor(cy);
        const ux1 = Math.min(ux0 + 1, chromaWidth - 1);
        const uy1 = Math.min(uy0 + 1, chromaHeight - 1);
        const fx = cx - ux0;
        const fy = cy - uy0;

        const u00 = frame.data[uvOffset + uy0 * uvStride + ux0 * 2];
        const v00 = frame.data[uvOffset + uy0 * uvStride + ux0 * 2 + 1];
        const u10 = frame.data[uvOffset + uy0 * uvStride + ux1 * 2];
        const v10 = frame.data[uvOffset + uy0 * uvStride + ux1 * 2 + 1];
        const u01 = frame.data[uvOffset + uy1 * uvStride + ux0 * 2];
        const v01 = frame.data[uvOffset + uy1 * uvStride + ux0 * 2 + 1];
        const u11 = frame.data[uvOffset + uy1 * uvStride + ux1 * 2];
        const v11 = frame.data[uvOffset + uy1 * uvStride + ux1 * 2 + 1];

        const uTop = (1 - fx) * u00 + fx * u10;
        const uBot = (1 - fx) * u01 + fx * u11;
        const uu = (1 - fy) * uTop + fy * uBot;
        const vTop = (1 - fx) * v00 + fx * v10;
        const vBot = (1 - fx) * v01 + fx * v11;
        const vv = (1 - fy) * vTop + fy * vBot;

        const c = yy - 16;
        const d = uu - 128;
        const e = vv - 128;
        const out = (y * width + x) * 4;
        rgba[out] = this.clampByte((298 * c + 409 * e + 128) >> 8);
        rgba[out + 1] = this.clampByte((298 * c - 100 * d - 208 * e + 128) >> 8);
        rgba[out + 2] = this.clampByte((298 * c + 516 * d + 128) >> 8);
        rgba[out + 3] = 255;
      }
    }

    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
    const imageData = new ImageData(clamped, width, height);
    return this.imageDataToVideoFrame(imageData, this.frameTimestampUs(frame));
  }

  async libavYuv420FrameToRgbaVideoFrame(frame) {
    const width = frame.width;
    const height = frame.height;
    const rgba = new Uint8Array(width * height * 4);
    const chromaWidth = Math.ceil(width / 2);
    const chromaHeight = Math.ceil(height / 2);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const yy = this.planeSample(frame, 0, x, y, width);
        const cx = x * 0.5;
        const cy = y * 0.5;
        const uu = this.chromaSampleBilinear(frame, 1, cx, cy, chromaWidth, chromaHeight, chromaWidth);
        const vv = this.chromaSampleBilinear(frame, 2, cx, cy, chromaWidth, chromaHeight, chromaWidth);
        const c = yy - 16;
        const d = uu - 128;
        const e = vv - 128;
        const out = (y * width + x) * 4;
        rgba[out] = this.clampByte((298 * c + 409 * e + 128) >> 8);
        rgba[out + 1] = this.clampByte((298 * c - 100 * d - 208 * e + 128) >> 8);
        rgba[out + 2] = this.clampByte((298 * c + 516 * d + 128) >> 8);
        rgba[out + 3] = 255;
      }
    }

    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
    const imageData = new ImageData(clamped, width, height);
    return this.imageDataToVideoFrame(imageData, this.frameTimestampUs(frame));
  }

  async libavFrameToVideoFrame(frame) {
    if (frame.format == null) {
      console.warn("libav frame has no format, skipping");
      return null;
    }

    if (frame.format === 0) {
      return await this.libavI420FrameToVideoFrame(frame);
    }

    if (frame.format === 23) {
      return await this.libavNv12FrameToVideoFrame(frame);
    }

    try {
      const yuv = LibAVJSWebCodecs.laFrameToVideoFrame(frame);
      const ts = yuv.timestamp;
      const bitmap = await createImageBitmap(yuv);
      yuv.close();
      return { bitmap, timestamp: ts, displayWidth: bitmap.width, displayHeight: bitmap.height, close() { bitmap.close() } };
    } catch (e) {
      console.warn("Bridge conversion failed for format", frame.format, "- trying manual fallback:", e);
      if (frame.format === 23) return await this.libavNv12FrameToRgbaVideoFrame(frame);
      if (frame.format === 0) return await this.libavYuv420FrameToRgbaVideoFrame(frame);
      return null;
    }
  }

  copyPlane(dst, dstOff, dstStride, src, srcOff, srcStride, width, rows, label) {
    if (srcStride === dstStride) {
      const len = dstStride * rows;
      dst.set(src.subarray(srcOff, srcOff + len), dstOff);
    } else {
      for (let y = 0; y < rows; y++) {
        const sOff = srcOff + y * srcStride;
        const dOff = dstOff + y * dstStride;
        for (let x = 0; x < width; x++) {
          dst[dOff + x] = src[sOff + x];
        }
      }
    }
  }

  async libavI420FrameToVideoFrame(frame) {
    const width = frame.width;
    const height = frame.height;
    const uvW = Math.ceil(width / 2);
    const uvH = Math.ceil(height / 2);
    const ySize = width * height;
    const uvSize = uvW * uvH;
    const cleanData = new Uint8Array(ySize + uvSize * 2);

    const l0 = frame.layout[0];
    const l1 = frame.layout[1];
    const l2 = frame.layout[2];

    this.copyPlane(cleanData, 0, width,
      frame.data, l0.offset, l0.stride, width, height);
    this.copyPlane(cleanData, ySize, uvW,
      frame.data, l1.offset, l1.stride, uvW, uvH);
    this.copyPlane(cleanData, ySize + uvSize, uvW,
      frame.data, l2.offset, l2.stride, uvW, uvH);

    const ts = this.frameTimestampUs(frame);
    const vf = new VideoFrame(cleanData, {
      format: "I420",
      codedWidth: width,
      codedHeight: height,
      timestamp: ts,
      layout: [
        { offset: 0, stride: width },
        { offset: ySize, stride: uvW },
        { offset: ySize + uvSize, stride: uvW },
      ],
    });
    const bitmap = await createImageBitmap(vf);
    vf.close();
    return { bitmap, timestamp: ts, displayWidth: width, displayHeight: height, close() { bitmap.close() } };
  }

  async libavNv12FrameToVideoFrame(frame) {
    const width = frame.width;
    const height = frame.height;
    const uvW = Math.ceil(width / 2) * 2;
    const uvH = Math.ceil(height / 2);
    const ySize = width * height;
    const uvSize = uvW * uvH;
    const cleanData = new Uint8Array(ySize + uvSize);

    const l0 = frame.layout[0];
    const l1 = frame.layout[1];

    this.copyPlane(cleanData, 0, width,
      frame.data, l0.offset, l0.stride, width, height);
    this.copyPlane(cleanData, ySize, uvW,
      frame.data, l1.offset, l1.stride, uvW, uvH);

    const ts = this.frameTimestampUs(frame);
    const vf = new VideoFrame(cleanData, {
      format: "NV12",
      codedWidth: width,
      codedHeight: height,
      timestamp: ts,
      layout: [
        { offset: 0, stride: width },
        { offset: ySize, stride: uvW },
      ],
    });
    const bitmap = await createImageBitmap(vf);
    vf.close();
    return { bitmap, timestamp: ts, displayWidth: width, displayHeight: height, close() { bitmap.close() } };
  }

  async imageDataToVideoFrame(imageData, timestamp) {
    const bitmap = await createImageBitmap(imageData);
    return { bitmap, timestamp, displayWidth: bitmap.width, displayHeight: bitmap.height, close() { bitmap.close(); } };
  }

  // Communication with main thread

  startOutput() {
    if (this.isPlaying) return;

    this.isPlaying = true;
    // Use the first buffered frame's timestamp as the reference time,
    // so the stale check works even when frames start at non-zero pts.
    if (this.videoFrameBuffer.length > 0 && this.pausedVideoTime === 0) {
      this.pausedVideoTime = this.videoFrameBuffer[0].timestamp / 1000;
    }
    this.videoTimeStart = performance.now();
    self.postMessage({ type: "videoStatus", isPlaying: this.isPlaying });
    this.scheduleRenderLoop();
    this.schedulePipelinePump();
  }

  stopOutput() {
    if (!this.isPlaying) return;

    this.isPlaying = false;
    this.pausedVideoTime =
      this.pausedVideoTime + (performance.now() - this.videoTimeStart);
    this.cancelRenderLoop();
    self.postMessage({ type: "videoStatus", isPlaying: this.isPlaying });
  }

  scheduleRenderLoop() {
    if (this.renderRafId !== null || !this.isPlaying || this.isSeeking) return;
    this.renderRafId = self.requestAnimationFrame(() => {
      this.renderRafId = null;
      this.renderVideoLoop();
    });
  }

  cancelRenderLoop() {
    if (this.renderRafId !== null) {
      self.cancelAnimationFrame(this.renderRafId);
      this.renderRafId = null;
    }
  }

  schedulePipelinePump() {
    if (this.pipelinePumpScheduled || this.isSeeking) return;
    this.pipelinePumpScheduled = true;
    queueMicrotask(async () => {
      this.pipelinePumpScheduled = false;
      await this.pumpPipeline();
    });
  }

  async pumpPipeline() {
    if (!this.formatContext || this.isSeeking) return;
    if (this.audioStreamIndex !== -1) await this.feedAudioDecoder();
    if (this.videoStreamIndex !== -1) await this.feedVideoDecoder();
  }

  // Time management

  updateMediaTime(pausedVideoTime, videoTimeStart) {
    const audioTimeMs = pausedVideoTime * 1000;
    this.lastAVDifference = audioTimeMs - this.currentVideoTime();
    if (Math.abs(this.lastAVDifference) > 100) {
      self.postMessage({
        type: "avDrift",
        driftMs: this.lastAVDifference,
      });
    }
    this.pausedVideoTime = audioTimeMs;
    this.videoTimeStart = videoTimeStart - performance.timeOrigin;
  }

  currentVideoTime() {
    if (this.isPlaying) {
      return this.pausedVideoTime + (performance.now() - this.videoTimeStart);
    } else if (this.pausedVideoTime !== null) {
      return this.pausedVideoTime;
    } else {
      return 0;
    }
  }

  packetByteSize(packet) {
    return packet?.size || packet?.data?.byteLength || packet?.data?.length || 0;
  }

  enqueuePacket(type, packet) {
    if (type === "video") {
      this.videoPacketQueue.push(packet);
      this.PACKET_QUEUE_BYTES_VIDEO += this.packetByteSize(packet);
    } else {
      this.audioPacketQueue.push(packet);
      this.PACKET_QUEUE_BYTES_AUDIO += this.packetByteSize(packet);
    }
  }

  dequeuePacket(type) {
    const queue = type === "video" ? this.videoPacketQueue : this.audioPacketQueue;
    const packet = queue.shift();
    if (packet) {
      if (type === "video") {
        this.PACKET_QUEUE_BYTES_VIDEO = Math.max(
          0,
          this.PACKET_QUEUE_BYTES_VIDEO - this.packetByteSize(packet),
        );
      } else {
        this.PACKET_QUEUE_BYTES_AUDIO = Math.max(
          0,
          this.PACKET_QUEUE_BYTES_AUDIO - this.packetByteSize(packet),
        );
      }
    }
    return packet;
  }

  clearPacketQueues() {
    this.videoPacketQueue = [];
    this.audioPacketQueue = [];
    this.PACKET_QUEUE_BYTES_VIDEO = 0;
    this.PACKET_QUEUE_BYTES_AUDIO = 0;
  }

  needsMorePackets(type) {
    if (type === "video") {
      return this.videoStreamIndex !== -1 &&
        this.videoPacketQueue.length < this.PACKET_QUEUE_MIN_SIZE &&
        this.PACKET_QUEUE_BYTES_VIDEO < this.PACKET_QUEUE_MAX_BYTES;
    }
    return this.audioStreamIndex !== -1 &&
      this.audioPacketQueue.length < this.PACKET_QUEUE_MIN_SIZE &&
      this.PACKET_QUEUE_BYTES_AUDIO < this.PACKET_QUEUE_MAX_BYTES;
  }

  async refillFrameQueues() {
    // Video step 1/4: fill videoPacketQueue with demuxed packets
    // Audio step 1/4: fill audioPacketQueue with demuxed packets
    if (this.isSeeking)
      console.warn(
        "refillFrameQueues called while seeking (from feedVideoDecoder or feedAudioDecoder)",
      );
    if (this.queueFillInProgress || this.fileEnded) {
      return;
    }

    this.queueFillInProgress = true;
    // ff_read_frame_multi to fill videoPacketQueue and audioPacketQueue
    await this.refillFrameQueuesInternal();
    this.queueFillInProgress = false;
  }
  async refillFrameQueuesInternal() {
    // Video step 1/4: fill videoPacketQueue with demuxed packets
    // Audio step 1/4: fill audioPacketQueue with demuxed packets
    if (!this.needsMorePackets("video") && !this.needsMorePackets("audio")) {
      return;
    }
    if (!this.packet) {
      this.packet = await this.libav.av_packet_alloc();
    }
    if (!this.formatContext) {
      console.warn("Format context not initialized");
      return;
    }
    while (this.needsMorePackets("video") || this.needsMorePackets("audio")) {
      const gotPackets = await this.readDemuxPackets(512 * 1024);
      if (this.fileEnded) return;
      if (!gotPackets) break;
    }
  }

  async readDemuxPackets(limit) {
    if (!this.packet) {
      this.packet = await this.libav.av_packet_alloc();
    }
    if (!this.formatContext) return;
    const [res, packets] = await this.libav.ff_read_frame_multi(
      this.formatContext,
      this.packet,
      { limit },
    );
    if (res < 0 && res != -this.libav.EAGAIN) {
      if (res === this.libav.AVERROR_EOF) {
        this.fileEnded = true;
        return false;
      }
      console.error("Error reading frame:", await this.libav.ff_error(res));
      return false;
    }
    let gotPackets = false;
    if (packets[this.videoStreamIndex]) {
      for (const packet of packets[this.videoStreamIndex]) {
        this.enqueuePacket("video", packet);
        gotPackets = true;
      }
    }
    if (packets[this.audioStreamIndex]) {
      for (const packet of packets[this.audioStreamIndex]) {
        this.enqueuePacket("audio", packet);
        gotPackets = true;
      }
    }
    return gotPackets;
  }

  async feedVideoDecoder() {
    // Video step 2/4: send the demuxed video packets to the video decoder
    if (this.isSeeking) console.warn("feedVideoDecoder called while seeking");
    if (this.videoFillInProgress) return;
    this.videoFillInProgress = true;
    await this.feedVideoDecoderInternal();
    this.videoFillInProgress = false;
  }

  async feedVideoDecoderInternal() {
    try {
      if (!this.formatContext) {
        console.warn("Format context not initialized");
        return;
      }
      if (this.videoStreamIndex === -1) {
        return;
      }
      if (this.videoUseWebCodecs && !this.WCVideoDecoder) {
        return;
      }
      if (!this.videoUseWebCodecs && !this.VideoDecoderCodecContext) {
        return;
      }
      if (this.videoFrameBuffer.length > this.FRAME_BUFFER_TARGET_SIZE) {
        return;
      }
      if (
        this.videoPacketQueue.length === 0 ||
        (this.audioStreamIndex !== -1 && this.audioPacketQueue.length === 0)
      ) {
        await this.refillFrameQueues();
      }
      let packet = null;
      while (this.videoFrameBuffer.length < this.FRAME_BUFFER_TARGET_SIZE) {
        if (
          this.videoUseWebCodecs &&
          this.WCVideoDecoder &&
          this.WCVideoDecoder.decodeQueueSize >= this.DECODER_QUEUE_SIZE_MAX
        ) {
          break;
        }
        if (this.videoPacketQueue.length === 0) {
          await this.refillFrameQueues();
          if (this.videoPacketQueue.length === 0) {
            break;
          }
        }
        packet = this.dequeuePacket("video");
        if (this.videoUseWebCodecs && this.WCVideoDecoder) {
          const chunk = LibAVJSWebCodecs.packetToEncodedVideoChunk(
            packet,
            this.streams[this.videoStreamIndex],
          );
          this.WCVideoDecoder.decode(chunk);
        } else {
          const frames = await this.libav.ff_decode_multi(
            this.VideoDecoderCodecContext,
            this.VideoDecoderPacket,
            this.VideoDecoderFrame,
            [packet],
          );
          for (const frame of frames) {
            const timestamp = this.frameTimestampUs(frame) || this.packetTimestampUs(packet);
            const videoFrame = await this.libavFrameToVideoFrame(frame);
            if (videoFrame) this.bufferVideoFrame(videoFrame);
          }
        }
      }
    } catch (e) {
      console.error("Error decoding video data:", e);
    }
  }

  bufferVideoFrame(frame) {
    // Video step 3/4: add decoded video frame to the frame buffer
    if (this.isSeeking)
      console.warn(
        "bufferVideoFrame called while seeking (output of video decoder)",
      );
    this.videoFrameBuffer.push(frame);
    this.schedulePipelinePump();
  }

  renderVideoLoop() {
    if (!this.isPlaying || this.isSeeking) return;
    const now = performance.now();
    const lm = this.lagMonitor;

    let frameTime = 0;
    if (lm.lastFrameTime > 0) {
      frameTime = now - lm.lastFrameTime;
      lm.frameTimes.push(frameTime);
      if (frameTime > lm.lagThresholdMs) {
        lm.totalLagEvents++;
      }
    }
    lm.lastFrameTime = now;

    if (now - lm.lastReportTime >= lm.reportInterval) {
      if (lm.frameTimes.length > 0) {
        const avg = lm.frameTimes.reduce((a, b) => a + b, 0) / lm.frameTimes.length;
        const fps = 1000 / avg;
        self.postMessage({
          type: "workerLagReport",
          fps: Math.round(fps),
          avgFrameTime: Math.round(avg * 10) / 10,
          totalLagEvents: lm.totalLagEvents,
          lastFrameTime: Math.round(frameTime),
        });
      }
      lm.frameTimes = [];
      lm.lastReportTime = now;
    }

    this.renderVideo();
    this.schedulePipelinePump();
    this.scheduleRenderLoop();
  }

  renderVideo() {
    if (this.videoFrameBuffer.length == 0) return;
    const currentTime = this.currentVideoTime() * 1000;
    const VSYNC_INTERVAL = 16.67;
    while (
      this.videoFrameBuffer.length > 1 &&
      this.videoFrameBuffer[0].timestamp < currentTime - VSYNC_INTERVAL
    ) {
      let staleFrame = this.videoFrameBuffer.shift();
      staleFrame.close();
    }

    const frame = this.videoFrameBuffer[0];
    const result = this.renderer.draw(frame);
    if (result && typeof result.then === 'function') {
      result.catch(e => console.error("Renderer draw error:", e));
    }
  }

  async feedAudioDecoder() {
    // Audio step 2/3: send the demuxed audio packets to the audio decoder
    if (this.isSeeking) console.warn("feedAudioDecoder called while seeking");
    if (this.audioFillInProgress) return;
    this.audioFillInProgress = true;
    try {
      await this.feedAudioDecoderInternal();
    } finally {
      this.audioFillInProgress = false;
    }
  }

  async feedAudioDecoderInternal() {
    // Audio step 2/3: send the demuxed audio packets to the audio decoder
    // Based on https://github.com/w3c/webcodecs/blob/724b7d620519450c0c9630ab4eb97fe555f9007b/samples/lib/audio_renderer.js#L83
    if (this.audioStreamIndex === -1 || !this.ringbuffer) return;
    if (this.audioUseWebCodecs && !this.WCAudioDecoder) return;
    if (!this.audioUseWebCodecs && !this.AudioDecoderCodecContext) return;
    if (
      this.audioUseWebCodecs &&
      this.WCAudioDecoder.decodeQueueSize >= this.DECODER_QUEUE_SIZE_MAX
    ) {
      // Decoder is saturated, wait for it to drain
      return;
    }
    let usedBufferElements =
      this.ringbuffer.capacity() - this.ringbuffer.available_write();
    let usedBufferSecs =
      usedBufferElements / (this.channelCount * this.audioSampleRate);
    if (usedBufferSecs >= this.DATA_BUFFER_DECODE_TARGET_DURATION) {
      // Buffer is sufficiently full, wait before decoding more
      if (this.isPlaying) {
        // Schedule next check when buffer is half empty
        this.feedAudioDecoderTimeout = setTimeout(
          this.feedAudioDecoder.bind(this),
          (1000 * usedBufferSecs) / 2,
        );
      }
      return;
    }

    try {
      while (
        usedBufferSecs < this.DATA_BUFFER_DECODE_TARGET_DURATION &&
        (!this.audioUseWebCodecs ||
          (this.WCAudioDecoder &&
            this.WCAudioDecoder.decodeQueueSize < this.DECODER_QUEUE_SIZE_MAX))
      ) {
        if (this.audioPacketQueue.length === 0) {
          await this.refillFrameQueues();
          if (this.audioPacketQueue.length === 0) {
            // No more audio packets available
            console.warn("No more audio packets available");
            break;
          }
        }
        let packet = this.dequeuePacket("audio");
        if (packet == undefined) {
          break;
        }
        if (this.audioUseWebCodecs && this.WCAudioDecoder) {
          const chunk = LibAVJSWebCodecs.packetToEncodedAudioChunk(
            packet,
            this.streams[this.audioStreamIndex],
          );
          if (!this.WCAudioDecoder) return;
          this.WCAudioDecoder.decode(chunk);
        } else {
          if (!this.AudioDecoderCodecContext) return;
          // fallback decoding with libav
          if (!this.AudioDecoderCodecContext) return;
          var frames = await this.libav.ff_decode_multi(
            this.AudioDecoderCodecContext,
            this.AudioDecoderPacket,
            this.AudioDecoderFrame,
            [packet],
            false,
          );
          if (!frames || frames.length === 0) {
            if ((this._audioDecodeWarn || 0) < 5) {
              console.warn(
                `[audio] ff_decode_multi returned ${frames?.length} frames, pts=${packet.pts} dts=${packet.dts} size=${packet.size}`,
              );
              this._audioDecodeWarn = (this._audioDecodeWarn || 0) + 1;
            }
          }
          if (frames) {
            for (const frame of frames) {
              this.bufferAudioSamples(frame);
            }
          }
        }
        usedBufferElements =
          this.ringbuffer.capacity() - this.ringbuffer.available_write();
        usedBufferSecs =
          usedBufferElements / (this.channelCount * this.audioSampleRate);
      }
    } catch (e) {
      console.error("Error decoding audio data:", e);
    }
  }

  convertSampleToFloat32Array(data) {
    let samples;
    switch (data.constructor.name) {
      case "Uint8Array":
        samples = Float32Array.from(data, (x) => (x - 128) / 128);
        break;
      case "Uint16Array":
        samples = Float32Array.from(data, (x) => (x - 32768) / 32768);
        break;
      case "Uint32Array":
        samples = Float32Array.from(data, (x) => (x - 2147483648) / 2147483648);
        break;
      case "Int8Array":
        samples = Float32Array.from(data, (x) => x / 128);
        break;
      case "Int16Array":
        samples = Float32Array.from(data, (x) => x / 32768);
        break;
      case "Int32Array":
        samples = Float32Array.from(data, (x) => x / 2147483648);
        break;
      case "Float32Array":
        samples = data;
        break;
      default:
        throw `Unsupported audio sample format: ${data.constructor.name}`;
    }
    return samples;
  }

  bufferAudioSamples(data) {
    // Audio step 3/3: buffer decoded audio data into the ring buffer
    // this gets called from the audio decoder output callback (when a frame is decoded)
    // the ring buffer is then read by the AudioWorkletProcessor

    // based on https://github.com/w3c/webcodecs/blob/724b7d620519450c0c9630ab4eb97fe555f9007b/samples/lib/audio_renderer.js#L168
    if (this.isSeeking)
      console.warn(
        "bufferAudioSamples called while seeking (output of audio decoder)",
      );
    const isAudioData = data instanceof AudioData;
    const frameNumber = isAudioData ? data.numberOfFrames : data.nb_samples;
    if (!isAudioData && (this._audioDebugCount || 0) < 3) {
      const planar = data.data instanceof Array;
      const el = planar ? data.data[0] : data.data;
      const formatName = planar ? "planar" : "interleaved";
      const typeName = el?.constructor?.name ?? "unknown";
      const chLayout = data.ch_layout_nb_channels ?? "?";
      console.log(
        `[audio] libav frame: nb_samples=${data.nb_samples}`,
        `sr=${data.sample_rate} ch=${data.channels} ch_layout=${chLayout}`,
        `${formatName} ${typeName}`,
      );
      this._audioDebugCount = (this._audioDebugCount || 0) + 1;
    }
    if (this.audioPrerollTargetSeconds !== null) {
      const frameTime = this.frameTimeSeconds(data);
      const frameEnd = frameTime == null
        ? null
        : frameTime + this.frameDurationSeconds(data);
      if (frameEnd !== null && frameEnd < this.audioPrerollTargetSeconds) {
        if (isAudioData) data.close();
        this.schedulePipelinePump();
        return;
      }
      this.audioPrerollTargetSeconds = null;
    }
    if (!this._planarBuffers || this._planarBuffers.length !== this.channelCount ||
        (this._planarFrameNumber || 0) < frameNumber) {
      this._planarBuffers = new Array(this.channelCount);
      this._planarFrameNumber = frameNumber;
      for (var i = 0; i < this.channelCount; i++) {
        this._planarBuffers[i] = new Float32Array(frameNumber);
      }
    }
    const planarBuffers = this._planarBuffers;
    let samples;
    if (!isAudioData) {
      if (data.data instanceof Array) {
        // LibAV frame with planar data
        samples = Array(this.channelCount);
        for (let i = 0; i < data.data.length; i++) {
          samples[i] = this.convertSampleToFloat32Array(data.data[i]);
        }
      } else {
        // LibAV frame with interleaved data
        samples = this.convertSampleToFloat32Array(data.data);
      }
    }

    // Write to temporary planar arrays, and interleave into the ring buffer.
    for (var i = 0; i < this.channelCount; i++) {
      if (i >= (isAudioData ? data.numberOfChannels : data.channels)) break;
      if (isAudioData) {
        data.copyTo(planarBuffers[i], {
          planeIndex: i,
          format: "f32-planar",
        });
      } else {
        // LibAV frame
        if (samples instanceof Array) {
          // planar data
          planarBuffers[i].set(samples[i].subarray(0, frameNumber));
        } else {
          // interleaved data
          for (let j = 0; j < frameNumber; j++) {
            planarBuffers[i][j] = samples[j + frameNumber * i];
          }
        }
      }
    }
    // Write the data to the ring buffer. Because it wraps around, there is
    // potentially two copyTo to do.
    let wrote = this.ringbuffer.writeCallback(
      frameNumber * this.channelCount,
      (first_part, second_part) => {
        this.interleave(planarBuffers, 0, first_part.length, first_part, 0);
        this.interleave(
          planarBuffers,
          first_part.length,
          second_part.length,
          second_part,
          0,
        );
      },
    );

    // FIXME - this could theoretically happen since we're pretty agressive
    // about saturating the decoder without knowing the size of the
    // AudioData.duration vs ring buffer capacity.
    console.assert(
      wrote == this.channelCount * frameNumber,
      "Buffer full, dropping data!",
    );
    if (isAudioData) data.close();

    // Logging maxBufferHealth below shows we currently max around 73%, so we're
    // safe from the assert above *for now*. We should add an overflow buffer
    // just to be safe.
    // let bufferHealth = this.bufferHealth();
    // if (!('maxBufferHealth' in this))
    //   this.maxBufferHealth = 0;
    // if (bufferHealth > this.maxBufferHealth) {
    //   this.maxBufferHealth = bufferHealth;
    //   console.log(`new maxBufferHealth:${this.maxBufferHealth}`);
    // }
    //
    this.schedulePipelinePump();
  }

  interleave(
    inputs,
    inputOffset,
    inputSamplesToCopy,
    output,
    outputSampleOffset,
  ) {
    // Based on https://github.com/w3c/webcodecs/blob/724b7d620519450c0c9630ab4eb97fe555f9007b/samples/lib/audio_renderer.js#L151
    if (inputs.length * inputs[0].length < output.length) {
      throw `not enough space in destination (${inputs.length * inputs[0].length} < ${output.length}})`;
    }
    let channelCount = inputs.length;
    let outIdx = outputSampleOffset;
    let inputIdx = Math.floor(inputOffset / channelCount);
    var channel = inputOffset % channelCount;
    for (var i = 0; i < inputSamplesToCopy; i++) {
      output[outIdx++] = inputs[channel][inputIdx];
      if (++channel == inputs.length) {
        channel = 0;
        inputIdx++;
      }
    }
  }
}

// Create and initialize the worker when the script loads
new MediaWorker();
