const STORAGE_KEYS = {
  settings: "milkRiseAlert.settings"
};

const DEFAULT_SETTINGS = {
  zoneTop: 22,
  zoneBottom: 78,
  triggerDistance: 14,
  confirmFrames: 4
};

const ANALYSIS_WIDTH = 240;
const SAMPLE_INSET_RATIO = 0.24;
const MIN_CONFIDENCE = 8;
const ANALYSIS_INTERVAL_MS = 110;
const MAX_LOG_ITEMS = 6;
const ALARM_AUDIO_BASE64_PATH = "./assets/alarm.base64.txt?v=1";

const state = {
  settings: loadSettings(),
  stream: null,
  wakeLock: null,
  baselineNormalizedY: null,
  latestAnalysis: null,
  isCameraReady: false,
  isMonitoring: false,
  isAlarming: false,
  confirmCount: 0,
  lastAnalysisAt: 0,
  logs: [],
  analysisCanvas: document.createElement("canvas"),
  analysisContext: null,
  overlayContext: null,
  alarmAudio: null,
  alarmAudioDataUrl: null,
  alarmTimer: null,
  animationFrameId: null
};

const elements = {
  statusBanner: document.querySelector("#status-banner"),
  cameraPreview: document.querySelector("#camera-preview"),
  overlayCanvas: document.querySelector("#overlay-canvas"),
  cameraEmptyState: document.querySelector("#camera-empty-state"),
  startCameraButton: document.querySelector("#start-camera-button"),
  captureBaselineButton: document.querySelector("#capture-baseline-button"),
  monitorButton: document.querySelector("#monitor-button"),
  silenceButton: document.querySelector("#silence-button"),
  baselineValue: document.querySelector("#baseline-value"),
  currentValue: document.querySelector("#current-value"),
  riseValue: document.querySelector("#rise-value"),
  confidenceValue: document.querySelector("#confidence-value"),
  zoneTopInput: document.querySelector("#zone-top-input"),
  zoneBottomInput: document.querySelector("#zone-bottom-input"),
  triggerDistanceInput: document.querySelector("#trigger-distance-input"),
  confirmFramesInput: document.querySelector("#confirm-frames-input"),
  zoneTopOutput: document.querySelector("#zone-top-output"),
  zoneBottomOutput: document.querySelector("#zone-bottom-output"),
  triggerDistanceOutput: document.querySelector("#trigger-distance-output"),
  confirmFramesOutput: document.querySelector("#confirm-frames-output"),
  eventLog: document.querySelector("#event-log")
};

init();

function init() {
  state.analysisContext = state.analysisCanvas.getContext("2d", { willReadFrequently: true });
  state.overlayContext = elements.overlayCanvas.getContext("2d");

  bindControls();
  syncSettingInputs();
  render();
  logEvent("Ready", "Start the camera and angle the phone so the milk line is visible.");

  if (navigator.mediaDevices?.getUserMedia == null) {
    setStatus("This browser does not support camera access for live monitoring.");
    elements.startCameraButton.disabled = true;
  }

  window.addEventListener("resize", drawOverlay);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

function bindControls() {
  elements.startCameraButton.addEventListener("click", startCamera);
  elements.captureBaselineButton.addEventListener("click", captureBaseline);
  elements.monitorButton.addEventListener("click", toggleMonitoring);
  elements.silenceButton.addEventListener("click", silenceAlarm);

  elements.zoneTopInput.addEventListener("input", () => updateSetting("zoneTop", Number(elements.zoneTopInput.value)));
  elements.zoneBottomInput.addEventListener("input", () => updateSetting("zoneBottom", Number(elements.zoneBottomInput.value)));
  elements.triggerDistanceInput.addEventListener("input", () => updateSetting("triggerDistance", Number(elements.triggerDistanceInput.value)));
  elements.confirmFramesInput.addEventListener("input", () => updateSetting("confirmFrames", Number(elements.confirmFramesInput.value)));
}

async function startCamera() {
  try {
    setStatus("Requesting camera access...");
    stopStream();
    state.baselineNormalizedY = null;
    state.latestAnalysis = null;
    state.confirmCount = 0;
    state.isMonitoring = false;
    state.isAlarming = false;
    stopAlarmLoop();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });

    state.stream = stream;
    elements.cameraPreview.srcObject = stream;
    await elements.cameraPreview.play();

    state.isCameraReady = true;
    setStatus("Camera live. When the milk is calm, tap Set baseline.");
    logEvent("Camera live", "Rear-camera preview started.");
    await requestWakeLock();
    ensureAnimationLoop();
    render();
  } catch (error) {
    state.isCameraReady = false;
    setStatus("Camera access failed. Allow permission and try again.");
    logEvent("Camera error", readableError(error));
    render();
  }
}

