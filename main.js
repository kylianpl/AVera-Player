var gainNode;
var readerNode;
var audioContext;
var audioWorkletScript;
var totalTime = 0;
var lastOffsetMediaTime = 0;
var audioStreamActivated = false;
var audioGenerationBuffer = new SharedArrayBuffer(4);
var audioGenerationFlag = new Int32Array(audioGenerationBuffer);
Atomics.store(audioGenerationFlag, 0, 0);

document.getElementById("playStopButton").disabled = true;

function URLFromFiles(files) {
  // merge multiple files into one blob URL
  const promises = files.map((file) =>
    fetch(file).then((response) => response.text()),
  );

  return Promise.all(promises).then((texts) => {
    const text = texts.join("");
    const blob = new Blob([text], { type: "application/javascript" });

    return URL.createObjectURL(blob);
  });
}
URLFromFiles(["./libs/ringbuf.js", "audio-reader.js"]).then((url) => {
  audioWorkletScript = url;
});

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return (
    (hrs > 0 ? String(hrs).padStart(2, "0") + ":" : "") +
    String(mins).padStart(2, "0") +
    ":" +
    String(secs).padStart(2, "0")
  );
}

async function initializeAudio(channelCount, sampleRate, sharedArrayBuffer) {
  if (audioContext && audioContext.sampleRate !== sampleRate) {
    console.warn(
      `initializeAudio: rate mismatch (ctx=${audioContext.sampleRate} vs stream=${sampleRate}), recreating`,
    );
    console.log(`[audio] close ${audioContext.sampleRate}Hz (→ ${sampleRate}Hz)`);
    await audioContext.close();
    audioContext = null;
    audioStreamActivated = false;
  }
  if (readerNode) {
    console.log(`[audio] disconnect old readerNode`);
    readerNode.disconnect();
    readerNode = null;
  }
  Atomics.add(audioGenerationFlag, 0, 1);
  console.log(`[audio] generation bumped to ${Atomics.load(audioGenerationFlag, 0)}`);
  if (!audioContext) {
    try {
      console.log(`[audio] new AudioContext(${sampleRate}Hz) — from initializeAudio`);
      audioContext = new AudioContext({
        sampleRate: sampleRate,
        latencyHint: "playback",
      });
      console.log(`[audio] suspend (initial state: ${audioContext.state})`);
      await audioContext.suspend();
    } catch (e) {
      console.error("** Error: Unable to create audio context");
      return null;
    }
  }

  try {
    var gen = Atomics.load(audioGenerationFlag, 0);
    console.log(`[audio] new AudioWorkletNode(gen=${gen}, ch=${channelCount})`);
    readerNode = new AudioWorkletNode(audioContext, "audio-reader", {
      processorOptions: {
        sharedArrayBuffer: sharedArrayBuffer,
        mediaChannelCount: channelCount,
        generationBuffer: audioGenerationBuffer,
        generation: gen,
      },
      outputChannelCount: [channelCount],
    });
  } catch (e) {
    try {
      if (!audioWorkletScript) {
        console.warn("** Warning: Audio worklet script not ready");
        audioWorkletScript = await URLFromFiles([
          "./libs/ringbuf.js",
          "audio-reader.js",
        ]);
      }
      console.log(`[audio] addModule + new AudioWorkletNode(gen=${gen}, ch=${channelCount})`);
      await audioContext.audioWorklet.addModule(audioWorkletScript);
      readerNode = new AudioWorkletNode(audioContext, "audio-reader", {
        processorOptions: {
          sharedArrayBuffer: sharedArrayBuffer,
          mediaChannelCount: channelCount,
          generationBuffer: audioGenerationBuffer,
          generation: gen,
        },
        outputChannelCount: [channelCount],
      });
    } catch (e) {
      console.error(`** Error: Unable to create worklet node: ${e}`);
      return null;
    }
  }
  if (!gainNode || gainNode.context !== audioContext) {
    console.log(`[audio] new gainNode`);
    gainNode = audioContext.createGain();
  }
  gainNode.gain.setValueAtTime(
    document.getElementById("volumeControl").value,
    audioContext.currentTime,
  );
  readerNode.port.onmessage = (e) => {
    if (e.data.type === "partialReads") {
      console.warn(`[audio] Partial reads: ${e.data.count} (read ${e.data.read}/${e.data.expected})`);
    }
  };
}

