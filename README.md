# Claude Queue v2.0

Claude Queue is a sophisticated system that allows you to schedule and queue messages for Claude.ai. It bypasses the lack of an official scheduling API by using a custom Firefox/Chrome extension to harvest session tokens and a headless Playwright worker to automate the execution of your prompts at exactly the right time.

## Architecture

The system is built as a monorepo utilizing `pnpm` workspaces:
- **`apps/api`**: A robust NestJS backend that handles authentication, job scheduling (BullMQ), Postgres database management (Prisma), and S3 attachment storage.
- **`apps/worker`**: A headless Playwright service that executes scheduled jobs on Claude.ai by restoring your harvested browser session and driving the DOM dynamically.
- **`apps/extension`**: A WXT-based browser extension built with React & Tailwind that injects a scheduling button directly into Claude.ai and syncs your authentication state.
- **`packages/shared-types`**: Zod schemas ensuring strict data contracts across the entire stack.

---

## 🛠️ Local Development Setup

### Prerequisites
- [Node.js 20+](https://nodejs.org/en)
- [pnpm 8+](https://pnpm.io/installation)
- [Docker & Docker Compose](https://www.docker.com/)

### 1. Install Dependencies
```bash
# Install monorepo dependencies
pnpm install
```

### 2. Environment Variables
Copy the example environment file and adjust the values if needed:
```bash
cp .env.example .env
```
*(By default, the `.env.example` is pre-configured to work with the local docker-compose infrastructure).*

### 3. Start Local Infrastructure
Spin up PostgreSQL, Redis, and MinIO (S3 clone):
```bash
pnpm run docker:up
```
*(Postgres maps to port 5433 to avoid local conflicts).*

### 4. Setup Database
Push the Prisma schema to initialize the database:
```bash
pnpm run db:push
```

### 5. Start Development Servers
Run the API backend and Playwright worker simultaneously:
```bash
pnpm run dev
```
*(The API will be available on `http://localhost:3000`).*

### 6. Build and Load the Extension
In a new terminal tab, compile the extension:
```bash
cd apps/extension

# Build for Chrome / Edge / Brave
pnpm exec wxt build

# Build for Firefox
pnpm exec wxt build -b firefox
```
The compiled extensions will be placed in `apps/extension/.output/`.

**For Chrome / Brave / Edge:**
1. Open your browser's extension management page (`chrome://extensions`).
2. Enable **Developer Mode** (usually a toggle in the top right).
3. Click **Load Unpacked** and select the `apps/extension/.output/chrome-mv3/` directory.

**For Firefox:**
1. Open a new tab and navigate to `about:debugging#/runtime/this-firefox`.
2. Click the **Load Temporary Add-on...** button.
3. Browse to the `apps/extension/.output/firefox-mv2/` folder and select the `manifest.json` file.
   - *Note for macOS users:* The `.output` folder is hidden by default. When the file picker is open, press **`Command + Shift + .`** to reveal hidden folders so you can select it.

---

## 🚀 How to Use

1. **Configure the Extension:**
   - Click the extension icon in your browser toolbar to open the popup.
   - Set the **Backend URL** to `http://localhost:3000`.
   - Set the **Admin Token** to match `BACKEND_ADMIN_TOKEN` in your `.env` file.
2. **Pair Account:**
   - Log into [claude.ai](https://claude.ai).
   - In the extension popup, click **Pair Account**. This syncs your session tokens securely with the backend.
3. **Queue a Message:**
   - Go to any chat on Claude.ai.
   - Type a prompt, but instead of hitting "Send", click the new orange **clock icon** injected next to the send button.
   - Choose a delay or an absolute time, select your model, and queue the message!

---

## 🐳 Production Deployment (Coolify)

This repository is optimized for deployment via [Coolify](https://coolify.io/) using its native Docker Compose integration.

1. **Push your code to Git:**
   Push this entire repository to GitHub, GitLab, or your Git provider of choice.

2. **Create the Resource in Coolify:**
   - In your Coolify dashboard, create a new Project and Environment.
   - Click **Add New Resource** ➔ select **Git Repository** ➔ select your repository.
   - For the build pack, select **Docker Compose**.
   - Under the configuration, set the **Docker Compose File** path to: `/docker-compose.prod.yml`

3. **Configure Environment Variables:**
   - Before deploying, go to the **Environment Variables** tab.
   - Open your local `.env.production.example` file and copy everything.
   - Paste it into Coolify's bulk editor. 
   - **Crucial:** Change all the `CHANGE_ME_*` placeholders to strong passwords/keys. 

4. **Setup Routing (SSL/Domains):**
   - Coolify will parse the `docker-compose.prod.yml` and list the individual services (`api`, `worker`, `postgres`, etc.).
   - Click on the **`api`** service.
   - Enter your public domain (e.g., `https://claude-api.yourdomain.com`). Coolify will automatically set up Traefik/Caddy and generate an SSL certificate.

5. **Deploy:**
   - Click **Deploy**. 
   - Coolify will build the multi-stage `Dockerfile` for the API and the massive Playwright image for the worker, start up your Postgres/Redis/MinIO instances, and hook everything together.
   - Once it's running, update your Extension's popup to use your new `https://claude-api.yourdomain.com` URL!
