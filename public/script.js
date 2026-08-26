import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// ---------- DOM ----------
const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const bootOverlay = document.getElementById("bootOverlay");
const cueBanner = document.getElementById("cueBanner");
const cueText = document.getElementById("cueText");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const repCountEl = document.getElementById("repCount");
const goodCountEl = document.getElementById("goodCount");
const badCountEl = document.getElementById("badCount");
const angleValueEl = document.getElementById("angleValue");
const angleLabelEl = document.getElementById("angleLabel");
const timerValueEl = document.getElementById("timerValue");
const feedbackList = document.getElementById("feedbackList");
const historyList = document.getElementById("historyList");
const exerciseSelect = document.getElementById("exercise");

// ---------- State ----------
let poseLandmarker = null;
let running = false;
let rafId = null;
let lastVideoTime = -1;

let repPhase = "extended"; // "extended" | "contracted" — generic rep phase, reused across exercises
let repCount = 0;
let goodReps = 0;
let badReps = 0;
let currentRepHadBadForm = false;
let sessionStart = null;
let timerInterval = null;

// ---------- Landmark indices (MediaPipe Pose) ----------
const L = {
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28
};

// Pick whichever side (left/right) MediaPipe is more confident about, and
// return a lookup of named joints for that side. Keeps per-exercise code
// simple since it never has to think about left vs. right itself.
function pickSide(landmarks) {
  const leftVis = landmarks[L.LEFT_SHOULDER].visibility;
  const rightVis = landmarks[L.RIGHT_SHOULDER].visibility;
  const side = leftVis >= rightVis ? "LEFT" : "RIGHT";
  return {
    shoulder: landmarks[L[`${side}_SHOULDER`]],
    elbow: landmarks[L[`${side}_ELBOW`]],
    wrist: landmarks[L[`${side}_WRIST`]],
    hip: landmarks[L[`${side}_HIP`]],
    knee: landmarks[L[`${side}_KNEE`]],
    ankle: landmarks[L[`${side}_ANKLE`]]
  };
}

// ---------- Exercise definitions ----------
// Each exercise watches one "primary" joint angle to drive the rep counter,
// plus an optional secondary check for a common form mistake. The rep state
// machine itself (extended <-> contracted) is shared across all of them.
const EXERCISES = {
  squat: {
    label: "Squat",
    angleLabel: "KNEE ANGLE",
    primaryAngle: (j) => angleAt(j.hip, j.knee, j.ankle),
    contractedThreshold: 100, // knee angle below this = "in the squat"
    extendedThreshold: 160,   // knee angle above this = "standing"
    cues: {
      contracted: "Good depth — drive back up",
      extended: "Standing — ready for next rep"
    },
    formCheck: (j, primaryAngle, phase) => {
      if (phase !== "contracted") return null;
      const lean = torsoLeanAngle(j.shoulder, j.hip);
      if (lean < 45) return "Leaning too far forward — keep your chest up";
      if (primaryAngle < 60) return "Going too deep — control the bottom of the squat";
      return null;
    }
  },

  pushup: {
    label: "Push-up",
    angleLabel: "ELBOW ANGLE",
    primaryAngle: (j) => angleAt(j.shoulder, j.elbow, j.wrist),
    contractedThreshold: 90,  // elbow angle below this = "at the bottom"
    extendedThreshold: 160,   // elbow angle above this = "arms extended"
    cues: {
      contracted: "At the bottom — push back up",
      extended: "Arms extended — ready for next rep"
    },
    formCheck: (j) => {
      // Body should stay a straight line from shoulder to hip to ankle.
      const bodyLine = angleAt(j.shoulder, j.hip, j.ankle);
      if (bodyLine < 155) return "Keep your body straight — don't let your hips sag or pike up";
      return null;
    }
  },

  bicepcurl: {
    label: "Bicep Curl",
    angleLabel: "ELBOW ANGLE",
    primaryAngle: (j) => angleAt(j.shoulder, j.elbow, j.wrist),
    contractedThreshold: 50,  // elbow angle below this = "fully curled"
    extendedThreshold: 150,   // elbow angle above this = "arm hanging extended"
    cues: {
      contracted: "Nice squeeze — lower it slow and controlled",
      extended: "Arm extended — ready to curl"
    },
    formCheck: (j, primaryAngle, phase) => {
      if (phase !== "contracted") return null;
      // Upper arm should stay close to the torso; a wide angle here means
      // the person is swinging their shoulder to help lift the weight.
      const upperArmSwing = angleAt(j.elbow, j.shoulder, j.hip);
      if (upperArmSwing > 40) return "Keep your elbow tucked in — avoid swinging your upper arm";
      return null;
    }
  }
};

function currentExercise() {
  return EXERCISES[exerciseSelect.value] || EXERCISES.squat;
}

// ---------- Setup pose model ----------
async function initPoseLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numPoses: 1
  });
  bootOverlay.classList.add("hidden");
}

// ---------- Camera ----------
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
    audio: false
  });
  video.srcObject = stream;
  await new Promise((resolve) => (video.onloadedmetadata = resolve));
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

