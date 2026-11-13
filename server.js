const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000
});

const genders = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];
const yearLevels = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year'];
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function createApp(options = {}) {
  const db = options.pool || pool;
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.locals.dateValue = dateInputValue;
  app.locals.user = null;
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://unpkg.com', 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    }
  }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

  const store = options.sessionStore || (options.pool
    ? new session.MemoryStore()
    : new PgSession({ pool: db, tableName: 'user_sessions', createTableIfMissing: true }));
  app.use(session({
    name: 'campus.sid',
    secret: process.env.SESSION_SECRET || (process.env.NODE_ENV === 'test' ? 'test-session-secret' : undefined),
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
  }));
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.user = req.session.user || null;
    res.locals.currentPath = req.path;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
  });
  app.use((req, res, next) => {
    if (req.method === 'POST' && (!req.body._csrf || req.body._csrf !== req.session.csrfToken)) {
      return res.status(403).render('error', { title: 'Request expired', message: 'Please refresh the page and try again.' });
    }
    next();
  });

  const query = (text, values) => db.query(text, values);
  const flash = (req, type, message) => { req.session.flash = { type, message }; };
  const requireAuth = (req, res, next) => req.session.user ? next() : res.redirect('/login');
  const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true
  });
  const hasAdmin = async () => (await query('SELECT EXISTS (SELECT 1 FROM administrators) AS exists')).rows[0].exists;
  app.param('id', (req, res, next, id) => {
    if (/^\d+$/.test(id) && Number.isSafeInteger(Number(id))) return next();
    res.status(404).render('error', { title: 'Record not found', message: 'This record may have been removed.' });
  });

  app.get('/health', asyncRoute(async (_req, res) => {
    await query('SELECT 1');
    res.json({ status: 'ok' });
  }));

  app.get('/login', asyncRoute(async (req, res) => {
    if (req.session.user) return res.redirect('/');
    if (!await hasAdmin()) return res.redirect('/setup');
    res.render('login', { title: 'Sign in', error: null });
  }));
  app.post('/login', authRateLimit, asyncRoute(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const result = await query('SELECT id, username, password_hash FROM administrators WHERE username = $1', [username]);
    if (!result.rows[0] || !await bcrypt.compare(password, result.rows[0].password_hash)) {
      return res.status(401).render('login', { title: 'Sign in', error: 'That username or password did not match.' });
    }
    req.session.regenerate((error) => {
      if (error) return res.status(500).render('error', { title: 'Sign in failed', message: 'Please try again.' });
      req.session.user = { id: result.rows[0].id, username: result.rows[0].username };
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
      if (req.body.remember === '1') req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
      req.session.save((saveError) => saveError ? res.status(500).render('error', { title: 'Sign in failed', message: 'Please try again.' }) : res.redirect('/'));
    });
  }));
  app.get('/setup', asyncRoute(async (req, res) => {
    if (await hasAdmin()) return res.redirect('/login');
    res.render('setup', { title: 'Set up your workspace', error: null });
  }));
  app.post('/setup', authRateLimit, asyncRoute(async (req, res) => {
    if (await hasAdmin()) return res.redirect('/login');
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!/^[a-zA-Z0-9._-]{3,48}$/.test(username) || password.length < 12) {
      return res.status(400).render('setup', { title: 'Set up your workspace', error: 'Use a 3–48 character username and a password of at least 12 characters.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const created = await query(
        'INSERT INTO administrators (username, password_hash) VALUES ($1, $2) RETURNING id, username',
        [username, passwordHash]
      );
      req.session.regenerate((error) => {
        if (error) return res.status(500).render('error', { title: 'Setup failed', message: 'Please try again.' });
        req.session.user = created.rows[0];
        req.session.csrfToken = crypto.randomBytes(24).toString('hex');
        req.session.save((saveError) => saveError ? res.status(500).render('error', { title: 'Setup failed', message: 'Please try again.' }) : res.redirect('/'));
      });
    } catch (error) {
      if (error.code === '23505') return res.status(409).render('setup', { title: 'Set up your workspace', error: 'An administrator account has already been created. Please sign in.' });
      throw error;
    }
  }));
  app.post('/logout', requireAuth, (req, res, next) => req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('campus.sid');
    res.redirect('/login');
  }));

  app.get('/', requireAuth, asyncRoute(async (_req, res) => {
    const [stats, courses, gender, levels, enrollment] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total, (SELECT COUNT(*)::int FROM courses) AS courses,
        COUNT(*) FILTER (WHERE gender = 'Male')::int AS male,
        COUNT(*) FILTER (WHERE gender = 'Female')::int AS female
        FROM students`),
      query('SELECT c.id, c.name, COUNT(st.id)::int AS total FROM courses c LEFT JOIN students st ON st.course_id = c.id GROUP BY c.id ORDER BY total DESC, c.name LIMIT 6'),
      query('SELECT gender AS label, COUNT(*)::int AS total FROM students GROUP BY gender ORDER BY total DESC'),
      query('SELECT year_level AS label, COUNT(*)::int AS total FROM students WHERE year_level IS NOT NULL GROUP BY year_level ORDER BY year_level'),
      query('SELECT enrollment_date, COUNT(*)::int AS total FROM students GROUP BY enrollment_date ORDER BY enrollment_date')
    ]);
    res.render('dashboard', {
      title: 'Overview', stats: stats.rows[0], courses: courses.rows,
      chartData: { gender: gender.rows, levels: levels.rows, enrollment: monthlyEnrollment(enrollment.rows, 6), courses: courses.rows }
    });
  }));

  app.get('/students', requireAuth, asyncRoute(async (req, res) => {
    const search = String(req.query.q || '').trim().slice(0, 100);
    const courseId = /^\d+$/.test(req.query.course || '') && Number.isSafeInteger(Number(req.query.course)) ? req.query.course : '';
    const level = yearLevels.includes(req.query.level) ? req.query.level : '';
    const gender = genders.includes(req.query.gender) ? req.query.gender : '';
    const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = 10;
    const conditions = [];
    const values = [];
    const add = (sql, value) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    if (search) {
      values.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
      const start = values.length - 3;
      conditions.push(`(s.student_id ILIKE $${start} OR s.first_name ILIKE $${start + 1} OR s.last_name ILIKE $${start + 2} OR s.email ILIKE $${start + 3})`);
    }
    if (courseId) add('s.course_id = ?', courseId);
    if (level) add('s.year_level = ?', level);
    if (gender) add('s.gender = ?', gender);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM students s ${where}`, values);
    const total = countResult.rows[0].total;
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / limit)));
    const rows = await query(
      `SELECT s.*, c.name AS course_name FROM students s LEFT JOIN courses c ON c.id = s.course_id
      ${where} ORDER BY s.last_name, s.first_name LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, (page - 1) * limit]
    );
    const courses = await query('SELECT id, name, code FROM courses ORDER BY name');
    res.render('students', {
      title: 'Student records', students: rows.rows, courses: courses.rows,
      filters: { q: search, course: courseId, level, gender },
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
    });
  }));

  app.get('/students/new', requireAuth, asyncRoute(async (_req, res) => {
    const courses = await query('SELECT id, name, code FROM courses ORDER BY name');
    res.render('student-form', { title: 'Add student', student: {}, courses: courses.rows, errors: [] });
  }));
  app.post('/students', requireAuth, asyncRoute(async (req, res) => {
    const data = studentInput(req.body);
    const errors = validateStudent(data);
    if (errors.length) {
      const courses = await query('SELECT id, name, code FROM courses ORDER BY name');
      return res.status(422).render('student-form', { title: 'Add student', student: data, courses: courses.rows, errors });
    }
    try {
      await query(`INSERT INTO students
        (student_id, first_name, middle_name, last_name, gender, date_of_birth, email, phone, address, course_id, year_level, section, enrollment_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, studentValues(data));
    } catch (error) {
      if (error.code === '23505') {
        const courses = await query('SELECT id, name, code FROM courses ORDER BY name');
        return res.status(409).render('student-form', { title: 'Add student', student: data, courses: courses.rows, errors: ['Student ID or email already exists.'] });
      }
      throw error;
    }
    flash(req, 'success', 'Student record added successfully.');
    res.redirect('/students');
  }));
  app.get('/students/:id', requireAuth, asyncRoute(async (req, res) => {
    const result = await query('SELECT s.*, c.name AS course_name FROM students s LEFT JOIN courses c ON c.id = s.course_id WHERE s.id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).render('error', { title: 'Student not found', message: 'This record may have been removed.' });
    res.render('student-profile', { title: result.rows[0].first_name, student: result.rows[0] });
  }));
  app.get('/students/:id/edit', requireAuth, asyncRoute(async (req, res) => {
    const [result, courses] = await Promise.all([
      query('SELECT * FROM students WHERE id = $1', [req.params.id]),
      query('SELECT id, name FROM courses ORDER BY name')
    ]);
    if (!result.rows[0]) return res.status(404).render('error', { title: 'Student not found', message: 'This record may have been removed.' });
    res.render('student-form', { title: 'Edit student', student: result.rows[0], courses: courses.rows, errors: [] });
  }));
  app.post('/students/:id/edit', requireAuth, asyncRoute(async (req, res) => {
    const data = studentInput(req.body);
    const errors = validateStudent(data);
    if (errors.length) {
      const courses = await query('SELECT id, name, code FROM courses ORDER BY name');
      return res.status(422).render('student-form', { title: 'Edit student', student: { ...data, id: req.params.id }, courses: courses.rows, errors });
    }
    try {
      const result = await query(`UPDATE students SET student_id=$1, first_name=$2, middle_name=$3, last_name=$4, gender=$5,
        date_of_birth=$6, email=$7, phone=$8, address=$9, course_id=$10, year_level=$11, section=$12, enrollment_date=$13, updated_at=NOW()
        WHERE id=$14`, [...studentValues(data), req.params.id]);
      if (!result.rowCount) return res.status(404).render('error', { title: 'Student not found', message: 'This record may have been removed.' });
    } catch (error) {
      if (error.code === '23505') {
        const courses = await         query('SELECT id, name, code FROM courses ORDER BY name');
        return res.status(409).render('student-form', { title: 'Edit student', student: { ...data, id: req.params.id }, courses: courses.rows, errors: ['Student ID or email already exists.'] });
      }
      throw error;
    }
    flash(req, 'success', 'Student profile updated.');
    res.redirect(`/students/${req.params.id}`);
  }));
  app.post('/students/:id/delete', requireAuth, asyncRoute(async (req, res) => {
    const result = await query('DELETE FROM students WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).render('error', { title: 'Student not found', message: 'This record may have been removed.' });
    flash(req, 'success', 'Student record deleted.');
    res.redirect('/students');
  }));

  app.get('/courses', requireAuth, asyncRoute(async (_req, res) => {
    const courses = await query('SELECT c.id, c.name, c.code, c.created_at, COUNT(s.id)::int AS student_count FROM courses c LEFT JOIN students s ON s.course_id = c.id GROUP BY c.id ORDER BY c.name');
    res.render('courses', { title: 'Course management', courses: courses.rows });
  }));
  app.post('/courses', requireAuth, asyncRoute(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || '').trim().toUpperCase();
    if (name.length < 2 || name.length > 100 || code.length < 2 || code.length > 12) {
      flash(req, 'error', 'Enter a course name and a 2–12 character course code.');
      return res.redirect('/courses');
    }
    try {
      await query('INSERT INTO courses (name, code) VALUES ($1, $2)', [name, code]);
    } catch (error) {
      if (error.code === '23505') {
        flash(req, 'error', 'That course name or code already exists.');
        return res.redirect('/courses');
      }
      throw error;
    }
    flash(req, 'success', 'Course added.');
    res.redirect('/courses');
  }));
  app.post('/courses/:id/delete', requireAuth, asyncRoute(async (req, res) => {
    const used = await query('SELECT EXISTS (SELECT 1 FROM students WHERE course_id = $1) AS used', [req.params.id]);
    if (used.rows[0].used) {
      flash(req, 'error', 'This course has enrolled students and cannot be removed.');
      return res.redirect('/courses');
    }
    await query('DELETE FROM courses WHERE id = $1', [req.params.id]);
    flash(req, 'success', 'Course removed.');
    res.redirect('/courses');
  }));

  app.get('/reports', requireAuth, asyncRoute(async (_req, res) => {
    const [summary, courses, gendersResult, levels, monthly] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE gender='Male')::int AS male,
        COUNT(*) FILTER (WHERE gender='Female')::int AS female, (SELECT COUNT(*)::int FROM courses) AS courses FROM students`),
      query('SELECT c.name, COUNT(s.id)::int AS total FROM courses c LEFT JOIN students s ON s.course_id=c.id GROUP BY c.id ORDER BY total DESC, c.name'),
      query('SELECT gender, COUNT(*)::int AS total FROM students GROUP BY gender ORDER BY total DESC'),
      query('SELECT year_level, COUNT(*)::int AS total FROM students WHERE year_level IS NOT NULL GROUP BY year_level ORDER BY year_level'),
      query('SELECT enrollment_date, COUNT(*)::int AS total FROM students GROUP BY enrollment_date ORDER BY enrollment_date')
    ]);
    res.render('reports', {
      title: 'Reports & analytics', summary: summary.rows[0], courses: courses.rows,
      chartData: { gender: gendersResult.rows, levels: levels.rows, enrollment: monthlyEnrollment(monthly.rows, 12, true), courses: courses.rows }
    });
  }));
  app.get('/reports/export.csv', requireAuth, asyncRoute(async (_req, res) => {
    const result = await query(`SELECT s.student_id, s.first_name, s.middle_name, s.last_name, s.email, s.gender, s.year_level,
      s.section, c.name AS course, s.enrollment_date FROM students s LEFT JOIN courses c ON c.id=s.course_id ORDER BY s.last_name, s.first_name`);
    const fields = ['student_id', 'first_name', 'middle_name', 'last_name', 'email', 'gender', 'year_level', 'section', 'course', 'enrollment_date'];
    const csv = [fields.join(','), ...result.rows.map((row) => fields.map((field) => csvCell(row[field])).join(','))].join('\r\n');
    res.type('text/csv').attachment('student-records.csv').send(csv);
  }));

  app.get('/settings', requireAuth, (req, res) => res.render('settings', { title: 'Settings', username: req.session.user.username }));
  app.post('/settings/password', requireAuth, asyncRoute(async (req, res) => {
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.new_password || '');
    const result = await query('SELECT password_hash FROM administrators WHERE id=$1', [req.session.user.id]);
    if (!result.rows[0] || !await bcrypt.compare(currentPassword, result.rows[0].password_hash)) {
      flash(req, 'error', 'Your current password did not match.');
      return res.redirect('/settings');
    }
    if (newPassword.length < 12) {
      flash(req, 'error', 'Choose a password with at least 12 characters.');
      return res.redirect('/settings');
    }
    await query('UPDATE administrators SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(newPassword, 12), req.session.user.id]);
    flash(req, 'success', 'Password updated.');
    res.redirect('/settings');
  }));

  app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'The page you are looking for does not exist.' }));
  app.use((error, _req, res, _next) => {
    console.error(error);
    if (res.headersSent) return;
    res.status(500).render('error', { title: 'Something went wrong', message: 'We could not complete that request. Please try again.' });
  });

  return app;
}

function studentInput(body) {
  const value = (key) => String(body[key] || '').trim();
  return {
    student_id: value('student_id'), first_name: value('first_name'), middle_name: value('middle_name'),
    last_name: value('last_name'), gender: value('gender'), date_of_birth: value('date_of_birth'),
    email: value('email').toLowerCase(), phone: value('phone'), address: value('address'),
    course_id: value('course_id') || null, year_level: value('year_level'), section: value('section'),
    enrollment_date: value('enrollment_date')
  };
}
function dateInputValue(value) {
  if (!value) return '';
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
function validateStudent(student) {
  const errors = [];
  for (const [field, label] of [['student_id', 'Student ID'], ['first_name', 'First name'], ['last_name', 'Last name'], ['gender', 'Gender'], ['email', 'Email'], ['year_level', 'Year level'], ['enrollment_date', 'Enrollment date']]) {
    if (!student[field]) errors.push(`${label} is required.`);
  }
  if (student.student_id.length > 40 || student.first_name.length > 80 || student.middle_name.length > 80 || student.last_name.length > 80) errors.push('Student ID and names must be within their allowed length.');
  if (student.email.length > 254 || student.phone.length > 40 || student.section.length > 40 || student.address.length > 20_000) errors.push('One or more contact details are too long.');
  if (student.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(student.email)) errors.push('Enter a valid email address.');
  if (student.gender && !genders.includes(student.gender)) errors.push('Select a valid gender.');
  if (student.year_level && !yearLevels.includes(student.year_level)) errors.push('Select a valid year level.');
  if (student.course_id && (!/^\d+$/.test(student.course_id) || !Number.isSafeInteger(Number(student.course_id)))) errors.push('Select a valid course.');
  for (const [label, value] of [['Date of birth', student.date_of_birth], ['Enrollment date', student.enrollment_date]]) {
    if (value) {
      const parsed = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        errors.push(`${label} must be a valid date.`);
      }
    }
  }
  return errors;
}
function studentValues(student) {
  return [
    student.student_id, student.first_name, student.middle_name || null, student.last_name, student.gender,
    student.date_of_birth || null, student.email, student.phone || null, student.address || null,
    student.course_id, student.year_level, student.section || null, student.enrollment_date
  ];
}
function csvCell(value) {
  let text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function monthlyEnrollment(rows, count, includeYear = false) {
  const now = new Date();
  const totals = new Map();
  rows.forEach((row) => {
    const date = row.enrollment_date instanceof Date
      ? row.enrollment_date.toISOString().slice(0, 10)
      : String(row.enrollment_date).slice(0, 10);
    const key = date.slice(0, 7);
    totals.set(key, (totals.get(key) || 0) + Number(row.total));
  });
  return Array.from({ length: count }, (_value, index) => {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count + index + 1, 1));
    const key = month.toISOString().slice(0, 7);
    const label = month.toLocaleDateString('en-US', { month: 'short', ...(includeYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
    return { label, total: totals.get(key) || 0 };
  });
}

async function initializeDatabase(db = pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS administrators (
      id BIGINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      username VARCHAR(48) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS courses (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      code VARCHAR(12) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS students (
      id BIGSERIAL PRIMARY KEY,
      student_id VARCHAR(40) NOT NULL UNIQUE,
      first_name VARCHAR(80) NOT NULL,
      middle_name VARCHAR(80),
      last_name VARCHAR(80) NOT NULL,
      gender VARCHAR(30) NOT NULL,
      date_of_birth DATE,
      email VARCHAR(254) NOT NULL UNIQUE,
      phone VARCHAR(40),
      address TEXT,
      course_id BIGINT REFERENCES courses(id) ON DELETE SET NULL,
      year_level VARCHAR(20) NOT NULL,
      section VARCHAR(40),
      enrollment_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS students_name_idx ON students (last_name, first_name);
    CREATE INDEX IF NOT EXISTS students_course_idx ON students (course_id);
    CREATE INDEX IF NOT EXISTS students_year_idx ON students (year_level);
  `);
}

if (require.main === module) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters.');
  const port = Number(process.env.PORT) || 3000;
  initializeDatabase().then(() => createApp().listen(port, () => console.log(`Campus Records is listening on port ${port}`)))
    .catch((error) => { console.error('Application startup failed:', error); process.exitCode = 1; });
}

module.exports = { createApp, initializeDatabase, studentInput, dateInputValue, validateStudent, csvCell, monthlyEnrollment, genders, yearLevels };
