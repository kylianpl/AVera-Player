var gainNode;
var readerNode;
var audioContext;
var audioWorkletScript;
var audioInitialized = false;
var totalTime = 0;
var lastOffsetMediaTime = 0;

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
  if (audioInitialized) {
    return;
  }
  audioInitialized = true;
  if (!audioContext) {
    try {
      audioContext = new AudioContext({
        sampleRate: sampleRate,
        latencyHint: "playback",
      });
    } catch (e) {
      console.error("** Error: Unable to create audio context");
      return null;
    }
  }

  try {
    readerNode = new AudioWorkletNode(audioContext, "audio-reader", {
      processorOptions: {
        sharedArrayBuffer: sharedArrayBuffer,
        mediaChannelCount: channelCount,
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
      await audioContext.audioWorklet.addModule(audioWorkletScript);
      readerNode = new AudioWorkletNode(audioContext, "audio-reader", {
        processorOptions: {
          sharedArrayBuffer: sharedArrayBuffer,
          mediaChannelCount: channelCount,
        },
        outputChannelCount: [channelCount],
      });
    } catch (e) {
      console.error(`** Error: Unable to create worklet node: ${e}`);
      return null;
    }
  }
  gainNode = audioContext.createGain();
  gainNode.gain.setValueAtTime(
    document.getElementById("volumeControl").value,
    audioContext.currentTime,
  );
  readerNode.connect(gainNode).connect(audioContext.destination);
}

async function stopAudio() {
  if (audioContext) {
    await audioContext.suspend();
  }
}
async function startAudio() {
  if (audioContext) {
    await audioContext.resume();
  }
}

document.addEventListener("DOMContentLoaded", async function () {
  ///////////////////////////
  // Common configurations //
  ///////////////////////////

  const worker = new Worker("worker.js", { type: "module" });
  let isPlaying = false;

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
  document.getElementById("video").addEventListener("change", (event) => {
    // TODO correctly stop and re-init the worker
    // For now just save to local storage and reload the page
    localStorage.setItem("video", event.target.value);
    location.reload();
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
      updatePlayStopButton();
      if (isPlaying) {
        if (e.data.channelCount && e.data.sampleRate && e.data.sharedArrayBuffer) {
          initializeAudio(
            e.data.channelCount,
            e.data.sampleRate,
            e.data.sharedArrayBuffer,
          );
        }
        await startAudio();
        sendMediaTimeUpdates(true);
      } else {
        await stopAudio();
        sendMediaTimeUpdates(false);
      }
    } else if (e.data.type === "initFinished") {
      document.getElementById("playStopButton").disabled = false;
      totalTime = e.data.duration;
      document.getElementById("duration").textContent = formatTime(
        e.data.duration,
      );
      var videoStream = document.getElementById("videoStream");
      videoStream.innerHTML = "";
      videoStream.onchange = function () {
        changeStream("video", this.value);
      };
      e.data.availableStreams.video.forEach((stream) => {
        var option = document.createElement("option");
        option.value = stream.index;
        option.text = `Video Stream ${stream.index} - ${stream.codec} - ${stream.width}x${stream.height}`;
        option.selected = stream.selected;
        videoStream.appendChild(option);
      });
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
        await stopAudio();
        sendMediaTimeUpdates(false);
      } else if (isPlaying) {
        await startAudio();
        sendMediaTimeUpdates(true);
      }
    } else if (e.data.type == "offsetMediaTime") {
      // to offset the time from webaudio after a seek
      lastOffsetMediaTime = e.data.mediaTime - audioContext.currentTime;
    }
  };

  function changeStream(type, index) {
    worker.postMessage({
      type: "changeStream",
      streamType: type,
      index: parseInt(index),
    });
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
      return 0.0;
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
  let uiTimeUpdateInterval = null;
  function sendMediaTimeUpdates(enabled) {
    if (enabled && audioInitialized) {
      // Local testing shows this interval (1 second) is frequent enough that the
      // estimated media time between updates drifts by less than 20 msec. Lower
      // values didn't produce meaningfully lower drift and have the downside of
      // waking up the main thread more often. Higher values could make av sync
      // glitches more noticeable when changing the output device.
      const UPDATE_INTERVAL = 1000;
      mediaTimeUpdateInterval = setInterval(() => {
        worker.postMessage({
          type: "updateMediaTime",
          pausedVideoTime: getMediaTime(),
          videoTimeStart: performance.now() + performance.timeOrigin,
        });
      }, UPDATE_INTERVAL);
      uiTimeUpdateInterval = setInterval(() => {
        if (totalTime > 0) {
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
      }, 500);
    } else {
      clearInterval(mediaTimeUpdateInterval);
      clearInterval(uiTimeUpdateInterval);
      uiTimeUpdateInterval = null;
      mediaTimeUpdateInterval = null;
    }
  }

  ///////////////////////
  // Lag Monitor Setup //
  ///////////////////////

  // Initialize and start the lag monitor
  let script = document.createElement("script");
  script.src = "libs/lag-monitor.js";
  document.head.appendChild(script);
  script.onload = function () {
    // Get references to HTML elements
    const lagStatusElement = document.getElementById("lagStatus");
    const fpsCounterElement = document.getElementById("fpsCounter");
    const frameTimeCounterElement = document.getElementById("frameTimeCounter");
    const lagCounterElement = document.getElementById("lagCounter");

    let totalLagEvents = 0;

    // Create the lag monitor with custom settings
    const lagMonitor = new LagMonitor({
      lagThresholdMs: 50, // 50ms threshold for lag detection
      reportingInterval: 3000, // Report stats every 3 seconds
      onLagDetected: (data) => {
        console.warn(
          `Main thread lag detected: ${Math.round(data.frameTime)}ms`,
        );

        // Update lag counter
        totalLagEvents++;
        lagCounterElement.textContent = totalLagEvents;

        // Update status indicator
        lagStatusElement.textContent = `Lag detected: ${Math.round(data.frameTime)}ms`;
        lagStatusElement.className = "lag-high";

        // Reset class after a moment
        setTimeout(() => {
          lagStatusElement.textContent = "Running...";
          lagStatusElement.className = "lag-normal";
        }, 2000);

        // Add visual indicator for lag on the page
        const lagIndicator = document.createElement("div");
        lagIndicator.style.position = "fixed";
        lagIndicator.style.top = "10px";
        lagIndicator.style.right = "10px";
        lagIndicator.style.backgroundColor = "red";
        lagIndicator.style.color = "white";
        lagIndicator.style.padding = "5px 10px";
        lagIndicator.style.borderRadius = "5px";
        lagIndicator.style.zIndex = "9999";
        lagIndicator.style.opacity = "0.8";
        lagIndicator.textContent = `Lag: ${Math.round(data.frameTime)}ms`;

        document.body.appendChild(lagIndicator);

        // Remove the indicator after 2 seconds
        setTimeout(() => {
          lagIndicator.remove();
        }, 2000);
      },
      // Add callback to update UI with stats
      onStatsUpdate: (stats) => {
        fpsCounterElement.textContent = stats.fps;
        frameTimeCounterElement.textContent = stats.avgFrameTime;

        // Color code based on performance
        if (stats.fps < 30) {
          fpsCounterElement.className = "lag-high";
        } else if (stats.fps < 50) {
          fpsCounterElement.className = "lag-medium";
        } else {
          fpsCounterElement.className = "lag-normal";
        }
      },
    });

    // Start monitoring
    lagMonitor.start();

    // Expose to window for debugging
    window.lagMonitor = lagMonitor;
  };
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
