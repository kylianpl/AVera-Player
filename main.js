var gainNode;
var readerNode;
var audioContext;
var audioWorkletScript;
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
  if (audioContext) {
    await audioContext.close();
  }
  try {
    audioContext = new AudioContext({
      sampleRate: sampleRate,
      latencyHint: "playback",
    });
  } catch (e) {
    console.error("** Error: Unable to create audio context");
    return null;
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
  let mediaClockStartTime = performance.now() + performance.timeOrigin;
  let mediaClockStartSeconds = 0;

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
    const wasPlaying = isPlaying;
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
      await audioContext.close();
      audioContext = null;
    }

    totalTime = 0;
    lastOffsetMediaTime = 0;
    mediaClockStartSeconds = 0;
    mediaClockStartTime = performance.now() + performance.timeOrigin;
    worker.postMessage({
      type: "reinit",
      video: event.target.value || null,
      autoplay: wasPlaying,
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
      if (isPlaying) {
        await startAudio();
      }
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