function captureBaseline() {
  const analysis = analyzeFrame();
  if (!analysis || analysis.confidence < MIN_CONFIDENCE) {
    setStatus("I could not find a stable milk line yet. Adjust the angle or watch zone and try again.");
    logEvent("Baseline failed", "The visible edge was too weak for calibration.");
    return;
  }

  state.baselineNormalizedY = analysis.normalizedY;
  state.latestAnalysis = analysis;
  state.confirmCount = 0;
  state.isAlarming = false;
  stopAlarmLoop();
  setStatus("Baseline captured. You can start monitoring now.");
  logEvent("Baseline set", `Captured at ${formatPixels(analysis.pixelY)} with confidence ${analysis.confidence.toFixed(1)}.`);
  render();
  drawOverlay();
}

async function toggleMonitoring() {
  if (!state.isMonitoring) {
    if (state.baselineNormalizedY == null) {
      setStatus("Capture a baseline before monitoring.");
      return;
    }

    await ensureAlarmAudio();
    await requestWakeLock();
    state.isMonitoring = true;
    state.confirmCount = 0;
    setStatus("Monitoring for upward motion...");
    logEvent("Monitoring on", `Alarm triggers after ${state.settings.confirmFrames} rising frames.`);
    render();
    return;
  }

  state.isMonitoring = false;
  state.confirmCount = 0;
  setStatus("Monitoring paused.");
  logEvent("Monitoring off", "The camera preview stays active.");
  render();
}

function analyzeFrame() {
  const video = elements.cameraPreview;
  if (!state.isCameraReady || video.videoWidth < 2 || video.videoHeight < 2) {
    return null;
  }

  const width = ANALYSIS_WIDTH;
  const height = Math.max(120, Math.round((video.videoHeight / video.videoWidth) * ANALYSIS_WIDTH));
  state.analysisCanvas.width = width;
  state.analysisCanvas.height = height;
  state.analysisContext.drawImage(video, 0, 0, width, height);

  const zoneTop = Math.round((state.settings.zoneTop / 100) * height);
  const zoneBottom = Math.round((state.settings.zoneBottom / 100) * height);
  const sampleStartX = Math.round(width * SAMPLE_INSET_RATIO);
  const sampleEndX = Math.round(width * (1 - SAMPLE_INSET_RATIO));
  const sampleWidth = Math.max(8, sampleEndX - sampleStartX);
  const sampleHeight = Math.max(8, zoneBottom - zoneTop + 1);
  const image = state.analysisContext.getImageData(sampleStartX, zoneTop, sampleWidth, sampleHeight).data;

  const rowBrightness = [];
  for (let row = 0; row < sampleHeight; row += 1) {
    let brightnessSum = 0;
    const rowStart = row * sampleWidth * 4;

    for (let column = 0; column < sampleWidth; column += 1) {
      const index = rowStart + column * 4;
      const red = image[index];
      const green = image[index + 1];
      const blue = image[index + 2];
      brightnessSum += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    }

    rowBrightness.push(brightnessSum / sampleWidth);
  }

  const smoothed = smoothSeries(rowBrightness);
  let bestIndex = -1;
  let bestGradient = -Infinity;

  for (let index = 2; index < smoothed.length - 2; index += 1) {
    const gradient = smoothed[index + 2] - smoothed[index - 2];
    if (gradient > bestGradient) {
      bestGradient = gradient;
      bestIndex = index;
    }
  }

  if (bestIndex < 0 || !Number.isFinite(bestGradient)) {
    return null;
  }

  const pixelY = zoneTop + bestIndex;
  return {
    pixelY,
    normalizedY: pixelY / height,
    confidence: Math.max(0, bestGradient),
    zoneTop,
    zoneBottom,
    height
  };
}

function smoothSeries(values) {
  return values.map((_, index) => {
    let sum = 0;
    let count = 0;

    for (let offset = -2; offset <= 2; offset += 1) {
      const candidate = values[index + offset];
      if (candidate == null) {
        continue;
      }
      sum += candidate;
      count += 1;
    }

    return count > 0 ? sum / count : values[index];
  });
}

function ensureAnimationLoop() {
  if (state.animationFrameId != null) {
    return;
  }

  const tick = (timestamp) => {
    state.animationFrameId = window.requestAnimationFrame(tick);

    if (!state.isCameraReady) {
      drawOverlay();
      return;
    }

    if (timestamp - state.lastAnalysisAt >= ANALYSIS_INTERVAL_MS) {
      state.lastAnalysisAt = timestamp;
      const analysis = analyzeFrame();
      if (analysis) {
        state.latestAnalysis = analysis;
        updateMonitoringState(analysis);
        renderStats();
      }
    }

    drawOverlay();
  };

  state.animationFrameId = window.requestAnimationFrame(tick);
}

