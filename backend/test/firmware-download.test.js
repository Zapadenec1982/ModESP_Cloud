'use strict';

const { describe, it, expect, beforeAll, afterAll } = require('vitest');
const request  = require('supertest');
const fs       = require('fs');
const path     = require('path');
const { createTestApp }  = require('./helpers/app');
const { cleanDatabase, shutdownDb } = require('./helpers/setup');
const { generateSignedUrl } = require('../src/services/firmware-url');

const app = createTestApp();

// Create a temp firmware file for testing
const firmwareDir = process.env.FIRMWARE_STORAGE_PATH
  || path.join(__dirname, '../firmware');
const TEST_FILENAME = 'test_device_1.0.0_1700000000000.bin';
const TEST_FILEPATH = path.join(firmwareDir, TEST_FILENAME);

describe('Firmware Download (signed URLs)', () => {
  beforeAll(async () => {
    await cleanDatabase();
    // Ensure firmware directory exists and create test binary
    fs.mkdirSync(firmwareDir, { recursive: true });
    fs.writeFileSync(TEST_FILEPATH, Buffer.from('FAKE_FIRMWARE_BINARY_DATA'));
  });

  afterAll(async () => {
    // Clean up test file
    if (fs.existsSync(TEST_FILEPATH)) fs.unlinkSync(TEST_FILEPATH);
    await shutdownDb();
  });

  it('returns 200 for valid signed URL', async () => {
    const signedPath = generateSignedUrl(TEST_FILENAME);
    const res = await request(app).get(signedPath);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/octet-stream/);
    expect(res.body.toString()).toBe('FAKE_FIRMWARE_BINARY_DATA');
  });

  it('returns 403 for expired signature', async () => {
    // Generate URL and manually make it expired
    const signedPath = generateSignedUrl(TEST_FILENAME);
    const url = new URL(signedPath, 'http://localhost');
    url.searchParams.set('expires', '1000000000'); // year ~2001

    const res = await request(app).get(url.pathname + url.search);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('returns 403 for tampered signature', async () => {
    const signedPath = generateSignedUrl(TEST_FILENAME);
    const tamperedPath = signedPath.replace(/sig=[a-f0-9]+/, 'sig=00000000000000000000000000000000');

    const res = await request(app).get(tamperedPath);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('returns 400 for path traversal attempt', async () => {
    const signedPath = generateSignedUrl('../etc/passwd');
    const res = await request(app).get(signedPath);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_filename');
  });

  it('returns 400 for missing params', async () => {
    const res = await request(app).get('/api/firmware/dl');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_params');
  });

  it('returns 404 for non-existent file with valid signature', async () => {
    const signedPath = generateSignedUrl('nonexistent_file.bin');
    const res = await request(app).get(signedPath);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
