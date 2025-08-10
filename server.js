const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const app = express();
const mongoose = require('mongoose');
const cors = require('cors');
const logger = require('morgan');

mongoose.connect(process.env.MONGODB_URI);

mongoose.connection.on('connected', () => {
  console.log(`Connected to MongoDB ${mongoose.connection.name}.`);
});

const port = process.env.PORT ? process.env.PORT : "3000";

const allowedOrigins = [
  'http://localhost:5173',
  'https://sparktadrib.onrender.com'
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

app.use('/auth', authRouter);
app.use('/users', userRouter);
app.use('/test-jwt', testJwtRouter);
app.use("/courses", courseRouter);
app.use("/instructors", instructorRouter);

app.listen(port, () => {
  console.log(`The express app is ready and running on port ${port}!`);
});