async function stopAudio() {
  if (readerNode) {
    console.log(`[audio] stopAudio → disconnect readerNode`);
    readerNode.disconnect();
  }
  audioStreamActivated = false;
  if (audioContext) {
    console.log(`[audio] stopAudio → suspend (state: ${audioContext.state})`);
    await audioContext.suspend();
  }
}
async function startAudio() {
  if (audioContext) {
    if (readerNode && gainNode && !audioStreamActivated) {
      console.log(`[audio] startAudio → connect readerNode → gainNode → destination`);
      readerNode.connect(gainNode).connect(audioContext.destination);
      audioStreamActivated = true;
    }
    console.log(`[audio] startAudio → resume (state: ${audioContext.state})`);
    await audioContext.resume();
  }
}

document.addEventListener("DOMContentLoaded", async function () {
  ///////////////////////////
  // Common configurations //
  ///////////////////////////

  const worker = new Worker("worker.js", { type: "module" });
  let isPlaying = false;
  let mediaClockStartTime = performance.now() + performance.timeOrigin;
  let mediaClockStartSeconds = 0;
  let availableStreams = null;

  // Wait for samples to load before proceeding
  await waitForSamplesToLoad();

  // set the video from local storage if available
  const savedVideo = localStorage.getItem("video");
  if (savedVideo) {
    document.getElementById("video").value = savedVideo;
  }

  // Get the play/stop button and set up event listener
  const playStopButton = document.getElementById("playStopButton");
  playStopButton.addEventListener("click", toggleVideo);

  document.getElementById("progressBar").addEventListener("click", (event) => {
    if (totalTime > 0) {
      const rect = event.currentTarget.getBoundingClientRect();
      const clickPosition = event.clientX - rect.left;
      const clickRatio = clickPosition / rect.width;
      const seekTime = clickRatio * totalTime;
      worker.postMessage({
        type: "seek",
        seconds: seekTime,
        videoTimeStart: performance.now() + performance.timeOrigin,
      });
    }
  });
  document.getElementById("video").addEventListener("change", async (event) => {
    localStorage.setItem("video", event.target.value);
    isPlaying = false;
    updatePlayStopButton();
    sendMediaTimeUpdates(false);
    document.getElementById("playStopButton").disabled = true;
    document.getElementById("buffering").style.display = "block";
    document.getElementById("progress").style.width = "0%";
    document.getElementById("currentTime").textContent = formatTime(0);
    document.getElementById("duration").textContent = "Loading...";

    if (audioContext) {
      lastOffsetMediaTime = -(audioContext.currentTime ?? 0);
      await audioContext.suspend();
      if (readerNode) {
        readerNode.disconnect();
        readerNode = null;
        Atomics.add(audioGenerationFlag, 0, 1);
        console.log(`[audio] source change — generation bumped to ${Atomics.load(audioGenerationFlag, 0)}`);
      }
    } else {
      lastOffsetMediaTime = 0;
    }

    totalTime = 0;
    mediaClockStartSeconds = 0;
    mediaClockStartTime = performance.now() + performance.timeOrigin;
    worker.postMessage({
      type: "reinit",
      video: event.target.value || null,
    });
  });

  // Toggle video on button click
  async function toggleVideo() {
    if (isPlaying) {
      worker.postMessage({
        type: "stop",
        pausedVideoTime: getMediaTime(),
        videoTimeStart: performance.now() + performance.timeOrigin,
      });
    } else {
      worker.postMessage({
        type: "start",
        pausedVideoTime: getMediaTime(),
        videoTimeStart: performance.now() + performance.timeOrigin,
      });
    }
  }

  // Update button text and style based on animation state
  function updatePlayStopButton() {
    if (isPlaying) {
      playStopButton.textContent = "Stop";
      playStopButton.classList.remove("paused");
    } else {
      playStopButton.textContent = "Play";
      playStopButton.classList.add("paused");
    }
  }

  /////////////////////////
  // Video configuration //
  /////////////////////////
  const offscreenCanvas = document
    .getElementById("videoCanvas")
    .transferControlToOffscreen();

  // Transfer the offscreen canvas to the worker
  worker.postMessage(
    {
      type: "init",
      canvas: offscreenCanvas,
      video: document.getElementById("video").value || null,
    },
    [offscreenCanvas],
  );

  // Listen for messages from the worker
  worker.onmessage = async function (e) {
    if (e.data.type === "videoStatus") {
      // Update animation state
      isPlaying = e.data.isPlaying;
      mediaClockStartSeconds = getMediaTime();
      mediaClockStartTime = performance.now() + performance.timeOrigin;
      updatePlayStopButton();
      if (isPlaying) {
        if (audioContext) await startAudio();
        sendMediaTimeUpdates(true);
      } else {
        if (audioContext) await stopAudio();
        sendMediaTimeUpdates(false);
      }
    } else if (e.data.type === "audioConfig") {
      await initializeAudio(
        e.data.channelCount,
        e.data.sampleRate,
        e.data.sharedArrayBuffer,
      );
    } else if (e.data.type === "initFinished") {
      document.getElementById("buffering").style.display = "none";
      document.getElementById("playStopButton").disabled = false;
      totalTime = e.data.duration;
      mediaClockStartSeconds = 0;
      mediaClockStartTime = performance.now() + performance.timeOrigin;
      document.getElementById("duration").textContent = formatTime(
        e.data.duration,
      );
      var videoStream = document.getElementById("videoStream");
      videoStream.innerHTML = "";
      videoStream.onchange = function () {
        changeStream("video", this.value);
      };
      var hasVideo = e.data.availableStreams.video.length > 0;
      e.data.availableStreams.video.forEach((stream) => {
        var option = document.createElement("option");
        option.value = stream.index;
        option.text = `Video Stream ${stream.index} - ${stream.codec} - ${stream.width}x${stream.height}`;
        option.selected = stream.selected;
        videoStream.appendChild(option);
      });
      document.getElementById("noVideoOverlay").style.display = hasVideo ? "none" : "flex";
      availableStreams = e.data.availableStreams;
      var audioStream = document.getElementById("audioStream");
      audioStream.innerHTML = "";
      audioStream.onchange = (event) => {
        changeStream("audio", event.target.value);
      };
      e.data.availableStreams.audio.forEach((stream) => {
        var option = document.createElement("option");
        option.value = stream.index;
        option.text = `Audio Stream ${stream.index} - ${stream.codec} - ${stream.channelCount}ch ${stream.sampleRate}Hz`;
        option.selected = stream.selected;
        audioStream.appendChild(option);
      });
    } else if (e.data.type == "buffering") {
      document.getElementById("buffering").style.display = e.data.buffering
        ? "block"
        : "none";
      if (e.data.buffering) {
        if (audioContext) await stopAudio();
        sendMediaTimeUpdates(false);
      } else if (isPlaying) {
        if (audioContext) await startAudio();
        sendMediaTimeUpdates(true);
      }
    } else if (e.data.type == "offsetMediaTime") {
      // to offset the time from webaudio after a seek
      if (audioContext) {
        lastOffsetMediaTime = e.data.mediaTime - audioContext.currentTime;
      }
      mediaClockStartSeconds = e.data.mediaTime;
      mediaClockStartTime = performance.now() + performance.timeOrigin;
      if (isPlaying) await startAudio();
    } else if (e.data.type === "avDrift") {
      if (audioContext) {
        const driftMs = e.data.driftMs;
        if (Math.abs(driftMs) > 150) {
          lastOffsetMediaTime += Math.sign(driftMs) * 0.001 * Math.min(50, Math.abs(driftMs) * 0.05);
        }
      }
    } else if (e.data.type === "workerLagReport") {
      const fpsCounter = document.getElementById("fpsCounter");
      const frameTimeCounter = document.getElementById("frameTimeCounter");
      const lagCounter = document.getElementById("lagCounter");
      const lagStatus = document.getElementById("lagStatus");
      if (fpsCounter) fpsCounter.textContent = e.data.fps;
      if (frameTimeCounter) frameTimeCounter.textContent = e.data.avgFrameTime;
      if (lagCounter) lagCounter.textContent = e.data.totalLagEvents;
      if (lagStatus) {
        const isLagging = e.data.lastFrameTime > 50;
        lagStatus.textContent = isLagging
          ? `Lag detected: ${Math.round(e.data.lastFrameTime)}ms`
          : "Running...";
        lagStatus.className = isLagging ? "lag-high" : "lag-normal";
      }
      if (fpsCounter) {
        fpsCounter.className = e.data.fps < 30
          ? "lag-high" : e.data.fps < 50
            ? "lag-medium" : "lag-normal";
      }
    }
  };

  function changeStream(type, index) {
    if (type === "audio") {
      const idx = parseInt(index);
      const targetStream = availableStreams?.audio?.find(s => s.index === idx);
      if (targetStream) {
        if (audioContext && audioContext.sampleRate !== targetStream.sampleRate) {
          console.log(`[audio] close ${audioContext.sampleRate}Hz → pre-create ${targetStream.sampleRate}Hz`);
          audioContext.close();
          audioContext = tryCreateAudioContext(targetStream.sampleRate);
        } else if (!audioContext) {
          audioContext = tryCreateAudioContext(targetStream.sampleRate);
        }
      }
    }
    worker.postMessage({
      type: "changeStream",
      streamType: type,
      index: parseInt(index),
    });
  }

  function tryCreateAudioContext(sampleRate) {
    try {
      console.log(`[audio] new AudioContext(${sampleRate}Hz) — from changeStream`);
      const ctx = new AudioContext({ sampleRate, latencyHint: "playback" });
      if (!isPlaying) {
        console.log(`[audio] suspend (initial state: ${ctx.state})`);
        ctx.suspend();
      }
      return ctx;
    } catch (e) {
      console.warn(`[audio] Failed to create AudioContext at ${sampleRate} Hz: ${e}. Using default.`);
      const ctx = new AudioContext({ latencyHint: "playback" });
      if (!isPlaying) {
        console.log(`[audio] suspend fallback (initial state: ${ctx.state})`);
        ctx.suspend();
      }
      return ctx;
    }
  }
  /////////////////////////
  // Audio configuration //
  /////////////////////////
  document
    .getElementById("volumeControl")
    .addEventListener("input", (event) => {
      const volume = parseFloat(event.target.value);
      if (gainNode) {
        gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
      }
    });

  function getMediaTime() {
    if (!audioContext) {
      if (!isPlaying) return mediaClockStartSeconds;
      return mediaClockStartSeconds +
        (performance.now() + performance.timeOrigin - mediaClockStartTime) / 1000;
    }
    let outputLatency = audioContext.outputLatency
      ? audioContext.outputLatency
      : 0;
    let totalOutputLatency = outputLatency + audioContext.baseLatency;

    let mediaTimeSecs = audioContext.currentTime - totalOutputLatency;
    mediaTimeSecs += lastOffsetMediaTime;
    if (mediaTimeSecs < 0) {
      mediaTimeSecs = 0;
    }
    return mediaTimeSecs;
  }

  let mediaTimeUpdateInterval = null;
  let uiRafId = null;
  function sendMediaTimeUpdates(enabled) {
    clearInterval(mediaTimeUpdateInterval);
    mediaTimeUpdateInterval = null;
    if (uiRafId !== null) {
      self.cancelAnimationFrame(uiRafId);
      uiRafId = null;
    }

    if (enabled) {
      const UPDATE_INTERVAL = 200;
      mediaTimeUpdateInterval = setInterval(() => {
        worker.postMessage({
          type: "updateMediaTime",
          pausedVideoTime: getMediaTime(),
          videoTimeStart: performance.now() + performance.timeOrigin,
        });
      }, UPDATE_INTERVAL);

      function updateUi() {
        if (isPlaying && totalTime > 0) {
          var currentTime = getMediaTime();
          document.getElementById("progress").style.width =
            `${(currentTime / totalTime) * 100}%`;
          document.getElementById("currentTime").textContent =
            formatTime(currentTime);
          if (currentTime >= totalTime) {
            worker.postMessage({
              type: "stop",
              pausedVideoTime: getMediaTime(),
              videoTimeStart: performance.now() + performance.timeOrigin,
            });
          }
        }
        uiRafId = self.requestAnimationFrame(updateUi);
      }
      updateUi();
    }
  }

});

// Function to wait for samples to be loaded
function waitForSamplesToLoad() {
  return new Promise((resolve) => {
    const checkSamples = () => {
      const videoSelect = document.getElementById("video");
      const options = videoSelect.querySelectorAll("option");

      // Check if samples are loaded (more than just the loading option)
      if (
        options.length > 1 ||
        (options.length === 1 && !options[0].disabled)
      ) {
        resolve();
      } else {
        setTimeout(checkSamples, 100);
      }
    };
    checkSamples();
  });
}
