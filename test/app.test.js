const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const request = require('supertest');
const { createApp, initializeDatabase, dateInputValue, validateStudent, csvCell, monthlyEnrollment } = require('../server');

process.env.NODE_ENV = 'test';

function csrf(html) {
  const token = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(token, 'CSRF token should be present');
  return token[1];
}

function studentRecord(overrides = {}) {
  return {
    student_id: '2025-0001', first_name: 'Avery', middle_name: '', last_name: 'Morgan',
    gender: 'Non-binary', date_of_birth: '2005-04-15', email: 'avery@example.edu',
    phone: '555-0123', address: '10 College Way', course_id: '', year_level: '2nd Year',
    section: 'A', enrollment_date: '2025-08-20', ...overrides
  };
}

test('validates required fields, date values, and gender choices', () => {
  assert.deepEqual(validateStudent(studentRecord()), []);
  assert.ok(validateStudent(studentRecord({ gender: 'Other' })).includes('Select a valid gender.'));
  assert.ok(validateStudent(studentRecord({ enrollment_date: '2025-99-99' })).includes('Enrollment date must be a valid date.'));
  assert.ok(validateStudent(studentRecord({ email: 'not-an-email' })).includes('Enter a valid email address.'));
});

test('CSV export cells quote delimiters and neutralize spreadsheet formulas', () => {
  assert.equal(csvCell('A "quote", value'), '"A ""quote"", value"');
  assert.equal(csvCell('=HYPERLINK("https://example.com")'), `"'=HYPERLINK(""https://example.com"")"`);
});

test('date form values are formatted for HTML date inputs', () => {
  assert.equal(dateInputValue(new Date('2025-08-20T00:00:00.000Z')), '2025-08-20');
  assert.equal(dateInputValue('2025-08-20T00:00:00.000Z'), '2025-08-20');
  assert.equal(dateInputValue(null), '');
});

test('monthly enrollment charts group database counts into the displayed real month range', () => {
  const month = new Date().toISOString().slice(0, 7);
  const chart = monthlyEnrollment([{ enrollment_date: `${month}-12`, total: 3 }], 6);
  assert.equal(chart.length, 6);
  assert.equal(chart.at(-1).total, 3);
  assert.equal(chart.slice(0, -1).reduce((sum, item) => sum + item.total, 0), 0);
});

test('administrator setup is one-time and students support create, search, edit, and delete', async () => {
  const memoryDb = newDb();
  const { Pool: MemoryPool } = memoryDb.adapters.createPg();
  const db = new MemoryPool();
  await initializeDatabase(db);
  const app = createApp({ pool: db });
  const client = request.agent(app);

  const setupPage = await client.get('/setup').expect(200);
  await client.post('/setup').type('form').send({
    username: 'campus-admin', password: 'a-very-long-test-password'
  }).expect(403);
  await client.post('/setup').type('form').send({
    _csrf: csrf(setupPage.text), username: 'campus-admin', password: 'a-very-long-test-password'
  }).expect(302);
  await client.get('/setup').expect(302).expect('Location', '/login');

  await client.get('/').expect(200);
  await client.get('/reports').expect(200);
  let page = await client.get('/students/new').expect(200);
  const coursePage = await client.get('/courses').expect(200);
  await client.post('/courses').type('form').send({ name: 'Computer Science', code: 'BSCS' }).expect(403);
  await client.post('/courses').type('form').send({
    _csrf: csrf(coursePage.text), name: 'Computer Science', code: 'BSCS'
  }).expect(302);
  page = await client.get('/students/new').expect(200);
  assert.match(page.text, /Computer Science · BSCS/);
  const courseId = Number((await db.query('SELECT id FROM courses WHERE code=$1', ['BSCS'])).rows[0].id);
  await client.post('/students').type('form').send({
    ...studentRecord({ course_id: String(courseId) }), _csrf: csrf(page.text)
  }).expect(302).expect('Location', '/students');
  page = await client.get('/students/new').expect(200);
  await client.post('/students').type('form').send({
    ...studentRecord({ student_id: 'INVALID', gender: 'Invalid gender' }), _csrf: csrf(page.text)
  }).expect(422).expect((res) => assert.match(res.text, /Select a valid gender/));
  await client.post('/students').type('form').send({
    ...studentRecord(), _csrf: csrf(page.text)
  }).expect(409).expect((res) => assert.match(res.text, /already exists/));

  const records = await client.get('/students?q=avery').expect(200);
  assert.match(records.text, /Avery Morgan/);
  assert.match(records.text, /Computer Science/);
  await client.get('/reports/export.csv').expect(200).expect('Content-Type', /text\/csv/).expect((res) => assert.match(res.text, /2025-0001/));
  await client.get('/students?course=invalid&gender=unknown&level=invalid&page=100').expect(200).expect((res) => assert.match(res.text, /Page 1 of 1/));
  page = await client.get('/courses').expect(200);
  await client.post(`/courses/${courseId}/delete`).type('form').send({ _csrf: csrf(page.text) }).expect(302);
  assert.equal((await db.query('SELECT id FROM courses WHERE id=$1', [courseId])).rowCount, 1);
  const stored = (await db.query('SELECT id FROM students WHERE student_id=$1', ['2025-0001'])).rows[0];
  assert.ok(stored);
  const populatedDashboard = await client.get('/').expect(200);
  assert.match(populatedDashboard.text, /class="stat-value">1<\/strong>/);
  assert.match(populatedDashboard.text, /data-chart="gender"/);

  page = await client.get(`/students/${stored.id}/edit`).expect(200);
  await client.post(`/students/${stored.id}/edit`).type('form').send({
    ...studentRecord({ student_id: '2025-0002', first_name: 'Jordan', course_id: String(courseId) }),
    _csrf: csrf(page.text)
  }).expect(302);
  const profile = await client.get(`/students/${stored.id}`).expect(200);
  assert.match(profile.text, /Jordan Morgan/);

  page = await client.get(`/students/${stored.id}`).expect(200);
  await client.post(`/students/${stored.id}/delete`).type('form').send({ _csrf: csrf(page.text) }).expect(302);
  await client.get('/students?q=avery').expect(200).expect((res) => assert.doesNotMatch(res.text, /Jordan Morgan/));

  await client.post('/logout').type('form').send({ _csrf: csrf((await client.get('/students')).text) }).expect(302);
  await client.get('/students').expect(302).expect('Location', '/login');
  const loginPage = await client.get('/login').expect(200);
  await client.post('/login').type('form').send({
    _csrf: csrf(loginPage.text), username: 'campus-admin', password: 'a-very-long-test-password', remember: '1'
  }).expect(302);
  const settingsPage = await client.get('/settings').expect(200);
  await client.post('/settings/password').type('form').send({
    _csrf: csrf(settingsPage.text), current_password: 'incorrect-password', new_password: 'a-different-long-password'
  }).expect(302);
  await client.post('/settings/password').type('form').send({
    _csrf: csrf((await client.get('/settings')).text), current_password: 'a-very-long-test-password',
    new_password: 'a-different-long-password'
  }).expect(302);
  page = await client.get('/students').expect(200);
  await client.post('/logout').type('form').send({ _csrf: csrf(page.text) }).expect(302);
  const updatedLogin = await client.get('/login').expect(200);
  await client.post('/login').type('form').send({
    _csrf: csrf(updatedLogin.text), username: 'campus-admin', password: 'a-different-long-password'
  }).expect(302);
  await db.end();
});