function stopCamera() {
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

// ---------- Geometry helpers ----------
// Angle at point b, formed by points a-b-c, in degrees (0-180)
function angleAt(a, b, c) {
  const radians =
    Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let deg = Math.abs((radians * 180) / Math.PI);
  if (deg > 180) deg = 360 - deg;
  return deg;
}

// Angle of the torso relative to vertical (0 = perfectly upright)
function torsoLeanAngle(shoulder, hip) {
  const dx = shoulder.x - hip.x;
  const dy = shoulder.y - hip.y;
  const radians = Math.atan2(Math.abs(dx), Math.abs(dy));
  return (radians * 180) / Math.PI;
}

// ---------- Feedback UI ----------
function setCue(message, kind) {
  cueText.textContent = message;
  cueBanner.classList.remove("good", "bad");
  if (kind) cueBanner.classList.add(kind);
}

function logFeedback(message) {
  const li = document.createElement("li");
  li.textContent = message;
  feedbackList.prepend(li);
  while (feedbackList.children.length > 6) feedbackList.removeChild(feedbackList.lastChild);
}

// ---------- Core analysis per frame ----------
function analyzePose(landmarks) {
  const exercise = currentExercise();
  const j = pickSide(landmarks);
  const primaryAngle = exercise.primaryAngle(j);

  angleValueEl.textContent = `${Math.round(primaryAngle)}°`;

  // Rep state machine — shared logic across all exercises
  if (repPhase === "extended" && primaryAngle < exercise.contractedThreshold) {
    repPhase = "contracted";
    currentRepHadBadForm = false;
  }

  const issue = exercise.formCheck(j, primaryAngle, repPhase);

  if (repPhase === "contracted" && primaryAngle > exercise.extendedThreshold) {
    repPhase = "extended";
    repCount += 1;
    if (currentRepHadBadForm) {
      badReps += 1;
    } else {
      goodReps += 1;
    }
    repCountEl.textContent = repCount;
    goodCountEl.textContent = goodReps;
    badCountEl.textContent = badReps;
  }

  if (issue) {
    currentRepHadBadForm = true;
    setCue(issue, "bad");
    logFeedback(issue);
  } else {
    setCue(exercise.cues[repPhase], repPhase === "contracted" ? "good" : null);
  }
}

// ---------- Drawing ----------
const drawingUtils = new DrawingUtils(ctx);

function drawSkeleton(result) {
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const landmarks of result.landmarks) {
    drawingUtils.drawLandmarks(landmarks, {
      radius: 3,
      color: "#4fd1ae",
      fillColor: "#4fd1ae"
    });
    drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
      color: "#edede6",
      lineWidth: 2
    });
  }
  ctx.restore();
}

// ---------- Main loop ----------
function renderLoop() {
  if (!running) return;

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = poseLandmarker.detectForVideo(video, performance.now());
    drawSkeleton(result);
    if (result.landmarks.length > 0) {
      analyzePose(result.landmarks[0]);
    }
  }

  rafId = requestAnimationFrame(renderLoop);
}

// ---------- Timer ----------
function startTimer() {
  sessionStart = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    timerValueEl.textContent = `${mm}:${ss}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  return sessionStart ? Math.floor((Date.now() - sessionStart) / 1000) : 0;
}

// ---------- Session persistence ----------
async function saveSession(durationSeconds) {
  const issues = Array.from(feedbackList.children).map((li) => li.textContent);
  const body = {
    exercise: document.getElementById("exercise").value,
    reps: repCount,
    goodReps,
    badReps,
    durationSeconds,
    formIssues: [...new Set(issues)]
  };
  try {
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    await loadHistory();
  } catch (err) {
    console.error("Could not save session:", err);
  }
}

async function loadHistory() {
  try {
    const res = await fetch("/api/sessions");
    const sessions = await res.json();
    historyList.innerHTML = "";
    if (sessions.length === 0) {
      historyList.innerHTML = `<li class="muted">No sessions saved yet</li>`;
      return;
    }
    sessions
      .slice(-6)
      .reverse()
      .forEach((s) => {
        const li = document.createElement("li");
        const date = new Date(s.createdAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric"
        });
        li.innerHTML = `<span>${date} · ${s.exercise}</span><span>${s.reps} reps (${s.goodReps}✓/${s.badReps}✗)</span>`;
        historyList.appendChild(li);
      });
  } catch (err) {
    console.error("Could not load history:", err);
  }
}

// ---------- Reset state for a new session ----------
function resetSessionState() {
  repPhase = "extended";
  repCount = 0;
  goodReps = 0;
  badReps = 0;
  currentRepHadBadForm = false;
  repCountEl.textContent = "0";
  goodCountEl.textContent = "0";
  badCountEl.textContent = "0";
  angleLabelEl.textContent = currentExercise().angleLabel;
  angleValueEl.textContent = "–";
  timerValueEl.textContent = "00:00";
  feedbackList.innerHTML = "";
}

// ---------- Controls ----------
startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  exerciseSelect.disabled = true;
  resetSessionState();
  await startCamera();
  running = true;
  setCue("Get into position…", null);
  startTimer();
  renderLoop();
  stopBtn.disabled = false;
});

stopBtn.addEventListener("click", async () => {
  running = false;
  cancelAnimationFrame(rafId);
  const duration = stopTimer();
  stopCamera();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setCue("Session ended", null);
  startBtn.disabled = false;
  exerciseSelect.disabled = false;
  stopBtn.disabled = true;
  if (repCount > 0) {
    await saveSession(duration);
  }
});

// Keep the angle label in sync when the user picks a different exercise
// before starting a session.
exerciseSelect.addEventListener("change", () => {
  angleLabelEl.textContent = currentExercise().angleLabel;
});

// ---------- Boot ----------
(async function boot() {
  await initPoseLandmarker();
  await loadHistory();
})();
