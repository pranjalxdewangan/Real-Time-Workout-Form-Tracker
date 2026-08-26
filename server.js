const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'sessions.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- tiny helpers to read/write the JSON "database" ---
function readSessions() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeSessions(sessions) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(sessions, null, 2));
}

// --- API routes ---

// Get all past workout sessions
app.get('/api/sessions', (req, res) => {
  res.json(readSessions());
});

// Save a completed workout session
// Expected body: { exercise, reps, goodReps, badReps, durationSeconds, formIssues: [string] }
app.post('/api/sessions', (req, res) => {
  const { exercise, reps, goodReps, badReps, durationSeconds, formIssues } = req.body;

  if (!exercise || typeof reps !== 'number') {
    return res.status(400).json({ error: 'exercise (string) and reps (number) are required' });
  }

  const sessions = readSessions();
  const session = {
    id: Date.now(),
    exercise,
    reps,
    goodReps: goodReps ?? 0,
    badReps: badReps ?? 0,
    durationSeconds: durationSeconds ?? 0,
    formIssues: formIssues ?? [],
    createdAt: new Date().toISOString()
  };

  sessions.push(session);
  writeSessions(sessions);
  res.status(201).json(session);
});

// Delete all history (handy for testing)
app.delete('/api/sessions', (req, res) => {
  writeSessions([]);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Posture Check running at http://localhost:${PORT}`);
});
