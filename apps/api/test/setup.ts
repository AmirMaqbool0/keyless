import crypto from 'node:crypto';
import { inject } from 'vitest';

// Must run before src/config/env is imported.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = inject('mongoUri');
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.APP_URL = 'http://localhost:5173';
process.env.INBOUND_WEBHOOK_SECRET = 'test-inbound-secret';
process.env.INBOUND_EMAIL_DOMAIN = 'in.keyless.test';
process.env.MS_CLIENT_ID = 'test-ms-client';
process.env.MS_CLIENT_SECRET = 'test-ms-secret';
process.env.GOOGLE_CLIENT_ID = 'test-google-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
