# Free Deployment Guide for Keyless Sales Order Processor

This guide will walk you through deploying the entire application (Web UI, API Server, and Background Processing Worker) **100% for free** without needing a credit card.

---

## 🏗️ Architecture for Free Hosting

| Component | Free Provider | Free Tier Details |
| :--- | :--- | :--- |
| **Database** | [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) | **M0 Cluster:** 512 MB storage, free forever, no credit card |
| **App (Web + API + Worker)** | [Render](https://render.com) | **Free Web Service:** 512 MB RAM, free forever |
| **Background Queue** | MongoDB Queue | Built-in (`QUEUE_DRIVER=mongo`), **zero extra servers/Redis needed** |
| **File Storage** | Local Disk / [Cloudflare R2](https://www.cloudflare.com/products/r2/) | Built-in local storage or 10 GB free S3-compatible R2 |
| **Outbound Email** | [Resend](https://resend.com) | 3,000 emails/month free (or set `EMAIL_PROVIDER=console` for demo) |

---

## Step 1: Set Up Free MongoDB Atlas (3 minutes)

1. Sign up for free at [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas/register).
2. Choose **M0 Free** (Shared) cluster:
   - Cloud Provider: **AWS**
   - Region: Any close to you (e.g., `us-east-1` or `eu-central-1`)
   - Click **Create Cluster**.
3. **Database Access (User Credentials)**:
   - Create a database user with username (e.g. `keyless_user`) and password (e.g. `StrongPassword123!`).
   - Save these credentials.
4. **Network Access (Allow Connections)**:
   - Go to **Network Access** → **Add IP Address**.
   - Select **Allow Access From Anywhere** (`0.0.0.0/0`) → Confirm.
5. **Get Connection String**:
   - Go to **Database** → Click **Connect** → **Drivers (Node.js)**.
   - Copy the URI, replacing `<password>` with your database password:
     ```
     mongodb+srv://keyless_user:<password>@cluster0.mongodb.net/keyless?retryWrites=true&w=majority
     ```

---

## Step 2: Generate Security Keys

Run the following in your terminal to generate 2 random 32-byte Base64 secrets:

```bash
# Generate JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Generate ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Save these two output strings for the next step.

---

## Step 3: Deploy to Render for Free (Unified Single Service)

The repository is pre-configured to build the frontend Vite SPA and bundle it inside the Express server. The start command (`pnpm start:prod`) concurrently starts **both the API server and the background queue worker** in a single container.

### Option A: Using the Render Blueprint (1-Click)

1. Push your repository to GitHub.
2. In [Render Dashboard](https://dashboard.render.com), click **New +** → **Blueprint**.
3. Select your GitHub repository.
4. Render will detect the included `render.yaml`.
5. Enter your `MONGO_URI` when prompted.
6. Click **Apply**.

---

### Option B: Manual Setup on Render

1. Push your repository to GitHub.
2. In [Render Dashboard](https://dashboard.render.com), click **New +** → **Web Service**.
3. Connect your GitHub repository.
4. Configure the service:
   - **Name:** `keyless-sales-orders` (or your preferred name)
   - **Language / Runtime:** `Node`
   - **Region:** Frankfurt (EU) or Oregon (US)
   - **Branch:** `main` (or your active branch)
   - **Build Command:**
     ```bash
     pnpm install && pnpm build
     ```
   - **Start Command:**
     ```bash
     pnpm start:prod
     ```
   - **Instance Type:** `Free`
5. Click **Advanced** and set **Health Check Path** to:
   ```
   /health
   ```
6. Add the following **Environment Variables**:

| Variable | Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Production mode |
| `PORT` | `10000` | Port assigned by Render |
| `MONGO_URI` | `mongodb+srv://...` | Connection string from Step 1 |
| `APP_URL` | `https://<your-service-name>.onrender.com` | Your Render app URL |
| `API_URL` | `https://<your-service-name>.onrender.com` | Same URL (unified deployment) |
| `JWT_SECRET` | *(string from Step 2)* | Session & Token security |
| `ENCRYPTION_KEY` | *(string from Step 2)* | Data-at-rest encryption |
| `QUEUE_DRIVER` | `mongo` | Built-in MongoDB job queue (No Redis needed) |
| `STORAGE_DRIVER` | `local` | Local file storage (or `s3` with Cloudflare R2) |
| `LLM_PROVIDER` | `mock` | Rule-based parser (free), or `anthropic` if you have a key |

7. Click **Create Web Service**.
8. Render will install dependencies, build the packages, and launch your application at `https://<your-service-name>.onrender.com`.

---

## Step 4: Seed Initial Data or Create Super-Admin (Optional)

Once your service is live:
1. Open your Render Web Service dashboard → click the **Shell** tab (or connect locally via `.env` pointing to your Atlas database).
2. To create the first Super-Admin user:
   ```bash
   pnpm --filter @keyless/api make-superadmin your-email@example.com
   ```
3. (Optional) To seed demo products, customers, and sample orders:
   ```bash
   pnpm --filter @keyless/api seed
   ```

---

## Alternative: Docker Deployment (Railway / Fly.io / Self-Hosted VPS)

A production-ready multi-stage [Dockerfile](file:///d:/AMIR%202.o/sales-order-processor/Dockerfile) is included in the root directory.

### Run locally or on VPS with Docker:
```bash
# Build Docker image
docker build -t keyless-app .

# Run container
docker run -p 4000:4000 \
  -e NODE_ENV=production \
  -e MONGO_URI="mongodb+srv://..." \
  -e APP_URL="http://localhost:4000" \
  -e API_URL="http://localhost:4000" \
  -e JWT_SECRET="your-jwt-secret" \
  -e ENCRYPTION_KEY="your-encryption-key" \
  keyless-app
```

---

## ✅ Deployment Checklist

- [x] Production build passes (`pnpm build`).
- [x] Express serves the built Vite SPA static assets from `apps/web/dist`.
- [x] API routes (`/api/*`), Webhooks (`/webhooks/*`), and Health (`/health`) operate without routing collisions.
- [x] Background worker (`apps/worker`) runs concurrently with the API (`pnpm start:prod`).
- [x] MongoDB Atlas M0 cluster supplies persistent storage and background job queue without external Redis.
- [x] Security headers and CSRF protections configured for production.
