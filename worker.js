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

    this.sharedArrayBuffer = null;
    this.ringbuffer = null;

    this.libav = null;
    this.formatContext = null;
    this.streams = null;
    this.videoStreamIndex = -1;
    this.audioStreamIndex = -1;
    this.packet = null;

    this.availableStreams = [];
    this.videoHeight = 0;
    this.videoWidth = 0;
    this.channelCount = 0;
    this.audioSampleRate = 0;
    this.videoTimeStart = null;
    this.pausedVideoTime = null;

    this.audioUseWebCodecs = false;
    this.videoUseWebCodecs = false;
    this.WCAudioDecoder = null;
    this.WCVideoDecoder = null;

    this.AudioDecoderCodecContext = null;
    this.AudioDecoderPacket = null;
    this.AudioDecoderFrame = null;

    this.DATA_BUFFER_DURATION = 0.6;
    this.DATA_BUFFER_DECODE_TARGET_DURATION = 0.3;
    this.DECODER_QUEUE_SIZE_MAX = 5;
    this.FRAME_BUFFER_TARGET_SIZE = 3;
    this.PACKET_QUEUE_MIN_SIZE = 5;

    this.videoFrameBuffer = [];
    this.videoFillInProgress = false;
    this.audioFillInProgress = false;
    this.queueFillInProgress = false;

    this.videoPacketQueue = [];
    this.audioPacketQueue = [];

    this.feedAudioDecoderTimeout = null;

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
      default:
        console.warn("Unknown message type:", e.data.type);
    }
  }

  // Initialize worker with canvas and video
  async init(data) {
    this.canvas = data.canvas;
    this.renderer = new WebGLRenderer(this.canvas);

    try {
      await this.initLibAV();
      // Load video file
      // download then feed to libav
      let loaded = false;
      while (!loaded) {
        try {
          var videoResponse = await fetch(data.video);
          if (!videoResponse.ok) {
            throw new Error(
              `Failed to fetch video: ${videoResponse.statusText}`,
            );
          }
          await this.libav.writeFile(
            "sample",
            new Uint8Array(await videoResponse.arrayBuffer()),
          );
          [this.formatContext, this.streams] =
            await this.libav.ff_init_demuxer_file("sample");
        } catch (e) {
          console.warn("ff_init_demuxer_file failed, retrying...", e);
          await new Promise((r) => setTimeout(r, 10));
          continue;
        }
        loaded = true;
      }
      // alternative: let libav fetch the file directly (buggy for now)
      //[this.formatContext, this.streams] = await this.libav.ff_init_demuxer_file("jsfetch:" + new URL(data.video, location.href).href);

      this.availableStreams = { video: [], audio: [], subtitle: [], other: [] };
      for (const streamInfo of this.streams) {
        if (streamInfo.codec_type == LibAV.AVMEDIA_TYPE_VIDEO) {
          var codecpar = await this.libav.ff_copyout_codecpar(
            streamInfo.codecpar,
          );
          if (this.videoStreamIndex == -1) {
            this.videoStreamIndex = streamInfo.index;
            this.videoWidth = codecpar.width;
            this.videoHeight = codecpar.height;
            this.canvas.width = this.videoWidth;
            this.canvas.height = this.videoHeight;
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
            this.sampleRate = codecpar.sample_rate;
            this.channelCount = codecpar.channels;
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
        let sampleCountIn500ms =
          this.DATA_BUFFER_DURATION * this.sampleRate * this.channelCount;
        this.sharedArrayBuffer = RingBuffer.getStorageForCapacity(
          sampleCountIn500ms,
          Float32Array,
        );
        this.ringbuffer = new RingBuffer(this.sharedArrayBuffer, Float32Array);

        const audioConfig = await LibAVJSWebCodecs.audioStreamToConfig(
          this.libav,
          this.streams[this.audioStreamIndex],
        );
        if (AudioDecoder.isConfigSupported(audioConfig)) {
          this.audioUseWebCodecs = true;
          this.WCAudioDecoder = new AudioDecoder({
            output: this.bufferAudioSamples.bind(this),
            error: (e) => {
              if (e.name == "NotSupportedError") {
                console.warn(
                  "Falling back to libav audio decoding due to NotSupportedError",
                );
                this.setupFallbackAudioDecoder();
              } else {
                console.error("AudioDecoder error:", e);
              }
            },
          });
          this.WCAudioDecoder.configure(audioConfig);
        } else {
          this.setupFallbackAudioDecoder();
        }
      }
      // Video
      if (this.videoStreamIndex != -1) {
        const videoConfig = await LibAVJSWebCodecs.videoStreamToConfig(
          this.libav,
          this.streams[this.videoStreamIndex],
        );
        if (VideoDecoder.isConfigSupported(videoConfig)) {
          this.videoUseWebCodecs = true;
          this.WCVideoDecoder = new VideoDecoder({
            output: this.bufferVideoFrame.bind(this),
            error: (e) => console.error("VideoDecoder error:", e),
          });
          this.WCVideoDecoder.configure(videoConfig);
        }
      }
    } catch (error) {
      console.error("Error initializing media:", error);
      self.postMessage({ type: "error", message: error.message });
    }
  }

  async seek(seconds, videoTimeStart) {
    self.postMessage({ type: "buffering", buffering: true });
    if (!this.formatContext) {
      console.warn("Format context not initialized");
      return;
    }

    if (this.WCVideoDecoder) {
      await this.WCVideoDecoder.flush();
    }
    if (this.WCAudioDecoder) {
      await this.WCAudioDecoder.flush();
    }
    if (this.feedAudioDecoderTimeout) {
      clearTimeout(this.feedAudioDecoderTimeout);
      this.feedAudioDecoderTimeout = null;
    }

    this.isSeeking = true;
    self.requestAnimationFrame(() => {});
    var seekStream =
      this.videoStreamIndex != -1
        ? this.videoStreamIndex
        : this.audioStreamIndex != -1
          ? this.audioStreamIndex
          : -1;
    var timebase =
      seekStream != -1
        ? this.streams[seekStream].time_base_den /
          this.streams[seekStream].time_base_num
        : this.libav.AV_TIME_BASE;
    let timestamp = seconds * timebase;
    let ret = await this.libav.avformat_seek_file_max(
      this.formatContext,
      seekStream,
      timestamp,
      0,
    );
    if (ret < 0) {
      console.error("Error seeking:", await this.libav.ff_error(ret));
      return;
    }
    // Clear packet queues and decoders
    this.videoPacketQueue = [];
    this.audioPacketQueue = [];
    this.videoFrameBuffer.forEach((frame) => frame.close());
    this.videoFrameBuffer = [];
    // Reset ring buffer
    if (this.ringbuffer) {
      this.ringbuffer.pop(new Float32Array(this.ringbuffer.available_read()));
    }
    // Reset timing
    this.pausedVideoTime = seconds * 1000;
    this.videoTimeStart = videoTimeStart - performance.timeOrigin;
    this.isSeeking = false;
    await this.refillFrameQueues();
    var queue =
      this.audioStreamIndex != -1
        ? this.audioPacketQueue
        : this.videoPacketQueue; // audio is more accurate because of more data
    while (queue.length == 0) {
      // Wait until we have at least one packet to decode
      await new Promise((r) => setTimeout(r, 10));
    }
    let packet = queue[0];
    const time = (packet.pts * packet.time_base_num) / packet.time_base_den;

    console.log(
      "seeked to",
      time,
      "seconds (asked for",
      seconds,
      ")\ntimestamp from",
      this.audioStreamIndex != -1 ? "audio" : "video",
    );

    if (this.audioStreamIndex != -1) this.feedAudioDecoder();
    this.feedVideoDecoder();
    // TODO: better sync:
    // 1. get the timestamp of the first audio frame which comes after the video frame
    // 2. drop video frames until we reach that timestamp
    // 3. tweak pausedVideoTime accordingly

    // TODO: fill buffers to avoid "No more audio packets available" after seek
    self.postMessage({ type: "buffering", buffering: false });
    self.postMessage({ type: "offsetMediaTime", mediaTime: time });
    self.requestAnimationFrame(this.renderVideoLoop.bind(this));
  }

  async setupFallbackAudioDecoder() {
    this.audioUseWebCodecs = false;
    if (this.WCAudioDecoder) {
      if (this.WCAudioDecoder.state == "configured")
        this.WCAudioDecoder.close();
      this.WCAudioDecoder = null;
    }
    [
      ,
      this.AudioDecoderCodecContext,
      this.AudioDecoderPacket,
      this.AudioDecoderFrame,
    ] = await this.libav.ff_init_decoder(
      this.streams[this.audioStreamIndex].codec_id,
      this.streams[this.audioStreamIndex].codecpar,
    );
  }

  // Communication with main thread

  startOutput() {
    if (this.isPlaying) return;

    this.isPlaying = true;
    this.videoTimeStart = performance.now();
    self.postMessage({
      type: "videoStatus",
      isPlaying: this.isPlaying,
      channelCount: this.channelCount,
      sampleRate: this.sampleRate,
      sharedArrayBuffer: this.sharedArrayBuffer,
    });
    self.requestAnimationFrame(this.renderVideoLoop.bind(this));
    if (this.audioStreamIndex != -1) this.feedAudioDecoder();
  }

  stopOutput() {
    if (!this.isPlaying) return;

    this.isPlaying = false;
    this.pausedVideoTime =
      this.pausedVideoTime + (performance.now() - this.videoTimeStart);
    self.postMessage({ type: "videoStatus", isPlaying: this.isPlaying });
  }

  // Time management

  updateMediaTime(pausedVideoTime, videoTimeStart) {
    this.pausedVideoTime = pausedVideoTime * 1000;
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
    if (
      this.videoPacketQueue.length > this.PACKET_QUEUE_MIN_SIZE &&
      this.audioPacketQueue.length > this.PACKET_QUEUE_MIN_SIZE
    ) {
      return;
    }
    if (!this.packet) {
      this.packet = await this.libav.av_packet_alloc();
    }
    if (!this.formatContext) {
      console.warn("Format context not initialized");
      return;
    }
    while (
      this.videoPacketQueue.length < this.PACKET_QUEUE_MIN_SIZE ||
      this.audioPacketQueue.length < this.PACKET_QUEUE_MIN_SIZE
    ) {
      const [res, packets] = await this.libav.ff_read_frame_multi(
        this.formatContext,
        this.packet,
        { limit: 32 * 1024 },
      );
      if (res < 0 && res != -this.libav.EAGAIN) {
        if (res === this.libav.AVERROR_EOF) {
          this.fileEnded = true;
          return;
        }
        console.error("Error reading frame:", await this.libav.ff_error(res));
        return;
      }
      if (packets[this.videoStreamIndex]) {
        for (const packet of packets[this.videoStreamIndex]) {
          this.videoPacketQueue.push(packet);
        }
      }
      if (packets[this.audioStreamIndex]) {
        for (const packet of packets[this.audioStreamIndex]) {
          this.audioPacketQueue.push(packet);
        }
      }
    }
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
    // Step 2/4: send the demuxed video packets to the video decoder
    try {
      if (!this.formatContext) {
        console.warn("Format context not initialized");
        return;
      }
      if (this.videoStreamIndex === -1) {
        return;
      }
      if (this.videoFrameBuffer.length > this.FRAME_BUFFER_TARGET_SIZE) {
        // Don't decode more if we have enough frames buffered
        return;
      }
      if (
        this.videoPacketQueue.length === 0 ||
        this.audioPacketQueue.length === 0
      ) {
        await this.refillFrameQueues();
      }
      // Feed video packets to video decoder
      let packet = null;
      while (this.videoFrameBuffer.length < this.FRAME_BUFFER_TARGET_SIZE) {
        if (this.videoPacketQueue.length === 0) {
          await this.refillFrameQueues();
          if (this.videoPacketQueue.length === 0) {
            // No more video packets available
            break;
          }
        }
        packet = this.videoPacketQueue.shift();
        if (this.videoUseWebCodecs && this.WCVideoDecoder) {
          const chunk = LibAVJSWebCodecs.packetToEncodedVideoChunk(
            packet,
            this.streams[this.videoStreamIndex],
          );
          this.WCVideoDecoder.decode(chunk);
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
  }

  renderVideoLoop() {
    // Video step 4/4: render video frames at the correct time
    if (!this.isPlaying || this.isSeeking) {
      return;
    }
    this.renderVideo();
    setTimeout(() => this.feedVideoDecoder(), 0);
    self.requestAnimationFrame(this.renderVideoLoop.bind(this));
  }

  renderVideo() {
    // Video step 4/4: render video frames at the correct time
    if (this.videoFrameBuffer.length == 0) {
      return;
    }
    let minTimeDelta = Number.MAX_VALUE;
    let frameIndex = -1;
    const currentTime = this.currentVideoTime() * 1000;

    for (let i = 0; i < this.videoFrameBuffer.length; i++) {
      let time_delta = Math.abs(
        currentTime - this.videoFrameBuffer[i].timestamp,
      );
      if (time_delta < minTimeDelta) {
        minTimeDelta = time_delta;
        frameIndex = i;
      }
    }
    if (frameIndex == -1) {
      return;
    }
    for (let i = 0; i < frameIndex; i++) {
      let staleFrame = this.videoFrameBuffer.shift();
      staleFrame.close();
    }

    const frame = this.videoFrameBuffer[0];
    this.renderer.draw(frame);
  }

  async feedAudioDecoder() {
    // Audio step 2/3: send the demuxed audio packets to the audio decoder
    if (this.isSeeking) console.warn("feedAudioDecoder called while seeking");
    if (this.audioFillInProgress) return;
    this.audioFillInProgress = true;
    await this.feedAudioDecoderInternal();
    this.audioFillInProgress = false;
  }

  async feedAudioDecoderInternal() {
    // Audio step 2/3: send the demuxed audio packets to the audio decoder
    // Based on https://github.com/w3c/webcodecs/blob/724b7d620519450c0c9630ab4eb97fe555f9007b/samples/lib/audio_renderer.js#L83
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
      usedBufferElements / (this.channelCount * this.sampleRate);
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
          this.WCAudioDecoder.decodeQueueSize < this.DECODER_QUEUE_SIZE_MAX)
      ) {
        if (this.audioPacketQueue.length === 0) {
          await this.refillFrameQueues();
          if (this.audioPacketQueue.length === 0) {
            // No more audio packets available
            console.warn("No more audio packets available");
            break;
          }
        }
        let packet = this.audioPacketQueue.shift();
        if (packet == undefined) {
          break;
        }
        if (this.audioUseWebCodecs && this.WCAudioDecoder) {
          const chunk = LibAVJSWebCodecs.packetToEncodedAudioChunk(
            packet,
            this.streams[this.audioStreamIndex],
          );
          this.WCAudioDecoder.decode(chunk);
        } else {
          // fallback decoding with libav
          var frames = await this.libav.ff_decode_multi(
            this.AudioDecoderCodecContext,
            this.AudioDecoderPacket,
            this.AudioDecoderFrame,
            [packet],
            false,
          );
          for (const frame of frames) {
            setTimeout(() => this.bufferAudioSamples(frame), 0);
          }
        }
        usedBufferElements =
          this.ringbuffer.capacity() - this.ringbuffer.available_write();
        usedBufferSecs =
          usedBufferElements / (this.channelCount * this.sampleRate);
      }
    } catch (e) {
      console.error("Error decoding audio data:", e);
    }
  }

  convertSampleToFloat32Array(data) {
    let samples;
    if (data instanceof Uint8Array) {
      samples = Float32Array.from(data, (x) => (x - 128) / 128);
    } else if (data instanceof Uint16Array) {
      samples = Float32Array.from(data, (x) => (x - 32768) / 32768);
    } else if (data instanceof Uint32Array) {
      samples = Float32Array.from(data, (x) => (x - 2147483648) / 2147483648);
    } else if (data instanceof Int8Array) {
      samples = Float32Array.from(data, (x) => x / 128);
    } else if (data instanceof Int16Array) {
      samples = Float32Array.from(data, (x) => x / 32768);
    } else if (data instanceof Int32Array) {
      samples = Float32Array.from(data, (x) => x / 2147483648);
    } else if (data instanceof Float32Array) {
      samples = data;
    } else {
      throw `Unsupported audio sample format in LibAV frame: ${data.data.constructor.name}`;
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
    const planarBuffers = new Array(this.channelCount);
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

    for (var i = 0; i < planarBuffers.length; i++) {
      planarBuffers[i] = new Float32Array(frameNumber);
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
    this.feedAudioDecoder();
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