function updateMonitoringState(analysis) {
  if (state.baselineNormalizedY == null || !state.isMonitoring || state.isAlarming) {
    return;
  }

  if (analysis.confidence < MIN_CONFIDENCE) {
    state.confirmCount = 0;
    return;
  }

  const risePixels = (state.baselineNormalizedY - analysis.normalizedY) * analysis.height;
  if (risePixels >= state.settings.triggerDistance) {
    state.confirmCount += 1;
  } else {
    state.confirmCount = 0;
  }

  if (state.confirmCount >= state.settings.confirmFrames) {
    triggerAlarm(risePixels);
  }
}

async function triggerAlarm(risePixels) {
  state.isAlarming = true;
  state.isMonitoring = false;
  state.confirmCount = 0;
  setStatus(`Milk is rising. Alarm triggered at ${formatPixels(risePixels)} above baseline.`);
  logEvent("Alarm", `Triggered after the milk rose by ${formatPixels(risePixels)}.`);
  render();

  await startAlarmLoop();
}

async function ensureAlarmAudio() {
  if (state.alarmAudio) {
    return state.alarmAudio;
  }

  const audio = new Audio();
  audio.loop = true;
  audio.preload = "auto";
  audio.src = await loadAlarmAudioSource();
  state.alarmAudio = audio;
  return audio;
}

