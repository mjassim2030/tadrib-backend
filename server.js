const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const app = express();
const mongoose = require('mongoose');
const cors = require('cors');
const logger = require('morgan');

mongoose.connect(process.env.DB_URL);

mongoose.connection.on('connected', () => {
  console.log(`Connected to MongoDB ${mongoose.connection.name}.`);
});

const port = process.env.PORT ? process.env.PORT : "8080";


const allowedOrigins = [
  'http://localhost:5173',
  'https://whale-app-2vav2.ondigitalocean.app'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use(express.json());
app.use(logger('dev'));

const testJwtRouter = require('./controllers/test-jwt');
const authRouter = require('./controllers/auth');
const userRouter = require('./controllers/users');
const courseRouter = require("./controllers/courses.js");
const instructorRouter = require("./controllers/instructors.js");

// GET
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

// --- Auth guard for protected routes ---
function bearerToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.cookies?.token; // if you use cookies
}

function requireAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    // For normal browser navigations, send them to sign-in; for APIs, 401 JSON
    return req.method === 'GET' && req.accepts('html')
      ? res.redirect('/signin')
      : res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return req.method === 'GET' && req.accepts('html')
      ? res.redirect('/signin')
      : res.status(401).json({ error: 'Unauthorized' });
  }
}

app.use('/auth', authRouter);
app.use('/users',requireAuth, userRouter);
app.use('/test-jwt',requireAuth, testJwtRouter);
app.use("/courses",requireAuth, courseRouter);
app.use("/instructors",requireAuth, instructorRouter);

// --- Serve React (SPA) ---
// Point this to your built frontend (e.g., client/dist or build)
const clientDir = path.join(__dirname, 'client', 'dist'); // <-- adjust as needed
app.use(express.static(clientDir));

// SPA fallback: any non-API GET should return index.html so /signin works directly
app.get('*', (req, res, next) => {
  // Let API/health fall through
  if (
    req.path.startsWith('/users') ||
    req.path.startsWith('/courses') ||
    req.path.startsWith('/instructors') ||
    req.path.startsWith('/auth') ||
    req.path.startsWith('/test-jwt') ||
    req.path === '/healthz'
  ) return next();

  res.sendFile(path.join(clientDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`The express app is ready and running on port ${port}!`);
});