async function loadAlarmAudioSource() {
  if (state.alarmAudioDataUrl) {
    return state.alarmAudioDataUrl;
  }

  const response = await fetch(ALARM_AUDIO_BASE64_PATH, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Alarm audio fetch failed with status ${response.status}`);
  }

  const base64 = (await response.text()).trim();
  state.alarmAudioDataUrl = `data:audio/mpeg;base64,${base64}`;
  return state.alarmAudioDataUrl;
}

async function startAlarmLoop() {
  stopAlarmLoop();

  try {
    const alarmAudio = await ensureAlarmAudio();
    alarmAudio.currentTime = 0;
    await alarmAudio.play();
  } catch (error) {
    setStatus("Alarm triggered, but the sound could not start automatically. Tap Silence alarm and re-arm if needed.");
    logEvent("Audio blocked", readableError(error));
  }

  if ("vibrate" in navigator) {
    navigator.vibrate([220, 120, 220, 120, 480]);
    state.alarmTimer = window.setInterval(() => {
      navigator.vibrate([220, 120, 220, 120, 480]);
    }, 1100);
  }
}

function silenceAlarm() {
  state.isAlarming = false;
  stopAlarmLoop();
  setStatus("Alarm silenced. You can set a new baseline or restart monitoring.");
  logEvent("Alarm silenced", "Monitoring paused after the alert.");
  render();
}

function stopAlarmLoop() {
  state.alarmAudio?.pause();
  if (state.alarmAudio) {
    state.alarmAudio.currentTime = 0;
  }

  if (state.alarmTimer != null) {
    window.clearInterval(state.alarmTimer);
    state.alarmTimer = null;
  }

  if ("vibrate" in navigator) {
    navigator.vibrate(0);
  }
}

function drawOverlay() {
  const canvas = elements.overlayCanvas;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width < 2 || bounds.height < 2) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * dpr);
  canvas.height = Math.round(bounds.height * dpr);

  const context = state.overlayContext;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);

  const zoneTopY = (state.settings.zoneTop / 100) * bounds.height;
  const zoneBottomY = (state.settings.zoneBottom / 100) * bounds.height;
  const insetX = bounds.width * SAMPLE_INSET_RATIO;
  const zoneHeight = zoneBottomY - zoneTopY;

  context.strokeStyle = "rgba(255, 210, 119, 0.95)";
  context.lineWidth = 2;
  context.setLineDash([8, 8]);
  context.strokeRect(insetX, zoneTopY, bounds.width - insetX * 2, zoneHeight);
  context.setLineDash([]);

  if (state.baselineNormalizedY != null) {
    drawGuideLine(context, bounds.width, state.baselineNormalizedY * bounds.height, "#ffd277", "Baseline");
  }

  if (state.latestAnalysis) {
    const color = state.isAlarming ? "#ff5a59" : "#7cf2c1";
    drawGuideLine(context, bounds.width, state.latestAnalysis.normalizedY * bounds.height, color, "Current");
  }
}

function drawGuideLine(context, width, y, color, label) {
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(18, y);
  context.lineTo(width - 18, y);
  context.stroke();

  context.fillStyle = color;
  context.font = "700 12px Trebuchet MS";
  context.fillText(label, 18, Math.max(18, y - 8));
}

function updateSetting(key, value) {
  const previousTop = state.settings.zoneTop;
  const previousBottom = state.settings.zoneBottom;

  if (key === "zoneTop") {
    state.settings.zoneTop = Math.min(value, state.settings.zoneBottom - 8);
  } else if (key === "zoneBottom") {
    state.settings.zoneBottom = Math.max(value, state.settings.zoneTop + 8);
  } else {
    state.settings[key] = value;
  }

  persistSettings();
  syncSettingInputs();

  if ((key === "zoneTop" && previousTop !== state.settings.zoneTop) || (key === "zoneBottom" && previousBottom !== state.settings.zoneBottom)) {
    state.isMonitoring = false;
    state.confirmCount = 0;
    if (state.baselineNormalizedY != null) {
      setStatus("Watch zone changed. Capture a new baseline before monitoring again.");
      logEvent("Recalibrate", "The watch zone changed, so the old baseline was cleared.");
    }
    state.baselineNormalizedY = null;
  }

  render();
  drawOverlay();
}

function syncSettingInputs() {
  elements.zoneTopInput.value = String(state.settings.zoneTop);
  elements.zoneBottomInput.value = String(state.settings.zoneBottom);
  elements.triggerDistanceInput.value = String(state.settings.triggerDistance);
  elements.confirmFramesInput.value = String(state.settings.confirmFrames);

  elements.zoneTopOutput.textContent = `${state.settings.zoneTop}%`;
  elements.zoneBottomOutput.textContent = `${state.settings.zoneBottom}%`;
  elements.triggerDistanceOutput.textContent = `${state.settings.triggerDistance} px`;
  elements.confirmFramesOutput.textContent = String(state.settings.confirmFrames);
}

function render() {
  renderStats();

  elements.cameraEmptyState.classList.toggle("hidden", state.isCameraReady);
  elements.captureBaselineButton.disabled = !state.isCameraReady;
  elements.monitorButton.disabled = !state.isCameraReady || state.baselineNormalizedY == null;
  elements.monitorButton.textContent = state.isMonitoring ? "Pause monitoring" : "Start monitoring";
  elements.silenceButton.disabled = !state.isAlarming;
  elements.startCameraButton.textContent = state.isCameraReady ? "Restart camera" : "Start camera";

  renderLog();
}

function renderStats() {
  elements.baselineValue.textContent = state.baselineNormalizedY == null || !state.latestAnalysis
    ? "--"
    : formatPixels(state.baselineNormalizedY * state.latestAnalysis.height);

  elements.currentValue.textContent = state.latestAnalysis
    ? formatPixels(state.latestAnalysis.pixelY)
    : "--";

  const risePixels = state.baselineNormalizedY != null && state.latestAnalysis
    ? (state.baselineNormalizedY - state.latestAnalysis.normalizedY) * state.latestAnalysis.height
    : 0;
  elements.riseValue.textContent = `${Math.max(0, Math.round(risePixels))} px`;

  elements.confidenceValue.textContent = state.latestAnalysis
    ? state.latestAnalysis.confidence.toFixed(1)
    : "--";
}

function renderLog() {
  elements.eventLog.innerHTML = "";

  for (const entry of state.logs) {
    const item = document.createElement("li");
    item.innerHTML = `<strong>${escapeHtml(entry.title)}</strong> ${escapeHtml(entry.message)}`;
    elements.eventLog.appendChild(item);
  }
}

function logEvent(title, message) {
  state.logs.unshift({ title, message });
  state.logs = state.logs.slice(0, MAX_LOG_ITEMS);
  renderLog();
}

function setStatus(message) {
  elements.statusBanner.textContent = message;
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) ?? "{}");
    return {
      ...DEFAULT_SETTINGS,
      ...raw
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
}

function formatPixels(value) {
  return `${Math.round(value)} px`;
}

function readableError(error) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    return;
  }

  try {
    await state.wakeLock?.release();
    state.wakeLock = await navigator.wakeLock.request("screen");
  } catch {
  }
}

async function handleVisibilityChange() {
  if (document.visibilityState === "visible" && state.isCameraReady) {
    await requestWakeLock();
  }
}

function stopStream() {
  if (!state.stream) {
    state.isCameraReady = false;
    render();
    return;
  }

  for (const track of state.stream.getTracks()) {
    track.stop();
  }

  state.stream = null;
  state.isCameraReady = false;
  state.isMonitoring = false;
  stopAlarmLoop();
  state.wakeLock?.release().catch(() => {
  });
  state.wakeLock = null;
  render();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js?v=2").catch(() => {
    });
  });
}

registerServiceWorker();
